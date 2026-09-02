/** Computes ASAP topological stages (each node placed at `1 + max(stage of needs)`) and a
 * stable vertical ordering within each stage that minimizes edge crossings via the
 * standard barycenter heuristic. No IO, no Runner, no plugin imports — easily reusable by
 * both the `--print` renderer and the streaming TUI.
 */

import { type Plan, validatePlan } from "./plan.ts";

/** Compute each node's ASAP stage: Roots (no `needs`) are stage 0. Every other node is `1 +
 * max(stage of needs)`. Validates the plan first; throws on missing `needs` references or
 * cycles.
 */
export function computeStages(plan: Plan): Map<string, number> {
  validatePlan(plan);

  const stages = new Map<string, number>();

  // Iterative memoized DFS — handles arbitrary topology in a single pass without relying on
  // a particular nodes Map ordering. Plan was already cycle-checked by `validatePlan`, so we
  const computeFor = (id: string): number => {
    const cached = stages.get(id);
    if (cached !== undefined) return cached;

    const node = plan.nodes.get(id);
    // unreachable: validatePlan would have thrown for unknown ids
    if (node === undefined) {
      throw new Error(`Plan node "${id}" not found`);
    }

    if (node.needs.length === 0) {
      stages.set(id, 0);
      return 0;
    }

    let maxParent = -1;
    for (const dep of node.needs) {
      const depStage = computeFor(dep);
      if (depStage > maxParent) maxParent = depStage;
    }
    const stage = maxParent + 1;
    stages.set(id, stage);
    return stage;
  };

  for (const id of plan.nodes.keys()) {
    computeFor(id);
  }

  return stages;
}

/** Group nodes by stage and order them within each stage to minimize edge crossings using
 * the barycenter heuristic: a node's position is the average index of its predecessors in
 * the previous stage's ordering. Roots (and any node with no predecessors in stage-1) keep
 * their plan-insertion order as a stable tiebreaker; ties at later stages are also broken
 */
export function verticalOrderWithinStage(
  plan: Plan,
  stages: Map<string, number>,
): Map<number, string[]> {
  // Insertion order becomes the stable tiebreaker; we capture it explicitly so a later sort
  // doesn't lose it.
  const byStage = new Map<number, string[]>();
  const insertionIndex = new Map<string, number>();
  let idx = 0;
  for (const id of plan.nodes.keys()) {
    insertionIndex.set(id, idx++);
    const stage = stages.get(id);
    if (stage === undefined) {
      throw new Error(`computeStages did not assign a stage to "${id}"`);
    }
    let bucket = byStage.get(stage);
    if (bucket === undefined) {
      bucket = [];
      byStage.set(stage, bucket);
    }
    bucket.push(id);
  }

  if (byStage.size === 0) return byStage;

  const maxStage = Math.max(...byStage.keys());

  // Stage 0 keeps insertion order (already in that order from above). For each subsequent
  // stage, compute each node's barycenter against its `needs` that land in the immediately
  for (let stage = 1; stage <= maxStage; stage++) {
    const bucket = byStage.get(stage);
    if (bucket === undefined) continue;
    const prev = byStage.get(stage - 1) ?? [];
    const prevPos = new Map<string, number>();
    prev.forEach((id, i) => prevPos.set(id, i));

    interface Scored {
      id: string;
      bary: number;
      tiebreak: number;
    }

    const scored: Scored[] = bucket.map((id) => {
      const node = plan.nodes.get(id)!;
      const positions: number[] = [];
      for (const dep of node.needs) {
        const p = prevPos.get(dep);
        if (p !== undefined) positions.push(p);
      }
      const tiebreak = insertionIndex.get(id) ?? 0;
      const bary =
        positions.length > 0
          ? positions.reduce((sum, p) => sum + p, 0) / positions.length
          : tiebreak;
      return { id, bary, tiebreak };
    });

    scored.sort((a, b) => {
      if (a.bary !== b.bary) return a.bary - b.bary;
      return a.tiebreak - b.tiebreak;
    });

    byStage.set(
      stage,
      scored.map((s) => s.id),
    );
  }

  return byStage;
}
