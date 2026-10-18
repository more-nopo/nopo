import { describe, expect, it } from "vitest";

import { loadCacheConfig } from "./index.ts";

describe("loadCacheConfig", () => {
  describe("enabled", () => {
    it("defaults to disabled", () => {
      const config = loadCacheConfig({});
      expect(config.enabled).toBe(false);
    });

    it("enables with NOPO_CACHE=1", () => {
      const config = loadCacheConfig({ NOPO_CACHE: "1" });
      expect(config.enabled).toBe(true);
    });

    it("enables with NOPO_CACHE=true", () => {
      const config = loadCacheConfig({ NOPO_CACHE: "true" });
      expect(config.enabled).toBe(true);
    });

    it("respects override.enabled", () => {
      const config = loadCacheConfig({}, { enabled: true });
      expect(config.enabled).toBe(true);
    });
  });

  describe("writeEnabled", () => {
    it("defaults to false when not in CI", () => {
      const config = loadCacheConfig({});
      expect(config.writeEnabled).toBe(false);
    });

    it("defaults to true in CI (CI=true)", () => {
      const config = loadCacheConfig({ CI: "true" });
      expect(config.writeEnabled).toBe(true);
    });

    it("defaults to true in CI (CI=1)", () => {
      const config = loadCacheConfig({ CI: "1" });
      expect(config.writeEnabled).toBe(true);
    });

    it("enables with NOPO_CACHE_WRITE=1 even outside CI", () => {
      const config = loadCacheConfig({ NOPO_CACHE_WRITE: "1" });
      expect(config.writeEnabled).toBe(true);
    });

    it("enables with NOPO_CACHE_WRITE=true even outside CI", () => {
      const config = loadCacheConfig({ NOPO_CACHE_WRITE: "true" });
      expect(config.writeEnabled).toBe(true);
    });

    it("respects override.writeEnabled", () => {
      const config = loadCacheConfig({}, { writeEnabled: true });
      expect(config.writeEnabled).toBe(true);
    });

    it("override.writeEnabled takes precedence over CI", () => {
      const config = loadCacheConfig({ CI: "true" }, { writeEnabled: false });
      expect(config.writeEnabled).toBe(false);
    });
  });

  describe("samplingPercent", () => {
    it("defaults to 0", () => {
      const config = loadCacheConfig({});
      expect(config.samplingPercent).toBe(0);
    });

    it("reads NOPO_CACHE_SAMPLING", () => {
      const config = loadCacheConfig({ NOPO_CACHE_SAMPLING: "5" });
      expect(config.samplingPercent).toBe(5);
    });

    it("respects override.samplingPercent", () => {
      const config = loadCacheConfig({}, { samplingPercent: 10 });
      expect(config.samplingPercent).toBe(10);
    });
  });

  describe("runUrl", () => {
    it("auto-detects GitHub Actions URL", () => {
      const config = loadCacheConfig({
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "12345",
      });
      expect(config.runUrl).toBe("https://github.com/owner/repo/actions/runs/12345");
    });

    it("uses custom GITHUB_SERVER_URL", () => {
      const config = loadCacheConfig({
        GITHUB_SERVER_URL: "https://github.enterprise.com",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "12345",
      });
      expect(config.runUrl).toBe("https://github.enterprise.com/owner/repo/actions/runs/12345");
    });

    it("reads NOPO_CACHE_RUN_URL", () => {
      const config = loadCacheConfig({
        NOPO_CACHE_RUN_URL: "https://custom.ci/run/123",
      });
      expect(config.runUrl).toBe("https://custom.ci/run/123");
    });

    it("NOPO_CACHE_RUN_URL takes precedence over auto-detect", () => {
      const config = loadCacheConfig({
        NOPO_CACHE_RUN_URL: "https://custom.ci/run/123",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "12345",
      });
      expect(config.runUrl).toBe("https://custom.ci/run/123");
    });
  });
});
