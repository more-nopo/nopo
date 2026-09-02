/** Bug regression: Deployment.spec.selector is IMMUTABLE in Kubernetes. The first cut of this PR added
 * `nopo.process: <name>` to the Deployment's `spec.selector.matchLabels`.
 */
import type {
  NormalizedProcess,
  NormalizedService,
  ResolvedRuntime,
} from "@more-nopo/nopo/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { type ServiceManifest, yamlDeployment } from "./index.ts";

function makeProcess(o: Partial<NormalizedProcess> = {}): NormalizedProcess {
  return {
    name: "default",
    cpu: "1",
    memory: "512Mi",
    minInstances: 1,
    maxInstances: 1,
    deps: [],
    ...o,
  };
}

function makeService(
  id: string,
  processes: Record<string, NormalizedProcess>,
): NormalizedService {
  const primary = processes.default ?? Object.values(processes)[0]!;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
  return {
    id,
    name: id,
    description: "",
    staticPath: "",
    tags: [],
    secrets: [],
    type: "service",
    buildDeps: [],
    runtimeDeps: [],
    systemDeps: [],
    commands: {},
    paths: { root: `/proj/${id}`, context: `/proj/${id}` },
    packageManagers: [],
    configPath: `/proj/${id}/nopo.yml`,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: only the runtime fields the YAML emitter reads matter
    runtime: {
      processes,
      command: primary.command,
      cpu: primary.cpu,
      memory: primary.memory,
      port: primary.port ?? 3000,
      deps: primary.deps,
    } as NormalizedService["runtime"],
  } as NormalizedService;
}

describe("Deployment.spec.selector immutability (regression)", () => {
  const processes = {
    default: makeProcess({ port: 5432 }),
  };
  const svc: ServiceManifest = {
    id: "db",
    service: makeService("db", processes),
    image: "postgres:16-alpine",
    port: 5432,
    env: {},
    secrets: [],
    isInfra: true,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
    overlay: {
      name: "default",
      cpu: "1",
      memory: "512Mi",
      port: 5432,
      replicas: 1,
      deps: [],
      envs: { env: {}, secrets: {}, effective: {} },
    } as unknown as ResolvedRuntime,
  };

  it("Deployment.spec.selector.matchLabels MUST NOT include nopo.process — k8s rejects mutating selectors on live Deployments", () => {
    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: true,
      isNginx: false,
      isDev: false,
      isCI: true,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: "db-secrets",
      configMounts: [],
      process: processes.default!,
      port: 5432,
    });
    const doc = parse(yaml);
    const matchLabels = doc.spec.selector.matchLabels;

    // The FIX: selector is the legacy {app: <id>} only — guaranteed
    // compatible with every existing rolled-out Deployment.
    expect(matchLabels).toEqual({ app: "db" });
    expect(matchLabels).not.toHaveProperty("nopo.process");
  });

  it("Pod template labels MAY include nopo.process — those evolve freely", () => {
    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: true,
      isNginx: false,
      isDev: false,
      isCI: true,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: "db-secrets",
      configMounts: [],
      process: processes.default!,
      port: 5432,
    });
    const doc = parse(yaml);
    expect(doc.spec.template.metadata.labels).toMatchObject({
      app: "db",
      "nopo.process": "default",
    });
  });
});

describe("Deployment.spec.strategy — RWO PVC deadlock prevention", () => {
  /** Regression: with the default RollingUpdate strategy, services that mount a ReadWriteOnce PVC (db)
   * deadlock on every deploy. The new pod can never become Ready because the old pod still holds the
   * PVC; the old pod never terminates because the rollout is waiting for the new pod to be Ready. Hit on
   * 2026-05-16 across multiple production deploys; required break-glass kubectl scale to recover.
   */

  function buildService(opts: {
    id: string;
    image: string;
    port: number;
    isInfra: boolean;
  }): { svc: ServiceManifest; process: NormalizedProcess } {
    const process = makeProcess({ port: opts.port });
    const processes = { default: process };
    return {
      svc: {
        id: opts.id,
        service: makeService(opts.id, processes),
        image: opts.image,
        port: opts.port,
        env: {},
        secrets: [],
        isInfra: opts.isInfra,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
        overlay: {
          name: "default",
          cpu: "1",
          memory: "512Mi",
          port: opts.port,
          replicas: 1,
          deps: [],
          envs: { env: {}, secrets: {}, effective: {} },
        } as unknown as ResolvedRuntime,
      },
      process,
    };
  }

  it("emits strategy: Recreate on the db Deployment (RWO PVC mount)", () => {
    const { svc, process } = buildService({
      id: "db",
      image: "pgvector/pgvector:pg16",
      port: 5432,
      isInfra: true,
    });
    const yaml = yamlDeployment(svc, "nopo-prod", {
      isDb: true,
      isNginx: false,
      isDev: false,
      isCI: true,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: "db-secrets",
      configMounts: [],
      process,
      port: 5432,
    });
    const doc = parse(yaml);
    expect(doc.spec.strategy).toEqual({ type: "Recreate" });
  });

  it("omits strategy on non-db Deployments (K8s default RollingUpdate is correct without RWO PVC)", () => {
    const { svc, process } = buildService({
      id: "api",
      image: "example/app-api:test",
      port: 3000,
      isInfra: false,
    });
    const yaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: true,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: "api-secrets",
      configMounts: [],
      process,
      port: 3000,
    });
    const doc = parse(yaml);
    // No `strategy:` field — K8s applies the default RollingUpdate.
    expect(doc.spec.strategy).toBeUndefined();
  });
});
