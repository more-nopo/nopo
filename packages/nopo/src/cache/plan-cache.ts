/**
 * Cache-aware plan execution wrapper.
 *
 * This module wraps the plan runner to add caching support:
 * - Before execution: lookup cache for each node
 * - Skip nodes with cache hits
 * - After execution: record results to cache
 *
 * Integrates with the existing plan runner by intercepting the dispatch.
 */

import type { NormalizedProjectConfig } from "../config/index.ts";
import type { Plan, PlanNode } from "../plan.ts";
import {
  executePlan,
  type HandlerDispatch,
  type NodeResult,
  type PlanContext,
  type PlanEvent,
  type PlanRunResult,
} from "../plan-runner.ts";
import {
  type CacheConfig,
  type CacheContext,
  formatBypassMessage,
  formatCacheHitMessage,
  formatVerifyMessage,
  loadCacheConfig,
  StepCache,
  type StepKey,
} from "./index.ts";

/** Extended plan context with caching support */
export interface CachedPlanContext extends PlanContext {
  /** Cache configuration (null if disabled) */
  cache?: CacheConfig | null;
  /** Project configuration for cache key computation */
  project: NormalizedProjectConfig;
  /** Repository root path */
  repoRoot: string;
}

/** Result from cached plan execution */
export interface CachedPlanRunResult extends PlanRunResult {
  /** Number of steps skipped due to cache hits */
  cacheHits: number;
  /** Number of steps that ran (cache misses) */
  cacheMisses: number;
  /** Number of steps re-run for verification */
  verifications: number;
  /** Number of steps bypassed due to dirty working tree */
  bypasses: number;
  /** Whether writes are enabled */
  writeEnabled: boolean;
  /** Step keys computed during execution */
  stepKeys: ReadonlyMap<string, StepKey>;
}

/**
 * Execute a plan with caching support.
 *
 * This is the main entry point for cached plan execution. It:
 * 1. Loads cache configuration from environment
 * 2. Creates a cache-aware dispatch wrapper
 * 3. Tracks cache hits/misses
 * 4. Records results after execution
 */
