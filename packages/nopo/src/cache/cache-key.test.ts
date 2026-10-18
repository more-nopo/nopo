import { describe, expect, it } from "vitest";

import {
  computePlanKey,
  computeStepKey,
  getRuntimeVersion,
  hashFileContent,
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

      expect(key.version).toBe("v1");
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
});
