/** Adversarial security tests for the docker-compose plugin's runtime overlay decrypt path. */
import { generateIdentity, identityToRecipient } from "age-encryption";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedService } from "@more-nopo/nopo/config";
import type { Runner } from "@more-nopo/nopo/lib";
import { encryptValue } from "@more-nopo/nopo/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";

import { generateComposeFile } from "./generate.ts";

/** ============================================================================
 * Local fixtures (mirrors generate-secrets.test.ts; kept self-contained so
 * the security suite stays runnable in isolation).
 * ============================================================================
 */

type RuntimeMapInput = NonNullable<NormalizedService["runtimes"]>;

function makeService(
  id: string,
  runtimes: RuntimeMapInput,
  extras: Partial<NormalizedService> = {},
): NormalizedService {
  return {
    id,
    name: extras.name ?? id,
    description: "",
    staticPath: "",
    tags: [],
    secrets: extras.secrets ?? [],
    env: extras.env,
    type: "service",
    build: undefined,
    runtime: undefined,
    runtimes,
    configPath: extras.configPath ?? `/project/services/${id}/nopo.yml`,
    image: extras.image,
    buildDeps: [],
    runtimeDeps: extras.runtimeDeps ?? [],
    systemDeps: [],
    commands: {},
    paths: {
      root: `/project/services/${id}`,
      context: "/project",
    },
    pluginData: extras.pluginData,
    packageManagers: [],
  };
}

function makeRunner(
  services: Record<string, NormalizedService>,
  rootDir: string,
): Runner {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
  return {
    config: {
      root: rootDir,
      project: {
        name: "test-project",
        configPath: `${rootDir}/nopo.yml`,
        os: {
          base: { from: "node:22.16.0-slim" },
          dependencies: {},
          user: { uid: 1001, gid: 1001, home: "/home/nopoapp" },
        },
        services: {
          dirs: [`${rootDir}/services`],
          entries: services,
          targets: Object.keys(services),
        },
        rootName: "root",
        pluginRefs: [],
        plugins: [],
        packageManagers: {},
      },
      envFile: `${rootDir}/.env`,
      processEnv: {},
      silent: false,
      targets: Object.keys(services),
    },
    environment: {
      env: {
        DOCKER_PORT: "80",
        DOCKER_TAG: "example/app:local",
        DOCKER_REGISTRY: "",
        DOCKER_IMAGE: "example/app",
        DOCKER_VERSION: "local",
        DOCKER_DIGEST: "",
        DOCKER_TARGET: "production",
        GIT_REPO: "example/app",
        GIT_BRANCH: "main",
        GIT_COMMIT: "abc123",
        NODE_ENV: "production",
      },
      processEnv: {},
      extraEnv: {},
    },
    io: {
      stdout: { write: () => true },
      stderr: { write: () => true },
    },
    getResolvedTargets: () => null,
  } as unknown as Runner;
}

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

async function installFreshIdentity(): Promise<string> {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const tmpFile = path.join(
    os.tmpdir(),
    `nopo-sec-test-identity-${process.pid}-${identityFiles.length}-${Date.now()}`,
  );
  fs.writeFileSync(tmpFile, identity, { mode: 0o600 });
  identityFiles.push(tmpFile);
  process.env.NOPO_AGE_IDENTITY_COMMAND = `cat '${tmpFile}'`;
  return recipient;
}

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-compose-sec-"));
  tmpRoots.push(root);
  return root;
}

/** Section 1: malicious secret KEY — an attacker who can author a runtime overlay tries to land a key
 * that breaks YAML scope when stringified or when echoed by docker-compose's stderr. Even though
 * `yaml@2` quotes the key safely, the resulting `docker compose` validation error includes the
 * offending env name in stderr, which the plugin re-throws as `cause`. Refuse at the source.
 */

