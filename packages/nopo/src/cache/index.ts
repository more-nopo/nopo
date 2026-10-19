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
  checkCacheEligibility,
  collectLockfileHashes,
  collectPathsForDirtyCheck,
  collectRootConfigHashes,
  collectTreeHashes,
  collectTreeHashesForTargets,
  computePlanKey,
  computeStepKey,
  getDeclaredEnvInputs,
  getDirtyPaths,
  getGitTreeHash,
  getNopoVersion,
  getRuntimeVersion,
  hashFileContent,
  isHandlerCacheable,
  isPathDirty,
  type BuildStepKeyResult,
  type CacheableCheck,
  type CacheEligibility,
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

import path from "node:path";

import type { NormalizedProjectConfig } from "../config/index.ts";
import type { PlanNode } from "../plan.ts";
import {
  buildStepKeyInputs,
  checkCacheEligibility,
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
  /**
   * Whether cache writes are enabled.
   * Default: true only in CI (when CI=true), false for local/agent runs.
   * Override with NOPO_CACHE_WRITE=1 to enable writes locally.
   */
  writeEnabled: boolean;
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
  /** The step key computed for this node, null if not cacheable */
  stepKey: StepKey | null;
  /** The cached entry if hit */
  entry?: CacheEntry;
  /** Whether this hit should be verified via sampling */
  shouldVerify: boolean;
  /** Whether cache was bypassed (dirty tree, not cacheable, etc.) */
  bypassed: boolean;
  /** Reason for bypass (e.g., "uncommitted changes in: api, shared") */
  bypassReason?: string;
}

/**
 * Step cache manager - handles all cache operations for plan execution.
 */
export class StepCache {
  private readonly store: ResultStore;
  private readonly config: CacheConfig;
  private readonly context: CacheContext;
  private readonly stepKeys = new Map<string, StepKey | null>();
  private readonly eligibilityCache = new Map<string, { eligible: boolean; reason?: string }>();
  private readonly uncacheableReasons = new Map<string, string>();

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

  /** Whether writes are enabled for this cache instance */
  get writeEnabled(): boolean {
    return this.config.writeEnabled;
  }

  /** Get the underlying store (for direct operations like delete) */
  get resultStore(): ResultStore {
    return this.store;
  }

  /**
   * Look up a cache entry for a plan node.
   * Only returns hits for passing results with valid trust properties.
   * Bypasses cache (no read, no write) for:
   * - Steps with dirty working trees
   * - Non-cacheable handlers (side-effectful operations)
   * - Nodes without tree hashes
   */
  async lookup(node: PlanNode): Promise<CacheLookupResult> {
    // Compute or retrieve step key (may be null if not cacheable)
    const stepKeyResult = this.computeStepKey(node);

    // If step is not cacheable, bypass
    if (stepKeyResult === null) {
      const reason = this.uncacheableReasons.get(node.id) ?? "not cacheable";
      return {
        hit: false,
        stepKey: null,
        shouldVerify: false,
        bypassed: true,
        bypassReason: reason,
      };
    }

    const stepKey = stepKeyResult;

    // Check if this step is eligible for caching (working tree clean)
    const eligibility = this.checkEligibility(node);
    if (!eligibility.eligible) {
      return {
        hit: false,
        stepKey,
        shouldVerify: false,
        bypassed: true,
        bypassReason: eligibility.reason,
      };
    }

    // Try to get cached entry
    const entry = await this.store.get(stepKey.key);

    // Validate entry trust: must have passed === true (boolean, not string),
    // key must match, and must not be expired
    const isValidEntry = this.validateEntry(entry, stepKey.key);

    // Determine if we should verify this hit via sampling
    const shouldVerify = isValidEntry && this.shouldSampleVerify();

    return {
      hit: isValidEntry && !shouldVerify, // If verifying, treat as miss
      stepKey,
      entry: entry ?? undefined,
      shouldVerify,
      bypassed: false,
    };
  }

  /**
   * Record a step result in the cache.
   * - Passing results are stored
   * - Failed results invalidate any existing entry (for verification failures)
   * Skips if writes are disabled, not cacheable, or working tree is dirty.
   * Returns a promise that resolves when the write completes (for awaiting).
   */
  async record(
    stepKey: StepKey | null,
    passed: boolean,
    durationMs: number,
    node?: PlanNode,
  ): Promise<void> {
    // Can't record without a step key
    if (stepKey === null) return;

    // Skip if writes are disabled
    if (!this.config.writeEnabled) return;

    // Skip if working tree is dirty for this node
    if (node) {
      const eligibility = this.checkEligibility(node);
      if (!eligibility.eligible) return;
    }

    // If the step failed, invalidate any existing cached entry
    // This handles verification failures - a cached pass that fails on re-run is a false hit
    if (!passed) {
      await this.invalidate(stepKey.key);
      return;
    }

    const entry = createCacheEntry(
      stepKey,
      passed,
      durationMs,
      this.config.ttlSeconds,
      this.config.runUrl ?? this.context.runUrl,
    );

    await this.store.put(entry);
  }

