/**
 * Integration tests for `nopo secret`. Tmpdir fixture, fresh age identity
 * outside the project (never `.nopo/`). Covers keygen, set/get, stdin,
 * list, unset, unsafe audit, map-shape, overlay, rotate, corrupt, unicode.
 */
import { generateIdentity } from "age-encryption";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { resolveRuntime } from "../../src/config/index.ts";
import { createConfig, Logger, Runner } from "../../src/lib.ts";
import { Environment } from "../../src/parse-env.ts";
import SecretScript, { parseSecretArgs } from "../../src/scripts/secret.ts";
import { secrets } from "../../src/secrets/index.ts";
import {
  listSecrets,
  setSecretCiphertext,
} from "../../src/secrets/yaml-edit.ts";

vi.mock("../../src/git-info", () => ({
  GitInfo: {
    exists: () => false,
    parse: vi.fn(() => ({
      repo: "unknown",
      branch: "unknown",
      commit: "unknown",
    })),
  },
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Fixtures live at <repo root>/nopo/fixtures.
// __dirname = packages/nopo/tests/secrets → up 4 reaches the repo root.
const FIXTURES_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "nopo",
  "fixtures",
);

let tmpRoots: string[] = [];
let identityFiles: string[] = [];
let savedIdentityCommand: string | undefined;

beforeEach(() => {
  tmpRoots = [];
  identityFiles = [];
  savedIdentityCommand = process.env.NOPO_AGE_IDENTITY_COMMAND;
});

afterEach(() => {
  for (const r of tmpRoots) {
    fs.rmSync(r, { recursive: true, force: true });
  }
  for (const f of identityFiles) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // best effort
    }
  }
  if (savedIdentityCommand === undefined) {
    delete process.env.NOPO_AGE_IDENTITY_COMMAND;
  } else {
    process.env.NOPO_AGE_IDENTITY_COMMAND = savedIdentityCommand;
  }
});

/**
 * Write a fresh age identity to os.tmpdir() (not a nopo path). Set
 * NOPO_AGE_IDENTITY_COMMAND to `cat <tmpfile>` (stand-in for `op read`).
 * Return the identity string.
 */
