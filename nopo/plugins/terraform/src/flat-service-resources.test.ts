import type { NormalizedService, ResolvedRuntime } from "@more-nopo/nopo/config";
import { describe, expect, it } from "vitest";

import { resolveProcesses } from "./index.ts";

/** A flat service (no `processes:` block) gets a single `default` process synthesized by
 * `normalizeRuntime` from the legacy DEFAULT-only view, so its cpu/memory ignore any named-runtime
 * override. `resolveProcesses` must re-synthesize that lone `default` from the RESOLVED overlay —
 * otherwise a flat service's prod resource override (e.g.
 */
function overlay(memory: string, cpu = "1"): ResolvedRuntime {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal overlay stub: resolveProcesses only reads scalar fields
  return {
    name: "prod",
    cpu,
    memory,
    port: 5432,
    replicas: 1,
    deps: [],
    envs: { env: {}, secrets: {}, effective: {} },
  } as unknown as ResolvedRuntime;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: only `processes` is read here
const flatRuntime = {
  // What normalizeRuntime synthesizes for a flat service: a `default` process
  // carrying the legacy DEFAULT-block memory (512Mi), NOT the prod override.
  processes: {
    default: {
      name: "default",
      cpu: "1",
      memory: "512Mi",
      minInstances: 1,
      maxInstances: 1,
      deps: [],
    },
  },
} as unknown as NormalizedService["runtime"];

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
const multiRuntime = {
  processes: {
    web: {
      name: "web",
      cpu: "1",
      memory: "256Mi",
      minInstances: 1,
      maxInstances: 1,
      deps: [],
    },
    worker: {
      name: "worker",
      cpu: "1",
      memory: "256Mi",
      minInstances: 1,
      maxInstances: 1,
      deps: [],
    },
  },
} as unknown as NormalizedService["runtime"];

describe("resolveProcesses — flat-service overlay resources", () => {
  it("re-synthesizes a lone `default` from the resolved overlay (prod override applies)", () => {
    const procs = resolveProcesses(flatRuntime, overlay("4Gi", "2"));
    expect(procs.default!.memory).toBe("4Gi");
    expect(procs.default!.cpu).toBe("2");
  });

  it("applies named-runtime per-process resource + env overlays for multi-process services", () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub
    const previewOverlay = {
      name: "preview",
      cpu: "1",
      memory: "512Mi",
      port: 3001,
      replicas: 1,
      deps: [],
      envs: {
        env: { BETTER_AUTH_URL: "https://preview.example.com" },
        secrets: {},
        effective: {
          BETTER_AUTH_URL: "https://preview.example.com",
        },
      },
      processes: {
        web: { cpu: "0.5", memory: "384Mi" },
        worker: { cpu: "0.25", memory: "256Mi" },
      },
    } as unknown as ResolvedRuntime;

    const procs = resolveProcesses(multiRuntime, previewOverlay);
    expect(Object.keys(procs).sort()).toEqual(["web", "worker"]);
    expect(procs.web!.cpu).toBe("0.5");
    expect(procs.web!.memory).toBe("384Mi");
    expect(procs.worker!.cpu).toBe("0.25");
    expect(procs.web!.env?.BETTER_AUTH_URL).toBe(
      "https://preview.example.com",
    );
  });

  it("lets runtime overlay env win over process default env", () => {
    const withProcEnv: NormalizedService["runtime"] = {
      ...multiRuntime,
      processes: {
        web: {
          ...multiRuntime.processes!.web!,
          env: { BETTER_AUTH_URL: "https://app.example.com" },
        },
        worker: multiRuntime.processes!.worker!,
      },
    };
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub
    const previewOverlay = {
      name: "preview",
      cpu: "1",
      memory: "512Mi",
      port: 3001,
      replicas: 1,
      deps: [],
      envs: {
        env: { BETTER_AUTH_URL: "https://preview.example.com" },
        secrets: {},
        effective: {
          BETTER_AUTH_URL: "https://preview.example.com",
        },
      },
      processes: { web: { cpu: "0.5" } },
    } as unknown as ResolvedRuntime;

    const procs = resolveProcesses(withProcEnv, previewOverlay);
    expect(procs.web!.env?.BETTER_AUTH_URL).toBe(
      "https://preview.example.com",
    );
  });

  it("preserves per-process memory when the overlay has no process override", () => {
    const procs = resolveProcesses(multiRuntime, overlay("4Gi"));
    expect(Object.keys(procs).sort()).toEqual(["web", "worker"]);
    // Block-level overlay memory must NOT clobber per-process declared memory
    // when overlay.processes is absent.
    expect(procs.web!.memory).toBe("256Mi");
  });

  it("synthesizes from the overlay when no processes are declared", () => {
    const procs = resolveProcesses(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub
      { processes: {} } as unknown as NormalizedService["runtime"],
      overlay("8Gi"),
    );
    expect(procs.default!.memory).toBe("8Gi");
  });
});

/** Regression: the lone-`default` re-synthesis must carry the runtime block's pre_command/post_command
 * hooks and declared volumes, not just the scalar resources.
 */
describe("resolveProcesses — flat-service hooks and volumes survive re-synthesis", () => {
  const volumes = [
    {
      name: "migrations",
      mountPath: "/docker-entrypoint-initdb.d",
      source: "./migrations",
      readOnly: true,
    },
  ];

  function hookOverlay(): ResolvedRuntime {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal overlay stub mirroring db's resolved prod runtime
    return {
      name: "prod",
      cpu: "2",
      memory: "4Gi",
      port: 5432,
      replicas: 1,
      deps: [],
      preCommand: "echo pre",
      postCommand:
        'for f in /docker-entrypoint-initdb.d/*.sh; do bash "$f"; done',
      volumes,
      envs: { env: {}, secrets: {}, effective: {} },
    } as unknown as ResolvedRuntime;
  }

  it("carries postCommand through the lone-`default` re-synthesis", () => {
    const procs = resolveProcesses(flatRuntime, hookOverlay());
    expect(procs.default!.postCommand).toBe(
      'for f in /docker-entrypoint-initdb.d/*.sh; do bash "$f"; done',
    );
  });

  it("carries preCommand through the lone-`default` re-synthesis", () => {
    const procs = resolveProcesses(flatRuntime, hookOverlay());
    expect(procs.default!.preCommand).toBe("echo pre");
  });

  it("carries volumes through the lone-`default` re-synthesis", () => {
    const procs = resolveProcesses(flatRuntime, hookOverlay());
    expect(procs.default!.volumes).toEqual(volumes);
  });

  it("carries hooks and volumes when no processes are declared at all", () => {
    const procs = resolveProcesses(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub
      { processes: {} } as unknown as NormalizedService["runtime"],
      hookOverlay(),
    );
    expect(procs.default!.postCommand).toContain("docker-entrypoint-initdb.d");
    expect(procs.default!.volumes).toEqual(volumes);
  });
});
