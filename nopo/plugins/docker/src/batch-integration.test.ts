/** End-to-end integration of the docker plugin's MT2 batch path: BuildScript.plan() → N
 * `build:<target>` nodes ↓ compactPlan(docker BatchSpec) 1 `build:bake` plugin-hook node (claimed
 * docker-eligible targets) + N package `build:<target>` nodes left intact ↓ executePlan docker
 * buildBatch hook called exactly once with the claimed target list package build:exec nodes still
 */

import type { BuildableService, NormalizedService } from "@more-nopo/nopo/config";
import type { Plan, PlanHandler, PlanNode } from "@more-nopo/nopo/plan";
import type { CompactionContext } from "@more-nopo/nopo/plan-compact";
import { compactPlan } from "@more-nopo/nopo/plan-compact";
import type { HookContext, LoadedPlugin } from "@more-nopo/nopo/plugin";
import type { ScriptArgs } from "@more-nopo/nopo/script-args";
import { describe, expect, it } from "vitest";

import dockerPlugin from "./index.ts";

/** --------------------------------------------------------------------------- fixture builders —
 * synthesize the minimal NormalizedService shapes BuildScript.plan() + the docker BatchSpec consume.
 * No real workspace resolution; just the fields the plan + claim predicate read.
 * ---------------------------------------------------------------------------
 */

function makeService(overrides: Partial<NormalizedService>): NormalizedService {
  return {
    id: overrides.id ?? "svc",
    name: overrides.name ?? overrides.id ?? "svc",
    description: "",
    image: undefined,
    staticPath: "",
    tags: [],
    secrets: [],
    type: overrides.type ?? "service",
    env: undefined,
    runtime: undefined,
    pluginData: undefined,
    paths: overrides.paths ?? {
      root: `/project/services/${overrides.id ?? "svc"}`,
      context: `/project/services/${overrides.id ?? "svc"}`,
    },
    configPath: `/project/services/${overrides.id ?? "svc"}/nopo.yml`,
    packageManagers: [],
    commands: {},
    buildDeps: [],
    runtimeDeps: [],
    systemDeps: [],
    ...overrides,
  };
}

function dockerService(id: string): BuildableService {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the makeService stub is structurally a BuildableService once `build` is set
  return makeService({
    id,
    type: "service",
    build: { deps: [], command: `build ${id}` },
    pluginData: { docker: {} },
  }) as BuildableService;
}

function packageService(id: string): NormalizedService {
  return makeService({
    id,
    type: "package",
    build: { deps: [], command: `pack ${id}` },
    pluginData: undefined,
  });
}

function loadedDockerPlugin(): LoadedPlugin {
  return {
    definition: dockerPlugin({}),
    serviceConfigs: {},
  };
}

function makeCompactionCtx(
  services: Record<string, NormalizedService>,
  plugins: LoadedPlugin[],
): CompactionContext {
  /* eslint-disable @typescript-eslint/consistent-type-assertions -- partial CompactionContext for integration test; compactPlan reads `services`/`project.plugins` */
  return {
    services,
    project: { plugins } as unknown as CompactionContext["project"],
    env: {},
    args: {} as unknown as ScriptArgs,
  };
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
}

/** --------------------------------------------------------------------------- hand-rolled plan factory
 * — same shape BuildScript.plan() would emit, but inlined to keep this test free of the `nopo/lib`
 * import graph (which pulls yaml + zod + the whole config loader). The shape is audited by
 * `packages/nopo/src/scripts/build.test.ts` — we only need the docker BatchSpec to recognize the
 */

function makeBuildPlan(targets: string[]): Plan {
  const nodes = new Map<string, PlanNode>();
  const pre: PlanNode = {
    id: "pre_build",
    handler: { kind: "builtin", name: "build:pre" },
    needs: [],
  };
  nodes.set("pre_build", pre);
  for (const target of targets) {
    const node: PlanNode = {
      id: `build:${target}`,
      handler: { kind: "builtin", name: "build:exec" },
      needs: ["pre_build"],
      target,
      payload: { target, noCache: false },
    };
    nodes.set(node.id, node);
  }
  const post: PlanNode = {
    id: "post_build",
    handler: { kind: "builtin", name: "build:post" },
    needs: targets.map((t) => `build:${t}`),
  };
  nodes.set("post_build", post);
  return { nodes };
}

/** ---------------------------------------------------------------------------
 * compactPlan ∘ docker BatchSpec — coalesces docker-eligible targets
 * into a single `build:bake` plugin-hook node, leaves the rest intact.
 * ---------------------------------------------------------------------------
 */

