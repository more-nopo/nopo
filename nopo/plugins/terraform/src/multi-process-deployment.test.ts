import type {
  NormalizedProcess,
  NormalizedService,
  ResolvedRuntime,
} from "@more-nopo/nopo/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  deploymentName,
  type ServiceManifest,
  yamlDeployment,
  yamlService,
} from "./index.ts";

/** Two contracts are exercised: 1. Single-process services (the back-compat path) emit YAML that's
 * byte-identical to the legacy 1-Deployment-per-service shape, *with the documented exception of two
 * new pod labels* — `nopo.process: default` on the Deployment's pod template and the matching selector
 * entry.
 */

// ---- helpers ----

function makeProcess(overrides: Partial<NormalizedProcess>): NormalizedProcess {
  return {
    name: "default",
    cpu: "1",
    memory: "512Mi",
    minInstances: 1,
    maxInstances: 1,
    deps: [],
    ...overrides,
  };
}

function makeService(
  id: string,
  processes: Record<string, NormalizedProcess>,
): NormalizedService {
  const primary =
    processes.default ?? Object.values(processes)[0] ?? makeProcess({});
  const svc: Partial<NormalizedService> = {
    id,
    name: id,
    description: "",
    staticPath: "",
    tags: [],
    secrets: [],
    type: "service",
    buildDeps: [],
    runtimeDeps: [],
    commands: {},
    paths: { root: `/proj/${id}`, context: `/proj/${id}` },
    packageManagers: [],
    configPath: `/proj/${id}/nopo.yml`,

    // pre_command is process-level (NormalizedProcess.preCommand), not the runtime block.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: only the runtime fields the YAML emitter reads matter
    runtime: {
      processes,
      command: primary.command,
      cpu: primary.cpu,
      memory: primary.memory,
      port: primary.port ?? 3000,
      deps: primary.deps,
    } as NormalizedService["runtime"],
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: only the runtime fields the YAML emitter reads matter
  return svc as NormalizedService;
}

function makeManifest(
  id: string,
  processes: Record<string, NormalizedProcess>,
  opts: { image?: string; isInfra?: boolean } = {},
): ServiceManifest {
  const primary =
    processes.default ?? Object.values(processes)[0] ?? makeProcess({});
  return {
    id,
    service: makeService(id, processes),
    image: opts.image ?? `local/${id}:test`,
    port: primary.port ?? 3000,
    env: { SERVICE_NAME: id, NODE_ENV: "production" },
    secrets: [],
    isInfra: opts.isInfra ?? false,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal overlay for test
    overlay: {
      name: "default",
      cpu: primary.cpu,
      memory: primary.memory,
      port: primary.port ?? 3000,
      replicas: primary.minInstances,
      deps: primary.deps,
      envs: {
        env: { SERVICE_NAME: id, NODE_ENV: "production" },
        secrets: {},
        effective: { SERVICE_NAME: id, NODE_ENV: "production" },
      },
    } as unknown as ResolvedRuntime,
  };
}

/** Parse the YAML string into a JS object. Tests poke at deeply nested k8s manifest fields
 * (`doc.spec.template.spec.containers[0].command`) without a precise schema.
 */
interface ParsedYaml {
  /** Non-undefined value type so chained `.spec.template.spec` traversal works under
   * `noUncheckedIndexedAccess`. The shape is technically looser than the runtime (leaf values are
   * scalars/arrays, not nested objects), but the only consumer is vitest matchers + array indexing,
   * which accept any input and assert at runtime.
   */
  [key: string]: ParsedYaml;
}

function parseYaml(src: string): ParsedYaml {
  const result = parse(src);
  if (typeof result !== "object" || result === null) {
    throw new Error("parseYaml: expected an object at the document root");
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- yaml's `parse` returns `unknown`; runtime check above proves the root is an object. ParsedYaml's self-reference + scalar intersection lets tests drill down without per-step type guards.
  return result as ParsedYaml;
}

// ---- deploymentName ----

describe("deploymentName", () => {
  it("returns the service id unsuffixed for the `default` process", () => {
    expect(deploymentName("web", "default")).toBe("web");
  });

  it("suffixes non-default processes with the process name", () => {
    expect(deploymentName("web", "worker")).toBe("web-worker");
    expect(deploymentName("af-api", "scheduler")).toBe("af-api-scheduler");
  });
});

// ---- single-process back-compat ----

describe("yamlDeployment — single-process back-compat", () => {
  const processes = {
    default: makeProcess({
      command: "node server.js",
      port: 3000,
      cpu: "0.5",
      memory: "256Mi",
      minInstances: 1,
      maxInstances: 1,
    }),
  };
  const svc = makeManifest("web", processes);

  it("emits a Deployment named after the service id (unsuffixed default)", () => {
    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.default!,
      port: 3000,
    });
    const doc = parseYaml(yaml);
    expect(doc).toMatchObject({
      metadata: {
        name: "web",
        labels: {
          app: "web",
          "app.kubernetes.io/managed-by": "nopo",
        },
      },
    });
  });

  it("adds `nopo.process: default` to pod template labels (selector stays `app:` only — selector is k8s-immutable)", () => {
    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.default!,
      port: 3000,
    });
    const doc = parseYaml(yaml);
    expect(doc.spec?.selector?.matchLabels).toEqual({ app: "web" });
    expect(doc.spec?.template?.metadata?.labels).toMatchObject({
      app: "web",
      "nopo.process": "default",
    });
  });

  it("keeps the legacy hardcoded `replicas: 1` for services that don't set min_instances", () => {
    // minInstances=0 must still emit replicas: 1 — that's the back-compat contract.
    const procs = { default: makeProcess({ port: 3000, minInstances: 0 }) };
    const m = makeManifest("web", procs);
    const yaml = yamlDeployment(m, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: procs.default!,
      port: 3000,
    });
    expect(parseYaml(yaml)).toMatchObject({ spec: { replicas: 1 } });
  });

  it("respects explicit min_instances > 1", () => {
    const procs = {
      default: makeProcess({ port: 3000, minInstances: 3, maxInstances: 5 }),
    };
    const m = makeManifest("web", procs);
    const yaml = yamlDeployment(m, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: procs.default!,
      port: 3000,
    });
    expect(parseYaml(yaml)).toMatchObject({ spec: { replicas: 3 } });
  });

  it("emits a single containerPort matching the process port", () => {
    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.default!,
      port: 3000,
    });
    expect(parseYaml(yaml)).toMatchObject({
      spec: {
        template: {
          spec: {
            containers: [{ ports: [{ containerPort: 3000 }] }],
          },
        },
      },
    });
  });

  it("emits the pre_command initContainer when the process declares pre_command", () => {
    /** pre_command is now process-level: it lives on NormalizedProcess.preCommand,
     * not on the service runtime. The process with preCommand gets its own
     * initContainer; sibling processes without preCommand get none.
     */
    const procWithPre = makeProcess({
      command: "node server.js",
      port: 3000,
      preCommand: "bunx drizzle-kit migrate",
    });
    const m = makeManifest("af-api", { default: procWithPre });
    const yaml = yamlDeployment(m, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: procWithPre,
      port: 3000,
    });
    expect(parseYaml(yaml)).toMatchObject({
      spec: {
        template: {
          spec: {
            initContainers: [
              {
                name: "af-api-pre",
                command: ["sh", "-c", "bunx drizzle-kit migrate"],
              },
            ],
          },
        },
      },
    });
  });
});

