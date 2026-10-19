import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createCacheEntry,
  createResultStore,
  DEFAULT_TTL_SECONDS,
  isExpired,
  storeConfigFromEnv,
  type CacheEntry,
} from "./store.ts";
import type { StepKey } from "./cache-key.ts";
import { FilesystemStore } from "./stores/filesystem.ts";

describe("store", () => {
  describe("storeConfigFromEnv", () => {
    it("defaults to filesystem store", () => {
      const config = storeConfigFromEnv({});
      expect(config.type).toBe("filesystem");
      expect(config.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
    });

    it("reads NOPO_CACHE_STORE for filesystem", () => {
      const config = storeConfigFromEnv({ NOPO_CACHE_STORE: "filesystem" });
      expect(config.type).toBe("filesystem");
    });

    it("reads NOPO_CACHE_TTL", () => {
      const config = storeConfigFromEnv({ NOPO_CACHE_TTL: "3600" });
      expect(config.ttlSeconds).toBe(3600);
    });

    it("reads filesystem config", () => {
      const config = storeConfigFromEnv({
        NOPO_CACHE_STORE: "filesystem",
        NOPO_CACHE_DIR: "/tmp/cache",
      });
      expect(config.type).toBe("filesystem");
      expect(config.filesystem?.baseDir).toBe("/tmp/cache");
    });

    it("reads S3 config", () => {
      const config = storeConfigFromEnv({
        NOPO_CACHE_STORE: "s3",
        NOPO_CACHE_S3_ENDPOINT: "https://r2.example.com",
        NOPO_CACHE_S3_BUCKET: "my-bucket",
        NOPO_CACHE_S3_PREFIX: "cache",
        NOPO_CACHE_S3_REGION: "us-east-1",
        NOPO_CACHE_S3_ACCESS_KEY_ID: "access-key",
        NOPO_CACHE_S3_SECRET_ACCESS_KEY: "secret-key",
      });
      expect(config.type).toBe("s3");
      expect(config.s3?.endpoint).toBe("https://r2.example.com");
      expect(config.s3?.bucket).toBe("my-bucket");
      expect(config.s3?.prefix).toBe("cache");
      expect(config.s3?.region).toBe("us-east-1");
      expect(config.s3?.accessKeyId).toBe("access-key");
      expect(config.s3?.secretAccessKey).toBe("secret-key");
    });

    it("throws when S3 bucket is missing", () => {
      expect(() => storeConfigFromEnv({ NOPO_CACHE_STORE: "s3" })).toThrow(
        "NOPO_CACHE_S3_BUCKET is required",
      );
    });
  });

  describe("createCacheEntry", () => {
    it("creates entry with correct fields", () => {
      const stepKey: StepKey = {
        key: "abc123",
        version: "v1",
        inputs: {
          targetId: "api",
          command: "test",
          treeHashes: {},
          runtimeVersion: "node:v22.0.0",
          envInputs: {},
        },
      };

      const entry = createCacheEntry(stepKey, true, 1234, 3600, "https://ci.example.com/123");

      expect(entry).not.toBeNull();
      expect(entry!.key).toBe("abc123");
      expect(entry!.passed).toBe(true);
      expect(entry!.durationMs).toBe(1234);
      expect(entry!.runUrl).toBe("https://ci.example.com/123");
      expect(entry!.createdAt).toBeDefined();
      expect(entry!.expiresAt).toBeDefined();

      // Check that expiresAt is TTL seconds after createdAt
      const created = new Date(entry!.createdAt).getTime();
      const expires = new Date(entry!.expiresAt).getTime();
      expect(expires - created).toBe(3600 * 1000);
    });
  });

  describe("isExpired", () => {
    it("returns false for non-expired entry", () => {
      const entry: CacheEntry = {
        key: "test",
        passed: true,
        durationMs: 100,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      };
      expect(isExpired(entry)).toBe(false);
    });

    it("returns true for expired entry", () => {
      const entry: CacheEntry = {
        key: "test",
        passed: true,
        durationMs: 100,
        createdAt: new Date(Date.now() - 7200 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      };
      expect(isExpired(entry)).toBe(true);
    });
  });

  describe("createResultStore", () => {
    it("creates filesystem store", async () => {
      const store = await createResultStore({
        type: "filesystem",
        ttlSeconds: 3600,
      });
      expect(store.name).toBe("filesystem");
    });

    it("throws for unknown store type", async () => {
      await expect(
        createResultStore({
          // @ts-expect-error testing invalid type
          type: "unknown",
          ttlSeconds: 3600,
        }),
      ).rejects.toThrow("Unknown store type");
    });
  });
});

describe("FilesystemStore", () => {
  let tempDir: string;
  let store: FilesystemStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-cache-test-"));
    store = new FilesystemStore({ baseDir: tempDir, ttlSeconds: 3600 });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null for non-existent key", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  it("stores and retrieves entries", async () => {
    const entry: CacheEntry = {
      key: "test-key",
      passed: true,
      durationMs: 1234,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    };

    await store.put(entry);
    const retrieved = await store.get("test-key");

    expect(retrieved).toEqual(entry);
  });

  it("returns null for expired entries and removes them", async () => {
    const entry: CacheEntry = {
      key: "expired-key",
      passed: true,
      durationMs: 100,
      createdAt: new Date(Date.now() - 7200 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    };

    await store.put(entry);
    const retrieved = await store.get("expired-key");

    expect(retrieved).toBeNull();

    // File should be cleaned up
    const filePath = path.join(tempDir, "ex", "expired-key.json");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("isAvailable returns true for writable directory", async () => {
    const available = await store.isAvailable();
    expect(available).toBe(true);
  });

  it("cleanup removes expired entries", async () => {
    // Add a non-expired entry
    const validEntry: CacheEntry = {
      key: "valid-key",
      passed: true,
      durationMs: 100,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    };
    await store.put(validEntry);

    // Add an expired entry
    const expiredEntry: CacheEntry = {
      key: "expired-key",
      passed: true,
      durationMs: 100,
      createdAt: new Date(Date.now() - 7200 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    };
    await store.put(expiredEntry);

    const cleaned = await store.cleanup!();
    expect(cleaned).toBe(1);

    // Valid entry should still exist
    const valid = await store.get("valid-key");
    expect(valid).not.toBeNull();
  });
});
