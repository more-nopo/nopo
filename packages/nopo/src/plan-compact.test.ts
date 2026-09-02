import { describe, expect, it } from "vitest";

import type {
  NormalizedProjectConfig,
  NormalizedService,
} from "./config/index.ts";
import {
  type Plan,
  planFromNodes,
  type PlanNode,
  serializePlan,
  validatePlan,
} from "./plan.ts";
import {
  BatchClaimConflictError,
  type BatchSpec,
  type CompactionContext,
  compactPlan,
} from "./plan-compact.ts";
import type { LoadedPlugin, NopoPlugin } from "./plugin.ts";
import type { ScriptArgs } from "./script-args.ts";

// helpers

function pluginNode(id: string, overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    id,
    handler: { kind: "plugin-hook", plugin: "docker", hook: "build" },
    needs: [],
    ...overrides,
  };
}

function builtinNode(id: string, overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    id,
    handler: { kind: "builtin", name: "host-exec" },
    needs: [],
    ...overrides,
  };
}

function planOf(...nodes: PlanNode[]): Plan {
  return planFromNodes(nodes);
}

function makePlugin(name: string, batches: BatchSpec[] = []): LoadedPlugin {
  const definition: NopoPlugin = { name, batches };
  return { definition, serviceConfigs: {} };
}

function makeCtx(
  plugins: LoadedPlugin[] = [],
  overrides: Partial<CompactionContext> = {},
): CompactionContext {
  // Minimal project stub — compactPlan reads `plugins` off it; the rest is opaque
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
  const project = {
    name: "test-project",
    services: { dirs: [], entries: {}, targets: [] },
    plugins,
    pluginRefs: [],
    packageManagers: {},
  } as unknown as NormalizedProjectConfig;
  return {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
    services: {} as Record<string, NormalizedService>,
    project,
    env: {},
    // Tests don't read off args — compactPlan just hands the ctx to plugin specs. A typed stub
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
    args: {} as ScriptArgs,
    ...overrides,
  };
}

// no-op

describe("compactPlan — no-op", () => {
  it("returns a plan equal to the input when no plugins declare batches", () => {
    const plan = planOf(
      pluginNode("a"),
      pluginNode("b", { needs: ["a"] }),
      builtinNode("c", { needs: ["b"] }),
    );
    const out = compactPlan(plan, makeCtx());
    expect(serializePlan(out)).toEqual(serializePlan(plan));
  });

  it("returns a plan equal to the input when no spec claims any node", () => {
    const plan = planOf(pluginNode("a"), pluginNode("b"));
    const spec: BatchSpec = {
      claims: () => false,
      coalesce: () => {
        throw new Error("should not be called");
      },
    };
    const out = compactPlan(plan, makeCtx([makePlugin("docker", [spec])]));
    expect(serializePlan(out)).toEqual(serializePlan(plan));
  });
});

// single-spec, multi-claim

describe("compactPlan — single spec", () => {
  it("replaces N claimed nodes with a single batch node carrying union(needs) minus intra-batch ids", () => {
    const plan = planOf(
      builtinNode("root"),
      pluginNode("build:a", { needs: ["root"] }),
      pluginNode("build:b", { needs: ["root", "build:a"] }),
      pluginNode("build:c", { needs: ["build:b"] }),
    );
    const spec: BatchSpec = {
      claims: (node) => node.id.startsWith("build:"),
      coalesce: () => ({
        id: "build:batch",
        handler: {
          kind: "plugin-hook",
          plugin: "docker",
          hook: "build_batch",
        },
        payload: { kind: "buildx-bake" },
        meta: { renderer: "buildx" },
      }),
    };
    const out = compactPlan(plan, makeCtx([makePlugin("docker", [spec])]));
    expect([...out.nodes.keys()]).toEqual(["root", "build:batch"]);

    const batch = out.nodes.get("build:batch")!;
    expect(batch.needs).toEqual(["root"]);
    expect(batch.handler).toEqual({
      kind: "plugin-hook",
      plugin: "docker",
      hook: "build_batch",
    });
    expect(batch.payload).toEqual({ kind: "buildx-bake" });
    expect(batch.meta).toMatchObject({
      renderer: "buildx",
      batchOf: ["build:a", "build:b", "build:c"],
    });
  });

  it("produces a batch node even when only one node is claimed (uniform path)", () => {
    const plan = planOf(pluginNode("a"), pluginNode("b", { needs: ["a"] }));
    const spec: BatchSpec = {
      claims: (node) => node.id === "b",
      coalesce: () => ({
        id: "batch",
        handler: {
          kind: "plugin-hook",
          plugin: "docker",
          hook: "b_batch",
        },
      }),
    };
    const out = compactPlan(plan, makeCtx([makePlugin("docker", [spec])]));
    expect([...out.nodes.keys()]).toEqual(["a", "batch"]);
    const batch = out.nodes.get("batch")!;
    expect(batch.needs).toEqual(["a"]);
    expect(batch.meta).toEqual({ batchOf: ["b"] });
  });
});

