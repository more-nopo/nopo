/**
 * Pluggable result store interface for the step-level cache.
 *
 * Stores persist cache entries with metadata about the original run:
 * - Whether it passed or failed (only passes are reused)
 * - Duration
 * - Run URL (CI link)
 * - Timestamp
 */

import type { StepKey } from "./cache-key.ts";

/** Cached result metadata */
export interface CacheEntry {
  /** Cache key that produced this entry */
  key: string;
  /** Whether the step passed */
  passed: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** URL to the CI run that produced this result */
  runUrl?: string;
  /** When this entry was created (ISO timestamp) */
  createdAt: string;
  /** When this entry expires (ISO timestamp) */
  expiresAt: string;
  /** Optional metadata for debugging */
  meta?: Record<string, unknown>;
}

/** Result store interface - implementations provide get/put */
export interface ResultStore {
  /** Store name for logging */
  readonly name: string;

  /**
   * Get a cached result by key.
   * Returns null if not found or expired.
   */
  get(key: string): Promise<CacheEntry | null>;

  /**
   * Store a result. Implementations handle TTL and cleanup.
   */
  put(entry: CacheEntry): Promise<void>;

  /**
   * Check if the store is available/configured.
   * Returns false if credentials are missing or store is unreachable.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Optional cleanup of expired entries.
   * Not all stores need to implement this (e.g., S3 lifecycle rules).
   */
  cleanup?(): Promise<number>;
}

/** Configuration for creating a result store */
export interface StoreConfig {
  /** Store type: "filesystem" | "s3" */
  type: "filesystem" | "s3";

  /** Time-to-live for cache entries in seconds. Default: 7 days (604800) */
  ttlSeconds?: number;

  /** Filesystem-specific config */
  filesystem?: {
    /** Base directory for cache files. Default: ~/.nopo/cache */
    baseDir?: string;
  };

  /** S3-compatible store config (works with Cloudflare R2) */
  s3?: {
    /** S3 endpoint URL (required for R2) */
    endpoint?: string;
    /** Bucket name */
    bucket: string;
    /** Key prefix within bucket */
    prefix?: string;
    /** AWS region (default: auto) */
    region?: string;
    /** Access key ID (can also use AWS_ACCESS_KEY_ID env) */
    accessKeyId?: string;
    /** Secret access key (can also use AWS_SECRET_ACCESS_KEY env) */
    secretAccessKey?: string;
  };
}

/** Default TTL: 7 days */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Create a result store from configuration.
 * Loads the appropriate implementation lazily.
 */
export async function createResultStore(config: StoreConfig): Promise<ResultStore> {
  const ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  switch (config.type) {
    case "filesystem": {
      const { FilesystemStore } = await import("./stores/filesystem.ts");
      return new FilesystemStore({
        baseDir: config.filesystem?.baseDir,
        ttlSeconds,
      });
    }
    case "s3": {
      if (!config.s3?.bucket) {
        throw new Error("S3 store requires bucket configuration");
      }
      const { S3Store } = await import("./stores/s3.ts");
      return new S3Store({
        ...config.s3,
        ttlSeconds,
      });
    }
    default:
      throw new Error(`Unknown store type: ${config.type}`);
  }
}

/**
 * Create a store config from environment variables.
 * This is the primary way stores are configured in CI.
 *
 * Environment variables:
 * - NOPO_CACHE_STORE: "filesystem" | "s3" (default: filesystem)
 * - NOPO_CACHE_TTL: TTL in seconds
 * - NOPO_CACHE_DIR: Filesystem store base directory
 * - NOPO_CACHE_S3_ENDPOINT: S3/R2 endpoint URL
 * - NOPO_CACHE_S3_BUCKET: S3/R2 bucket name
 * - NOPO_CACHE_S3_PREFIX: Key prefix in bucket
 * - NOPO_CACHE_S3_REGION: AWS region
 * - AWS_ACCESS_KEY_ID / NOPO_CACHE_S3_ACCESS_KEY_ID: Access key
 * - AWS_SECRET_ACCESS_KEY / NOPO_CACHE_S3_SECRET_ACCESS_KEY: Secret key
 */
export function storeConfigFromEnv(env: Record<string, string | undefined>): StoreConfig {
  const type = (env.NOPO_CACHE_STORE ?? "filesystem") as StoreConfig["type"];
  const ttlSeconds = env.NOPO_CACHE_TTL
    ? parseInt(env.NOPO_CACHE_TTL, 10)
    : DEFAULT_TTL_SECONDS;

  const config: StoreConfig = { type, ttlSeconds };

  if (type === "filesystem") {
    config.filesystem = {
      baseDir: env.NOPO_CACHE_DIR,
    };
  } else if (type === "s3") {
    const bucket = env.NOPO_CACHE_S3_BUCKET;
    if (!bucket) {
      throw new Error("NOPO_CACHE_S3_BUCKET is required for S3 cache store");
    }
    config.s3 = {
      endpoint: env.NOPO_CACHE_S3_ENDPOINT,
      bucket,
      prefix: env.NOPO_CACHE_S3_PREFIX,
      region: env.NOPO_CACHE_S3_REGION,
      accessKeyId: env.NOPO_CACHE_S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.NOPO_CACHE_S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY,
    };
  }

  return config;
}

/**
 * Create cache entry from step result.
 */
export function createCacheEntry(
  stepKey: StepKey,
  passed: boolean,
  durationMs: number,
  ttlSeconds: number,
  runUrl?: string,
  meta?: Record<string, unknown>,
): CacheEntry {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  return {
    key: stepKey.key,
    passed,
    durationMs,
    runUrl,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    meta,
  };
}

/**
 * Check if a cache entry is expired.
 */
export function isExpired(entry: CacheEntry): boolean {
  return new Date(entry.expiresAt) < new Date();
}
