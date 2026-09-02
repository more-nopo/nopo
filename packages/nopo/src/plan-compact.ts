/**
 * Compaction pass after `static plan()`, before `executePlan`. Plugins
 * claim nodes and coalesce them into one batch. Dual claims throw
 * BatchClaimConflictError. See `decisions/0012_plugin_batches.md`.
 */

import type {
  NormalizedProjectConfig,
  NormalizedService,
} from "./config/index.ts";
// Type-only import — keeps `plan-compact` free of the runtime config module
// so targeted vitest runs do not pull in `yaml` and the config loader graph.
import {
  type Plan,
  planFromNodes,
  type PlanHandler,
  type PlanNode,
} from "./plan.ts";
import type { ScriptArgs } from "./script-args.ts";

// ---------------------------------------------------------------------------
// Public API

/**
 * Context for every BatchSpec call. Same shape for `claims` and `coalesce`.
 * Both must be pure — no IO, spawn, or mutation. Capture state in the
 * plugin factory closure, not lazily inside `claims`.
 */
export interface CompactionContext {
  /** All normalized services, keyed by service id. */
  services: Record<string, NormalizedService>;
  /** The full normalized project (services, plugins, runtimes, package managers). */
  project: NormalizedProjectConfig;
  /** Process env + project env, merged. */
  env: Record<string, string>;
  /** The current script's parsed args. */
  args: ScriptArgs;
}

/**
 * Claim+coalesce contract. `claims` runs once per input node; `true`
 * includes it. `coalesce` then returns the single replacement node
 * for the claimed set.
 */
export interface BatchSpec {
  claims: (node: PlanNode, ctx: CompactionContext) => boolean;
  coalesce: (
    claimed: readonly PlanNode[],
    ctx: CompactionContext,
  ) => {
    id: string;
    handler: PlanHandler;
    payload?: unknown;
    meta?: Record<string, unknown>;
  };
}

/**
 * Thrown when two {@link BatchSpec}s — either across plugins or within
 * one plugin — return `true` for the same node. The contract is
 * "exactly one owner per node"; conflicts are a plugin authoring bug.
 */
export class BatchClaimConflictError extends Error {
  public readonly nodeId: string;
  public readonly conflicts: ReadonlyArray<{
    plugin: string;
    specIndex: number;
  }>;

  constructor(
    nodeId: string,
    conflicts: ReadonlyArray<{ plugin: string; specIndex: number }>,
  ) {
    const description = conflicts
      .map((c) => `${c.plugin}#${c.specIndex}`)
      .join(", ");
    super(
      `Plan compaction conflict on node "${nodeId}": claimed by ${description}`,
    );
    this.name = "BatchClaimConflictError";
    this.nodeId = nodeId;
    this.conflicts = conflicts;
  }
}

/**
 * Fold claimed nodes into one batch per spec. Rewrites needs: union minus
 * intra-batch; downstream refs become the batch id (deduped, order kept).
 * Single-pass on the input plan. No batches: return the input unchanged.
 */
