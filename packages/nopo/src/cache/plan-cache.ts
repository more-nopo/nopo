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
  type CacheEntry,
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
  /** Number of steps bypassed (dirty tree, not cacheable, etc.) */
  bypasses: number;
  /** Whether writes are enabled */
  writeEnabled: boolean;
  /** Step keys computed during execution (null for non-cacheable nodes) */
  stepKeys: ReadonlyMap<string, StepKey | null>;
  /** Number of false-hit detections (verification failures that invalidated entries) */
  falseHits: number;
}

// Timeout for awaiting pending writes before returning (10 seconds)
const WRITE_AWAIT_TIMEOUT_MS = 10_000;

/**
 * Execute a plan with caching support.
 *
 * This is the main entry point for cached plan execution. It:
 * 1. Loads cache configuration from environment
 * 2. Creates a cache-aware dispatch wrapper
 * 3. Tracks cache hits/misses
 * 4. Records results after execution
 * 5. Awaits all pending writes before returning (with timeout)
 * 6. Invalidates entries that fail verification
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
      falseHits: 0,
    };
  }

  // Track cache stats
  let cacheHits = 0;
  let cacheMisses = 0;
  let verifications = 0;
  let bypasses = 0;
  let falseHits = 0;

  // Track which nodes to skip (cache hits)
  const skipNodes = new Set<string>();
  const skippedResults = new Map<string, NodeResult>();
  // Track bypassed nodes - these should not be recorded
  const bypassedNodes = new Set<string>();
  // Track nodes being verified (to detect false hits)
  const verifyingNodes = new Map<string, StepKey>();
  // Track lookup results for step keys
  const lookupResults = new Map<string, { stepKey: StepKey | null; entry?: CacheEntry }>();

  // Collect all pending write promises to await before returning
  const pendingWrites: Promise<void>[] = [];

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

      // Store lookup result for later
      lookupResults.set(nodeId, { stepKey: result.stepKey, entry: result.entry });

      if (result.bypassed) {
        // Bypassed (dirty tree, not cacheable, etc.)
        bypasses++;
        cacheMisses++;
        bypassedNodes.add(nodeId);
        ctx.io.stdout.write(
          formatBypassMessage(nodeId, result.bypassReason ?? "not cacheable") + "\n",
        );
      } else if (result.hit && result.entry && result.stepKey) {
        // Cache hit - mark for skipping
        skipNodes.add(nodeId);
        cacheHits++;

        // Create synthetic result for this node
        skippedResults.set(nodeId, {
          id: nodeId,
          status: "success",
          durationMs: 0,
        });

        // Emit node-skip event so the renderer can track this node
        ctx.onEvent?.({
          type: "node-skip",
          nodeId,
          reason: "cache hit",
        });

        // Log cache hit
        ctx.io.stdout.write(
          formatCacheHitMessage(nodeId, result.stepKey, result.entry) + "\n",
        );
      } else if (result.shouldVerify && result.stepKey) {
        // Verification run - don't skip but track for invalidation on failure
        verifications++;
        cacheMisses++;
        verifyingNodes.set(nodeId, result.stepKey);
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
  const originalOnEvent = ctx.onEvent;

  // Wrap onEvent to track timing and record results
  const wrappedOnEvent = (event: PlanEvent): void => {
    originalOnEvent?.(event);

    if (event.type === "node-success" || event.type === "node-failure") {
      const node = plan.nodes.get(event.nodeId);
      if (!node) return;

      // Skip recording for bypassed nodes
      if (bypassedNodes.has(event.nodeId)) return;

      const lookup = lookupResults.get(event.nodeId);
      const stepKey = lookup?.stepKey ?? stepCache.getStepKey(node);
      const passed = event.type === "node-success";
      const durationMs = event.durationMs;

      // Check if this was a verification run that failed
      const wasVerifying = verifyingNodes.has(event.nodeId);
      if (wasVerifying && !passed && stepKey) {
        // Verification failed - this is a false hit!
        // Invalidate the cached entry and emit a warning
        falseHits++;
        ctx.io.stderr.write(
          `[cache] ⚠ FALSE HIT DETECTED: ${event.nodeId} failed verification, invalidating cached entry\n`,
        );
        const invalidatePromise = stepCache.invalidate(stepKey.key).catch((err) => {
          console.warn(`[cache] Failed to invalidate ${event.nodeId}:`, err);
        });
        pendingWrites.push(invalidatePromise);
      }

      // Record result to cache (only passes, handled by record())
      if (stepKey) {
        const recordPromise = stepCache.record(stepKey, passed, durationMs, node).catch((err) => {
          console.warn(`[cache] Failed to record ${event.nodeId}:`, err);
        });
        pendingWrites.push(recordPromise);
      }
    }
  };

  // Execute the (potentially filtered) plan
  const result = await executePlan(modifiedPlan, {
    ...ctx,
    onEvent: wrappedOnEvent,
  });

  // IMPORTANT: Await all pending writes before returning
  // This ensures the CLI doesn't exit before cache entries are persisted
  if (pendingWrites.length > 0) {
    try {
      await Promise.race([
        Promise.allSettled(pendingWrites),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Write timeout")), WRITE_AWAIT_TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      // Timeout - some writes didn't complete but we shouldn't block forever
      console.warn("[cache] Some cache writes timed out");
    }
  }

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
    falseHits,
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