describe("security: malicious secret key", () => {
  it("rejects a secret key containing a newline", async () => {
    const recipient = await installFreshIdentity();
    const root = makeProjectRoot();
    const cipher = await encryptValue("plaintext-irrelevant", recipient);

    const evilKey = "API_KEY\n  privileged: true\n  pid: host\n  X";
    const services = {
      svc: makeService("svc", {
        default: {
          command: "true",
          port: 80,
          cpu: "1",
          memory: "1Mi",
          replicas: 1,
          secrets: { [evilKey]: cipher },
        },
      }),
    };
    const runner = makeRunner(services, root);
    await expect(generateComposeFile(runner, "default")).rejects.toThrow(
      /invalid environment variable name/i,
    );
  });

  it("rejects a secret key with leading digit (not a POSIX env name)", async () => {
    const recipient = await installFreshIdentity();
    const root = makeProjectRoot();
    const cipher = await encryptValue("v", recipient);
    const services = {
      svc: makeService("svc", {
        default: {
          command: "true",
          port: 80,
          cpu: "1",
          memory: "1Mi",
          replicas: 1,
          secrets: { "1BAD": cipher },
        },
      }),
    };
    const runner = makeRunner(services, root);
    await expect(generateComposeFile(runner, "default")).rejects.toThrow(
      /invalid environment variable name/i,
    );
  });

  it("rejects a secret key containing a NUL byte", async () => {
    const recipient = await installFreshIdentity();
    const root = makeProjectRoot();
    const cipher = await encryptValue("v", recipient);
    const services = {
      svc: makeService("svc", {
        default: {
          command: "true",
          port: 80,
          cpu: "1",
          memory: "1Mi",
          replicas: 1,
          secrets: { "FOO\x00BAR": cipher },
        },
      }),
    };
    const runner = makeRunner(services, root);
    await expect(generateComposeFile(runner, "default")).rejects.toThrow(
      /invalid environment variable name/i,
    );
  });

  it("rejects a secret key with YAML-special leading char (`&`, `*`, `!`)", async () => {
    const recipient = await installFreshIdentity();
    const root = makeProjectRoot();
    const cipher = await encryptValue("v", recipient);
    const services = {
      svc: makeService("svc", {
        default: {
          command: "true",
          port: 80,
          cpu: "1",
          memory: "1Mi",
          replicas: 1,
          secrets: { "&PWN": cipher },
        },
      }),
    };
    const runner = makeRunner(services, root);
    await expect(generateComposeFile(runner, "default")).rejects.toThrow(
      /invalid environment variable name/i,
    );
  });

  it("redact mode also rejects bad keys (defense in depth — same YAML doc)", async () => {
    delete process.env.NOPO_AGE_IDENTITY_COMMAND;
    const root = makeProjectRoot();
    const tmpRecipient = await identityToRecipient(await generateIdentity());
    const cipher = await encryptValue("opaque", tmpRecipient);
    const services = {
      svc: makeService("svc", {
        default: {
          command: "true",
          port: 80,
          cpu: "1",
          memory: "1Mi",
          replicas: 1,
          secrets: { "BAD\nKEY": cipher },
        },
      }),
    };
    const runner = makeRunner(services, root);
    await expect(
      generateComposeFile(runner, "default", { secretMode: "redact" }),
    ).rejects.toThrow(/invalid environment variable name/i);
  });
});

/** Section 2: malicious VALUE — the key is fine, but the decrypted (or pass-through) value contains a
 * newline / control char. Even though `yaml@2` emits a block scalar that round-trips cleanly,
 * downstream `docker compose` may reject the manifest and echo the value verbatim. Reject newlines and
 * NUL in values; allow tabs and printable chars.
 */