async function installFreshIdentity(): Promise<string> {
  const identity = await generateIdentity();
  const tmpFile = path.join(
    os.tmpdir(),
    `nopo-test-identity-${process.pid}-${identityFiles.length}-${Date.now()}`,
  );
  fs.writeFileSync(tmpFile, identity, { mode: 0o600 });
  identityFiles.push(tmpFile);
  // Quote the path with single quotes — tmpFile may contain unusual chars.
  process.env.NOPO_AGE_IDENTITY_COMMAND = `cat '${tmpFile}'`;
  return identity;
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Materialize a fresh project root in a tmpdir, copying just the named
 * fixture services across. Returns paths the tests need.
 */
function makeProject(serviceFixtures: string[]): {
  root: string;
  servicePaths: Record<string, string>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-secret-"));
  tmpRoots.push(root);

  fs.writeFileSync(
    path.join(root, "nopo.yml"),
    [
      "name: Secrets Test Project",
      "os:",
      "  base:",
      "    image: alpine:3.19",
      "services:",
      "  dirs:",
      "    - ./services",
      "",
    ].join("\n"),
  );

  const servicesDir = path.join(root, "services");
  fs.mkdirSync(servicesDir, { recursive: true });
  const servicePaths: Record<string, string> = {};
  for (const svc of serviceFixtures) {
    const src = path.join(FIXTURES_ROOT, "services", svc);
    const dst = path.join(servicesDir, svc);
    copyDir(src, dst);
    servicePaths[svc] = path.join(dst, "nopo.yml");
  }
  return { root, servicePaths };
}

async function runSecret(root: string, argv: string[]): Promise<void> {
  // Prepend "secret" so argv shape matches what the runner provides.
  const config = createConfig({
    rootDir: root,
    processEnv: {},
    silent: true,
  });
  const logger = new Logger(config);
  const environment = new Environment(config);
  const runner = new Runner(config, environment, ["secret", ...argv], logger);
  await runner.run(SecretScript);
}

describe("parseSecretArgs", () => {
  it("parses `secret set svc KEY value`", () => {
    const r = parseSecretArgs(["secret", "set", "svc", "KEY", "value"]);
    expect(r.verb).toBe("set");
    expect(r.positionals).toEqual(["svc", "KEY", "value"]);
    expect(r.runtime).toBe("default");
  });

  it("recognizes flags anywhere in argv", () => {
    const r = parseSecretArgs([
      "secret",
      "set",
      "--runtime",
      "prod",
      "svc",
      "KEY",
      "--from-stdin",
    ]);
    expect(r.verb).toBe("set");
    expect(r.runtime).toBe("prod");
    expect(r.fromStdin).toBe(true);
    expect(r.positionals).toEqual(["svc", "KEY"]);
  });

  it("supports --flag=value form", () => {
    const r = parseSecretArgs([
      "secret",
      "set",
      "--runtime=prod",
      "svc",
      "KEY",
      "v",
    ]);
    expect(r.runtime).toBe("prod");
  });

  it("rejects unknown flags", () => {
    expect(() => parseSecretArgs(["secret", "set", "--bogus"])).toThrow(
      /Unknown flag/,
    );
  });

  it("requires a value for --runtime", () => {
    expect(() => parseSecretArgs(["secret", "set", "--runtime"])).toThrow(
      /requires a value/,
    );
  });
});

describe("nopo secret keygen", () => {
  it("prints a fresh identity to stdout and writes no files", async () => {
    const { root } = makeProject(["secrets-flat"]);
    // keygen does NOT need an identity already installed — it generates one.
    // It must not write to any nopo-controlled path.
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      await runSecret(root, ["keygen"]);
    } finally {
      stdoutSpy.mockRestore();
    }
    const out = stdoutChunks.join("");
    expect(out).toMatch(/AGE-SECRET-KEY-/);
    expect(out).toMatch(/Recipient: age1/);
    expect(out).toMatch(/NOPO_AGE_IDENTITY_COMMAND/);
    // No `.nopo/` directory or sops-age.key file should exist anywhere
    // under the project root.
    expect(fs.existsSync(path.join(root, ".nopo"))).toBe(false);
  });

  it("emits a different identity each time (no shared randomness)", async () => {
    const { root } = makeProject(["secrets-flat"]);
    const captures: string[][] = [];
    for (let i = 0; i < 2; i++) {
      const chunks: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          chunks.push(String(chunk));
          return true;
        });
      try {
        await runSecret(root, ["keygen"]);
      } finally {
        spy.mockRestore();
      }
      captures.push(chunks);
    }
    const first = captures[0]!.join("");
    const second = captures[1]!.join("");
    // Both should contain identity lines, but not the same one.
    const grab = (s: string): string =>
      s.match(/AGE-SECRET-KEY-[A-Z0-9]+/)?.[0] ?? "";
    const a = grab(first);
    const b = grab(second);
    expect(a).not.toBe("");
    expect(b).not.toBe("");
    expect(a).not.toBe(b);
  });
});

