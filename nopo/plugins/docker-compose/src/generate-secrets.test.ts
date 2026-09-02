/** Covers the W3 #5 contract: - service with `runtime.default.secrets.X: ENC[...]` produces a compose
 * document where `services.<svc>.environment.X` is the plaintext - default→named runtime override
 * flow: named overlay's encrypted value wins under `--runtime <name>`, default's wins under default -
 * decrypt failure (corrupt envelope) aborts compose-gen with a clear error naming the service + key -
 */
import { generateIdentity, identityToRecipient } from "age-encryption";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedService } from "@more-nopo/nopo/config";
import type { Runner } from "@more-nopo/nopo/lib";
import { encryptValue } from "@more-nopo/nopo/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";

import {
  generateComposeFile,
  REDACTED_PLACEHOLDER,
  writeRedactedComposeFile,
} from "./generate.ts";

/** ============================================================================
 * Test fixtures (subset of the helpers in generate.test.ts — kept local so
 * this file is self-contained)
 * ============================================================================
 */

/**
 * RuntimeBlock has `secrets` typed as `Record<string, string>`. We use a
 * view that allows us to attach raw runtimes maps with secrets blocks
 * without redeclaring the full Zod-derived shape.
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
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub provides the subset of Runner that generateComposeFile accesses
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

/**
 * Materialize a fresh age keypair, write the identity to a tmpfile that
 * lives OUTSIDE any project root, and point NOPO_AGE_IDENTITY_COMMAND at
 * `cat <file>`. Returns the public recipient so tests can encrypt values.
 */
async function installFreshIdentity(): Promise<string> {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const tmpFile = path.join(
    os.tmpdir(),
    `nopo-test-identity-${process.pid}-${identityFiles.length}-${Date.now()}`,
  );
  fs.writeFileSync(tmpFile, identity, { mode: 0o600 });
  identityFiles.push(tmpFile);
  process.env.NOPO_AGE_IDENTITY_COMMAND = `cat '${tmpFile}'`;
  return recipient;
}

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-compose-secret-"));
  tmpRoots.push(root);
  return root;
}

function getEnvMap(
  parsed: ReturnType<typeof yamlParse>,
  service: string,
): Record<string, string> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- YAML is parsed to plain objects
  const root = parsed as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const svc = root.services?.[service];
  if (!svc) throw new Error(`service "${service}" missing from compose doc`);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- YAML is parsed to plain objects
  return (svc.environment ?? {}) as Record<string, string>;
}

