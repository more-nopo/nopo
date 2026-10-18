/**
 * Step-level result cache for nopo CLI.
 *
 * This module provides caching infrastructure that prevents identical work
 * from running twice across PR, merge-queue, and main CI runs (or locally).
 *
 * Key concepts:
 * - Step key: Content-addressable hash of a step's inputs
 * - Result store: Pluggable storage backend (filesystem, S3/R2)
 * - Cache hit: Step with matching key that previously passed
 *
 * Only passing results are cached; failures always rerun. This is a
 * conservative choice that avoids caching environmental failures.
 *
 * @module
 */

export {
  buildStepKeyInputs,
  collectTreeHashes,
  computePlanKey,
  computeStepKey,
  getDeclaredEnvInputs,
  getGitTreeHash,
  getRuntimeVersion,
  hashFileContent,
  type StepKey,
  type StepKeyInputs,
} from "./cache-key.ts";

export {
  createCacheEntry,
  createResultStore,
  DEFAULT_TTL_SECONDS,
  isExpired,
  storeConfigFromEnv,
  type CacheEntry,
  type ResultStore,
  type StoreConfig,
} from "./store.ts";

export { FilesystemStore } from "./stores/filesystem.ts";
export { S3Store } from "./stores/s3.ts";

import type { NormalizedProjectConfig } from "../config/index.ts";
import type { Plan, PlanNode } from "../plan.ts";
import {
  buildStepKeyInputs,
  computeStepKey,
  getDeclaredEnvInputs,
  type StepKey,
} from "./cache-key.ts";
import {
  createCacheEntry,
  createResultStore,
  DEFAULT_TTL_SECONDS,
  storeConfigFromEnv,
  type CacheEntry,
  type ResultStore,
  type StoreConfig,
} from "./store.ts";

/** Cache configuration loaded from environment or nopo.yml */
export interface CacheConfig {
  /** Whether caching is enabled (default: false, opt-in) */
  enabled: boolean;
  /** Store configuration */
  store: StoreConfig;
  /** TTL for cache entries in seconds */
  ttlSeconds: number;
  /** Random sampling percentage (0-100) to verify cache correctness */
  samplingPercent: number;
  /** URL of the current CI run (for cache metadata) */
  runUrl?: string;
}

/** Context for cache operations */
export interface CacheContext {
  /** Project configuration */
  project: NormalizedProjectConfig;
  /** Repository root path */
  repoRoot: string;
  /** Current environment variables */
  env: Record<string, string | undefined>;
  /** CI run URL for metadata */
  runUrl?: string;
}

/** Result of a cache lookup */
export interface CacheLookupResult {
  /** Whether there was a cache hit */
  hit: boolean;
  /** The step key computed for this node */
  stepKey: StepKey;
  /** The cached entry if hit */
  entry?: CacheEntry;
  /** Whether this hit should be verified via sampling */
  shouldVerify: boolean;
}

/**
 * Step cache manager - handles all cache operations for plan execution.
 */
export class StepCache {
  private readonly store: ResultStore;
  private readonly config: CacheConfig;
  private readonly context: CacheContext;
  private readonly stepKeys = new Map<string, StepKey>();

  private constructor(
    store: ResultStore,
    config: CacheConfig,
    context: CacheContext,
  ) {
    this.store = store;
    this.config = config;
    this.context = context;
  }

  /**
   * Create a step cache instance.
   * Returns null if caching is disabled or store is unavailable.
   */
  static async create(
    config: CacheConfig,
    context: CacheContext,
  ): Promise<StepCache | null> {
    if (!config.enabled) return null;

    try {
      const store = await createResultStore(config.store);
      const available = await store.isAvailable();
      if (!available) {
        console.warn("[cache] Store not available, caching disabled");
        return null;
      }
      return new StepCache(store, config, context);
    } catch (err) {
      console.warn("[cache] Failed to create store:", err);
      return null;
    }
  }

  /**
   * Look up a cache entry for a plan node.
   * Only returns hits for passing results.
   */
  async lookup(node: PlanNode): Promise<CacheLookupResult> {
    const stepKey = this.computeStepKey(node);

    // Try to get cached entry
    const entry = await this.store.get(stepKey.key);

    // Only hit on passing results
    const hit = entry !== null && entry.passed;

    // Determine if we should verify this hit via sampling
    const shouldVerify = hit && this.shouldSampleVerify();

    return {
      hit: hit && !shouldVerify, // If verifying, treat as miss
      stepKey,
      entry: entry ?? undefined,
      shouldVerify,
    };
  }

