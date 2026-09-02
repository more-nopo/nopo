import type { NormalizedService } from "@more-nopo/nopo/config";
import type { Runner } from "@more-nopo/nopo/lib";
import { describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";

import { generateComposeFile } from "./generate.ts";

/** Test-fixture authoring shape. Mirrors the trimmed
 * `NormalizedServiceRuntime` view but also accepts a `dev` shell command
 * that the helper materializes as a `runtimes.dev` overlay (the way real
 * services declare hot-reload commands).
 */
type FixtureRuntime = NormalizedService["runtime"] & {
  /** Optional dev hot-reload command. Materialized as a `dev:` runtime overlay. */
  dev?: string;
};

function makeService(
  overrides: Omit<Partial<NormalizedService>, "runtime"> & {
    id: string;
    runtime?: FixtureRuntime;
  },
): NormalizedService {
  /** Synthesize a `runtimes` map from the legacy `runtime` view so the generator (which reads via
   * resolveRuntime) sees a stable overlay. Tests still author services as { runtime: { command, port,
   * ... } } — the synthesis keeps that authoring style working with the new plugin contract. Real config
   * loading does the same flat→`{ default }` wrap in normalizeRuntimeMap.
   */
  const runtimes = overrides.runtimes ?? synthesizeRuntimes(overrides.runtime);
  // Strip the fixture-only `dev` field before storing on `runtime` (the
  // trimmed `NormalizedServiceRuntime` no longer carries `dev`).
  const runtime = overrides.runtime
    ? (() => {
        const { dev: _dev, ...rest } = overrides.runtime;
        return rest;
      })()
    : undefined;
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    description: overrides.description ?? "",
    staticPath: overrides.staticPath ?? "",
    tags: overrides.tags ?? [],
    secrets: overrides.secrets ?? [],
    env: overrides.env,
    type: overrides.type ?? (overrides.runtime ? "service" : "package"),
    build: overrides.build,
    runtime,
    runtimes,
    configPath:
      overrides.configPath ?? `/project/services/${overrides.id}/nopo.yml`,
    image: overrides.image,
    buildDeps: overrides.buildDeps ?? [],
    runtimeDeps: overrides.runtimeDeps ?? [],
    systemDeps: overrides.systemDeps ?? [],
    commands: overrides.commands ?? {},
    paths: overrides.paths ?? {
      root: `/project/services/${overrides.id}`,
      context: "/project",
    },
    pluginData: overrides.pluginData,
    packageManagers: overrides.packageManagers ?? [],
  };
}

/** Map the trimmed NormalizedServiceRuntime into a RuntimeMap with a
 * `default` block (and optionally a `dev` overlay materialized from the
 * fixture-only `dev` shell command). Mirrors what RuntimeMapSchema would
 * produce for an autoWrapRuntime'd flat shape.
 */
function synthesizeRuntimes(
  runtime: FixtureRuntime | undefined,
): NonNullable<NormalizedService["runtimes"]> | undefined {
  if (!runtime) return undefined;
  const out: NonNullable<NormalizedService["runtimes"]> = {
    default: {
      command: runtime.command,
      pre_command: runtime.preCommand,
      post_command: runtime.postCommand,
      port: runtime.port,
      cpu: runtime.cpu,
      memory: runtime.memory,
      /** RuntimeMap.default is DefaultRuntimeBlock — `replicas` is
       * required post-transform. The legacy NormalizedServiceRuntime
       * never carried it, so default to 1 (matches DefaultRuntimeBlockSchema).
       */
      replicas: 1,
      deps: runtime.deps,
    },
  };
  if (runtime.dev) {
    out.dev = { command: runtime.dev };
  }
  return out;
}

type DockerTarget = "development" | "production" | "test" | "base" | "build";
type NodeEnv = "development" | "production" | "test";

function makeRunner(
  services: Record<string, NormalizedService>,
  envOverrides: Partial<{
    DOCKER_TAG: string;
    DOCKER_REGISTRY: string;
    DOCKER_IMAGE: string;
    DOCKER_VERSION: string;
    DOCKER_TARGET: DockerTarget;
    DOCKER_PORT: string;
  }> = {},
  resolvedTargets: string[] | null = null,
  stderrWrites: string[] = [],
): Runner {
  const env: {
    DOCKER_PORT: string;
    DOCKER_TAG: string;
    DOCKER_REGISTRY: string;
    DOCKER_IMAGE: string;
    DOCKER_VERSION: string;
    DOCKER_DIGEST: string;
    DOCKER_TARGET: DockerTarget;
    GIT_REPO: string;
    GIT_BRANCH: string;
    GIT_COMMIT: string;
    NODE_ENV: NodeEnv;
  } = {
    DOCKER_PORT: "80",
    DOCKER_TAG: "example/app:local",
    DOCKER_REGISTRY: "",
    DOCKER_IMAGE: "example/app",
    DOCKER_VERSION: "local",
    DOCKER_DIGEST: "",
    DOCKER_TARGET: "development",
    GIT_REPO: "example/app",
    GIT_BRANCH: "main",
    GIT_COMMIT: "abc123",
    NODE_ENV: "development",
    ...envOverrides,
  };

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub provides the subset of Runner that generateComposeFile accesses
  return {
    config: {
      root: "/project",
      project: {
        name: "test-project",
        configPath: "/project/nopo.yml",
        os: {
          base: { from: "node:22.16.0-slim" },
          dependencies: {},
          user: { uid: 1001, gid: 1001, home: "/home/nopoapp" },
        },
        services: {
          dirs: ["/project/services"],
          entries: services,
          targets: Object.keys(services),
        },
        rootName: "root",
        pluginRefs: [],
        plugins: [],
        packageManagers: {},
      },
      envFile: "/project/.env",
      processEnv: {},
      silent: false,
      targets: Object.keys(services),
    },
    environment: {
      env,
      processEnv: {},
      extraEnv: {},
    },
    io: {
      stdout: { write: () => true },
      stderr: {
        write: (chunk: string) => {
          stderrWrites.push(chunk);
          return true;
        },
      },
    },
    getResolvedTargets: () => resolvedTargets,
  } as unknown as Runner;
}

