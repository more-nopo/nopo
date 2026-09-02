import type {
  NormalizedProcess,
  NormalizedService,
  ResolvedRuntime,
} from "@more-nopo/nopo/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { type ServiceManifest, yamlDeployment } from "./index.ts";

/** Pod deletion and Endpoints removal run concurrently, so nginx keeps routing to a pod that already
 * exited. A `preStop` sleep holds the container open while the Endpoints update propagates. The
 * container's `lifecycle:` key must carry BOTH hooks — a second `lifecycle:` key is invalid YAML input
 * for k8s.
 */

interface PodSpec {
  terminationGracePeriodSeconds?: number;
  containers: {
    lifecycle?: {
      postStart?: { exec: { command: string[] } };
      preStop?: { exec: { command: string[] } };
    };
  }[];
}

function podSpec(yaml: string): PodSpec {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- yaml parse returns unknown
  const doc = parse(yaml) as { spec: { template: { spec: PodSpec } } };
  return doc.spec.template.spec;
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

function render(
  proc: NormalizedProcess,
  overlayFields: Partial<ResolvedRuntime> = {},
): string {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: only the runtime fields the YAML emitter reads matter
  const service = {
    id: "svc",
    name: "svc",
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
    ...overlayFields,
  } as unknown as ResolvedRuntime;

  return yamlDeployment(
    {
      id: "svc",
      service,
      image: "local/svc:tree-abc",
      port: proc.port ?? 3000,
      env: { SERVICE_NAME: "svc" },
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

describe("yamlDeployment — preStop drain hook", () => {
  it("emits exactly one lifecycle block carrying a preStop sleep for a port-bearing process", () => {
    const yaml = render(makeProcess({ port: 3000 }));

    expect(yaml.match(/lifecycle:/g)).toHaveLength(1);
    expect(podSpec(yaml).containers[0]!.lifecycle).toEqual({
      preStop: { exec: { command: ["sh", "-c", "sleep 5"] } },
    });
  });

  it("carries postStart AND preStop under the same single lifecycle block", () => {
    const yaml = render(
      makeProcess({ port: 5432, postCommand: "pg_isready -U nopo" }),
    );

    expect(yaml.match(/lifecycle:/g)).toHaveLength(1);
    const lifecycle = podSpec(yaml).containers[0]!.lifecycle;
    expect(lifecycle?.postStart?.exec.command).toEqual([
      "sh",
      "-c",
      "pg_isready -U nopo",
    ]);
    expect(lifecycle?.preStop?.exec.command).toEqual(["sh", "-c", "sleep 5"]);
  });

  it("honours a custom pre_stop_delay from the resolved runtime", () => {
    const yaml = render(makeProcess({ port: 3000 }), { preStopDelay: 12 });

    expect(
      podSpec(yaml).containers[0]!.lifecycle?.preStop?.exec.command,
    ).toEqual(["sh", "-c", "sleep 12"]);
  });

  it("emits no preStop when pre_stop_delay is 0", () => {
    /** `db` sets 0: a drain delay is pointless on a Recreate service and only
     * lengthens the RWO PVC handoff.
     */
    const yaml = render(makeProcess({ port: 5432 }), { preStopDelay: 0 });

    expect(yaml).not.toContain("preStop");
    expect(yaml).not.toContain("lifecycle:");
  });

  it("keeps the postStart-only block intact when pre_stop_delay is 0", () => {
    const yaml = render(
      makeProcess({ port: 5432, postCommand: "bootstrap.sh" }),
      { preStopDelay: 0 },
    );

    expect(yaml.match(/lifecycle:/g)).toHaveLength(1);
    expect(yaml).not.toContain("preStop");
    expect(podSpec(yaml).containers[0]!.lifecycle?.postStart).toBeDefined();
  });

  it("emits no preStop for a port-less process (worker)", () => {
    const yaml = render(makeProcess({ name: "worker" }));

    expect(yaml).not.toContain("preStop");
  });

  it("reads a per-process pre_stop_delay override off the resolved runtime", () => {
    const proc = makeProcess({ name: "web", port: 3000 });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- passthrough runtime block stub
    const processes = {
      web: { pre_stop_delay: 0 },
    } as unknown as ResolvedRuntime["processes"];
    const yaml = render(proc, { preStopDelay: 5, processes });

    expect(yaml).not.toContain("preStop");
  });
});

describe("yamlDeployment — termination grace", () => {
  it("emits terminationGracePeriodSeconds: 30 explicitly on the pod spec", () => {
    expect(
      podSpec(render(makeProcess({ port: 3000 })))
        .terminationGracePeriodSeconds,
    ).toBe(30);
  });

  it("emits it for port-less processes too", () => {
    expect(
      podSpec(render(makeProcess({ name: "worker" })))
        .terminationGracePeriodSeconds,
    ).toBe(30);
  });
});