// ---- multi-process ----

describe("yamlDeployment — multi-process", () => {
  // pre_command is process-level: the `default` process declares it,
  // the `worker` process does not — so only `default` gets an initContainer.
  const processes: Record<string, NormalizedProcess> = {
    default: makeProcess({
      command: "bun run server.ts",
      port: 3000,
      cpu: "1",
      memory: "512Mi",
      minInstances: 2,
      maxInstances: 5,
      env: { ROLE: "api" },
      preCommand: "bunx drizzle-kit migrate",
    }),
    worker: makeProcess({
      name: "worker",
      command: "bun run worker.ts",
      // no port — workers don't expose a port
      // no pre_command — workers don't run migrations
      cpu: "0.5",
      memory: "256Mi",
      minInstances: 1,
      maxInstances: 3,
      env: { ROLE: "worker" },
    }),
  };
  const svc = makeManifest("af-api", processes);

  function deployDefault() {
    return parseYaml(
      yamlDeployment(svc, "nopo-dev", {
        isDb: false,
        isNginx: false,
        isDev: false,
        isCI: false,
        projectRoot: "/proj",
        nginxTemplatePath: null,
        secretName: null,
        configMounts: [],
        process: processes.default!,
        port: 3000,
      }),
    );
  }

  function deployWorker() {
    return parseYaml(
      yamlDeployment(svc, "nopo-dev", {
        isDb: false,
        isNginx: false,
        isDev: false,
        isCI: false,
        projectRoot: "/proj",
        nginxTemplatePath: null,
        secretName: null,
        configMounts: [],
        process: processes.worker!,
        // no port — workers don't expose a port
      }),
    );
  }

  it("emits a Deployment per process with the right names", () => {
    expect(deployDefault()).toMatchObject({ metadata: { name: "af-api" } });
    expect(deployWorker()).toMatchObject({
      metadata: { name: "af-api-worker" },
    });
  });

  it("gives each Deployment a distinct selector via `app: <deployName>` (selectors stay legacy single-key — k8s-immutable)", () => {
    expect(deployDefault()).toMatchObject({
      spec: {
        selector: {
          matchLabels: { app: "af-api" },
        },
        template: {
          metadata: { labels: { app: "af-api", "nopo.process": "default" } },
        },
      },
    });
    expect(deployWorker()).toMatchObject({
      spec: {
        selector: {
          matchLabels: { app: "af-api-worker" },
        },
        template: {
          metadata: {
            labels: { app: "af-api-worker", "nopo.process": "worker" },
          },
        },
      },
    });
  });

  it("emits per-process container.command — never relies on the image's baked CMD", () => {
    /** The image's baked CMD is set from `runtime.default.command`, which is undefined for multi-process
     * services (commands live on each `processes.<name>`). Without per-process command on the Deployment,
     * pods inherit a stale base-image CMD (e.g. `tsx /app/nopo/scripts/bin.ts` — a path renamed long ago)
     * and crashloop with ERR_MODULE_NOT_FOUND. Prod rolled into exactly this on first multi-process
     */
    const d = deployDefault();
    const cmd = d.spec?.template?.spec?.containers?.[0]?.command;
    expect(cmd).toEqual(["sh", "-c", "bun run server.ts"]);

    const w = deployWorker();
    const wcmd = w.spec?.template?.spec?.containers?.[0]?.command;
    expect(wcmd).toEqual(["sh", "-c", "bun run worker.ts"]);
  });

  it("omits ports on a port-less process (worker)", () => {
    // Workers have no `ports:` block on the container — k8s default is
    // "no published port" which is correct.
    const w = deployWorker();
    expect(w).toMatchObject({
      spec: { template: { spec: { containers: [{ name: "af-api-worker" }] } } },
    });
    // assert the absence of `ports` on the container
    expect(JSON.stringify(w)).not.toMatch(/"ports":\[/);
  });

  it("uses per-process replicas, cpu, and memory", () => {
    expect(deployDefault()).toMatchObject({
      spec: {
        replicas: 2,
        template: {
          spec: {
            containers: [
              {
                resources: {
                  requests: { cpu: "1", memory: "512Mi" },
                  limits: { cpu: "1", memory: "512Mi" },
                },
              },
            ],
          },
        },
      },
    });
    expect(deployWorker()).toMatchObject({
      spec: {
        replicas: 1,
        template: {
          spec: {
            containers: [
              {
                resources: {
                  requests: { cpu: "0.5", memory: "256Mi" },
                  limits: { cpu: "0.5", memory: "256Mi" },
                },
              },
            ],
          },
        },
      },
    });
  });

  it("merges service-level env with per-process env (process keys win)", () => {
    const dEnv = collectEnv(deployDefault());
    const wEnv = collectEnv(deployWorker());

    // Service-level env (SERVICE_NAME, NODE_ENV) is on both
    expect(dEnv.SERVICE_NAME).toBe("af-api");
    expect(wEnv.SERVICE_NAME).toBe("af-api");

    // Per-process env keys win
    expect(dEnv.ROLE).toBe("api");
    expect(wEnv.ROLE).toBe("worker");

    // Port-bearing process gets PORT injected
    expect(dEnv.PORT).toBe("3000");
  });

  it("emits the pre_command initContainer on the process that declares it, not on siblings", () => {
    // The `default` process declares preCommand → gets initContainer.
    expect(deployDefault()).toMatchObject({
      spec: {
        template: {
          spec: {
            initContainers: [{ name: "af-api-pre" }],
          },
        },
      },
    });
    // The `worker` process has no preCommand → no initContainers block.
    expect(JSON.stringify(deployWorker())).not.toMatch(/initContainers/);
  });

  it("two processes with ports emit two independent Services (rule 1)", () => {
    // Any process can declare a port. Two port-bearing processes = two Services.
    const procs: Record<string, NormalizedProcess> = {
      default: makeProcess({ port: 3000 }),
      admin: makeProcess({ name: "admin", port: 9001 }),
    };
    const m = makeManifest("svc", procs);
    const adminYaml = yamlService(m, "nopo-dev", {
      isNginx: false,
      isDb: false,
      isBackend: false,
      isCI: true,
      process: procs.admin!,
      port: 9001,
    });
    const defaultYaml = yamlService(m, "nopo-dev", {
      isNginx: false,
      isDb: false,
      isBackend: false,
      isCI: true,
      process: procs.default!,
      port: 3000,
    });
    // default process → unsuffixed Service name (back-compat)
    expect(parseYaml(defaultYaml)).toMatchObject({ metadata: { name: "svc" } });
    // admin process → suffixed Service name
    expect(parseYaml(adminYaml)).toMatchObject({
      metadata: { name: "svc-admin" },
      spec: { ports: [{ port: 9001 }] },
    });
  });

  it("pre_command on a non-default process emits initContainer on that process only", () => {
    // Rule 2: pre_command is process-level — any process can declare it.
    // Here the worker (non-default) has the initContainer, default does not.
    const procs: Record<string, NormalizedProcess> = {
      default: makeProcess({ port: 3000, command: "bun run server.ts" }),
      worker: makeProcess({
        name: "worker",
        command: "bun run worker.ts",
        preCommand: "bun run db:seed",
      }),
    };
    const m = makeManifest("svc", procs);

    const workerYaml = yamlDeployment(m, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: procs.worker!,
    });
    expect(parseYaml(workerYaml)).toMatchObject({
      metadata: { name: "svc-worker" },
      spec: {
        template: {
          spec: {
            initContainers: [
              {
                name: "svc-pre",
                command: ["sh", "-c", "bun run db:seed"],
              },
            ],
          },
        },
      },
    });

    const defaultYaml = yamlDeployment(m, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: procs.default!,
      port: 3000,
    });
    // default process has no preCommand → no initContainers
    expect(JSON.stringify(parseYaml(defaultYaml))).not.toMatch(
      /initContainers/,
    );
  });
});