/** Type-safe accessor for parsed YAML services */
function getService(
  parsed: ReturnType<typeof yamlParse>,
  name: string,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped; narrowing via runtime check
  const services = (parsed as Record<string, unknown>).services as Record<
    string,
    Record<string, unknown>
  >;
  const svc = services[name];
  if (!svc) throw new Error(`Service "${name}" not found in generated YAML`);
  return svc;
}

/** Get the environment object from a parsed service */
function getEnvVars(svc: Record<string, unknown>): Record<string, string> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime type from YAML parsing
  return (svc.environment ?? {}) as Record<string, string>;
}

/** Get all service names from parsed YAML */
function getServiceNames(parsed: ReturnType<typeof yamlParse>): string[] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped
  const obj = parsed as Record<string, Record<string, unknown>>;
  return Object.keys(obj.services ?? {});
}

/** Get top-level YAML field */
function getField(parsed: ReturnType<typeof yamlParse>, key: string): unknown {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped
  const obj = parsed as Record<string, unknown>;
  return obj[key];
}

async function parseGenerated(
  runner: Runner,
  runtimeName: string = "default",
): Promise<ReturnType<typeof yamlParse>> {
  const yaml = await generateComposeFile(runner, runtimeName, {
    /** Default tests don't exercise the decrypt path; redact mode keeps
     * them deterministic and side-effect free (no NOPO_AGE_IDENTITY_COMMAND
     * spawn). Tests that do exercise decryption pass `secretMode: "decrypt"`
     * explicitly.
     */
    secretMode: "redact",
  });
  return yamlParse(yaml);
}