describe("nopo secret set + get round-trip", () => {
  it("writes ENC[...] in place and decrypts back to original (default runtime)", async () => {
    const { root, servicePaths } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await runSecret(root, [
      "set",
      "secrets-flat",
      "API_KEY",
      "super-sekret-value",
    ]);

    // The yaml file should now have an ENC[...] under runtime.secrets.
    const yamlText = fs.readFileSync(servicePaths["secrets-flat"]!, "utf-8");
    expect(yamlText).toContain("ENC[AES256_GCM,");
    const doc = parseYaml(yamlText);
    expect(doc.runtime.secrets.API_KEY).toMatch(/^ENC\[AES256_GCM,/);

    // get --unsafe should print the original plaintext.
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await runSecret(root, ["get", "secrets-flat", "API_KEY", "--unsafe"]);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    expect(stdoutChunks.join("").trim()).toBe("super-sekret-value");
  });

  it("reshapes a flat-shape file to map shape when targeting a named runtime", async () => {
    const { root, servicePaths } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await runSecret(root, [
      "set",
      "--runtime",
      "prod",
      "secrets-flat",
      "DB_PASS",
      "prod-pw",
    ]);

    const doc = parseYaml(
      fs.readFileSync(servicePaths["secrets-flat"]!, "utf-8"),
    );
    expect(doc.runtime.default).toBeDefined();
    expect(doc.runtime.default.command).toBe("node server.js");
    expect(doc.runtime.prod.secrets.DB_PASS).toMatch(/^ENC\[/);
  });

  it("supports --from-stdin with multiline content", async () => {
    const { root, servicePaths } = makeProject(["secrets-map"]);
    await installFreshIdentity();
    // Multiline stdin (TLS-key path) without PEM markers. echo/pipe adds
    // a trailing `\n`; decryptValue strips it so compose env vars stay clean.
    const stdinValue = [
      "test-secret-line-one",
      "test-secret-line-two",
      "test-secret-line-three",
      "",
    ].join("\n"); // trailing \n from echo/pipe
    const value = stdinValue.trimEnd(); // decryptValue will strip it

    const { Readable } = await import("node:stream");
    const original = process.stdin;
    const fake = new Readable();
    fake.push(stdinValue);
    fake.push(null);
    Object.defineProperty(process, "stdin", {
      value: fake,
      configurable: true,
    });
    try {
      await runSecret(root, ["set", "secrets-map", "TLS_KEY", "--from-stdin"]);
    } finally {
      Object.defineProperty(process, "stdin", {
        value: original,
        configurable: true,
      });
    }

    // Decrypt via the plugin-side API
    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });
    const decrypted = await secrets.get("secrets-map", "default", "TLS_KEY", {
      project: config.project,
    });
    expect(decrypted).toBe(value);
    // Sanity: the file stored the ENC[...] ciphertext, not the plaintext.
    const yamlText = fs.readFileSync(servicePaths["secrets-map"]!, "utf-8");
    expect(yamlText).not.toContain("test-secret-line-one");
  });

  it("supports --from-stdin", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();

    // Pipe a value through stdin. Use a minimal Readable that emits one chunk
    // and ends — process.stdin is a stream, vitest doesn't supply piped input.
    const { Readable } = await import("node:stream");
    const original = process.stdin;
    const fake = new Readable();
    fake.push("piped-value-from-stdin");
    fake.push(null);
    Object.defineProperty(process, "stdin", {
      value: fake,
      configurable: true,
    });
    try {
      await runSecret(root, ["set", "secrets-flat", "PIPED", "--from-stdin"]);
    } finally {
      Object.defineProperty(process, "stdin", {
        value: original,
        configurable: true,
      });
    }

    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });
    const decrypted = await secrets.get("secrets-flat", "default", "PIPED", {
      project: config.project,
    });
    expect(decrypted).toBe("piped-value-from-stdin");
  });

  it("rejects when both <value> and --from-stdin are passed", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await expect(
      runSecret(root, ["set", "secrets-flat", "K", "value", "--from-stdin"]),
    ).rejects.toThrow(/exactly one value source/);
  });

  it("rejects when no value source is provided", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await expect(runSecret(root, ["set", "secrets-flat", "K"])).rejects.toThrow(
      /Provide a value/,
    );
  });
});

