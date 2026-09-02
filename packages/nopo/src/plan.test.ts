import { describe, expect, it } from "vitest";

import {
  deserializePlan,
  getRoots,
  mergePlans,
  type Plan,
  planFromNodes,
  type PlanHandler,
  PlanMergeError,
  type PlanNode,
  serializePlan,
  validatePlan,
} from "./plan.ts";

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

// PlanHandler / PlanNode shape

describe("PlanHandler discrimination", () => {
  it("narrows correctly on `kind`", () => {
    const handlers: PlanHandler[] = [
      { kind: "plugin-hook", plugin: "docker", hook: "build" },
      { kind: "builtin", name: "host-exec" },
    ];
    const summaries = handlers.map((h) => {
      // exhaustive switch — TS narrows each branch
      switch (h.kind) {
        case "plugin-hook":
          return `${h.plugin}:${h.hook}`;
        case "builtin":
          return h.name;
      }
    });
    expect(summaries).toEqual(["docker:build", "host-exec"]);
  });
});

describe("PlanNode structural shape", () => {
  it("accepts an empty `needs` array", () => {
    const node = pluginNode("a");
    expect(node.needs).toEqual([]);
  });

  it("accepts `needs` referencing other ids without enforcing presence", () => {
    // Referential integrity is validatePlan's job, not the constructor's.
    const node = pluginNode("a", { needs: ["other-id"] });
    expect(node.needs).toEqual(["other-id"]);
  });
});

// mergePlans