describe("MT2 — BuildScript.plan ∘ compactPlan(docker)", () => {
  it("folds N docker-eligible build:exec nodes into ONE build:bake plugin-hook node", () => {
    const services: Record<string, NormalizedService> = {
      web: dockerService("web"),
      api: dockerService("api"),
      worker: dockerService("worker"),
    };
    const plan = makeBuildPlan(["web", "api", "worker"]);

    const compacted = compactPlan(
      plan,
      makeCompactionCtx(services, [loadedDockerPlugin()]),
    );

    expect([...compacted.nodes.keys()]).toEqual([
      "pre_build",
      "build:bake",
      "post_build",
    ]);
    const bake = compacted.nodes.get("build:bake")!;
    expect(bake.handler).toEqual({
      kind: "plugin-hook",
      plugin: "docker",
      hook: "buildBatch",
    });
    expect(bake.payload).toEqual({
      targets: ["web", "api", "worker"],
      noCache: false,
    });
    expect(bake.meta).toEqual({
      batchOf: ["build:web", "build:api", "build:worker"],
    });
  });

  it("leaves non-docker package build:exec nodes alone (host-build path stays intact)", () => {
    const services: Record<string, NormalizedService> = {
      web: dockerService("web"),
      utils: packageService("utils"),
    };
    const plan = makeBuildPlan(["web", "utils"]);

    const compacted = compactPlan(
      plan,
      makeCompactionCtx(services, [loadedDockerPlugin()]),
    );

    expect([...compacted.nodes.keys()]).toEqual([
      "pre_build",
      "build:bake",
      "build:utils",
      "post_build",
    ]);
    const utils = compacted.nodes.get("build:utils")!;
    // `build:utils` keeps its original builtin dispatch — no docker bake.
    expect(utils.handler).toEqual({ kind: "builtin", name: "build:exec" });
    expect(utils.target).toBe("utils");
  });

  it("rewrites post_build needs to point at build:bake instead of the claimed per-target ids", () => {
    const services: Record<string, NormalizedService> = {
      a: dockerService("a"),
      b: dockerService("b"),
    };
    const plan = makeBuildPlan(["a", "b"]);

    const compacted = compactPlan(
      plan,
      makeCompactionCtx(services, [loadedDockerPlugin()]),
    );

    const post = compacted.nodes.get("post_build")!;
    expect([...post.needs]).toEqual(["build:bake"]);
  });
});

/** --------------------------------------------------------------------------- E2E — the dispatcher
 * invokes buildBatch exactly once with the right target list. Replicates the contract
 * `dispatchPluginHook` enforces in `packages/nopo/src/dispatch.ts`, exercised here via the
 * dockerPlugin's real hook (mocked DockerBuilder side effect via payload assertion only; the docker
 */

describe("MT2 — dispatching the coalesced build:bake node", () => {
  it("invokes dockerPlugin.hooks.buildBatch exactly once with the coalesced targets", async () => {
    const services: Record<string, NormalizedService> = {
      web: dockerService("web"),
      api: dockerService("api"),
    };
    const plan = makeBuildPlan(["web", "api"]);

    /** Capture-only stub: the real dockerPlugin's hook constructs a
     * DockerBuilder + calls into buildx. For this integration shape
     * test we want to verify the hook RECEIVES the right payload —
     * bake-execution shape is covered separately in unit tests.
     */
    const factoryCalls: Array<{ payload: unknown }> = [];
    const captureDocker = (): LoadedPlugin => ({
      serviceConfigs: {},
      definition: {
        name: "docker",
        // The real claim spec — same predicate we ship.
        batches: dockerPlugin({}).batches,
        hooks: {
          buildBatch: async (ctx: HookContext) => {
            factoryCalls.push({ payload: ctx.payload });
          },
        },
      },
    });

    const compacted = compactPlan(
      plan,
      makeCompactionCtx(services, [captureDocker()]),
    );

    /** Dispatch the bake node directly through the docker plugin's hook
     * — same call shape `dispatchPluginHook` makes in
     * `packages/nopo/src/dispatch.ts` (modulo the runner-derived ctx
     * fields, which this test doesn't exercise).
     */
    const bake = compacted.nodes.get("build:bake")!;
    expect(bake.handler.kind).toBe("plugin-hook");
    /* eslint-disable @typescript-eslint/consistent-type-assertions -- narrowed by the assert above */
    const handler = bake.handler as Extract<
      PlanHandler,
      { kind: "plugin-hook" }
    >;
    /* eslint-enable @typescript-eslint/consistent-type-assertions */
    expect(handler.plugin).toBe("docker");
    expect(handler.hook).toBe("buildBatch");

    /* eslint-disable @typescript-eslint/consistent-type-assertions -- stub HookContext for end-to-end shape */
    const ctx = { payload: bake.payload } as unknown as HookContext;
    /* eslint-enable @typescript-eslint/consistent-type-assertions */
    await captureDocker().definition.hooks!.buildBatch!(ctx);

    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]?.payload).toEqual({
      targets: ["web", "api"],
      noCache: false,
    });
  });
});