// rewiring

describe("compactPlan — dependent rewiring", () => {
  it("rewrites non-claimed nodes' needs from claimed ids to the batch id (deduped)", () => {
    const plan = planOf(
      pluginNode("build:a"),
      pluginNode("build:b"),
      builtinNode("downstream", { needs: ["build:a", "build:b"] }),
      builtinNode("other", { needs: ["downstream"] }),
    );
    const spec: BatchSpec = {
      claims: (node) => node.id.startsWith("build:"),
      coalesce: () => ({
        id: "build:batch",
        handler: {
          kind: "plugin-hook",
          plugin: "docker",
          hook: "build_batch",
        },
      }),
    };
    const out = compactPlan(plan, makeCtx([makePlugin("docker", [spec])]));
    expect(out.nodes.get("downstream")!.needs).toEqual(["build:batch"]);
    expect(out.nodes.get("other")!.needs).toEqual(["downstream"]);
  });
});

// conflicts

describe("compactPlan — conflict detection", () => {
  it("throws BatchClaimConflictError when two specs claim the same node", () => {
    const plan = planOf(pluginNode("a"));
    const specA: BatchSpec = {
      claims: () => true,
      coalesce: () => ({
        id: "batch-a",
        handler: { kind: "plugin-hook", plugin: "x", hook: "h" },
      }),
    };
    const specB: BatchSpec = {
      claims: () => true,
      coalesce: () => ({
        id: "batch-b",
        handler: { kind: "plugin-hook", plugin: "y", hook: "h" },
      }),
    };
    const ctx = makeCtx([
      makePlugin("plugin-a", [specA]),
      makePlugin("plugin-b", [specB]),
    ]);
    expect(() => compactPlan(plan, ctx)).toThrowError(BatchClaimConflictError);
    try {
      compactPlan(plan, ctx);
    } catch (err) {
      if (!(err instanceof BatchClaimConflictError)) throw err;
      expect(err.nodeId).toBe("a");
      expect(err.message).toContain("a");
      expect(err.message).toContain("plugin-a");
      expect(err.message).toContain("plugin-b");
    }
  });

  it("throws when two specs WITHIN one plugin claim the same node", () => {
    const plan = planOf(pluginNode("a"));
    const spec1: BatchSpec = {
      claims: () => true,
      coalesce: () => ({
        id: "b1",
        handler: { kind: "plugin-hook", plugin: "x", hook: "h" },
      }),
    };
    const spec2: BatchSpec = {
      claims: () => true,
      coalesce: () => ({
        id: "b2",
        handler: { kind: "plugin-hook", plugin: "x", hook: "h" },
      }),
    };
    const ctx = makeCtx([makePlugin("x", [spec1, spec2])]);
    expect(() => compactPlan(plan, ctx)).toThrowError(BatchClaimConflictError);
  });
});

// cycles surface via validatePlan

describe("compactPlan — cycle introduction", () => {
  it("compaction that introduces a cycle is rejected by validatePlan", () => {
    // Claim {a, c}: union of their needs is {b} (a has none, c has b). After rewriting
    // non-claimed nodes' needs ({a} → {batch} on b), the topology is: b.needs = [batch]
    const plan = planOf(
      pluginNode("a"),
      pluginNode("b", { needs: ["a"] }),
      pluginNode("c", { needs: ["b"] }),
    );
    const spec: BatchSpec = {
      claims: (node) => node.id === "a" || node.id === "c",
      coalesce: () => ({
        id: "ac-batch",
        handler: {
          kind: "plugin-hook",
          plugin: "docker",
          hook: "ac",
        },
      }),
    };
    const out = compactPlan(plan, makeCtx([makePlugin("docker", [spec])]));
    expect(() => validatePlan(out)).toThrowError(/cycle/i);
  });
});