// Helper: pull the env array out of a parsed Deployment doc into a flat
// {name: value} record.
function collectEnv(parsed: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (
    parsed &&
    typeof parsed === "object" &&
    "spec" in parsed &&
    parsed.spec &&
    typeof parsed.spec === "object" &&
    "template" in parsed.spec &&
    parsed.spec.template &&
    typeof parsed.spec.template === "object" &&
    "spec" in parsed.spec.template &&
    parsed.spec.template.spec &&
    typeof parsed.spec.template.spec === "object" &&
    "containers" in parsed.spec.template.spec &&
    Array.isArray(parsed.spec.template.spec.containers)
  ) {
    const env = parsed.spec.template.spec.containers[0]?.env;
    if (Array.isArray(env)) {
      for (const e of env) {
        if (
          e &&
          typeof e === "object" &&
          "name" in e &&
          "value" in e &&
          typeof e.name === "string" &&
          typeof e.value === "string"
        ) {
          result[e.name] = e.value;
        }
      }
    }
  }
  return result;
}

// ---- dep fan-out (Rule 3) ----

describe("deploymentName — dep fan-out across all dep processes (Rule 3)", () => {
  /** Rule 3: deps are service-level. When service A depends on service B, the dep-wait fans out to
   * *every* Deployment of B — i.e., one kubectl rollout status per process. The `deploymentName` helper
   * drives that fan-out: for each dep process, `deploymentName(depId, proc.name)` is the target.
   */

  it("generates correct Deployment names for every process of a multi-process dep", () => {
    const depId = "db-api";
    const depProcesses: NormalizedProcess[] = [
      makeProcess({ name: "default" }),
      makeProcess({ name: "replica" }),
    ];

    const waitTargets = depProcesses.map((p) => deploymentName(depId, p.name));
    // default process → unsuffixed (back-compat)
    expect(waitTargets).toContain("db-api");
    // replica process → suffixed
    expect(waitTargets).toContain("db-api-replica");
    // exactly one target per process — no extras
    expect(waitTargets).toHaveLength(2);
  });

  it("single-process dep fans out to exactly one Deployment (unsuffixed)", () => {
    const depId = "redis";
    const depProcesses: NormalizedProcess[] = [
      makeProcess({ name: "default" }),
    ];
    const waitTargets = depProcesses.map((p) => deploymentName(depId, p.name));
    expect(waitTargets).toEqual(["redis"]);
  });

  it("three-process dep fans out to three Deployments with correct names", () => {
    const depId = "af-api";
    const depProcesses: NormalizedProcess[] = [
      makeProcess({ name: "default" }),
      makeProcess({ name: "worker" }),
      makeProcess({ name: "cron" }),
    ];
    const waitTargets = depProcesses.map((p) => deploymentName(depId, p.name));
    expect(waitTargets).toEqual(["af-api", "af-api-worker", "af-api-cron"]);
  });
});