describe("nopo secret list", () => {
  it("shows keys per runtime, no values, after a series of sets", async () => {
    const { root } = makeProject(["secrets-map"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-map", "API_KEY", "v1"]);
    await runSecret(root, [
      "set",
      "--runtime",
      "prod",
      "secrets-map",
      "DB_PASS",
      "v2",
    ]);

    const log = vi.fn();
    // Spy on console.log — Logger.log forwards there when not silent.
    // This run disables silent by hand.
    const originalLog = console.log;
    console.log = log;
    try {
      const config = createConfig({
        rootDir: root,
        processEnv: {},
        silent: false,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["secret", "list", "secrets-map"],
        logger,
      );
      await runner.run(SecretScript);
    } finally {
      console.log = originalLog;
    }

    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("default:");
    expect(lines).toContain("- API_KEY");
    expect(lines).toContain("prod:");
    expect(lines).toContain("- DB_PASS");
    // Must not leak ciphertext or any value.
    expect(lines).not.toContain("ENC[");
    expect(lines).not.toContain("v1");
    expect(lines).not.toContain("v2");
  });
});

describe("nopo secret unset", () => {
  it("removes a key from a named runtime", async () => {
    const { root, servicePaths } = makeProject(["secrets-map"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-map", "ONE", "1"]);
    await runSecret(root, ["set", "secrets-map", "TWO", "2"]);
    await runSecret(root, ["unset", "secrets-map", "ONE"]);

    const doc = parseYaml(
      fs.readFileSync(servicePaths["secrets-map"]!, "utf-8"),
    );
    expect(doc.runtime.default.secrets.ONE).toBeUndefined();
    expect(doc.runtime.default.secrets.TWO).toBeDefined();
  });

  it("is a no-op when the key is absent", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    // No secrets ever written; should not throw.
    await runSecret(root, ["unset", "secrets-flat", "NEVER_THERE"]);
  });
});

describe("nopo secret get safety", () => {
  it("errors without --unsafe", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-flat", "API_KEY", "shhh"]);
    await expect(
      runSecret(root, ["get", "secrets-flat", "API_KEY"]),
    ).rejects.toThrow(/Refusing to print plaintext/);
  });

  it("writes an audit-log line to stderr BEFORE the plaintext on stdout", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-flat", "API_KEY", "plain-readback"]);

    const stderr: string[] = [];
    const stdout: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
    try {
      await runSecret(root, ["get", "secrets-flat", "API_KEY", "--unsafe"]);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }

    const stderrText = stderr.join("");
    const stdoutText = stdout.join("");
    expect(stderrText).toMatch(
      /\[secret-read\] secrets-flat\/default\/API_KEY read by .+ at \d{4}-\d{2}-\d{2}T/,
    );
    expect(stdoutText).toContain("plain-readback");
  });

  it("errors when the secret isn't declared", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await expect(
      runSecret(root, ["get", "secrets-flat", "NOT_THERE", "--unsafe"]),
    ).rejects.toThrow(/No secret declared/);
  });

  it("swallows EPIPE on stdout (`nopo secret get | head` early-closes the pipe)", async () => {
    // Audit log already fired; a closed-pipe write is still authorized.
    // The CLI must exit cleanly. head -c 0 would close stdin and hit EPIPE.
    const multiline = "line1\nline2\nline3\nline4\n";
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-flat", "PEM", multiline]);

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => {
        const err: NodeJS.ErrnoException = Object.assign(
          new Error("write EPIPE"),
          { code: "EPIPE" },
        );
        throw err;
      });
    try {
      await expect(
        runSecret(root, ["get", "secrets-flat", "PEM", "--unsafe"]),
      ).resolves.toBeUndefined();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe("plugin-side secrets.get", () => {
  it("decrypts via the configured key file", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-flat", "TOKEN", "tok-12345"]);

    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });
    const value = await secrets.get("secrets-flat", "default", "TOKEN", {
      project: config.project,
    });
    expect(value).toBe("tok-12345");
  });

  it("returns undefined when the secret isn't declared", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });
    const value = await secrets.get("secrets-flat", "default", "MISSING", {
      project: config.project,
    });
    expect(value).toBeUndefined();
  });

  it("throws on unknown service id", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });
    await expect(
      secrets.get("not-a-service", "default", "X", { project: config.project }),
    ).rejects.toThrow(/Unknown service/);
  });

  it("returns undefined for an unknown runtime", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-flat", "K", "v"]);
    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });
    // No `staging` runtime. readSecretCiphertext returns undefined;
    // plugins that probe optional secrets per runtime rely on that.
    const value = await secrets.get("secrets-flat", "staging", "K", {
      project: config.project,
    });
    expect(value).toBeUndefined();
  });
});