describe("security: malicious env values", () => {
  it("rejects a decrypted secret value containing a newline", async () => {
    const recipient = await installFreshIdentity();
    const root = makeProjectRoot();
    // Encrypt a value that has a newline. Plugin must reject post-decrypt.
    const cipher = await encryptValue("ok\nprivileged: true", recipient);
    const services = {
      svc: makeService("svc", {
        default: {
          command: "true",
          port: 80,
          cpu: "1",
          memory: "1Mi",
          replicas: 1,
          secrets: { GOOD_KEY: cipher },
        },
      }),
    };
    const runner = makeRunner(services, root);
    await expect(generateComposeFile(runner, "default")).rejects.toThrow(
      /invalid environment variable value/i,
    );
  });

  it("rejects a non-envelope pass-through secret value with a NUL byte", async () => {
    await installFreshIdentity();
    const root = makeProjectRoot();
    const services = {
      svc: makeService("svc", {
        default: {
          command: "true",
          port: 80,
          cpu: "1",
          memory: "1Mi",
          replicas: 1,
          secrets: { GOOD_KEY: "v\x00pwn" },
        },
      }),
    };
    const runner = makeRunner(services, root);
    await expect(generateComposeFile(runner, "default")).rejects.toThrow(
      /invalid environment variable value/i,
    );
  });

  it("rejects a runtime.env value with a newline", async () => {
    await installFreshIdentity();
    const root = makeProjectRoot();
    const services = {
      svc: makeService("svc", {
        default: {
          command: "true",
          port: 80,
          cpu: "1",
          memory: "1Mi",
          replicas: 1,
          env: { LOG_LEVEL: "info\nprivileged: true" },
        },
      }),
    };
    const runner = makeRunner(services, root);
    await expect(generateComposeFile(runner, "default")).rejects.toThrow(
      /invalid environment variable value/i,
    );
  });

  it("accepts ordinary values with spaces, equals, slashes", async () => {
    const recipient = await installFreshIdentity();
    const root = makeProjectRoot();
    const cipher = await encryptValue("Bearer abc/def=123 xyz", recipient);
    const services = {
      svc: makeService("svc", {
        default: {
          command: "true",
          port: 80,
          cpu: "1",
          memory: "1Mi",
          replicas: 1,
          secrets: { TOKEN: cipher },
        },
      }),
    };
    const runner = makeRunner(services, root);
    const yaml = await generateComposeFile(runner, "default");
    const parsed = yamlParse(yaml);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- yaml is plain object
    const root2 = parsed as {
      services: Record<string, { environment: Record<string, string> }>;
    };
    const svc = root2.services.svc;
    if (!svc) throw new Error("svc missing");
    expect(svc.environment.TOKEN).toBe("Bearer abc/def=123 xyz");
  });
});

/** Section 3: error sanitization — when decryption fails, the plugin constructs an Error whose message
 * embeds `cause.message`.
 */

describe("security: error message sanitization", () => {
  it("decrypt-failure error does not echo the ENC[...] envelope", async () => {
    await installFreshIdentity();
    const root = makeProjectRoot();
    // Build a structurally-valid envelope using a different recipient
    // so the configured identity can't unwrap it.
    const otherRecipient = await identityToRecipient(await generateIdentity());
    const cipher = await encryptValue("the-plaintext", otherRecipient);
    const services = {
      svc: makeService("svc", {
        default: {
          command: "true",
          port: 80,
          cpu: "1",
          memory: "1Mi",
          replicas: 1,
          secrets: { TOK: cipher },
        },
      }),
    };
    const runner = makeRunner(services, root);
    await expect(generateComposeFile(runner, "default")).rejects.toThrow(
      /Failed to decrypt secret "TOK" for service "svc"/,
    );

    let captured: unknown;
    try {
      await generateComposeFile(runner, "default");
    } catch (e) {
      captured = e;
    }
    const msg = captured instanceof Error ? captured.message : String(captured);
    // The envelope itself must not be echoed.
    expect(msg).not.toContain(cipher);
    expect(msg).not.toContain("ENC[");
    // And of course no plaintext (we couldn't decrypt anyway here, but
    // assert it as a property).
    expect(msg).not.toContain("the-plaintext");
  });
});
