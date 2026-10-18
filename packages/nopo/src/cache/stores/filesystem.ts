/**
 * Filesystem-based result store for local development and CI without S3.
 *
 * Cache entries are stored as JSON files in a directory structure:
 *   <baseDir>/<key-prefix>/<full-key>.json
 *
 * The key prefix (first 2 chars) distributes files across directories
 * to avoid filesystem performance issues with too many files in one dir.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CacheEntry, ResultStore } from "../store.ts";
import { isExpired } from "../store.ts";

export interface FilesystemStoreConfig {
  /** Base directory for cache files. Default: ~/.nopo/cache */
  baseDir?: string;
  /** TTL in seconds for cache entries */
  ttlSeconds: number;
}

const DEFAULT_BASE_DIR = path.join(os.homedir(), ".nopo", "cache");

export class FilesystemStore implements ResultStore {
  readonly name = "filesystem";
  private readonly baseDir: string;
  private readonly ttlSeconds: number;

  constructor(config: FilesystemStoreConfig) {
    this.baseDir = config.baseDir ?? DEFAULT_BASE_DIR;
    this.ttlSeconds = config.ttlSeconds;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Ensure base directory exists
      await this.ensureDir(this.baseDir);
      // Test write access
      const testFile = path.join(this.baseDir, ".write-test");
      fs.writeFileSync(testFile, "test", { flag: "w" });
      fs.unlinkSync(testFile);
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<CacheEntry | null> {
    const filePath = this.keyToPath(key);

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const entry: CacheEntry = JSON.parse(content);

      // Check expiration
      if (isExpired(entry)) {
        // Clean up expired entry
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Ignore cleanup errors
        }
        return null;
      }

      return entry;
    } catch (err) {
      // File not found or parse error
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        return null;
      }
      // Log parse errors but don't throw
      console.error(`[cache] Failed to read cache entry ${key}:`, err);
      return null;
    }
  }

  async put(entry: CacheEntry): Promise<void> {
    const filePath = this.keyToPath(entry.key);
    const dir = path.dirname(filePath);

    await this.ensureDir(dir);

    // Write atomically via temp file
    const tempPath = `${filePath}.tmp.${process.pid}`;
    try {
      const content = JSON.stringify(entry, null, 2);
      fs.writeFileSync(tempPath, content, "utf-8");
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      // Clean up temp file on error
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore
      }
      throw err;
    }
  }

  async cleanup(): Promise<number> {
    let cleaned = 0;
    const now = new Date();

    try {
      // Walk the cache directory
      const prefixDirs = fs.readdirSync(this.baseDir, { withFileTypes: true });

      for (const prefixDir of prefixDirs) {
        if (!prefixDir.isDirectory()) continue;

        const prefixPath = path.join(this.baseDir, prefixDir.name);
        const files = fs.readdirSync(prefixPath, { withFileTypes: true });

        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".json")) continue;

          const filePath = path.join(prefixPath, file.name);
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            const entry: CacheEntry = JSON.parse(content);

            if (new Date(entry.expiresAt) < now) {
              fs.unlinkSync(filePath);
              cleaned++;
            }
          } catch {
            // Skip unreadable files
          }
        }

        // Remove empty prefix directories
        try {
          const remaining = fs.readdirSync(prefixPath);
          if (remaining.length === 0) {
            fs.rmdirSync(prefixPath);
          }
        } catch {
          // Ignore
        }
      }
    } catch (err) {
      console.error("[cache] Cleanup error:", err);
    }

    return cleaned;
  }

  private keyToPath(key: string): string {
    // Use first 2 chars as prefix for directory distribution
    const prefix = key.slice(0, 2);
    return path.join(this.baseDir, prefix, `${key}.json`);
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      // Ignore EEXIST
      if (err instanceof Error && "code" in err && err.code !== "EEXIST") {
        throw err;
      }
    }
  }
}