export async function executePlanWithCache(
  plan: Plan,
  ctx: CachedPlanContext,
): Promise<CachedPlanRunResult> {
  // Load cache config from environment
  const cacheConfig = ctx.cache ?? loadCacheConfig(ctx.io.env);

  // Create cache context
  const cacheContext: CacheContext = {
    project: ctx.project,
    repoRoot: ctx.repoRoot,
    env: ctx.io.env,
    runUrl: cacheConfig.runUrl,
  };

  // Try to create step cache
  const stepCache = await StepCache.create(cacheConfig, cacheContext);

  // If caching is disabled, fall back to regular execution
  if (!stepCache) {
    const result = await executePlan(plan, ctx);
    return {
      ...result,
      cacheHits: 0,
      cacheMisses: plan.nodes.size,
      verifications: 0,
      bypasses: 0,
      writeEnabled: false,
      stepKeys: new Map(),
    };
  }

  // Track cache stats
  let cacheHits = 0;
  let cacheMisses = 0;
  let verifications = 0;
  let bypasses = 0;

  // Track which nodes to skip (cache hits)
  const skipNodes = new Set<string>();
  const skippedResults = new Map<string, NodeResult>();
  // Track bypassed nodes (dirty working tree) - these should not be recorded
  const bypassedNodes = new Set<string>();

  // Pre-compute cache lookups for all nodes
  const lookupPromises = new Map<string, ReturnType<typeof stepCache.lookup>>();
  for (const node of plan.nodes.values()) {
    lookupPromises.set(node.id, stepCache.lookup(node));
  }

  // Wait for all lookups
  for (const [nodeId, lookupPromise] of lookupPromises) {
    try {
      const result = await lookupPromise;
      const node = plan.nodes.get(nodeId)!;

      if (result.bypassed) {
        // Dirty working tree - bypass cache (no read, no write)
        bypasses++;
        cacheMisses++;
        bypassedNodes.add(nodeId);
        ctx.io.stdout.write(
          formatBypassMessage(nodeId, result.bypassReason ?? "dirty working tree") + "\n",
        );
      } else if (result.hit && result.entry) {
        // Cache hit - mark for skipping
        skipNodes.add(nodeId);
        cacheHits++;

        // Create synthetic result for this node
        skippedResults.set(nodeId, {
          id: nodeId,
          status: "success",
          durationMs: 0,
        });

        // Log cache hit
        ctx.io.stdout.write(
          formatCacheHitMessage(nodeId, result.stepKey, result.entry) + "\n",
        );
      } else if (result.shouldVerify) {
        // Verification run - don't skip but track
        verifications++;
        cacheMisses++;
        ctx.io.stdout.write(
          formatVerifyMessage(nodeId, result.stepKey) + "\n",
        );
      } else {
        cacheMisses++;
      }
    } catch (err) {
      // Cache lookup failed - treat as miss
      cacheMisses++;
      console.warn(`[cache] Lookup failed for ${nodeId}:`, err);
    }
  }

  // Build a modified plan that excludes cached nodes
  const modifiedPlan = skipNodes.size > 0
    ? filterPlanNodes(plan, (node) => !skipNodes.has(node.id))
    : plan;

  // Track timing for cache recording
  const startTimes = new Map<string, number>();
  const originalOnEvent = ctx.onEvent;

  // Wrap onEvent to track timing and record results
  const wrappedOnEvent = (event: PlanEvent): void => {
    originalOnEvent?.(event);

    if (event.type === "node-start") {
      startTimes.set(event.nodeId, Date.now());
    } else if (event.type === "node-success" || event.type === "node-failure") {
      const node = plan.nodes.get(event.nodeId);
      if (!node) return;

      // Skip recording for bypassed nodes (dirty working tree)
      if (bypassedNodes.has(event.nodeId)) return;

      const stepKey = stepCache.getStepKey(node);
      const passed = event.type === "node-success";
      const durationMs = event.durationMs;

      // Record result to cache asynchronously (pass node for eligibility check)
      stepCache.record(stepKey, passed, durationMs, node).catch((err) => {
        console.warn(`[cache] Failed to record ${event.nodeId}:`, err);
      });
    }
  };

  // Execute the (potentially filtered) plan
  const result = await executePlan(modifiedPlan, {
    ...ctx,
    onEvent: wrappedOnEvent,
  });

  // Merge skipped results into the final results
  const mergedResults = new Map(result.results);
  for (const [nodeId, skippedResult] of skippedResults) {
    mergedResults.set(nodeId, skippedResult);
  }

  return {
    ok: result.ok,
    results: mergedResults,
    cacheHits,
    cacheMisses,
    verifications,
    bypasses,
    writeEnabled: stepCache.writeEnabled,
    stepKeys: stepCache.getAllStepKeys(),
  };
}

/**
 * Filter plan nodes, preserving dependencies.
 * Nodes that are filtered out have their dependents' needs updated.
 */
function filterPlanNodes(
  plan: Plan,
  predicate: (node: PlanNode) => boolean,
): Plan {
  const filteredNodes = new Map<string, PlanNode>();
  const removedIds = new Set<string>();

  // First pass: identify nodes to keep
  for (const node of plan.nodes.values()) {
    if (predicate(node)) {
      filteredNodes.set(node.id, node);
    } else {
      removedIds.add(node.id);
    }
  }

  // Second pass: update needs to skip removed nodes
  // When a dependency is removed, inherit its dependencies
  const resolveNeeds = (needs: readonly string[]): string[] => {
    const resolved: string[] = [];
    for (const need of needs) {
      if (!removedIds.has(need)) {
        resolved.push(need);
      } else {
        // Inherit the removed node's dependencies
        const removedNode = plan.nodes.get(need);
        if (removedNode) {
          resolved.push(...resolveNeeds(removedNode.needs));
        }
      }
    }
    return [...new Set(resolved)];
  };

  const adjustedNodes = new Map<string, PlanNode>();
  for (const [id, node] of filteredNodes) {
    adjustedNodes.set(id, {
      ...node,
      needs: resolveNeeds(node.needs),
    });
  }

  return {
    nodes: adjustedNodes,
    maxConcurrency: plan.maxConcurrency,
  };
}