describe("yamlService — multi-process", () => {
  const processes: Record<string, NormalizedProcess> = {
    default: makeProcess({ port: 3000 }),
    worker: makeProcess({ name: "worker" }),
  };
  const svc = makeManifest("af-api", processes);

  it("emits one Service for the port-bearing process, named after the service id (default)", () => {
    const yaml = yamlService(svc, "nopo-dev", {
      isNginx: false,
      isDb: false,
      isBackend: false,
      isCI: true,
      process: processes.default!,
      port: 3000,
    });
    expect(parseYaml(yaml)).toMatchObject({
      metadata: { name: "af-api" },
      spec: { selector: { app: "af-api" } },
    });
  });

  it("uses the service id directly when the port-bearing process is named `default`", () => {
    const yaml = yamlService(svc, "nopo-dev", {
      isNginx: false,
      isDb: false,
      isBackend: false,
      isCI: true,
      process: processes.default!,
      port: 3000,
    });
    expect(parseYaml(yaml)).toMatchObject({ metadata: { name: "af-api" } });
  });

  it("suffixes the Service name when the port-bearing process is non-default", () => {
    const procs: Record<string, NormalizedProcess> = {
      api: makeProcess({ name: "api", port: 3000 }),
    };
    const m = makeManifest("svc", procs);
    const yaml = yamlService(m, "nopo-dev", {
      isNginx: false,
      isDb: false,
      isBackend: false,
      isCI: true,
      process: procs.api!,
      port: 3000,
    });
    expect(parseYaml(yaml)).toMatchObject({
      metadata: { name: "svc-api" },
      spec: { selector: { app: "svc-api" } },
    });
  });
});