describe("generateComposeFile", () => {
  it("generates a basic service with runtime config", async () => {
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          dev: "bun run --hot src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
        env: { DATABASE_URL: "postgres://nopo:nopo@db:5432/nopo" },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-api");
    const envVars = getEnvVars(svc);

    // Dev mode + dev overlay declared → uses base image with bind-mount.
    expect(svc.image).toBe("example/app:local");
    expect(svc.pull_policy).toBe("never");
    expect(envVars.SERVICE_NAME).toBe("af-api");
    expect(envVars.PORT).toBe("3001");
    expect(envVars.DATABASE_URL).toBe("postgres://nopo:nopo@db:5432/nopo");
    // Dev mode: should use dev command
    expect(svc.command).toBe("bun run --hot src/index.ts");
    // Default healthcheck
    expect(svc.healthcheck).toEqual({
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"],
      interval: "20s",
      timeout: "10s",
      retries: 3,
      start_period: "30s",
    });
  });

  it("uses production command when DOCKER_TARGET is production", async () => {
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          dev: "bun run --hot src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
      }),
    };

    const runner = makeRunner(services, { DOCKER_TARGET: "production" });
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-api");

    expect(svc.command).toBe("bun run src/index.ts");
  });

  it("generates external image services (e.g., db)", async () => {
    const services = {
      db: makeService({
        id: "db",
        image: "pgvector/pgvector:pg16",
        runtime: {
          cpu: "1",
          memory: "512Mi",
          port: 5432,
          deps: [],
        },
        pluginData: {
          "docker-compose": {
            environment: {
              POSTGRES_DB: "nopo",
              POSTGRES_USER: "nopo",
              POSTGRES_PASSWORD: "nopo",
            },
            volumes: ["data_postgres:/var/lib/postgresql/data"],
            healthcheck: {
              test: ["CMD-SHELL", "pg_isready -U nopo -d nopo"],
              interval: "10s",
              timeout: "5s",
              retries: 5,
              start_period: "10s",
            },
          },
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "db");
    const envVars = getEnvVars(svc);

    // External images should use the image directly
    expect(svc.image).toBe("pgvector/pgvector:pg16");
    // Should NOT have pull_policy: never (external image needs pull)
    expect(svc.pull_policy).toBeUndefined();
    // Plugin config should override env
    expect(envVars.POSTGRES_DB).toBe("nopo");
    // Plugin healthcheck
    expect(svc.healthcheck).toEqual({
      test: ["CMD-SHELL", "pg_isready -U nopo -d nopo"],
      interval: "10s",
      timeout: "5s",
      retries: 5,
      start_period: "10s",
    });
    // Plugin volumes
    expect(svc.volumes).toContain("data_postgres:/var/lib/postgresql/data");
    // Named volume should be declared at top level
    expect(getField(parsed, "volumes")).toHaveProperty("data_postgres");
  });

  it("generates depends_on from runtimeDeps", async () => {
    const services = {
      db: makeService({
        id: "db",
        image: "pgvector/pgvector:pg16",
        runtime: {
          cpu: "1",
          memory: "512Mi",
          port: 5432,
          deps: [],
        },
        pluginData: {
          "docker-compose": {
            healthcheck: {
              test: ["CMD-SHELL", "pg_isready -U nopo"],
              interval: "5s",
              timeout: "5s",
              retries: 5,
              start_period: "10s",
            },
          },
        },
      }),
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          dev: "bun run --hot src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: ["db"],
        },
        runtimeDeps: ["db"],
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-api");

    expect(svc.depends_on).toEqual({
      db: { condition: "service_healthy" },
    });
  });

  it("does not propagate systemDeps into compose depends_on", async () => {
    /** Regression: project-level system_deps (e.g. `nopo`, `root`) are discovery-only edges and live on
     * `service.systemDeps`, NOT on buildDeps/runtimeDeps. The docker-compose plugin must keep ignoring
     * them — turning them into compose `depends_on:` entries produces "service X depends on undefined
     * service Y" errors at compose-up because the system dep target has no container.
     */
    const services = {
      db: makeService({
        id: "db",
        image: "pgvector/pgvector:pg16",
        runtime: {
          cpu: "1",
          memory: "512Mi",
          port: 5432,
          deps: [],
        },
        pluginData: {
          "docker-compose": {
            healthcheck: {
              test: ["CMD-SHELL", "pg_isready -U nopo"],
              interval: "5s",
              timeout: "5s",
              retries: 5,
              start_period: "10s",
            },
          },
        },
      }),
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          dev: "bun run --hot src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: ["db"],
        },
        runtimeDeps: ["db"],
        // System deps that are NOT runnable as compose services.
        systemDeps: ["nopo", "root"],
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-api");

    expect(svc.depends_on).toEqual({
      db: { condition: "service_healthy" },
    });
    expect(svc.depends_on).not.toHaveProperty("nopo");
    expect(svc.depends_on).not.toHaveProperty("root");
  });

  it("excludes package-only services (no runtime, no image)", async () => {
    const services = {
      configs: makeService({
        id: "configs",
        type: "package",
        build: { command: "bunx tsc", deps: [] },
      }),
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const serviceNames = getServiceNames(parsed);

    expect(serviceNames).toContain("af-api");
    expect(serviceNames).toContain("base"); // base utility service in dev
    expect(serviceNames).not.toContain("configs");
  });

  it("only includes target services when resolvedTargets is set", async () => {
    const services = {
      db: makeService({
        id: "db",
        image: "pgvector/pgvector:pg16",
        runtime: {
          cpu: "1",
          memory: "512Mi",
          port: 5432,
          deps: [],
        },
      }),
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: ["db"],
        },
        runtimeDeps: ["db"],
      }),
      "af-web": makeService({
        id: "af-web",
        runtime: {
          command: "bunx react-router-serve",
          cpu: "0.5",
          memory: "256Mi",
          port: 3000,
          deps: ["af-api"],
        },
        runtimeDeps: ["af-api"],
      }),
    };

    // Resolved targets only include af-api and db (not af-web)
    const runner = makeRunner(services, {}, ["af-api", "db"]);
    const parsed = await parseGenerated(runner);
    const serviceNames = getServiceNames(parsed);

    expect(serviceNames).toContain("af-api");
    expect(serviceNames).toContain("db");
    expect(serviceNames).toContain("base"); // base is always added in dev
    expect(serviceNames).not.toContain("af-web");
  });

  it("includes the base utility service in development mode", async () => {
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const base = getService(parsed, "base");

    expect(base).toBeDefined();
    expect(base.image).toBe("example/app:local");
    expect(base.pull_policy).toBe("never");
    expect(base.command).toEqual(["sleep", "infinity"]);
  });

  it("does not include base service in production mode", async () => {
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
      }),
    };

    const runner = makeRunner(services, { DOCKER_TARGET: "production" });
    const parsed = await parseGenerated(runner);
    const serviceNames = getServiceNames(parsed);

    expect(serviceNames).not.toContain("base");
  });

  it("passes through secrets as env var references", async () => {
    const services = {
      "af-api": makeService({
        id: "af-api",
        secrets: [{ name: "ANTHROPIC_API_KEY" }, { name: "OPENAI_API_KEY" }],
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-api");
    const envVars = getEnvVars(svc);

    expect(envVars.ANTHROPIC_API_KEY).toBe("${ANTHROPIC_API_KEY:-}");
    expect(envVars.OPENAI_API_KEY).toBe("${OPENAI_API_KEY:-}");
  });

  it("uses the declared test value as the shell default for secrets", async () => {
    const services = {
      "af-api": makeService({
        id: "af-api",
        secrets: [
          {
            name: "DATABASE_URL",
            test: "postgres://test:test@db:5432/test",
          },
          {
            name: "BETTER_AUTH_SECRET",
            test: "test-better-auth-secret-minimum-32-characters-long",
          },
        ],
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-api");
    const envVars = getEnvVars(svc);

    expect(envVars.DATABASE_URL).toBe(
      "${DATABASE_URL:-postgres://test:test@db:5432/test}",
    );
    expect(envVars.BETTER_AUTH_SECRET).toBe(
      "${BETTER_AUTH_SECRET:-test-better-auth-secret-minimum-32-characters-long}",
    );
  });

  it("adds custom ports from plugin config", async () => {
    const services = {
      "af-nginx": makeService({
        id: "af-nginx",
        runtime: {
          cpu: "0.25",
          memory: "64Mi",
          port: 80,
          deps: [],
        },
        pluginData: {
          "docker-compose": {
            ports: ["${AF_PORT:-8080}:80"],
          },
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-nginx");

    expect(svc.ports).toEqual(["${AF_PORT:-8080}:80"]);
  });

  it("adds custom volumes from plugin config (e.g., docker socket)", async () => {
    const services = {
      "af-run": makeService({
        id: "af-run",
        runtime: {
          command: "bun run src/index.ts",
          dev: "bun run --hot src/index.ts",
          cpu: "0.5",
          memory: "256Mi",
          port: 8080,
          deps: [],
        },
        pluginData: {
          "docker-compose": {
            volumes: ["/var/run/docker.sock:/var/run/docker.sock"],
            environment: {
              RUNNER_PROVIDER: "docker",
            },
          },
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-run");
    const envVars = getEnvVars(svc);

    expect(svc.volumes).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(envVars.RUNNER_PROVIDER).toBe("docker");
  });

  it("passes through a multi-process dev command verbatim", async () => {
    /** Multi-process dev workflows (e.g. Django + Vite together) are now
     * expressed in the dev overlay's single `command:` string using shell
     * operators — the generator no longer joins arrays with `&`.
     */
    const services = {
      backend: makeService({
        id: "backend",
        runtime: {
          command: "uv run gunicorn",
          dev: "uv run python manage.py runserver 0.0.0.0:80 & bunx --bun vite --host --port 5173 & wait",
          cpu: "1",
          memory: "512Mi",
          port: 3000,
          deps: [],
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "backend");

    expect(svc.command).toBe(
      "uv run python manage.py runserver 0.0.0.0:80 & bunx --bun vite --host --port 5173 & wait",
    );
  });

  it("includes default network configuration", async () => {
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);

    expect(getField(parsed, "networks")).toEqual({
      default: {
        driver: "bridge",
        enable_ipv6: false,
      },
    });
  });

  it("adds header comment to generated output", async () => {
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
      }),
    };

    const runner = makeRunner(services);
    const yaml = await generateComposeFile(runner, "default", {
      secretMode: "redact",
    });

    expect(yaml).toMatch(/^# Generated by nopo docker-compose plugin/);
  });

  it("emits one compose entry per process for a multi-process service", async () => {
    // af-api style: processes.web (port 3001) + processes.worker (no port).
    // Expect compose services `af-api-web` and `af-api-worker`.
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          cpu: "1",
          memory: "512Mi",
          // Runtime-level port unused by the multi-process path — each process
          // declares its own — but kept to satisfy NormalizedServiceRuntime.
          port: 3000,
          deps: [],
          processes: {
            web: {
              name: "web",
              command: "bun run src/index.ts",
              preCommand: "bunx drizzle-kit migrate",
              cpu: "1",
              memory: "512Mi",
              port: 3001,
              minInstances: 1,
              maxInstances: 1,
              deps: [],
            },
            worker: {
              name: "worker",
              command: "bun run src/worker.ts",
              cpu: "0.5",
              memory: "512Mi",
              port: undefined,
              minInstances: 1,
              maxInstances: 1,
              deps: [],
            },
          },
        },
        runtimeDeps: ["db"],
      }),
      db: makeService({
        id: "db",
        image: "pgvector/pgvector:pg16",
        runtime: {
          cpu: "1",
          memory: "512Mi",
          port: 5432,
          deps: [],
        },
        pluginData: {
          "docker-compose": {
            healthcheck: {
              test: ["CMD-SHELL", "pg_isready -U nopo"],
              interval: "5s",
              timeout: "5s",
              retries: 5,
              start_period: "10s",
            },
          },
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const serviceNames = getServiceNames(parsed);

    // Both processes should be emitted — no bare `af-api`
    expect(serviceNames).toContain("af-api-web");
    expect(serviceNames).toContain("af-api-worker");
    expect(serviceNames).not.toContain("af-api");
  });

  it("routes the web process command and port correctly", async () => {
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          cpu: "1",
          memory: "512Mi",
          // Runtime-level port unused by the multi-process path — each process
          // declares its own — but kept to satisfy NormalizedServiceRuntime.
          port: 3000,
          deps: [],
          processes: {
            web: {
              name: "web",
              command: "bun run src/index.ts",
              preCommand: "bunx drizzle-kit migrate",
              cpu: "1",
              memory: "512Mi",
              port: 3001,
              minInstances: 1,
              maxInstances: 1,
              deps: [],
            },
            worker: {
              name: "worker",
              command: "bun run src/worker.ts",
              cpu: "0.5",
              memory: "512Mi",
              port: undefined,
              minInstances: 1,
              maxInstances: 1,
              deps: [],
            },
          },
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const webSvc = getService(parsed, "af-api-web");
    const workerSvc = getService(parsed, "af-api-worker");
    const webEnv = getEnvVars(webSvc);
    const workerEnv = getEnvVars(workerSvc);

    // web process: has pre_command + command → sh -c form
    expect(webSvc.command).toEqual([
      "sh",
      "-c",
      "bunx drizzle-kit migrate && bun run src/index.ts",
    ]);
    // web process has PORT
    expect(webEnv.PORT).toBe("3001");
    // web process has a healthcheck
    expect(webSvc.healthcheck).toEqual({
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"],
      interval: "20s",
      timeout: "10s",
      retries: 3,
      start_period: "30s",
    });

    // worker process: just the command, no port
    expect(workerSvc.command).toBe("bun run src/worker.ts");
    // worker does NOT get PORT
    expect(workerEnv.PORT).toBeUndefined();
    // worker does NOT get a healthcheck
    expect(workerSvc.healthcheck).toBeUndefined();
  });

  it("applies per-process plugin environment overrides", async () => {
    // Simulate plugins.docker-compose.processes.web.environment in nopo.yml
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          cpu: "1",
          memory: "512Mi",
          // Runtime-level port unused by the multi-process path — each process
          // declares its own — but kept to satisfy NormalizedServiceRuntime.
          port: 3000,
          deps: [],
          processes: {
            web: {
              name: "web",
              command: "bun run src/index.ts",
              cpu: "1",
              memory: "512Mi",
              port: 3001,
              minInstances: 1,
              maxInstances: 1,
              deps: [],
            },
            worker: {
              name: "worker",
              command: "bun run src/worker.ts",
              cpu: "0.5",
              memory: "512Mi",
              port: undefined,
              minInstances: 1,
              maxInstances: 1,
              deps: [],
            },
          },
        },
        pluginData: {
          "docker-compose": {
            processes: {
              web: {
                environment: {
                  BETTER_AUTH_URL: "http://localhost:8080",
                },
              },
            },
          },
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const webEnv = getEnvVars(getService(parsed, "af-api-web"));
    const workerEnv = getEnvVars(getService(parsed, "af-api-worker"));

    // web process gets BETTER_AUTH_URL
    expect(webEnv.BETTER_AUTH_URL).toBe("http://localhost:8080");
    // worker process does NOT get BETTER_AUTH_URL
    expect(workerEnv.BETTER_AUTH_URL).toBeUndefined();
  });

  it("single-process services remain zero-diff (default process → bare service id)", async () => {
    // Ensure single-process services still emit under their original id
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          dev: "bun run --hot src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const serviceNames = getServiceNames(parsed);

    // Single-process services keep the bare id
    expect(serviceNames).toContain("af-api");
    expect(serviceNames).not.toContain("af-api-default");
    // And still have the right command (dev mode)
    const svc = getService(parsed, "af-api");
    expect(svc.command).toBe("bun run --hot src/index.ts");
  });

  it("rejects per-process volume map (Blocker 3 guard)", async () => {
    /** If a service mistakenly writes `volumes: { web: [...] }` in
     * plugins.docker-compose, the generator must throw a clear error
     * rather than hitting `TypeError: {} is not iterable` at runtime.
     */
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
        pluginData: {
          "docker-compose": {
            // Intentionally wrong shape — object instead of array
            volumes: { web: ["/var/run/docker.sock:/var/run/docker.sock"] },
          },
        },
      }),
    };

    const runner = makeRunner(services);
    await expect(parseGenerated(runner)).rejects.toThrow(
      /plugins\.docker-compose\.volumes for service "af-api" must be a flat list/,
    );
  });

  it("translates runtime.healthcheck into the compose healthcheck block", async () => {
    /** New unified schema: runtime.<env>.healthcheck declared with the five-field shape
     * (exec/interval/timeout/retries/delay). The plugin must translate it 1:1 into the compose healthcheck
     * block: exec -> test: ["CMD", ...] delay -> start_period
     */
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
        runtimes: {
          default: {
            command: "bun run src/index.ts",
            cpu: "1",
            memory: "512Mi",
            port: 3001,
            replicas: 1,
            healthcheck: {
              type: "exec",
              exec: ["curl", "-f", "http://localhost:3001/health/readiness"],
              interval: "10s",
              timeout: "5s",
              retries: 5,
              delay: "30s",
            },
          },
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-api");

    expect(svc.healthcheck).toEqual({
      test: ["CMD", "curl", "-f", "http://localhost:3001/health/readiness"],
      interval: "10s",
      timeout: "5s",
      retries: 5,
      start_period: "30s",
    });
  });

  it("emits a deprecation warning when plugins.docker-compose.healthcheck is used (no runtime.healthcheck override)", async () => {
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
        pluginData: {
          "docker-compose": {
            healthcheck: {
              test: ["CMD", "curl", "-f", "http://localhost:3001/old/path"],
              interval: "20s",
              timeout: "10s",
              retries: 3,
              start_period: "30s",
            },
          },
        },
      }),
    };

    const writes: string[] = [];
    const runner = makeRunner(services, {}, null, writes);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-api");
    // Legacy compose block still produces a working healthcheck so
    // existing services keep deploying while migrations land.
    expect(svc.healthcheck).toEqual({
      test: ["CMD", "curl", "-f", "http://localhost:3001/old/path"],
      interval: "20s",
      timeout: "10s",
      retries: 3,
      start_period: "30s",
    });

    const warning = writes.join("");
    expect(warning).toMatch(/deprecation/);
    expect(warning).toMatch(/af-api/);
    expect(warning).toMatch(/runtime\.<env>\.healthcheck:/);
  });

  it("prefers runtime.healthcheck over the legacy plugins.docker-compose.healthcheck", async () => {
    // Both shapes declared: the unified shape wins, the legacy stays
    // accessible only for services that haven't migrated yet.
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
        runtimes: {
          default: {
            command: "bun run src/index.ts",
            cpu: "1",
            memory: "512Mi",
            port: 3001,
            replicas: 1,
            healthcheck: {
              type: "exec",
              exec: ["curl", "-f", "http://localhost:3001/new"],
              interval: "5s",
              timeout: "2s",
              retries: 2,
              delay: "1s",
            },
          },
        },
        pluginData: {
          "docker-compose": {
            healthcheck: {
              test: ["CMD", "curl", "-f", "http://localhost:3001/old"],
              interval: "20s",
              timeout: "10s",
              retries: 3,
              start_period: "30s",
            },
          },
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-api");

    expect(svc.healthcheck).toEqual({
      test: ["CMD", "curl", "-f", "http://localhost:3001/new"],
      interval: "5s",
      timeout: "2s",
      retries: 2,
      start_period: "1s",
    });
  });

  /** For images without curl/wget (e.g. litellm's upstream python:slim) the `type: http` healthcheck
   * bind-mounts a vendored static curl at /.probe and emits `test: ["CMD", "/.probe", "-fsS",
   * "--max-time", "<t>", "<url>"]`. Caller-side fallback: when `port` is omitted, the URL takes the
   * runtime's `process.port`.
   */

  it("translates runtime.healthcheck (type: http) into the compose healthcheck + bind-mount", async () => {
    const services = {
      litellm: makeService({
        id: "litellm",
        image: "ghcr.io/berriai/litellm:v1.83.14-stable",
        runtime: {
          cpu: "0.5",
          memory: "2Gi",
          port: 4000,
          deps: [],
        },
        runtimes: {
          default: {
            cpu: "0.5",
            memory: "2Gi",
            port: 4000,
            replicas: 1,
            healthcheck: {
              type: "http",
              path: "/health/readiness",
              port: 4000,
              interval: "10s",
              timeout: "5s",
              retries: 5,
              delay: "30s",
            },
          },
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "litellm");

    expect(svc.healthcheck).toEqual({
      test: [
        "CMD",
        "/.probe",
        "-fsS",
        "--max-time",
        "5",
        "http://localhost:4000/health/readiness",
      ],
      interval: "10s",
      timeout: "5s",
      retries: 5,
      start_period: "30s",
    });

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped
    const volumes = (svc.volumes ?? []) as string[];
    const probeMount = volumes.find((v) => v.includes(":/.probe:ro"));
    expect(probeMount).toBeDefined();
    // Default host path is nopo/bin/probe; this monorepo overrides via nopo.yml.
    expect(probeMount).toMatch(
      /nopo\/bin\/probe\/probe-linux-(amd64|arm64):\/\.probe:ro$/,
    );
  });

  it("type: http falls back to the runtime port when `port` is omitted", async () => {
    const services = {
      litellm: makeService({
        id: "litellm",
        image: "ghcr.io/berriai/litellm:v1.83.14-stable",
        runtime: {
          cpu: "0.5",
          memory: "2Gi",
          port: 4000,
          deps: [],
        },
        runtimes: {
          default: {
            cpu: "0.5",
            memory: "2Gi",
            port: 4000,
            replicas: 1,
            healthcheck: {
              type: "http",
              path: "/health/readiness",
              // no port: — must fall back to runtime port 4000
              interval: "10s",
              timeout: "5s",
              retries: 5,
              delay: "30s",
            },
          },
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "litellm");

    expect(svc.healthcheck).toEqual({
      test: [
        "CMD",
        "/.probe",
        "-fsS",
        "--max-time",
        "5",
        "http://localhost:4000/health/readiness",
      ],
      interval: "10s",
      timeout: "5s",
      retries: 5,
      start_period: "30s",
    });
  });

  it("type: http with explicit port overrides the runtime port", async () => {
    const services = {
      web: makeService({
        id: "web",
        image: "some-image:latest",
        runtime: {
          cpu: "0.5",
          memory: "256Mi",
          port: 3000,
          deps: [],
        },
        runtimes: {
          default: {
            cpu: "0.5",
            memory: "256Mi",
            port: 3000,
            replicas: 1,
            healthcheck: {
              type: "http",
              path: "/admin/health",
              port: 9090, // sidecar admin port — wins over runtime port
              interval: "10s",
              timeout: "5s",
              retries: 3,
              delay: "10s",
            },
          },
        },
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "web");

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML
    const test = (svc.healthcheck as { test: string[] }).test;
    expect(test).toContain("http://localhost:9090/admin/health");
  });

  it("uses service_started for deps without healthcheck", async () => {
    const services = {
      "af-api": makeService({
        id: "af-api",
        runtime: {
          command: "bun run src/index.ts",
          cpu: "1",
          memory: "512Mi",
          port: 3001,
          deps: [],
        },
      }),
      "af-web": makeService({
        id: "af-web",
        image: "some-external:latest",
        runtime: {
          cpu: "0.5",
          memory: "256Mi",
          port: 3000,
          deps: ["af-api"],
        },
        runtimeDeps: ["af-api"],
      }),
    };

    const runner = makeRunner(services);
    const parsed = await parseGenerated(runner);
    const svc = getService(parsed, "af-web");

    // af-api is a built service with a port, so it has a default healthcheck
    expect(svc.depends_on).toEqual({
      "af-api": { condition: "service_healthy" },
    });
  });

  describe("runtime.volumes — declarative persistent volumes", () => {
    /** The unified runtime.volumes schema is consumed by both deploy plugins. The compose plugin emits one
     * `<name>:<mountPath>` entry under the service's volumes list, and registers each entry under the
     * top-level `volumes:` block (the named-volume declaration). `size:` is ignored — docker named volumes
     * auto-grow.
     */

    it("emits one named-volume mount per runtime.volumes entry", async () => {
      const services = {
        sonar: makeService({
          id: "sonar",
          image: "sonarqube:10.6-community",
          runtime: {
            cpu: "1",
            memory: "1Gi",
            port: 9000,
            deps: [],
          },
          runtimes: {
            default: {
              port: 9000,
              cpu: "1",
              memory: "1Gi",
              replicas: 1,
              volumes: [
                { name: "data", mountPath: "/opt/sonarqube/data", size: "5Gi" },
                {
                  name: "extensions",
                  mountPath: "/opt/sonarqube/extensions",
                  size: "5Gi",
                },
              ],
            },
          },
        }),
      };

      const runner = makeRunner(services);
      const parsed = await parseGenerated(runner);
      const svc = getService(parsed, "sonar");

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped
      const vols = svc.volumes as string[];
      expect(vols).toContain("data:/opt/sonarqube/data");
      expect(vols).toContain("extensions:/opt/sonarqube/extensions");
    });

    it("registers each declared volume under the top-level volumes block", async () => {
      const services = {
        sonar: makeService({
          id: "sonar",
          image: "sonarqube:10.6-community",
          runtime: { cpu: "1", memory: "1Gi", port: 9000, deps: [] },
          runtimes: {
            default: {
              port: 9000,
              cpu: "1",
              memory: "1Gi",
              replicas: 1,
              volumes: [
                { name: "data", mountPath: "/opt/sonarqube/data", size: "5Gi" },
                {
                  name: "extensions",
                  mountPath: "/opt/sonarqube/extensions",
                  size: "5Gi",
                },
              ],
            },
          },
        }),
      };

      const runner = makeRunner(services);
      const parsed = await parseGenerated(runner);
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped
      const namedVolumes = getField(parsed, "volumes") as Record<
        string,
        unknown
      >;
      expect(namedVolumes).toHaveProperty("data");
      expect(namedVolumes).toHaveProperty("extensions");
    });

    it("size: is ignored — only name + mountPath surface in compose output", async () => {
      const services = {
        sonar: makeService({
          id: "sonar",
          image: "sonarqube:10.6-community",
          runtime: { cpu: "1", memory: "1Gi", port: 9000, deps: [] },
          runtimes: {
            default: {
              port: 9000,
              cpu: "1",
              memory: "1Gi",
              replicas: 1,
              volumes: [
                {
                  name: "data",
                  mountPath: "/opt/sonarqube/data",
                  size: "999Ti",
                },
              ],
            },
          },
        }),
      };

      const runner = makeRunner(services);
      const yaml = await generateComposeFile(runner, "default", {
        secretMode: "redact",
      });
      // Compose volumes are docker-named volumes (no quota); the `size:` value
      // never appears in compose YAML.
      expect(yaml).not.toContain("999Ti");
    });

    it("the existing plugins.docker-compose.volumes raw escape hatch keeps working", async () => {
      /** Both schemas can coexist on the same service: declarative volumes
       * emit named mounts; the raw plugin field still emits its host-path /
       * additional mounts verbatim. (No service does this in-tree today,
       * but the escape hatch must not regress.)
       */
      const services = {
        svc: makeService({
          id: "svc",
          image: "nginx:alpine",
          runtime: { cpu: "1", memory: "256Mi", port: 80, deps: [] },
          runtimes: {
            default: {
              port: 80,
              cpu: "1",
              memory: "256Mi",
              replicas: 1,
              volumes: [{ name: "data", mountPath: "/srv/data", size: "1Gi" }],
            },
          },
          pluginData: {
            "docker-compose": {
              volumes: ["/etc/ssl/certs:/etc/ssl/certs:ro"],
            },
          },
        }),
      };

      const runner = makeRunner(services);
      const parsed = await parseGenerated(runner);
      const svc = getService(parsed, "svc");
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped
      const vols = svc.volumes as string[];
      expect(vols).toContain("data:/srv/data");
      expect(vols).toContain("/etc/ssl/certs:/etc/ssl/certs:ro");
    });

    /** Host-mount mode: when `source` is set on a runtime.volumes entry, compose emits a bind-mount (NOT a
     * named volume). The bind-mount path is forwarded verbatim — compose resolves it against its working
     * directory (the project root) at startup. NO entry under the top-level `volumes:` block.
     */

    it("emits a bind-mount when `source` is set (host-mount mode)", async () => {
      const services = {
        db: makeService({
          id: "db",
          image: "pgvector/pgvector:pg16",
          runtime: { cpu: "1", memory: "512Mi", port: 5432, deps: [] },
          runtimes: {
            default: {
              port: 5432,
              cpu: "1",
              memory: "512Mi",
              replicas: 1,
              volumes: [
                {
                  name: "migrations",
                  mountPath: "/docker-entrypoint-initdb.d",
                  source: "./migrations",
                  readOnly: true,
                },
              ],
            },
          },
        }),
      };

      const runner = makeRunner(services);
      const parsed = await parseGenerated(runner);
      const svc = getService(parsed, "db");
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped
      const vols = svc.volumes as string[];
      expect(vols).toContain(
        "/project/services/db/migrations:/docker-entrypoint-initdb.d:ro",
      );
    });

    it("omits the `:ro` suffix when `readOnly` is false (host-mount mode)", async () => {
      const services = {
        db: makeService({
          id: "db",
          image: "pgvector/pgvector:pg16",
          runtime: { cpu: "1", memory: "512Mi", port: 5432, deps: [] },
          runtimes: {
            default: {
              port: 5432,
              cpu: "1",
              memory: "512Mi",
              replicas: 1,
              volumes: [
                {
                  name: "migrations",
                  mountPath: "/docker-entrypoint-initdb.d",
                  source: "./migrations",
                  readOnly: false,
                },
              ],
            },
          },
        }),
      };

      const runner = makeRunner(services);
      const parsed = await parseGenerated(runner);
      const svc = getService(parsed, "db");
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped
      const vols = svc.volumes as string[];
      expect(vols).toContain(
        "/project/services/db/migrations:/docker-entrypoint-initdb.d",
      );
      expect(vols).not.toContain(
        "/project/services/db/migrations:/docker-entrypoint-initdb.d:ro",
      );
    });

    it("does NOT register host-mount entries in the top-level volumes block", async () => {
      const services = {
        db: makeService({
          id: "db",
          image: "pgvector/pgvector:pg16",
          runtime: { cpu: "1", memory: "512Mi", port: 5432, deps: [] },
          runtimes: {
            default: {
              port: 5432,
              cpu: "1",
              memory: "512Mi",
              replicas: 1,
              volumes: [
                {
                  name: "migrations",
                  mountPath: "/docker-entrypoint-initdb.d",
                  source: "./migrations",
                  readOnly: true,
                },
              ],
            },
          },
        }),
      };

      const runner = makeRunner(services);
      const parsed = await parseGenerated(runner);
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped
      const rawVolumes = getField(parsed, "volumes") as
        | Record<string, unknown>
        | undefined;
      const namedVolumes = rawVolumes ?? {};
      expect(namedVolumes).not.toHaveProperty("migrations");
    });

    it("mixed-mode: PVC entry and host-mount entry coexist on one service", async () => {
      const services = {
        db: makeService({
          id: "db",
          image: "pgvector/pgvector:pg16",
          runtime: { cpu: "1", memory: "512Mi", port: 5432, deps: [] },
          runtimes: {
            default: {
              port: 5432,
              cpu: "1",
              memory: "512Mi",
              replicas: 1,
              volumes: [
                {
                  name: "data",
                  mountPath: "/var/lib/postgresql/data",
                  size: "5Gi",
                },
                {
                  name: "migrations",
                  mountPath: "/docker-entrypoint-initdb.d",
                  source: "./migrations",
                  readOnly: true,
                },
              ],
            },
          },
        }),
      };

      const runner = makeRunner(services);
      const parsed = await parseGenerated(runner);
      const svc = getService(parsed, "db");
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped
      const vols = svc.volumes as string[];
      // PVC entry: named volume mount
      expect(vols).toContain("data:/var/lib/postgresql/data");
      // host-mount entry: bind mount with :ro
      expect(vols).toContain(
        "/project/services/db/migrations:/docker-entrypoint-initdb.d:ro",
      );

      // Top-level volumes block: PVC entry registered, host-mount NOT.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsed YAML is untyped
      const namedVolumes = getField(parsed, "volumes") as Record<
        string,
        unknown
      >;
      expect(namedVolumes).toHaveProperty("data");
      expect(namedVolumes).not.toHaveProperty("migrations");
    });
  });
});
