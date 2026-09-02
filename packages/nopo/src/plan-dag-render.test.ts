/**
 * ASCII DAG renderer (M5). Snapshots for 3 fixtures; 0/1-node one-liner
 * suppression; width truncation with `…`. Every `needs` link draws at
 * least one horizontal-line glyph.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  deserializePlan,
  type Plan,
  planFromNodes,
  type PlanNode,
  type SerializedPlan,
} from "./plan.ts";
import {
  batchMembers,
  nodeLabel,
  renderPlanDag,
  renderSerializedPlanDag,
  renderTrivialSummary,
  truncateLabel,
} from "./plan-dag-render.ts";
import type { NodeStatus } from "./plan-runner.ts";

// ---------------------------------------------------------------------------
// Fixture loader

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "dag-render",
);

function loadFixture(file: string): SerializedPlan {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), "utf8");
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- fixture JSON shape is contractually SerializedPlan + optional _comment doc field
  const parsed = JSON.parse(raw) as SerializedPlan & { _comment?: string };
  const cleaned: SerializedPlan = { nodes: parsed.nodes };
  if (parsed.maxConcurrency !== undefined) {
    cleaned.maxConcurrency = parsed.maxConcurrency;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Helpers

function builtin(
  id: string,
  needs: readonly string[] = [],
  target?: string,
): PlanNode {
  const node: PlanNode = {
    id,
    handler: { kind: "builtin", name: "build:exec" },
    needs,
  };
  if (target !== undefined) node.target = target;
  return node;
}

// ---------------------------------------------------------------------------
// Snapshot tests for the 3 fixture topologies

describe("renderPlanDag — snapshots", () => {
  it("case 1: vanilla build with one shared package dep", () => {
    const plan = loadFixture("case-1-vanilla-build.json");
    expect(renderSerializedPlanDag(plan, { width: 120 })).toMatchSnapshot();
  });

  it("case 2: command check, per-task inner DAG (typecheck → lint → test)", () => {
    const plan = loadFixture("case-2-command-check.json");
    expect(renderSerializedPlanDag(plan, { width: 160 })).toMatchSnapshot();
  });

  it("case 3: pathological cross-stage edges and heavy fan-in", () => {
    const plan = loadFixture("case-3-pathological.json");
    expect(renderSerializedPlanDag(plan, { width: 160 })).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Trivial-plan one-liner suppression

describe("renderPlanDag — trivial-plan suppression", () => {
  it("renders a one-line summary for a 0-node plan", () => {
    const plan: Plan = { nodes: new Map() };
    const out = renderPlanDag(plan);
    expect(out).toBe("Plan: 0 nodes\n");
  });

  it("renders a one-line summary for a single-node plan", () => {
    const plan = planFromNodes([builtin("only", [], "af-api")]);
    const out = renderPlanDag(plan);
    expect(out).toBe("Plan: 1 node — build:exec af-api\n");
  });

  it("renderTrivialSummary handles a plugin-hook handler without target", () => {
    const node: PlanNode = {
      id: "n",
      handler: { kind: "plugin-hook", plugin: "docker", hook: "build" },
      needs: [],
    };
    const plan = planFromNodes([node]);
    expect(renderTrivialSummary(plan)).toBe("Plan: 1 node — docker.build");
  });

  it("falls through to the full renderer once node count > 1", () => {
    const plan = planFromNodes([
      builtin("a", [], "svc-a"),
      builtin("b", ["a"], "svc-b"),
    ]);
    const out = renderPlanDag(plan, { width: 80 });
    // Multi-line render with at least one box border glyph.
    expect(out).toContain("┌");
    expect(out).toContain("└");
    // No trivial-summary one-liner mixed in.
    expect(out.startsWith("Plan: 1 node")).toBe(false);
    expect(out.startsWith("Plan: 0 nodes")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Width truncation

describe("truncateLabel", () => {
  it("returns the input unchanged when it fits", () => {
    expect(truncateLabel("hello", 10)).toBe("hello");
    expect(truncateLabel("hello", 5)).toBe("hello");
  });

  it("truncates with `…` so the result exactly fits", () => {
    expect(truncateLabel("hello-world", 8)).toBe("hello-w…");
    expect(truncateLabel("hello-world", 8).length).toBe(8);
  });

  it("emits a single `…` at max=1", () => {
    expect(truncateLabel("abcdef", 1)).toBe("…");
  });

  it("returns empty for max=0", () => {
    expect(truncateLabel("anything", 0)).toBe("");
  });
});

describe("renderPlanDag — width truncation", () => {
  it("truncates long node labels with `…` rather than wrapping", () => {
    // Long target name; with a narrow width budget the renderer must
    // truncate so the box stays on a single row.
    const plan = planFromNodes([
      builtin(
        "a",
        [],
        "this-is-a-very-long-service-target-name-that-cannot-fit",
      ),
      builtin("b", ["a"], "short"),
    ]);
    const out = renderPlanDag(plan, { width: 80 });
    expect(out).toContain("…");
    // No newline-wrapped label fragments: every visible line that
    // contains the label segment should sit inside a single row.
    const lines = out.split("\n");
    // Sanity: every line has bounded length.
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge drawing — every needs link must show up

describe("renderPlanDag — edge drawing", () => {
  it("draws at least one horizontal-line glyph for each `needs` edge", () => {
    const plan = planFromNodes([
      builtin("root", [], "root"),
      builtin("mid-a", ["root"], "mid-a"),
      builtin("mid-b", ["root"], "mid-b"),
      builtin("leaf", ["mid-a", "mid-b"], "leaf"),
    ]);
    const out = renderPlanDag(plan, { width: 120 });
    // 4 edges; each route writes ≥2 `─` chars. Assert ≥8 horizontals
    // as a proxy that every edge reached the output.
    const horizontalChars = (out.match(/─/gu) ?? []).length;
    expect(horizontalChars).toBeGreaterThanOrEqual(8);
  });

  it("draws vertical bend glyphs when source and target rows differ", () => {
    const plan = planFromNodes([
      builtin("root", [], "root"),
      builtin("a", ["root"], "a"),
      builtin("b", ["root"], "b"),
      builtin("c", ["root"], "c"),
    ]);
    const out = renderPlanDag(plan, { width: 80 });
    // Three children spread vertically → at least one branch bends, so
    // we expect both `│` (vertical run) and a corner glyph.
    expect(out).toMatch(/[│]/u);
    expect(out).toMatch(/[┐└┘┌]/u);
  });
});

// ---------------------------------------------------------------------------
// Label formatting

describe("nodeLabel", () => {
  it("formats builtin handlers as `<name> <target>`", () => {
    const node: PlanNode = {
      id: "n",
      handler: { kind: "builtin", name: "build:exec" },
      needs: [],
      target: "af-api",
    };
    expect(nodeLabel(node)).toBe("build:exec af-api");
  });

  it("formats plugin-hook handlers as `<plugin>.<hook>`", () => {
    const node: PlanNode = {
      id: "n",
      handler: { kind: "plugin-hook", plugin: "docker", hook: "build" },
      needs: [],
      target: "af-api",
    };
    expect(nodeLabel(node)).toBe("docker.build af-api");
  });

  it("omits the target portion when target is undefined/empty", () => {
    const node: PlanNode = {
      id: "n",
      handler: { kind: "builtin", name: "build:pre" },
      needs: [],
    };
    expect(nodeLabel(node)).toBe("build:pre");
  });
});

// ---------------------------------------------------------------------------
// M9 — color-coded post-mortem render

/**
 * Build a `statuses` map: `all-success`, `all-skipped`, or `mixed-failure`.
 * Mixed: first node with a descendant fails; transitive needs skip;
 * independent branches stay `success`.
 */