// ---- NODE_EXTRA_CA_CERTS injection (Bun + in-cluster TLS) ----

describe("yamlDeployment — NODE_EXTRA_CA_CERTS for in-cluster Bun", () => {
  /** Production blocker: af-api's worker process uses @kubernetes/client-node, which calls
   * `kc.loadFromCluster()` and attaches an `https.Agent({ ca })` to the request context.
   */

  const CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

  it("injects NODE_EXTRA_CA_CERTS on a single-process (default) Deployment", () => {
    const processes = {
      default: makeProcess({ command: "node server.js", port: 3000 }),
    };
    const svc = makeManifest("web", processes);
    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.default!,
      port: 3000,
    });
    const env = collectEnv(parseYaml(yaml));
    expect(env.NODE_EXTRA_CA_CERTS).toBe(CA_PATH);
  });

  it("injects NODE_EXTRA_CA_CERTS on every process of a multi-process service (web AND worker)", () => {
    /** The af-api worker is the actual production blocker — it's the
     * process that calls KubernetesProvider. The web process getting
     * the env var too is a no-op (it doesn't talk to the k8s API),
     * but pinning both keeps the rule simple: all Deployments get it.
     */
    const processes: Record<string, NormalizedProcess> = {
      web: makeProcess({
        name: "web",
        command: "bun run src/index.ts",
        port: 3001,
      }),
      worker: makeProcess({
        name: "worker",
        command: "bun run src/worker.ts",
      }),
    };
    const svc = makeManifest("af-api", processes);

    const webYaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.web!,
      port: 3001,
    });
    const workerYaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.worker!,
    });

    expect(collectEnv(parseYaml(webYaml)).NODE_EXTRA_CA_CERTS).toBe(CA_PATH);
    expect(collectEnv(parseYaml(workerYaml)).NODE_EXTRA_CA_CERTS).toBe(CA_PATH);
  });

  it("does not let user-declared NODE_EXTRA_CA_CERTS override the in-cluster path", () => {
    /** If a service ever sets its own NODE_EXTRA_CA_CERTS (e.g. for a
     * private CA bundle baked into the image), the terraform plugin
     * value wins — otherwise an unrelated override silently
     * re-introduces the production bug.
     */
    const processes = {
      default: makeProcess({
        command: "bun run server.ts",
        port: 3000,
        env: { NODE_EXTRA_CA_CERTS: "/etc/ssl/custom.pem" },
      }),
    };
    const svc = makeManifest("web", processes);
    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.default!,
      port: 3000,
    });
    expect(collectEnv(parseYaml(yaml)).NODE_EXTRA_CA_CERTS).toBe(CA_PATH);
  });
});

