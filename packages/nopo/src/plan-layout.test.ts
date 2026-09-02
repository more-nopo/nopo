import { describe, expect, it } from "vitest";

import { type Plan, planFromNodes, type PlanNode } from "./plan.ts";
import { computeStages, verticalOrderWithinStage } from "./plan-layout.ts";

function node(id: string, needs: readonly string[] = []): PlanNode {
  return {
    id,
    handler: { kind: "plugin-hook", plugin: "docker", hook: "build" },
    needs,
  };
}

function planOf(...nodes: PlanNode[]): Plan {
  return planFromNodes(nodes);
}

// computeStages

describe("computeStages", () => {
  it("places a single node at stage 0", () => {
    const plan = planOf(node("a"));
    const stages = computeStages(plan);
    expect(stages.get("a")).toBe(0);
    expect(stages.size).toBe(1);
  });

  it("layers a linear chain (a -> b -> c -> d)", () => {
    const plan = planOf(
      node("a"),
      node("b", ["a"]),
      node("c", ["b"]),
      node("d", ["c"]),
    );
    const stages = computeStages(plan);
    expect(stages.get("a")).toBe(0);
    expect(stages.get("b")).toBe(1);
    expect(stages.get("c")).toBe(2);
    expect(stages.get("d")).toBe(3);
  });

  it("layers fan-out (a -> {b, c, d})", () => {
    const plan = planOf(
      node("a"),
      node("b", ["a"]),
      node("c", ["a"]),
      node("d", ["a"]),
    );
    const stages = computeStages(plan);
    expect(stages.get("a")).toBe(0);
    expect(stages.get("b")).toBe(1);
    expect(stages.get("c")).toBe(1);
    expect(stages.get("d")).toBe(1);
  });

  it("layers fan-in ({a, b, c} -> d)", () => {
    const plan = planOf(
      node("a"),
      node("b"),
      node("c"),
      node("d", ["a", "b", "c"]),
    );
    const stages = computeStages(plan);
    expect(stages.get("a")).toBe(0);
    expect(stages.get("b")).toBe(0);
    expect(stages.get("c")).toBe(0);
    expect(stages.get("d")).toBe(1);
  });

  it("respects ASAP semantics across cross-stage edges", () => {
    // a -> b -> c (b at 1, c at 2) a -> c (cross-stage edge: c stays at 2 because max(b=1,
    // a=0)+1 = 2) a -> d -> e -> f (d=1, e=2, f=3) f -> g (g=4) a -> g
    const plan = planOf(
      node("a"),
      node("b", ["a"]),
      node("c", ["a", "b"]),
      node("d", ["a"]),
      node("e", ["d"]),
      node("f", ["e"]),
      node("g", ["a", "f"]),
    );
    const stages = computeStages(plan);
    expect(stages.get("a")).toBe(0);
    expect(stages.get("b")).toBe(1);
    expect(stages.get("c")).toBe(2);
    expect(stages.get("d")).toBe(1);
    expect(stages.get("e")).toBe(2);
    expect(stages.get("f")).toBe(3);
    expect(stages.get("g")).toBe(4);
  });

  it("handles parallel chains with multiple roots", () => {
    // chain 1: a -> b -> c
    // chain 2: x -> y
    const plan = planOf(
      node("a"),
      node("x"),
      node("b", ["a"]),
      node("y", ["x"]),
      node("c", ["b"]),
    );
    const stages = computeStages(plan);
    expect(stages.get("a")).toBe(0);
    expect(stages.get("x")).toBe(0);
    expect(stages.get("b")).toBe(1);
    expect(stages.get("y")).toBe(1);
    expect(stages.get("c")).toBe(2);
  });

  it("returns an empty map for an empty plan", () => {
    const stages = computeStages(planFromNodes([]));
    expect(stages.size).toBe(0);
  });

  it("throws on a cyclic plan via validatePlan", () => {
    // direct cycle a <-> b
    const plan = planOf(node("a", ["b"]), node("b", ["a"]));
    expect(() => computeStages(plan)).toThrow(/cycle/i);
  });
});

// verticalOrderWithinStage

describe("verticalOrderWithinStage", () => {
  it("preserves plan-insertion order for stage 0", () => {
    const plan = planOf(node("c"), node("a"), node("b"));
    const stages = computeStages(plan);
    const order = verticalOrderWithinStage(plan, stages);
    expect(order.get(0)).toEqual(["c", "a", "b"]);
  });

  it("orders stage 1 by barycenter of predecessors in stage 0", () => {
    // Stage 0: [r0, r1, r2] Stage 1: x -> r2 (bary 2), y -> r0 (bary 0), z -> r1 (bary 1)
    // Expected order: y (0), z (1), x (2)
    const plan = planOf(
      node("r0"),
      node("r1"),
      node("r2"),
      node("x", ["r2"]),
      node("y", ["r0"]),
      node("z", ["r1"]),
    );
    const stages = computeStages(plan);
    const order = verticalOrderWithinStage(plan, stages);
    expect(order.get(0)).toEqual(["r0", "r1", "r2"]);
    expect(order.get(1)).toEqual(["y", "z", "x"]);
  });

  it("breaks barycenter ties using plan insertion order (stable)", () => {
    // Two stage-1 nodes both depend on r0 and r1 -> identical barycenter
    // (mean position 0.5). Must preserve insertion order: x then y.
    const plan = planOf(
      node("r0"),
      node("r1"),
      node("x", ["r0", "r1"]),
      node("y", ["r0", "r1"]),
    );
    const stages = computeStages(plan);
    const order = verticalOrderWithinStage(plan, stages);
    expect(order.get(1)).toEqual(["x", "y"]);
  });

  it("ignores cross-stage edges to non-(N-1) predecessors when computing barycenter", () => {
    // Stage 0: [r0, r1] Stage 1: m0 (needs r0) idx 0, m1 (needs r1) idx 1 Stage 2: x (needs
    // m1, r0) — only m1 is in stage 1; bary uses m1=1 y (needs m0) — bary uses m0=0 Expected
    const plan = planOf(
      node("r0"),
      node("r1"),
      node("m0", ["r0"]),
      node("m1", ["r1"]),
      node("x", ["m1", "r0"]),
      node("y", ["m0"]),
    );
    const stages = computeStages(plan);
    expect(stages.get("x")).toBe(2);
    expect(stages.get("y")).toBe(2);
    const order = verticalOrderWithinStage(plan, stages);
    expect(order.get(1)).toEqual(["m0", "m1"]);
    expect(order.get(2)).toEqual(["y", "x"]);
  });

  it("handles parallel independent chains without crossing them", () => {
    // chain 1: a (stage 0, idx 0) -> b (stage 1) chain 2: x (stage 0, idx 1) -> y (stage 1)
    // Stage 0 order: [a, x]. b's bary = 0, y's bary = 1. > stage 1: [b, y] (no crossings).
    const plan = planOf(
      node("a"),
      node("x"),
      node("b", ["a"]),
      node("y", ["x"]),
    );
    const stages = computeStages(plan);
    const order = verticalOrderWithinStage(plan, stages);
    expect(order.get(0)).toEqual(["a", "x"]);
    expect(order.get(1)).toEqual(["b", "y"]);
  });

  it("returns an empty map for an empty plan", () => {
    const plan = planFromNodes([]);
    const stages = computeStages(plan);
    const order = verticalOrderWithinStage(plan, stages);
    expect(order.size).toBe(0);
  });
});