export function compactPlan(plan: Plan, ctx: CompactionContext): Plan {
  // Gather every (plugin, specIndex, spec) triple so we can attribute
  // conflicts back to the source. Empty list = no-op fast path.
  const specs: Array<{
    plugin: string;
    specIndex: number;
    spec: BatchSpec;
  }> = [];
  for (const loaded of ctx.project.plugins) {
    const declared = loaded.definition.batches;
    if (!declared) continue;
    for (let i = 0; i < declared.length; i++) {
      specs.push({
        plugin: loaded.definition.name,
        specIndex: i,
        spec: declared[i]!,
      });
    }
  }
  if (specs.length === 0) return plan;

  // First pass: record which spec owns each node. First conflict names
  // every claimant. Map key is specIndex-in-`specs` (input order).
  const claimedBySpec = new Map<number, PlanNode[]>();

  for (const node of plan.nodes.values()) {
    const claimants: Array<{ plugin: string; specIndex: number }> = [];
    let firstSpecIdx = -1;
    for (let i = 0; i < specs.length; i++) {
      const entry = specs[i]!;
      if (entry.spec.claims(node, ctx)) {
        claimants.push({ plugin: entry.plugin, specIndex: entry.specIndex });
        if (firstSpecIdx === -1) firstSpecIdx = i;
      }
    }
    if (claimants.length > 1) {
      throw new BatchClaimConflictError(node.id, claimants);
    }
    if (claimants.length === 1) {
      const list = claimedBySpec.get(firstSpecIdx) ?? [];
      list.push(node);
      claimedBySpec.set(firstSpecIdx, list);
    }
  }

  if (claimedBySpec.size === 0) return plan;

  // Build coalesced nodes per spec and the claimed-id → batch-id map
  // used to rewrite downstream `needs`.
  const claimedToBatch = new Map<string, string>();
  const batchNodes = new Map<number, PlanNode>(); // specIndex-in-`specs` → batch node

  for (const [specIdx, claimed] of claimedBySpec) {
    const entry = specs[specIdx]!;
    const result = entry.spec.coalesce(claimed, ctx);

    // Needs: union of claimed needs minus this spec's ids (intra-batch
    // collapse). Deduped; original order kept.
    const claimedIds = new Set(claimed.map((n) => n.id));
    const seen = new Set<string>();
    const needs: string[] = [];
    for (const node of claimed) {
      for (const dep of node.needs) {
        if (claimedIds.has(dep)) continue; // intra-batch
        if (seen.has(dep)) continue;
        seen.add(dep);
        needs.push(dep);
      }
    }

    const mergedMeta: Record<string, unknown> = {
      ...(result.meta ?? {}),
      batchOf: claimed.map((n) => n.id),
    };

    const batchNode: PlanNode = {
      id: result.id,
      handler: result.handler,
      needs,
      meta: mergedMeta,
    };
    if (result.payload !== undefined) batchNode.payload = result.payload;

    batchNodes.set(specIdx, batchNode);
    for (const id of claimedIds) claimedToBatch.set(id, result.id);
  }

  // Second pass: emit rewritten non-claimed nodes, or the batch node
  // on the first claimed member. Skip later members of that batch.
  const emittedBatches = new Set<number>();
  const outputNodes: PlanNode[] = [];

  // Reverse map: claimed-id → its owning specIdx. We need the index
  // into `specs` to look up `batchNodes` on the second-pass emit.
  const claimedToSpecIdx = new Map<string, number>();
  for (const [specIdx, claimed] of claimedBySpec) {
    for (const node of claimed) claimedToSpecIdx.set(node.id, specIdx);
  }

  for (const node of plan.nodes.values()) {
    const specIdx = claimedToSpecIdx.get(node.id);
    if (specIdx !== undefined) {
      if (!emittedBatches.has(specIdx)) {
        emittedBatches.add(specIdx);
        outputNodes.push(batchNodes.get(specIdx)!);
      }
      continue;
    }
    // Non-claimed: rewrite its needs.
    const rewritten = rewriteNeeds(node, claimedToBatch);
    outputNodes.push(rewritten);
  }

  const opts: { maxConcurrency?: number } = {};
  if (plan.maxConcurrency !== undefined)
    opts.maxConcurrency = plan.maxConcurrency;
  return planFromNodes(outputNodes, opts);
}

// ---------------------------------------------------------------------------
// internal helpers

/**
 * Copy `node` with claimed need ids rewritten to their batch id.
 * Collapses duplicates; keeps original order. No rewrite: same reference.
 */
function rewriteNeeds(
  node: PlanNode,
  claimedToBatch: ReadonlyMap<string, string>,
): PlanNode {
  let changed = false;
  const seen = new Set<string>();
  const next: string[] = [];
  for (const dep of node.needs) {
    const mapped = claimedToBatch.get(dep);
    const finalDep = mapped ?? dep;
    if (mapped !== undefined) changed = true;
    if (seen.has(finalDep)) {
      changed = true; // collapsed duplicate
      continue;
    }
    seen.add(finalDep);
    next.push(finalDep);
  }
  if (!changed) return node;
  const out: PlanNode = {
    id: node.id,
    handler: node.handler,
    needs: next,
  };
  if (node.target !== undefined) out.target = node.target;
  if (node.payload !== undefined) out.payload = node.payload;
  if (node.meta !== undefined) out.meta = node.meta;
  return out;
}