// ---- NOPO_NAMESPACE injection (downward API) ----

describe("yamlDeployment — NOPO_NAMESPACE via downward API", () => {
  /** Production blocker (#6998 follow-up): af-api's worker has no NOPO_NAMESPACE in its env, so
   * KubernetesProvider falls through to the literal "default" namespace. It then tries to manage agent
   * pods in `default` instead of the actual deploy namespace (e.g. `nopo-prod`) and gets a 403 from the
   * API server.
   */

  it("injects NOPO_NAMESPACE via downward API on a single-process Deployment", () => {
    const processes = {
      default: makeProcess({ command: "node server.js", port: 3000 }),
    };
    const svc = makeManifest("web", processes);
    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.default!,
      port: 3000,
    });
    const env = findEnvEntry(parseYaml(yaml), "NOPO_NAMESPACE");
    expect(env).toEqual({
      name: "NOPO_NAMESPACE",
      valueFrom: {
        fieldRef: {
          fieldPath: "metadata.namespace",
        },
      },
    });
  });

  it("injects NOPO_NAMESPACE on every process of a multi-process service (web AND worker)", () => {
    /** The af-api worker is the actual production blocker — that's the
     * process that calls KubernetesProvider. Both Deployments must carry
     * the env var: web for parity, worker because that's the spawn path.
     */
    const processes: Record<string, NormalizedProcess> = {
      web: makeProcess({
        name: "web",
        command: "bun run src/index.ts",
        port: 3001,
      }),
      worker: makeProcess({
        name: "worker",
        command: "bun run src/worker.ts",
      }),
    };
    const svc = makeManifest("af-api", processes);

    const webYaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.web!,
      port: 3001,
    });
    const workerYaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.worker!,
    });

    const expected = {
      name: "NOPO_NAMESPACE",
      valueFrom: {
        fieldRef: {
          fieldPath: "metadata.namespace",
        },
      },
    };
    expect(findEnvEntry(parseYaml(webYaml), "NOPO_NAMESPACE")).toEqual(
      expected,
    );
    expect(findEnvEntry(parseYaml(workerYaml), "NOPO_NAMESPACE")).toEqual(
      expected,
    );
  });
});