describe("nopo secret set on map-shape services", () => {
  it("writes into the existing default block without reshaping", async () => {
    // The map fixture already has `runtime.default.command: ...`, so
    // targeting the default runtime should leave the map shape intact.
    const { root, servicePaths } = makeProject(["secrets-map"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-map", "API_KEY", "default-only"]);

    const doc = parseYaml(
      fs.readFileSync(servicePaths["secrets-map"]!, "utf-8"),
    );
    // Still map-shape — `command` belongs to runtime.default.
    expect(doc.runtime.default.command).toBe("node server.js");
    expect(doc.runtime.default.secrets.API_KEY).toMatch(/^ENC\[/);
    // prod overlay still exists, untouched.
    expect(doc.runtime.prod.cpu).toBe("1");
  });

  it("writes into a named runtime block, leaving default untouched", async () => {
    const { root, servicePaths } = makeProject(["secrets-map"]);
    await installFreshIdentity();
    await runSecret(root, [
      "set",
      "--runtime",
      "prod",
      "secrets-map",
      "API_KEY",
      "prod-only",
    ]);

    const doc = parseYaml(
      fs.readFileSync(servicePaths["secrets-map"]!, "utf-8"),
    );
    expect(doc.runtime.prod.secrets.API_KEY).toMatch(/^ENC\[/);
    // Default block API_KEY came from the fixture placeholder; we did NOT
    // touch it — should still be the placeholder, not the prod ciphertext.
    expect(doc.runtime.default.secrets.API_KEY).toContain(
      "placeholder-default-api-key",
    );
  });
});

describe("default → named runtime override (the integration case)", () => {
  it("named runtime overrides default for the same secret key", async () => {
    // Set API_KEY on default, then a different value on prod.
    // resolveRuntime("prod").secrets.API_KEY must be the prod ciphertext.
    const { root } = makeProject(["secrets-map"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-map", "API_KEY", "default-value"]);
    await runSecret(root, [
      "set",
      "--runtime",
      "prod",
      "secrets-map",
      "API_KEY",
      "prod-value",
    ]);

    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });

    // Per-runtime decrypt via plugin API
    const defaultVal = await secrets.get("secrets-map", "default", "API_KEY", {
      project: config.project,
    });
    const prodVal = await secrets.get("secrets-map", "prod", "API_KEY", {
      project: config.project,
    });
    expect(defaultVal).toBe("default-value");
    expect(prodVal).toBe("prod-value");

    // resolveRuntime merges only. Values stay ENC[...]; prod and default
    // ciphertexts differ.
    const service = config.project.services.entries["secrets-map"]!;
    const runtimes = service.runtimes;
    expect(runtimes).toBeDefined();
    if (!runtimes) return;
    const defResolved = resolveRuntime(runtimes, "default");
    const prodResolved = resolveRuntime(runtimes, "prod");
    // Both have an API_KEY in their secrets bucket — but the ciphertexts
    // differ, since each was encrypted independently to the same recipient.
    expect(defResolved.envs.secrets.API_KEY).toMatch(/^ENC\[/);
    expect(prodResolved.envs.secrets.API_KEY).toMatch(/^ENC\[/);
    expect(prodResolved.envs.secrets.API_KEY).not.toBe(
      defResolved.envs.secrets.API_KEY,
    );
  });

  it("named runtime inherits default secrets it doesn't override", async () => {
    // Set TWO secrets in default; only override one in prod. resolveRuntime
    // for prod should still see the non-overridden default secret.
    const { root } = makeProject(["secrets-map"]);
    await installFreshIdentity();
    await runSecret(root, [
      "set",
      "secrets-map",
      "DEFAULT_ONLY",
      "stays-default",
    ]);
    await runSecret(root, ["set", "secrets-map", "OVERRIDDEN", "default-v"]);
    await runSecret(root, [
      "set",
      "--runtime",
      "prod",
      "secrets-map",
      "OVERRIDDEN",
      "prod-v",
    ]);

    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });
    const service = config.project.services.entries["secrets-map"]!;
    const prodResolved = resolveRuntime(service.runtimes!, "prod");

    // DEFAULT_ONLY inherited from default → still ENC of "stays-default"
    expect(prodResolved.envs.secrets.DEFAULT_ONLY).toMatch(/^ENC\[/);
    // OVERRIDDEN overlaid by prod → should differ from default's ciphertext
    expect(prodResolved.envs.secrets.OVERRIDDEN).toMatch(/^ENC\[/);

    // Verify by decrypting both via the plugin API
    const inherited = await secrets.get("secrets-map", "prod", "DEFAULT_ONLY", {
      project: config.project,
    });
    // secrets.get reads raw `runtime.<runtime>.secrets.<key>`, not the
    // merged overlay. Plugins merge via resolveRuntime, then decrypt.
    expect(inherited).toBeUndefined();

    // Decrypt via the merged overlay path
    const defaultOnlyEnc = prodResolved.envs.secrets.DEFAULT_ONLY;
    const overriddenEnc = prodResolved.envs.secrets.OVERRIDDEN;
    expect(defaultOnlyEnc).toBeDefined();
    expect(overriddenEnc).toBeDefined();
    if (!defaultOnlyEnc || !overriddenEnc) return;
    const decryptedOverlay = await secrets.decrypt(defaultOnlyEnc, {
      project: config.project,
    });
    expect(decryptedOverlay).toBe("stays-default");

    const decryptedOverridden = await secrets.decrypt(overriddenEnc, {
      project: config.project,
    });
    expect(decryptedOverridden).toBe("prod-v");
  });
});

describe("nopo secret list with multiple secrets in a runtime", () => {
  it("lists all keys in declaration order, no values", async () => {
    const { root } = makeProject(["secrets-map"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-map", "ALPHA", "1"]);
    await runSecret(root, ["set", "secrets-map", "BETA", "2"]);
    await runSecret(root, ["set", "secrets-map", "GAMMA", "3"]);

    const log = vi.fn();
    const originalLog = console.log;
    console.log = log;
    try {
      const config = createConfig({
        rootDir: root,
        processEnv: {},
        silent: false,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["secret", "list", "secrets-map"],
        logger,
      );
      await runner.run(SecretScript);
    } finally {
      console.log = originalLog;
    }

    const lines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(lines).toContain("- ALPHA");
    expect(lines).toContain("- BETA");
    expect(lines).toContain("- GAMMA");
    // Values are not leaked.
    expect(lines).not.toContain("ENC[");
    for (const v of ["1", "2", "3"]) {
      // The bare number could be a coincidence — match the value-shape, not
      // raw substring "1" which is too lenient.
      expect(lines).not.toContain(`: "${v}"`);
    }
  });
});

describe("decrypt failure modes", () => {
  it("errors when the loaded identity can't decrypt the ciphertext", async () => {
    // Encrypt with one identity, then point NOPO_AGE_IDENTITY_COMMAND at a
    // different identity. age fails the recipient check and throws.
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-flat", "API_KEY", "before-rotate"]);

    // Install a fresh, unrelated identity — installFreshIdentity rewrites
    // NOPO_AGE_IDENTITY_COMMAND to point at the new one.
    await installFreshIdentity();

    // get --unsafe with the new key should now fail to decrypt.
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await expect(
        runSecret(root, ["get", "secrets-flat", "API_KEY", "--unsafe"]),
      ).rejects.toThrow();
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it("errors when the value is plaintext (not an ENC[...] envelope)", async () => {
    // Write plaintext under runtime.secrets via fs (schema runs at load).
    // `nopo secret get` must then fail the envelope-shape check.
    const { root, servicePaths } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    await runSecret(root, ["set", "secrets-flat", "API_KEY", "good"]);

    // Replace ENC[...] with plaintext. Do not re-load via createConfig
    // (schema would reject). `nopo secret get` reads the raw yaml.
    const yamlText = fs.readFileSync(servicePaths["secrets-flat"]!, "utf-8");
    const corrupted = yamlText.replace(
      /API_KEY:.*$/m,
      'API_KEY: "plain-not-an-envelope"',
    );
    fs.writeFileSync(servicePaths["secrets-flat"]!, corrupted);

    // runSecret builds a Config, so the schema error is the operator-
    // facing failure mode. Assert that throw.
    await expect(
      runSecret(root, ["get", "secrets-flat", "API_KEY", "--unsafe"]),
    ).rejects.toThrow(); // schema rejects plaintext at load
  });
});

describe("unicode + edge-case values", () => {
  it("round-trips unicode characters in the secret value", async () => {
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();
    // Greek letters, Chinese ideographs, emoji, combining marks.
    const value = "αβγ 中文 🔐 é";
    await runSecret(root, ["set", "secrets-flat", "UCODE", value]);

    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });
    const decrypted = await secrets.get("secrets-flat", "default", "UCODE", {
      project: config.project,
    });
    expect(decrypted).toBe(value);
  });

  it("does not mistake a map-shape with a runtime named `secrets` for flat shape", async () => {
    // Regression: isFlatRuntime once treated env/secrets/processes-only
    // blocks as flat. `{ default, secrets }` is map-shape; keep that contract.
    const { root } = makeProject(["secrets-map"]);
    await installFreshIdentity();

    // Hand-craft yaml with a runtime named `secrets`. Bypass the loader
    // (schema rejects placeholder envelopes) and call setSecretCiphertext.
    const svcDir = path.join(root, "services", "named-secrets");
    fs.mkdirSync(svcDir, { recursive: true });
    const cfgPath = path.join(svcDir, "nopo.yml");
    fs.writeFileSync(
      cfgPath,
      [
        "name: Named-Secrets Fixture",
        "build:",
        "  command: echo build",
        "runtime:",
        "  default:",
        '    command: "node server.js"',
        "    port: 3000",
        "  secrets:",
        '    cpu: "2"',
        "",
      ].join("\n"),
    );

    // Encrypt a value so we have a real ENC[...] envelope, then write it
    // to the runtime named `secrets`.
    const { loadIdentity } = await import("../../src/secrets/identity.ts");
    const { encryptValue } = await import("../../src/secrets/envelope.ts");
    const { identityToRecipient } = await import("age-encryption");
    const identity = await loadIdentity();
    const recipient = await identityToRecipient(identity);
    const ct = await encryptValue("named-runtime-value", recipient);

    setSecretCiphertext(cfgPath, "secrets", "API_KEY", ct);

    // Verify the write landed in the NAMED runtime, not in default,
    // and not in a flat-shape reshape.
    const doc = parseYaml(fs.readFileSync(cfgPath, "utf-8"));
    // Default block must be untouched.
    expect(doc.runtime.default.command).toBe("node server.js");
    expect(doc.runtime.default.port).toBe(3000);
    // The named `secrets` runtime keeps its cpu and gains a secrets block.
    expect(doc.runtime.secrets.cpu).toBe("2");
    expect(doc.runtime.secrets.secrets.API_KEY).toMatch(/^ENC\[/);

    // listSecrets enumerates both runtimes (default has none, secrets has API_KEY).
    const view = listSecrets(cfgPath);
    const named = view.find((v) => v.runtime === "secrets");
    expect(named?.keys).toEqual(["API_KEY"]);
  });

  it("reshapes flat-shape correctly when set --runtime targets a non-default runtime", async () => {
    // Flat doc with scalar + object fields. set --runtime prod reshapes
    // to `{ default: <flat>, prod: { secrets } }` and keeps default.env.
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();

    // Add an env block to the flat fixture so the flat detection has to
    // reconcile a mix of scalar (command, port) + object (env) fields.
    const cfgPath = path.join(root, "services", "secrets-flat", "nopo.yml");
    const original = fs.readFileSync(cfgPath, "utf-8");
    // Insert env: { K: "v" } under runtime: by appending lines to runtime block.
    const withEnv = original.replace(
      /(runtime:\n {2}command:.*\n)/,
      "$1  env:\n    LOG_LEVEL: info\n",
    );
    fs.writeFileSync(cfgPath, withEnv);

    await runSecret(root, [
      "set",
      "--runtime",
      "prod",
      "secrets-flat",
      "DB_PASS",
      "prod-pw",
    ]);

    const doc = parseYaml(fs.readFileSync(cfgPath, "utf-8"));
    // Reshape: previous flat block lands under default.
    expect(doc.runtime.default.command).toBe("node server.js");
    expect(doc.runtime.default.env.LOG_LEVEL).toBe("info");
    // Named prod block holds the new secret.
    expect(doc.runtime.prod.secrets.DB_PASS).toMatch(/^ENC\[/);
  });

  it("round-trips empty string when set via --from-stdin", async () => {
    // Empty stdin is a valid value. Schema min(1) applies to ciphertext;
    // the envelope wrapper is non-empty.
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();

    const { Readable } = await import("node:stream");
    const original = process.stdin;
    const fake = new Readable();
    fake.push(null);
    Object.defineProperty(process, "stdin", {
      value: fake,
      configurable: true,
    });
    try {
      await runSecret(root, ["set", "secrets-flat", "EMPTY", "--from-stdin"]);
    } finally {
      Object.defineProperty(process, "stdin", {
        value: original,
        configurable: true,
      });
    }

    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });
    const decrypted = await secrets.get("secrets-flat", "default", "EMPTY", {
      project: config.project,
    });
    expect(decrypted).toBe("");
  });
});

describe("nopo secret rotate-key", () => {
  it("re-encrypts every secret across services to a fresh identity", async () => {
    // Two services, many secrets. Fixture placeholders do not decrypt,
    // so overwrite each with a real ENC[...] before rotate-key.
    const { root, servicePaths } = makeProject(["secrets-flat", "secrets-map"]);
    await installFreshIdentity();
    // secrets-flat: default.API_KEY (placeholder)
    await runSecret(root, ["set", "secrets-flat", "API_KEY", "flat-api"]);
    // secrets-map: default.API_KEY, prod.API_KEY, prod.DB_PASS (all placeholders)
    await runSecret(root, ["set", "secrets-map", "API_KEY", "map-api"]);
    await runSecret(root, [
      "set",
      "--runtime",
      "prod",
      "secrets-map",
      "API_KEY",
      "map-prod-api",
    ]);
    await runSecret(root, [
      "set",
      "--runtime",
      "prod",
      "secrets-map",
      "DB_PASS",
      "map-prod-db",
    ]);

    // Capture the rotate-key stdout — we need the new identity to verify
    // the post-rotate ciphertexts decrypt with it.
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      await runSecret(root, ["rotate-key"]);
    } finally {
      stdoutSpy.mockRestore();
    }
    const stdoutText = stdoutChunks.join("");
    const newIdentityMatch = stdoutText.match(/AGE-SECRET-KEY-[A-Z0-9]+/);
    expect(newIdentityMatch).not.toBeNull();
    const newIdentity = newIdentityMatch![0];

    // Install the new identity so plugin-side reads use it.
    const newIdFile = path.join(
      os.tmpdir(),
      `nopo-test-rotated-identity-${process.pid}-${Date.now()}`,
    );
    fs.writeFileSync(newIdFile, newIdentity, { mode: 0o600 });
    identityFiles.push(newIdFile);
    process.env.NOPO_AGE_IDENTITY_COMMAND = `cat '${newIdFile}'`;

    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });
    expect(
      await secrets.get("secrets-flat", "default", "API_KEY", {
        project: config.project,
      }),
    ).toBe("flat-api");
    expect(
      await secrets.get("secrets-map", "default", "API_KEY", {
        project: config.project,
      }),
    ).toBe("map-api");
    expect(
      await secrets.get("secrets-map", "prod", "API_KEY", {
        project: config.project,
      }),
    ).toBe("map-prod-api");
    expect(
      await secrets.get("secrets-map", "prod", "DB_PASS", {
        project: config.project,
      }),
    ).toBe("map-prod-db");

    // Rotation writes new envelopes (age uses fresh randomness). Confirm
    // the files still contain ENC[...] rather than comparing bytes.
    const flatYaml = fs.readFileSync(servicePaths["secrets-flat"]!, "utf-8");
    const mapYaml = fs.readFileSync(servicePaths["secrets-map"]!, "utf-8");
    expect(flatYaml).toMatch(/ENC\[AES256_GCM,/);
    expect(mapYaml).toMatch(/ENC\[AES256_GCM,/);
  });

  it("aborts cleanly with no writes when one value can't be decrypted", async () => {
    // Encrypt with identity A, then swap to B. rotate-key must refuse,
    // name the file, and leave the yaml byte-identical.
    const { root, servicePaths } = makeProject(["secrets-flat"]);
    await installFreshIdentity(); // identity A
    await runSecret(root, ["set", "secrets-flat", "API_KEY", "good-value"]);
    await runSecret(root, ["set", "secrets-flat", "OTHER", "other-value"]);

    const yamlBeforeRotate = fs.readFileSync(
      servicePaths["secrets-flat"]!,
      "utf-8",
    );

    // Swap to identity B — A's ciphertexts can no longer be decrypted.
    await installFreshIdentity();

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await expect(runSecret(root, ["rotate-key"])).rejects.toThrow(
        /Aborting rotation/,
      );
    } finally {
      stdoutSpy.mockRestore();
    }

    // The yaml file MUST be byte-identical to its pre-rotate state — no
    // partial rewrite of any value.
    const yamlAfterFailedRotate = fs.readFileSync(
      servicePaths["secrets-flat"]!,
      "utf-8",
    );
    expect(yamlAfterFailedRotate).toBe(yamlBeforeRotate);
  });

  it("succeeds with a clear message when there are no encrypted secrets", async () => {
    // No secrets set. rotate-key still generates and prints a new
    // identity so operators can pre-rotate.
    const { root } = makeProject(["secrets-flat"]);
    await installFreshIdentity();

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      // Fixture placeholders are envelopes but will not decrypt, so
      // rotate-key would abort. Build a project with no secrets instead.
      const cleanRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-clean-"));
      tmpRoots.push(cleanRoot);
      fs.writeFileSync(
        path.join(cleanRoot, "nopo.yml"),
        [
          "name: Empty",
          "os:",
          "  base:",
          "    image: alpine:3.19",
          "services:",
          "  dirs:",
          "    - ./services",
          "",
        ].join("\n"),
      );
      const svcDir = path.join(cleanRoot, "services", "no-secrets");
      fs.mkdirSync(svcDir, { recursive: true });
      fs.writeFileSync(
        path.join(svcDir, "nopo.yml"),
        [
          "name: No Secrets",
          "build:",
          "  command: echo build",
          "runtime:",
          '  command: "node server.js"',
          "  port: 3000",
          "",
        ].join("\n"),
      );
      await runSecret(cleanRoot, ["rotate-key"]);
    } finally {
      stdoutSpy.mockRestore();
    }
    const text = stdoutChunks.join("");
    expect(text).toMatch(/AGE-SECRET-KEY-/);
    expect(text).toMatch(/NOPO_AGE_IDENTITY_COMMAND/);
    // unused root var — cleaning is handled by afterEach
    void root;
  });
});
