import type {
  NormalizedProcess,
  NormalizedService,
  ResolvedRuntime,
} from "@more-nopo/nopo/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  resolveProcesses,
  type ServiceManifest,
  yamlService,
} from "./index.ts";

/** `runtime.extra_ports` lets a container that listens on more than one port (e.g. jaeger: 16686 UI +
 * 4317/4318 OTLP ingress) expose those ports on its plugin-generated Service. Without this the
 * otel-collector's trace exporter gets connection-refused on `jaeger:4317` — the latent bug behind the
 * 2026-06-18 incident where undeliverable spans backed the collector's export queue up until it
 */

// Same loose self-referential parse helper as multi-process-deployment.test.ts:
// tests poke at nested manifest fields and assert at runtime via vitest matchers.
interface ParsedYaml {
  [key: string]: ParsedYaml;
}

function parseYaml(src: string): ParsedYaml {
  const result = parse(src);
  if (typeof result !== "object" || result === null) {
    throw new Error("parseYaml: expected an object at the document root");
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- yaml's `parse` returns `unknown`; the runtime check above proves an object root.
  return result as ParsedYaml;
}

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

function makeManifest(id: string): ServiceManifest {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: yamlService only reads svc.id + opts
  return { id, service: { id } } as unknown as ServiceManifest;
}

function clusterIpOpts(proc: NormalizedProcess, port: number) {
  return {
    isNginx: false,
    isDb: false,
    isBackend: false,
    isCI: true,
    process: proc,
    port,
  };
}

describe("yamlService runtime.extra_ports", () => {
  it("renders each extra port as port == targetPort alongside http", () => {
    const proc = makeProcess({ port: 16686, extraPorts: [4317, 4318] });
    const yaml = yamlService(
      makeManifest("jaeger"),
      "nopo-prod",
      clusterIpOpts(proc, 16686),
    );
    const ports = parseYaml(yaml).spec.ports;

    // Primary UI port stays first and unchanged.
    expect(ports[0]).toMatchObject({
      name: "http",
      port: 16686,
      targetPort: 16686,
    });
    // Both OTLP ports follow, in declared order, with port == targetPort.
    expect(ports[1]).toMatchObject({ port: 4317, targetPort: 4317 });
    expect(ports[2]).toMatchObject({ port: 4318, targetPort: 4318 });
    expect(ports).toHaveLength(3);
  });

  it("emits only the primary port when extra_ports is absent", () => {
    const proc = makeProcess({ port: 16686 });
    const yaml = yamlService(
      makeManifest("jaeger"),
      "nopo-prod",
      clusterIpOpts(proc, 16686),
    );
    expect(parseYaml(yaml).spec.ports).toHaveLength(1);
  });
});

describe("resolveProcesses preserves extra_ports for flat services", () => {
  it("keeps extra_ports when re-synthesizing the default process from the overlay", () => {
    /** jaeger is flat: normalizeRuntime synthesizes lone `default` and extraPorts.
     * Deploy re-synthesizes `default` from the RESOLVED overlay and must keep extra_ports.
     * 2026-06-18: OTLP ports vanished; jaeger Service kept only 16686 UI.
     */
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: resolveProcesses reads processes + extraPorts only
    const runtime = {
      port: 16686,
      extraPorts: [4317, 4318],
      processes: {
        default: makeProcess({ port: 16686, extraPorts: [4317, 4318] }),
      },
    } as unknown as NormalizedService["runtime"];
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal overlay stub: synthesizeDefaultProcess reads scalar fields only
    const overlay = {
      name: "prod",
      cpu: "0.5",
      memory: "1Gi",
      port: 16686,
      replicas: 1,
      deps: [],
      envs: { env: {}, secrets: {}, effective: {} },
    } as unknown as ResolvedRuntime;

    const resolved = resolveProcesses(runtime, overlay);
    expect(resolved.default?.extraPorts).toEqual([4317, 4318]);
  });
});
