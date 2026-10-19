import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computePlanKey,
  computeStepKey,
  getDirtyPaths,
  getRuntimeVersion,
  hashFileContent,
  isPathDirty,
  type StepKeyInputs,
} from "./cache-key.ts";

describe("cache-key", () => {
  describe("computeStepKey", () => {
    it("produces a stable hash for the same inputs", () => {
      const inputs: StepKeyInputs = {
        targetId: "api",
        command: "builtin:command:exec",
        args: ["lint"],
        payload: { service: "api", command: "lint" },
        treeHashes: { api: "abc123", shared: "def456" },
        lockfileHash: "lockfile-hash",
        runtimeVersion: "node:v22.0.0",
        envInputs: { CI: "true", NODE_ENV: "test" },
      };

      const key1 = computeStepKey(inputs);
      const key2 = computeStepKey(inputs);

      expect(key1.key).toBe(key2.key);
      expect(key1.key).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it("produces different keys for different inputs", () => {
      const baseInputs: StepKeyInputs = {
        targetId: "api",
        command: "builtin:command:exec",
        treeHashes: { api: "abc123" },
        runtimeVersion: "node:v22.0.0",
        envInputs: {},
      };

      const key1 = computeStepKey(baseInputs);
      const key2 = computeStepKey({ ...baseInputs, targetId: "web" });
      const key3 = computeStepKey({ ...baseInputs, treeHashes: { api: "different" } });

      expect(key1.key).not.toBe(key2.key);
      expect(key1.key).not.toBe(key3.key);
    });

    it("includes version in key metadata", () => {
      const inputs: StepKeyInputs = {
        targetId: "api",
        command: "test",
        treeHashes: {},
        runtimeVersion: "node:v22.0.0",
        envInputs: {},
      };

      const key = computeStepKey(inputs);

      expect(key.version).toBe("v2");
      expect(key.inputs).toBe(inputs);
    });

    it("handles empty optional fields", () => {
      const inputs: StepKeyInputs = {
        targetId: "api",
        command: "test",
        treeHashes: {},
        runtimeVersion: "node:v22.0.0",
        envInputs: {},
      };

      const key = computeStepKey(inputs);
      expect(key.key).toMatch(/^[a-f0-9]{64}$/);
    });

    it("sorts object keys for deterministic output", () => {
      const inputs1: StepKeyInputs = {
        targetId: "api",
        command: "test",
        treeHashes: { b: "2", a: "1", c: "3" },
        runtimeVersion: "node:v22.0.0",
        envInputs: { Z: "z", A: "a" },
      };

      const inputs2: StepKeyInputs = {
        targetId: "api",
        command: "test",
        treeHashes: { c: "3", a: "1", b: "2" },
        runtimeVersion: "node:v22.0.0",
        envInputs: { A: "a", Z: "z" },
      };

      const key1 = computeStepKey(inputs1);
      const key2 = computeStepKey(inputs2);

      expect(key1.key).toBe(key2.key);
    });
  });

  describe("computePlanKey", () => {
    it("combines step keys into a plan key", () => {
      const stepKey1 = computeStepKey({
        targetId: "api",
        command: "test",
        treeHashes: {},
        runtimeVersion: "node:v22.0.0",
        envInputs: {},
      });

      const stepKey2 = computeStepKey({
        targetId: "web",
        command: "test",
        treeHashes: {},
        runtimeVersion: "node:v22.0.0",
        envInputs: {},
      });

      const planKey = computePlanKey([stepKey1, stepKey2]);
      expect(planKey).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces same key regardless of step order", () => {
      const stepKey1 = computeStepKey({
        targetId: "api",
        command: "test",
        treeHashes: {},
        runtimeVersion: "node:v22.0.0",
        envInputs: {},
      });

      const stepKey2 = computeStepKey({
        targetId: "web",
        command: "test",
        treeHashes: {},
        runtimeVersion: "node:v22.0.0",
        envInputs: {},
      });

      const planKey1 = computePlanKey([stepKey1, stepKey2]);
      const planKey2 = computePlanKey([stepKey2, stepKey1]);

      expect(planKey1).toBe(planKey2);
    });
  });

  describe("getRuntimeVersion", () => {
    it("returns node version string", () => {
      const version = getRuntimeVersion();
      expect(version).toMatch(/^node:v\d+\.\d+\.\d+/);
    });
  });

  describe("hashFileContent", () => {
    it("returns null for non-existent files", () => {
      const hash = hashFileContent("/nonexistent/file.txt");
      expect(hash).toBeNull();
    });
  });

  describe("getDirtyPaths", () => {
    let tempDir: string;
    let originalCwd: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      // Create a temporary git repo for testing
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-cache-dirty-test-"));
      process.chdir(tempDir);

      // Initialize git repo
      const { spawnSync } = require("node:child_process");
      spawnSync("git", ["init"], { cwd: tempDir });
      spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: tempDir });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: tempDir });

      // Create initial commit
      fs.writeFileSync(path.join(tempDir, "file.txt"), "initial content");
      spawnSync("git", ["add", "file.txt"], { cwd: tempDir });
      spawnSync("git", ["commit", "-m", "initial"], { cwd: tempDir });
    });

    afterEach(() => {
      process.chdir(originalCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns empty array for clean working tree", () => {
      const dirtyPaths = getDirtyPaths(tempDir, ["file.txt"]);
      expect(dirtyPaths).toEqual([]);
    });

    it("detects modified files", () => {
      fs.writeFileSync(path.join(tempDir, "file.txt"), "modified content");

      const dirtyPaths = getDirtyPaths(tempDir, ["file.txt"]);
      expect(dirtyPaths).toContain("file.txt");
    });

    it("detects untracked files", () => {
      fs.writeFileSync(path.join(tempDir, "newfile.txt"), "new content");

      const dirtyPaths = getDirtyPaths(tempDir, ["newfile.txt"]);
      expect(dirtyPaths).toContain("newfile.txt");
    });

    it("returns empty for paths with no changes", () => {
      // Create another file and modify it
      fs.writeFileSync(path.join(tempDir, "other.txt"), "other content");

      // Check only for file.txt which is clean
      const dirtyPaths = getDirtyPaths(tempDir, ["file.txt"]);
      expect(dirtyPaths).toEqual([]);
    });
  });

  describe("isPathDirty", () => {
    let tempDir: string;
    let originalCwd: string;

    beforeEach(() => {
      originalCwd = process.cwd();
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-cache-dirty-test-"));
      process.chdir(tempDir);

      const { spawnSync } = require("node:child_process");
      spawnSync("git", ["init"], { cwd: tempDir });
      spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: tempDir });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: tempDir });

      // Create directory structure
      fs.mkdirSync(path.join(tempDir, "subdir"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "root.txt"), "root content");
      fs.writeFileSync(path.join(tempDir, "subdir", "nested.txt"), "nested content");
      spawnSync("git", ["add", "."], { cwd: tempDir });
      spawnSync("git", ["commit", "-m", "initial"], { cwd: tempDir });
    });

    afterEach(() => {
      process.chdir(originalCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns false for clean directory", () => {
      expect(isPathDirty(tempDir, "subdir")).toBe(false);
    });

    it("returns true when directory contains modified file", () => {
      fs.writeFileSync(path.join(tempDir, "subdir", "nested.txt"), "modified");

      expect(isPathDirty(tempDir, "subdir")).toBe(true);
    });

    it("returns true when directory contains untracked file", () => {
      fs.writeFileSync(path.join(tempDir, "subdir", "newfile.txt"), "new content");

      expect(isPathDirty(tempDir, "subdir")).toBe(true);
    });

    it("returns false for clean file", () => {
      expect(isPathDirty(tempDir, "root.txt")).toBe(false);
    });

    it("returns true for modified file", () => {
      fs.writeFileSync(path.join(tempDir, "root.txt"), "modified");

      expect(isPathDirty(tempDir, "root.txt")).toBe(true);
    });

    it("checks entire repo when path is empty", () => {
      // Clean repo
      expect(isPathDirty(tempDir, "")).toBe(false);
      expect(isPathDirty(tempDir, ".")).toBe(false);

      // Dirty repo
      fs.writeFileSync(path.join(tempDir, "untracked.txt"), "new");
      expect(isPathDirty(tempDir, "")).toBe(true);
    });
  });
});