  /**
   * Record a step result in the cache.
   * Only passing results are stored.
   */
  async record(
    stepKey: StepKey,
    passed: boolean,
    durationMs: number,
  ): Promise<void> {
    // Only cache passes
    if (!passed) return;

    const entry = createCacheEntry(
      stepKey,
      passed,
      durationMs,
      this.config.ttlSeconds,
      this.config.runUrl ?? this.context.runUrl,
    );

    try {
      await this.store.put(entry);
    } catch (err) {
      // Log but don't fail the build
      console.warn(`[cache] Failed to store result for ${stepKey.key}:`, err);
    }
  }

  /**
   * Get the computed step key for a node.
   * Keys are cached for the lifetime of the StepCache instance.
   */
  getStepKey(node: PlanNode): StepKey {
    return this.computeStepKey(node);
  }

  /**
   * Get all computed step keys.
   */
  getAllStepKeys(): ReadonlyMap<string, StepKey> {
    return this.stepKeys;
  }

  private computeStepKey(node: PlanNode): StepKey {
    // Return cached key if already computed
    const cached = this.stepKeys.get(node.id);
    if (cached) return cached;

    // Get declared env inputs for this target
    const service = node.target
      ? this.context.project.services.entries[node.target]
      : undefined;
    const envInputs = getDeclaredEnvInputs(service);

    // Build inputs and compute key
    const inputs = buildStepKeyInputs(
      node,
      this.context.project,
      this.context.repoRoot,
      envInputs,
      this.context.env as Record<string, string>,
    );

    const stepKey = computeStepKey(inputs);
    this.stepKeys.set(node.id, stepKey);
    return stepKey;
  }

  private shouldSampleVerify(): boolean {
    if (this.config.samplingPercent <= 0) return false;
    if (this.config.samplingPercent >= 100) return true;
    return Math.random() * 100 < this.config.samplingPercent;
  }
}

/**
 * Load cache configuration from environment and optional config.
 *
 * Environment variables:
 * - NOPO_CACHE: "1" or "true" to enable caching
 * - NOPO_CACHE_STORE: "filesystem" | "s3" (default: filesystem)
 * - NOPO_CACHE_TTL: TTL in seconds (default: 604800 = 7 days)
 * - NOPO_CACHE_SAMPLING: Verification sampling percentage (default: 0)
 * - NOPO_CACHE_RUN_URL: CI run URL for metadata
 * - GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID: Auto-detect GitHub Actions run URL
 */
export function loadCacheConfig(
  env: Record<string, string | undefined>,
  override?: Partial<CacheConfig>,
): CacheConfig {
  const enabled =
    override?.enabled ??
    (env.NOPO_CACHE === "1" || env.NOPO_CACHE === "true");

  const storeConfig = override?.store ?? storeConfigFromEnv(env);

  const ttlSeconds =
    override?.ttlSeconds ??
    (env.NOPO_CACHE_TTL ? parseInt(env.NOPO_CACHE_TTL, 10) : DEFAULT_TTL_SECONDS);

  const samplingPercent =
    override?.samplingPercent ??
    (env.NOPO_CACHE_SAMPLING ? parseInt(env.NOPO_CACHE_SAMPLING, 10) : 0);

  // Auto-detect CI run URL
  let runUrl = override?.runUrl ?? env.NOPO_CACHE_RUN_URL;
  if (!runUrl && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    const server = env.GITHUB_SERVER_URL ?? "https://github.com";
    runUrl = `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }

  return {
    enabled,
    store: storeConfig,
    ttlSeconds,
    samplingPercent,
    runUrl,
  };
}

/**
 * Format a cache hit message for user output.
 */
export function formatCacheHitMessage(
  nodeId: string,
  stepKey: StepKey,
  entry: CacheEntry,
): string {
  const keyShort = stepKey.key.slice(0, 12);
  const durationStr = entry.durationMs < 1000
    ? `${entry.durationMs}ms`
    : `${(entry.durationMs / 1000).toFixed(1)}s`;

  let msg = `[cache] ✓ ${nodeId} skipped (key: ${keyShort}, prev: ${durationStr}`;
  if (entry.runUrl) {
    msg += `, run: ${entry.runUrl}`;
  }
  msg += ")";
  return msg;
}

/**
 * Format a cache verification message (when sampling triggers re-run).
 */
export function formatVerifyMessage(nodeId: string, stepKey: StepKey): string {
  const keyShort = stepKey.key.slice(0, 12);
  return `[cache] ⚡ ${nodeId} re-running for verification (key: ${keyShort})`;
}