describe("mergePlans", () => {
  it("returns an empty plan for empty input", () => {
    const merged = mergePlans([]);
    expect(merged.nodes.size).toBe(0);
    expect(merged.maxConcurrency).toBeUndefined();
  });

  it("returns an equivalent plan for a single-plan input", () => {
    const plan = planOf(pluginNode("a"), builtinNode("b"));
    const merged = mergePlans([plan]);
    expect([...merged.nodes.keys()]).toEqual(["a", "b"]);
  });

  it("clones the single-plan input (no Map aliasing)", () => {
    const plan = planOf(pluginNode("a"));
    const merged = mergePlans([plan]);
    expect(merged.nodes).not.toBe(plan.nodes);
  });

  it("unions two plans with no overlap", () => {
    const p1 = planOf(pluginNode("a"));
    const p2 = planOf(builtinNode("b"));
    const merged = mergePlans([p1, p2]);
    expect([...merged.nodes.keys()]).toEqual(["a", "b"]);
    expect(merged.nodes.get("a")?.handler.kind).toBe("plugin-hook");
    expect(merged.nodes.get("b")?.handler.kind).toBe("builtin");
  });

  it("preserves insertion order across plans", () => {
    const p1 = planOf(pluginNode("first"), pluginNode("second"));
    const p2 = planOf(pluginNode("third"), pluginNode("fourth"));
    const merged = mergePlans([p1, p2]);
    expect([...merged.nodes.keys()]).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("silently de-dups identical-content duplicate ids", () => {
    const a1 = pluginNode("a", { needs: ["x", "y"], target: "svc" });
    const a2 = pluginNode("a", { needs: ["y", "x"], target: "svc" }); // needs reordered
    const merged = mergePlans([planOf(a1), planOf(a2)]);
    expect(merged.nodes.size).toBe(1);
    expect(merged.nodes.get("a")?.needs).toEqual(["x", "y"]); // first wins
  });

  it("throws PlanMergeError when duplicate ids differ on `needs`", () => {
    const a1 = pluginNode("a", { needs: ["x"] });
    const a2 = pluginNode("a", { needs: ["y"] });
    expect(() => mergePlans([planOf(a1), planOf(a2)])).toThrow(PlanMergeError);
    let caught: unknown;
    try {
      mergePlans([planOf(a1), planOf(a2)]);
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof PlanMergeError)) {
      throw new Error("expected PlanMergeError");
    }
    expect(caught.conflictingId).toBe("a");
    expect(caught.message).toContain('"a"');
    expect(caught.message).toContain("needs");
  });

  it("throws PlanMergeError when duplicate ids differ on handler kind", () => {
    const a1 = pluginNode("a");
    const a2 = builtinNode("a");
    expect(() => mergePlans([planOf(a1), planOf(a2)])).toThrow(PlanMergeError);
  });

  it("throws PlanMergeError when duplicate ids differ on payload", () => {
    const a1 = pluginNode("a", { payload: { v: 1 } });
    const a2 = pluginNode("a", { payload: { v: 2 } });
    expect(() => mergePlans([planOf(a1), planOf(a2)])).toThrow(/payload/);
  });

  it("maxConcurrency: both undefined → undefined", () => {
    const merged = mergePlans([
      planOf(pluginNode("a")),
      planOf(pluginNode("b")),
    ]);
    expect(merged.maxConcurrency).toBeUndefined();
  });

  it("maxConcurrency: one defined → that value", () => {
    const p1 = planFromNodes([pluginNode("a")], { maxConcurrency: 4 });
    const p2 = planOf(pluginNode("b"));
    expect(mergePlans([p1, p2]).maxConcurrency).toBe(4);
    expect(mergePlans([p2, p1]).maxConcurrency).toBe(4);
  });

  it("maxConcurrency: both defined → min", () => {
    const p1 = planFromNodes([pluginNode("a")], { maxConcurrency: 8 });
    const p2 = planFromNodes([pluginNode("b")], { maxConcurrency: 3 });
    expect(mergePlans([p1, p2]).maxConcurrency).toBe(3);
  });
});

// serializePlan / deserializePlan

describe("serializePlan / deserializePlan", () => {
  it("round-trips an empty plan", () => {
    const plan: Plan = { nodes: new Map() };
    const s = serializePlan(plan);
    expect(s).toEqual({ nodes: [] });
    const back = deserializePlan(s);
    expect(back.nodes.size).toBe(0);
    expect(back.maxConcurrency).toBeUndefined();
  });

  it("survives JSON.stringify/JSON.parse with deep equality", () => {
    const plan = planFromNodes(
      [
        pluginNode("a", { target: "svc-a", payload: { count: 2 } }),
        builtinNode("b", { needs: ["a"], meta: { source: "script" } }),
      ],
      { maxConcurrency: 5 },
    );
    const direct = serializePlan(plan);
    const roundtripped: unknown = JSON.parse(JSON.stringify(direct));
    expect(roundtripped).toEqual(direct);
  });

  it("deserializePlan(serializePlan(p)) is structurally equivalent", () => {
    const plan = planFromNodes(
      [
        pluginNode("a", { payload: { x: 1 } }),
        builtinNode("b", { needs: ["a"], target: "svc" }),
      ],
      { maxConcurrency: 2 },
    );
    const back = deserializePlan(serializePlan(plan));
    expect([...back.nodes.keys()]).toEqual(["a", "b"]);
    expect(back.nodes.get("b")?.needs).toEqual(["a"]);
    expect(back.nodes.get("b")?.target).toBe("svc");
    expect(back.nodes.get("a")?.payload).toEqual({ x: 1 });
    expect(back.maxConcurrency).toBe(2);
  });

  it("preserves insertion order through round-trip", () => {
    const ids = ["env", "build:af-api", "cmd:lint:web", "deploy"];
    const plan = planFromNodes(ids.map((id) => pluginNode(id)));
    const back = deserializePlan(serializePlan(plan));
    expect([...back.nodes.keys()]).toEqual(ids);
  });

  it("round-trips arbitrary JSON-safe payload + meta", () => {
    const payload = { list: [1, "two", { nested: true }], n: null };
    const meta = { tag: "v1", attrs: { k: ["a", "b"] } };
    const plan = planOf(pluginNode("a", { payload, meta }));
    const back = deserializePlan(serializePlan(plan));
    expect(back.nodes.get("a")?.payload).toEqual(payload);
    expect(back.nodes.get("a")?.meta).toEqual(meta);
  });

  it("omits maxConcurrency from serialized form when unset", () => {
    const plan = planOf(pluginNode("a"));
    const s = serializePlan(plan);
    expect("maxConcurrency" in s).toBe(false);
  });

  it("includes maxConcurrency when set", () => {
    const plan = planFromNodes([pluginNode("a")], { maxConcurrency: 7 });
    const s = serializePlan(plan);
    expect(s.maxConcurrency).toBe(7);
  });

  it("omits absent optional node fields from serialized form", () => {
    const plan = planOf(pluginNode("a"));
    const s = serializePlan(plan);
    const node = s.nodes[0]!;
    expect("target" in node).toBe(false);
    expect("payload" in node).toBe(false);
    expect("meta" in node).toBe(false);
  });
});

// planFromNodes

describe("planFromNodes", () => {
  it("builds a plan and preserves order", () => {
    const plan = planFromNodes([pluginNode("a"), pluginNode("b")]);
    expect([...plan.nodes.keys()]).toEqual(["a", "b"]);
  });

  it("rejects duplicate ids", () => {
    expect(() => planFromNodes([pluginNode("a"), pluginNode("a")])).toThrow(
      PlanMergeError,
    );
  });

  it("carries maxConcurrency from opts", () => {
    const plan = planFromNodes([pluginNode("a")], { maxConcurrency: 4 });
    expect(plan.maxConcurrency).toBe(4);
  });
});

// validatePlan

describe("validatePlan", () => {
  it("accepts a plan with valid `needs`", () => {
    const plan = planFromNodes([
      pluginNode("a"),
      pluginNode("b", { needs: ["a"] }),
    ]);
    expect(() => validatePlan(plan)).not.toThrow();
  });

  it("rejects a `needs` reference to an unknown node", () => {
    const plan = planOf(pluginNode("b", { needs: ["missing"] }));
    expect(() => validatePlan(plan)).toThrow(/unknown node "missing"/);
  });

  it("rejects a cycle in `needs`", () => {
    const plan = planFromNodes([
      pluginNode("a", { needs: ["b"] }),
      pluginNode("b", { needs: ["a"] }),
    ]);
    expect(() => validatePlan(plan)).toThrow(/cycle/);
  });
});

// getRoots

describe("getRoots", () => {
  it("returns nodes with empty needs in insertion order", () => {
    const plan = planFromNodes([
      pluginNode("a"),
      pluginNode("b", { needs: ["a"] }),
      pluginNode("c"),
    ]);
    const roots = getRoots(plan);
    expect(roots.map((n) => n.id)).toEqual(["a", "c"]);
  });
});