  /**
   * Delete/invalidate a cache entry.
   * Used when verification fails to remove false-positive entries.
   */
  async invalidate(key: string): Promise<void> {
    if (this.store.delete) {
      await this.store.delete(key);
    }
  }

  /**
   * Get the computed step key for a node.
   * Returns null if the node is not cacheable.
   * Keys are cached for the lifetime of the StepCache instance.
   */
  getStepKey(node: PlanNode): StepKey | null {
    return this.computeStepKey(node);
  }

  /**
   * Get all computed step keys.
   */
  getAllStepKeys(): ReadonlyMap<string, StepKey | null> {
    return this.stepKeys;
  }

  /**
   * Validate a cache entry for trust.
   * Entry must have:
   * - passed === true (boolean, not truthy string like "false")
   * - key matching the requested key
   * - not expired (based on TTL)
   */
  private validateEntry(entry: CacheEntry | null, expectedKey: string): boolean {
    if (entry === null) return false;

    // passed must be boolean true, not a string "true" or "false"
    if (entry.passed !== true) return false;

    // key must match exactly
    if (entry.key !== expectedKey) return false;

    // Check expiration (enforce TTL from reader side)
    if (new Date(entry.expiresAt) < new Date()) return false;

    return true;
  }

  private checkEligibility(node: PlanNode): { eligible: boolean; reason?: string } {
    // Return cached result if already computed
    const cached = this.eligibilityCache.get(node.id);
    if (cached) return cached;

    // Get claimed targets from batch nodes
    const payload = node.payload as { targets?: string[] } | undefined;
    const claimedTargets = payload?.targets;

    const eligibility = checkCacheEligibility(
      this.context.project,
      node.target,
      this.context.repoRoot,
      claimedTargets,
    );

    const result = { eligible: eligibility.eligible, reason: eligibility.reason };
    this.eligibilityCache.set(node.id, result);
    return result;
  }

  private computeStepKey(node: PlanNode): StepKey | null {
    // Return cached key if already computed (including null for non-cacheable)
    if (this.stepKeys.has(node.id)) {
      return this.stepKeys.get(node.id)!;
    }

    // Get declared env inputs for this target
    const service = node.target
      ? this.context.project.services.entries[node.target]
      : undefined;
    const envInputs = getDeclaredEnvInputs(service);

    // Build inputs - may return null if not cacheable
    const result = buildStepKeyInputs(
      node,
      this.context.project,
      this.context.repoRoot,
      envInputs,
      this.context.env as Record<string, string>,
    );

    if (result.inputs === null) {
      // Not cacheable - remember why
      this.uncacheableReasons.set(node.id, result.reason ?? "not cacheable");
      this.stepKeys.set(node.id, null);
      return null;
    }

    const stepKey = computeStepKey(result.inputs);
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
 * - NOPO_CACHE_WRITE: "1" or "true" to enable cache writes (default: on in CI only)
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

  // Write is enabled by default only in CI, or explicitly via NOPO_CACHE_WRITE=1
  // This makes laptop/agent runs read-only by default
  const isCI = env.CI === "true" || env.CI === "1";
  const writeEnabled =
    override?.writeEnabled ??
    (env.NOPO_CACHE_WRITE === "1" || env.NOPO_CACHE_WRITE === "true" || isCI);

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
    writeEnabled,
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
  stepKey: StepKey | null,
  entry: CacheEntry,
): string {
  const keyShort = stepKey?.key.slice(0, 12) ?? "unknown";
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
export function formatVerifyMessage(nodeId: string, stepKey: StepKey | null): string {
  const keyShort = stepKey?.key.slice(0, 12) ?? "unknown";
  return `[cache] ⚡ ${nodeId} re-running for verification (key: ${keyShort})`;
}

/**
 * Format a cache bypass message (when working tree is dirty).
 */
export function formatBypassMessage(nodeId: string, reason: string): string {
  return `[cache] ⊘ ${nodeId} bypassed (${reason})`;
}