function statusesForOutcome(
  plan: Plan,
  outcome: "all-success" | "mixed-failure" | "all-skipped",
): Map<string, NodeStatus> {
  const out = new Map<string, NodeStatus>();
  if (outcome === "all-success") {
    for (const id of plan.nodes.keys()) out.set(id, "success");
    return out;
  }
  if (outcome === "all-skipped") {
    for (const id of plan.nodes.keys()) out.set(id, "skipped");
    return out;
  }

  // mixed-failure: fail the first node with a descendant; skip
  // transitive descendants; mark everything else success.
  const ids = [...plan.nodes.keys()];
  // Build forward-edge map so we can compute descendants.
  const children = new Map<string, string[]>();
  for (const id of ids) children.set(id, []);
  for (const node of plan.nodes.values()) {
    for (const dep of node.needs) {
      const bucket = children.get(dep);
      if (bucket !== undefined) bucket.push(node.id);
    }
  }
  let seed: string | null = null;
  for (const id of ids) {
    if ((children.get(id) ?? []).length > 0) {
      seed = id;
      break;
    }
  }
  // Defensive fallback — single-node plans never reach this helper
  // because the renderer suppresses them, but keep the path total.
  if (seed === null) seed = ids[0] ?? "";

  const skipped = new Set<string>();
  const stack = [...(children.get(seed) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (skipped.has(id)) continue;
    skipped.add(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }

  for (const id of ids) {
    if (id === seed) out.set(id, "failure");
    else if (skipped.has(id)) out.set(id, "skipped");
    else out.set(id, "success");
  }
  return out;
}

describe("renderPlanDag — M9 color-coded snapshots", () => {
  // Cases mirror the M5 fixture set so layout stays identical and the
  // diff between M5 and M9 snapshots is purely the symbol overlay.
  const cases: Array<{ name: string; file: string; width: number }> = [
    {
      name: "case 1 vanilla build",
      file: "case-1-vanilla-build.json",
      width: 120,
    },
    {
      name: "case 2 command check",
      file: "case-2-command-check.json",
      width: 160,
    },
    {
      name: "case 3 pathological",
      file: "case-3-pathological.json",
      width: 160,
    },
  ];
  const outcomes: Array<"all-success" | "mixed-failure" | "all-skipped"> = [
    "all-success",
    "mixed-failure",
    "all-skipped",
  ];

  for (const c of cases) {
    for (const outcome of outcomes) {
      it(`${c.name} — ${outcome} (non-TTY, symbols only)`, () => {
        const plan = deserializePlan(loadFixture(c.file));
        const statuses = statusesForOutcome(plan, outcome);
        const out = renderPlanDag(plan, {
          width: c.width,
          statuses,
          useColor: false,
        });
        expect(out).toMatchSnapshot();
        // Non-TTY: symbols present, no ANSI escape codes.
        expect(out).not.toContain("\x1b[");
      });
    }
  }
});

describe("renderPlanDag — M9 status overlay invariants", () => {
  it("symbols ✓/✘/⊘ appear inside node boxes", () => {
    const plan = planFromNodes([
      builtin("a", [], "alpha"),
      builtin("b", ["a"], "beta"),
      builtin("c", ["a"], "gamma"),
    ]);
    const statuses = new Map<string, NodeStatus>([
      ["a", "failure"],
      ["b", "skipped"],
      ["c", "success"],
    ]);
    const out = renderPlanDag(plan, { width: 120, statuses, useColor: false });
    expect(out).toContain("✘ build:exec alpha");
    expect(out).toContain("⊘ build:exec beta");
    expect(out).toContain("✓ build:exec gamma");
  });

  it("missing status entry renders the node without a symbol", () => {
    const plan = planFromNodes([
      builtin("a", [], "alpha"),
      builtin("b", ["a"], "beta"),
    ]);
    // Only `a` has a status; `b` falls back to the M5 label.
    const statuses = new Map<string, NodeStatus>([["a", "success"]]);
    const out = renderPlanDag(plan, { width: 120, statuses, useColor: false });
    expect(out).toContain("✓ build:exec alpha");
    // `b` keeps the bare label — no symbol prefix.
    expect(out).toContain("build:exec beta");
    expect(out).not.toContain("✓ build:exec beta");
    expect(out).not.toContain("✘ build:exec beta");
    expect(out).not.toContain("⊘ build:exec beta");
  });

  it("useColor=true emits ANSI green/red/gray for success/failure/skipped", () => {
    const plan = planFromNodes([
      builtin("a", [], "alpha"),
      builtin("b", ["a"], "beta"),
      builtin("c", ["a"], "gamma"),
    ]);
    const statuses = new Map<string, NodeStatus>([
      ["a", "failure"],
      ["b", "skipped"],
      ["c", "success"],
    ]);
    const out = renderPlanDag(plan, { width: 120, statuses, useColor: true });
    // ANSI: red failure, gray skipped, green success, then reset.
    expect(out).toContain("\x1b[31m");
    expect(out).toContain("\x1b[90m");
    expect(out).toContain("\x1b[32m");
    expect(out).toContain("\x1b[0m");
  });

  it("useColor=false (non-TTY) emits no ANSI escape codes", () => {
    const plan = planFromNodes([
      builtin("a", [], "alpha"),
      builtin("b", ["a"], "beta"),
    ]);
    const statuses = new Map<string, NodeStatus>([
      ["a", "success"],
      ["b", "failure"],
    ]);
    const out = renderPlanDag(plan, { width: 120, statuses, useColor: false });
    expect(out).not.toContain("\x1b[");
    expect(out).toContain("✓ build:exec alpha");
    expect(out).toContain("✘ build:exec beta");
  });

  it("≤1-node plans suppress to the M5 trivial summary even with statuses", () => {
    // Auto-suppression matches M5 — no symbol prefix is layered onto
    // the one-line summary either; `renderTrivialSummary` is M5 code.
    const plan = planFromNodes([builtin("only", [], "af-api")]);
    const statuses = new Map<string, NodeStatus>([["only", "failure"]]);
    const out = renderPlanDag(plan, { width: 120, statuses, useColor: true });
    expect(out).toBe("Plan: 1 node — build:exec af-api\n");
  });
});

// ---------------------------------------------------------------------------
// MT3 — batch node rendering (meta.batchOf)

/**
 * Build a synthetic batch node — what `compactPlan` would produce after
 * folding `members` into a single `coalesced` node. Used by MT3 tests
 * so we don't need to spin up a real plugin pipeline.
 */
function batchNode(
  id: string,
  members: readonly string[],
  needs: readonly string[] = [],
): PlanNode {
  return {
    id,
    handler: { kind: "plugin-hook", plugin: "docker", hook: "build" },
    needs,
    meta: { batchOf: [...members] },
  };
}

describe("batchMembers", () => {
  it("returns the batchOf list for batch nodes", () => {
    const node = batchNode("build:bake", ["build:web", "build:backend"]);
    expect(batchMembers(node)).toEqual(["build:web", "build:backend"]);
  });

  it("returns null when meta is missing", () => {
    expect(batchMembers(builtin("a", [], "svc-a"))).toBeNull();
  });

  it("returns null when meta.batchOf is not an array", () => {
    const node: PlanNode = {
      id: "n",
      handler: { kind: "builtin", name: "build:exec" },
      needs: [],
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub for malformed meta
      meta: { batchOf: "build:web" as unknown as string[] },
    };
    expect(batchMembers(node)).toBeNull();
  });

  it("returns null when batchOf is an empty array", () => {
    // Defensive: compactPlan never emits an empty batchOf, but the
    // renderer shouldn't crash if a third-party plugin does.
    const node: PlanNode = {
      id: "n",
      handler: { kind: "builtin", name: "build:exec" },
      needs: [],
      meta: { batchOf: [] },
    };
    expect(batchMembers(node)).toBeNull();
  });

  it("filters out non-string entries (defensive)", () => {
    const node: PlanNode = {
      id: "n",
      handler: { kind: "builtin", name: "build:exec" },
      needs: [],

      meta: {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: deliberately mixed types to verify runtime string-filtering
        batchOf: ["build:web", 42, "build:backend"] as unknown as string[],
      },
    };
    expect(batchMembers(node)).toEqual(["build:web", "build:backend"]);
  });
});

describe("nodeLabel — MT3 batch suffix", () => {
  it("appends `[+N batched]` when the node carries meta.batchOf", () => {
    const node = batchNode("build:bake", [
      "build:web",
      "build:backend",
      "build:af-api",
    ]);
    expect(nodeLabel(node)).toBe("docker.build [+3 batched]");
  });

  it("includes the suffix even when target is set", () => {
    const node: PlanNode = {
      id: "build:bake",
      handler: { kind: "plugin-hook", plugin: "docker", hook: "build" },
      needs: [],
      target: "monorepo",
      meta: { batchOf: ["build:web", "build:backend"] },
    };
    expect(nodeLabel(node)).toBe("docker.build monorepo [+2 batched]");
  });

  it("leaves non-batch nodes untouched", () => {
    expect(nodeLabel(builtin("a", [], "alpha"))).toBe("build:exec alpha");
  });
});

describe("renderPlanDag — MT3 batch legend", () => {
  it("emits a trailing Batches: block listing every batch node's members", () => {
    const plan = planFromNodes([
      builtin("setup", [], "setup"),
      batchNode("build:bake", ["build:web", "build:backend"], ["setup"]),
      builtin("deploy", ["build:bake"], "deploy"),
    ]);
    const out = renderPlanDag(plan, { width: 120 });
    expect(out).toContain("Batches:");
    expect(out).toContain("  build:bake [contains: build:web, build:backend]");
    // The DAG itself shows the count suffix on the batch node's label.
    expect(out).toContain("docker.build [+2 batched]");
  });

  it("omits the Batches: block entirely when no node carries batchOf", () => {
    const plan = planFromNodes([
      builtin("a", [], "alpha"),
      builtin("b", ["a"], "beta"),
    ]);
    const out = renderPlanDag(plan, { width: 80 });
    expect(out).not.toContain("Batches:");
    expect(out).not.toContain("[contains:");
  });

  it("renders multiple batches in the legend (insertion order)", () => {
    const plan = planFromNodes([
      batchNode("build:bake", ["build:web", "build:backend"]),
      batchNode("test:bake", ["test:web", "test:backend"]),
    ]);
    const out = renderPlanDag(plan, { width: 160 });
    const bakeIdx = out.indexOf("build:bake [contains:");
    const testIdx = out.indexOf("test:bake [contains:");
    expect(bakeIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThan(bakeIdx);
  });
});
