import type {
  NormalizedProcess,
  NormalizedService,
  ResolvedRuntime,
} from "@more-nopo/nopo/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { type ServiceManifest, yamlDeployment, yamlService } from "./index.ts";

/** Back-compat snapshot: a single-process service must produce the same Deployment + Service shape it
 * always did, with one documented exception — the new `nopo.process: default` label on the pod
 * template + Service selector. Everything else (name, replicas, image, ports, resources, container
 * layout) must match the legacy emitter byte-for- byte.
 */

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

    // Note: preCommand is now on the NormalizedProcess (process-level), not on runtime.
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

describe("back-compat: single-process service shape", () => {
  // Pick fixture-shaped values matching apps/db/nopo.yml so this is a
  // realistic legacy service.
  const processes = {
    default: makeProcess({
      port: 5432,
      cpu: "1",
      memory: "512Mi",
      minInstances: 1,
      maxInstances: 1,
    }),
  };
  const svc: ServiceManifest = {
    id: "db",
    service: makeService("db", processes),
    image: "postgres:16-alpine",
    port: 5432,
    env: { POSTGRES_USER: "nopo", POSTGRES_DB: "nopo" },
    secrets: [],
    isInfra: true,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal overlay stub for test; only scalar fields matter
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

  it("Deployment matches the legacy single-process shape (with new nopo.process pod label only — never in selector)", () => {
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

    // Top-level identity is unchanged
    expect(doc).toMatchObject({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: "db",
        namespace: "nopo-dev",
        labels: {
          app: "db",
          "app.kubernetes.io/managed-by": "nopo",
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: "db", // selector is IMMUTABLE in k8s; back-compat requires the legacy single-key shape
          },
        },
        template: {
          metadata: {
            labels: {
              app: "db",
              "nopo.process": "default", // pod labels can grow without breaking the immutable selector
            },
          },
          spec: {
            containers: [
              {
                name: "db",
                image: "postgres:16-alpine",
                imagePullPolicy: "IfNotPresent",
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
  });

  it("Service matches the legacy single-process shape (selector is the legacy single-key form, no nopo.process)", () => {
    const yaml = yamlService(svc, "nopo-dev", {
      isNginx: false,
      isDb: true,
      isBackend: false,
      isCI: true,
      process: processes.default!,
      port: 5432,
    });
    const doc = parse(yaml);
    expect(doc).toMatchObject({
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: "db", // unsuffixed — back-compat
        namespace: "nopo-dev",
        labels: {
          app: "db",
          "app.kubernetes.io/managed-by": "nopo",
        },
      },
      spec: {
        selector: {
          app: "db", // legacy single-key form; multi-process services disambiguate via the deployment-name suffix in `app`
        },
        ports: [
          {
            name: "http",
            port: 5432,
            targetPort: 5432,
          },
        ],
      },
    });
  });
});