describe("compose generation: runtime-overlay secrets", () => {
  it("decrypts ENC[...] secrets into the compose environment block", async () => {
    const recipient = await installFreshIdentity();
    const root = makeProjectRoot();

    const apiKeyCipher = await encryptValue("sk-real-secret-value", recipient);

    const services = {
      "af-api": makeService("af-api", {
        default: {
          command: "bun run src/index.ts",
          port: 3001,
          cpu: "1",
          memory: "512Mi",
          replicas: 1,
          secrets: { ANTHROPIC_API_KEY: apiKeyCipher },
        },
      }),
    };

    const runner = makeRunner(services, root);
    const yaml = await generateComposeFile(runner, "default");
    const parsed = yamlParse(yaml);
    const envVars = getEnvMap(parsed, "af-api");

    expect(envVars.ANTHROPIC_API_KEY).toBe("sk-real-secret-value");
    // The original ENC[...] envelope must NOT appear anywhere in the
    // generated YAML — that would mean the ciphertext leaked verbatim.
    expect(yaml).not.toMatch(/ENC\[/);
  });

  it("default→named runtime override picks the named runtime's secret", async () => {
    const recipient = await installFreshIdentity();
    const root = makeProjectRoot();

    const defaultCipher = await encryptValue("default-value", recipient);
    const prodCipher = await encryptValue("prod-value", recipient);

    const services = {
      "af-api": makeService("af-api", {
        default: {
          command: "bun run src/index.ts",
          port: 3001,
          cpu: "1",
          memory: "512Mi",
          replicas: 1,
          secrets: { K: defaultCipher },
        },
        prod: {
          secrets: { K: prodCipher },
        },
      }),
    };

    const runner = makeRunner(services, root);

    const defYaml = await generateComposeFile(runner, "default");
    const prodYaml = await generateComposeFile(runner, "prod");

    expect(getEnvMap(yamlParse(defYaml), "af-api").K).toBe("default-value");
    expect(getEnvMap(yamlParse(prodYaml), "af-api").K).toBe("prod-value");
  });

  it("inherits the default secret when a named overlay omits it", async () => {
    /** If `prod` doesn't override key K but `default.secrets.K` is set,
     * resolveRuntime carries the default value through and the plugin
     * decrypts it. Same encrypted blob, same plaintext.
     */
    const recipient = await installFreshIdentity();
    const root = makeProjectRoot();

    const cipher = await encryptValue("inherited-default", recipient);

    const services = {
      "af-api": makeService("af-api", {
        default: {
          command: "bun run src/index.ts",
          port: 3001,
          cpu: "1",
          memory: "512Mi",
          replicas: 1,
          secrets: { K: cipher },
        },
        prod: {
          // No secrets override — K should still appear, decrypted.
          replicas: 3,
        },
      }),
    };

    const runner = makeRunner(services, root);
    const yaml = await generateComposeFile(runner, "prod");
    expect(getEnvMap(yamlParse(yaml), "af-api").K).toBe("inherited-default");
  });

  it("aborts compose-gen with a service+key-tagged error on decrypt failure", async () => {
    await installFreshIdentity();
    const root = makeProjectRoot();

    // Tamper the ciphertext: build a structurally-valid envelope using a
    // DIFFERENT recipient so this identity can't unwrap the data key.
    const otherIdentity = await generateIdentity();
    const otherRecipient = await identityToRecipient(otherIdentity);
    const tamperedCipher = await encryptValue(
      "wont-be-readable",
      otherRecipient,
    );

    const services = {
      "af-api": makeService("af-api", {
        default: {
          command: "bun run src/index.ts",
          port: 3001,
          cpu: "1",
          memory: "512Mi",
          replicas: 1,
          secrets: { BROKER_KEK: tamperedCipher },
        },
      }),
    };

    const runner = makeRunner(services, root);

    await expect(generateComposeFile(runner, "default")).rejects.toThrow(
      /Failed to decrypt secret "BROKER_KEK" for service "af-api"/,
    );
  });

  it("redact mode replaces every runtime secret with [REDACTED]", async () => {
    /** Critical security property: redact mode must NEVER spawn the
     * operator's identity command. We delete NOPO_AGE_IDENTITY_COMMAND
     * entirely to prove it — generation must still succeed.
     */
    delete process.env.NOPO_AGE_IDENTITY_COMMAND;
    const root = makeProjectRoot();

    /** We can author the fixture envelope as opaque content because
     * redact mode never decrypts it. Use a fresh recipient just for
     * realism (the plugin's isEnvelope check is structural).
     */
    const tmpIdentity = await generateIdentity();
    const tmpRecipient = await identityToRecipient(tmpIdentity);
    const cipher = await encryptValue("plaintext-never-seen", tmpRecipient);

    const services = {
      "af-api": makeService("af-api", {
        default: {
          command: "bun run src/index.ts",
          port: 3001,
          cpu: "1",
          memory: "512Mi",
          replicas: 1,
          env: { LOG_LEVEL: "info" },
          secrets: { ANTHROPIC_API_KEY: cipher },
        },
      }),
    };

    const runner = makeRunner(services, root);
    const yaml = await generateComposeFile(runner, "default", {
      secretMode: "redact",
    });
    const envVars = getEnvMap(yamlParse(yaml), "af-api");

    // Secrets are redacted; env values pass through verbatim.
    expect(envVars.ANTHROPIC_API_KEY).toBe(REDACTED_PLACEHOLDER);
    expect(envVars.LOG_LEVEL).toBe("info");
    // Plaintext must not appear anywhere.
    expect(yaml).not.toContain("plaintext-never-seen");
    // Envelope must not appear either — redact replaces the whole value.
    expect(yaml).not.toMatch(/ENC\[/);
  });

  it("non-envelope secret values pass through verbatim under decrypt mode", async () => {
    /** Some `secrets:` entries may carry shell-substitution placeholders
     * (e.g., during local-dev migration) rather than ENC[...] envelopes.
     * The generator should not try to decrypt those — pass them through.
     */
    await installFreshIdentity();
    const root = makeProjectRoot();

    const services = {
      "af-api": makeService("af-api", {
        default: {
          command: "bun run src/index.ts",
          port: 3001,
          cpu: "1",
          memory: "512Mi",
          replicas: 1,
          /** Not an ENC[...] — would normally fail RuntimeSecretsSchema, but
           * the resolver layer doesn't validate post-merge. Plugin must
           * still gracefully pass it through rather than throw.
           */
          secrets: { LOCAL_PASSWORD: "${LOCAL_PASSWORD:-dev}" },
        },
      }),
    };

    const runner = makeRunner(services, root);
    const yaml = await generateComposeFile(runner, "default");
    expect(getEnvMap(yamlParse(yaml), "af-api").LOCAL_PASSWORD).toBe(
      "${LOCAL_PASSWORD:-dev}",
    );
  });

  it("writeRedactedComposeFile produces a file that contains [REDACTED] but no plaintext", async () => {
    // The only sanctioned on-disk path. Decrypted plaintext must NEVER
    // land in this file — that's the whole point of the redacted helper.
    delete process.env.NOPO_AGE_IDENTITY_COMMAND;
    const root = makeProjectRoot();

    const tmpIdentity = await generateIdentity();
    const tmpRecipient = await identityToRecipient(tmpIdentity);
    const cipher = await encryptValue("must-not-touch-disk", tmpRecipient);

    const services = {
      "af-api": makeService("af-api", {
        default: {
          command: "bun run src/index.ts",
          port: 3001,
          cpu: "1",
          memory: "512Mi",
          replicas: 1,
          env: { LOG_LEVEL: "info" },
          secrets: { K: cipher },
        },
      }),
    };

    const runner = makeRunner(services, root);
    const composePath = await writeRedactedComposeFile(runner, "default");

    // Path is under .nopo/docker-compose/ inside the project root.
    expect(composePath).toBe(
      path.join(root, ".nopo", "docker-compose", "docker-compose.yml"),
    );

    const fileContent = fs.readFileSync(composePath, "utf-8");
    expect(fileContent).toContain(REDACTED_PLACEHOLDER);
    expect(fileContent).toContain("LOG_LEVEL: info");
    expect(fileContent).not.toContain("must-not-touch-disk");
    expect(fileContent).not.toMatch(/ENC\[/);
  });

  it("generateComposeFile (decrypt mode) does not write to .nopo/docker-compose/", async () => {
    /** The runtime path generates the document in memory and pipes it to
     * docker compose via stdin. Verify nothing leaks to disk during
     * generation: the cache file should not exist after a generate call.
     */
    const recipient = await installFreshIdentity();
    const root = makeProjectRoot();

    const cipher = await encryptValue("never-on-disk", recipient);

    const services = {
      "af-api": makeService("af-api", {
        default: {
          command: "bun run src/index.ts",
          port: 3001,
          cpu: "1",
          memory: "512Mi",
          replicas: 1,
          secrets: { K: cipher },
        },
      }),
    };

    const runner = makeRunner(services, root);
    await generateComposeFile(runner, "default");

    const expectedPath = path.join(
      root,
      ".nopo",
      "docker-compose",
      "docker-compose.yml",
    );
    expect(fs.existsSync(expectedPath)).toBe(false);
  });
});
