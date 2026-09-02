import type {
  NormalizedProcess,
  NormalizedService,
  ResolvedRuntime,
} from "@more-nopo/nopo/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { type ServiceManifest, yamlDeployment } from "./index.ts";

/** Multi-replica Deployments spread across nodes so one node loss cannot take every replica. The rule
 * is PREFERRED, never required: on a 4-node cluster a required rule leaves replicas Pending forever
 * once every node already runs one.
 */

interface Affinity {
  podAntiAffinity?: {
    preferredDuringSchedulingIgnoredDuringExecution?: {
      weight: number;
      podAffinityTerm: {
        topologyKey: string;
        labelSelector: { matchLabels: Record<string, string> };
      };
    }[];
    requiredDuringSchedulingIgnoredDuringExecution?: unknown;
  };
}

function affinity(yaml: string): Affinity | undefined {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- yaml parse returns unknown
  const doc = parse(yaml) as {
    spec: { template: { spec: { affinity?: Affinity } } };
  };
  return doc.spec.template.spec.affinity;
}

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

function render(id: string, proc: NormalizedProcess): string {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: only the runtime fields the YAML emitter reads matter
  const service = {
    id,
    name: id,
    tags: [],
    secrets: [],
    runtime: { processes: { [proc.name]: proc } },
  } as unknown as NormalizedService;

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal overlay stub
  const overlay = {
    name: "default",
    cpu: proc.cpu,
    memory: proc.memory,
    port: proc.port ?? 3000,
    replicas: proc.minInstances,
    deps: [],
    envs: { env: {}, secrets: {}, effective: {} },
  } as unknown as ResolvedRuntime;

  return yamlDeployment(
    {
      id,
      service,
      image: `local/${id}:tree-abc`,
      port: proc.port ?? 3000,
      env: {},
      secrets: [],
      isInfra: false,
      overlay,
    } satisfies ServiceManifest,
    "nopo-prod",
    {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: proc.port,
    },
  );
}

describe("yamlDeployment — soft pod anti-affinity", () => {
  it("spreads replicas across hostnames with a weight-100 preferred rule", () => {
    const yaml = render(
      "api",
      makeProcess({ name: "web", port: 3000, minInstances: 2 }),
    );
    const rules =
      affinity(yaml)?.podAntiAffinity
        ?.preferredDuringSchedulingIgnoredDuringExecution;

    expect(rules).toHaveLength(1);
    expect(rules?.[0]).toMatchObject({
      weight: 100,
      podAffinityTerm: {
        topologyKey: "kubernetes.io/hostname",
        labelSelector: { matchLabels: { app: "api-web" } },
      },
    });
  });

  it("never emits a required rule", () => {
    const yaml = render("web", makeProcess({ port: 3000, minInstances: 3 }));

    expect(yaml).not.toContain(
      "requiredDuringSchedulingIgnoredDuringExecution",
    );
  });

  it("emits no affinity block for a single-replica Deployment", () => {
    const yaml = render("db", makeProcess({ port: 5432, minInstances: 1 }));

    expect(yaml).not.toContain("affinity");
    expect(affinity(yaml)).toBeUndefined();
  });
});