// ---- serviceAccountName ----

describe("yamlDeployment — serviceAccountName per process", () => {
  /** The worker process needs a non-default ServiceAccount so its RBAC covers `pods/create + delete` for
   * the agent-spawn path. The plugin emits `serviceAccountName` in `spec.template.spec` from a
   * per-process `kubernetes.serviceAccountName` config field. Single-process services (and any process
   * that doesn't declare it) omit the field — k8s falls back to the namespace's `default` SA, matching
   */

  it("emits serviceAccountName when kubernetes.serviceAccountName is set on the process", () => {
    const processes: Record<string, NormalizedProcess> = {
      worker: makeProcess({
        name: "worker",
        command: "bun run src/worker.ts",
        kubernetes: { serviceAccountName: "af-runner" },
      }),
    };
    const svc = makeManifest("af-api", processes);
    const yaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.worker!,
    });
    const doc = parseYaml(yaml);
    expect(doc).toMatchObject({
      spec: {
        template: {
          spec: {
            serviceAccountName: "af-runner",
          },
        },
      },
    });
  });

  it("omits serviceAccountName when not configured (back-compat with default SA)", () => {
    const processes = {
      default: makeProcess({ command: "node server.js", port: 3000 }),
    };
    const svc = makeManifest("web", processes);
    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: processes.default!,
      port: 3000,
    });
    /** The string `serviceAccountName` MUST NOT appear anywhere in the YAML —
     * an empty value would still bind the pod to the literal "" SA, which
     * is a different failure mode than legacy (no key = default SA).
     */
    expect(yaml).not.toContain("serviceAccountName");
  });
});

// Helper: find a single env entry by name from a parsed Deployment doc.
// Returns the raw entry shape so tests can assert on `value` vs `valueFrom`.
function findEnvEntry(parsed: unknown, name: string): unknown {
  if (
    parsed &&
    typeof parsed === "object" &&
    "spec" in parsed &&
    parsed.spec &&
    typeof parsed.spec === "object" &&
    "template" in parsed.spec &&
    parsed.spec.template &&
    typeof parsed.spec.template === "object" &&
    "spec" in parsed.spec.template &&
    parsed.spec.template.spec &&
    typeof parsed.spec.template.spec === "object" &&
    "containers" in parsed.spec.template.spec &&
    Array.isArray(parsed.spec.template.spec.containers)
  ) {
    const env = parsed.spec.template.spec.containers[0]?.env;
    if (Array.isArray(env)) {
      for (const e of env) {
        if (e && typeof e === "object" && "name" in e && e.name === name) {
          return e;
        }
      }
    }
  }
  return undefined;
}
