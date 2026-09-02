import { describe, expect, it } from "vitest";

import { parseTargetArgs } from "../src/target-args.ts";

describe("Target Resolution Algorithm", () => {
  describe("parseTargetArgs for script classes", () => {
    const availableTargets = ["backend", "web"];

    it("should extract targets from positionals for build command", () => {
      const argv = ["backend", "web"];
      const result = parseTargetArgs("build", argv, availableTargets);

      expect(result.targets).toEqual(["backend", "web"]);
      expect(result.leadingArgs).toEqual([]);
    });

    it("should return empty targets when none specified", () => {
      const argv: string[] = [];
      const result = parseTargetArgs("build", argv, availableTargets);

      expect(result.targets).toEqual([]);
      // When no targets, should use all available targets (handled by script)
    });

    it("should validate targets against available list", () => {
      const argv = ["backend", "invalid"];
      expect(() => {
        parseTargetArgs("build", argv, availableTargets);
      }).toThrow("Unknown target 'invalid'");
    });
  });

  describe("parseTargetArgs for arbitrary commands", () => {
    const availableTargets = ["backend", "web"];

    it("should extract command name and targets for host execution", () => {
      // After CLI routing strips "lint" from `nopo lint web`, argv is
      // targets only. parseTargetArgs expects targets, not command names.
      const argv = ["web"];
      const result = parseTargetArgs("lint", argv, availableTargets);

      // After command name is stripped, only targets remain
      expect(result.targets).toEqual(["web"]);
    });

    it("should extract command and multiple targets", () => {
      // nopo lint backend web
      // After CLI routing strips "lint", argv becomes ["backend", "web"]
      const argv = ["backend", "web"];
      const result = parseTargetArgs("lint", argv, availableTargets);

      expect(result.targets).toEqual(["backend", "web"]);
    });

    it("should handle command without targets", () => {
      // nopo lint
      // After CLI routing strips "lint", argv is empty
      const argv: string[] = [];
      const result = parseTargetArgs("lint", argv, availableTargets);

      expect(result.targets).toEqual([]);
      // Should run at root level when no targets
    });

    it("should extract command and targets for container execution", () => {
      // nopo run lint web
      // After removing "run", argv becomes ["lint", "web"]
      const argv = ["lint", "web"];
      const result = parseTargetArgs("run", argv, availableTargets, {
        leadingPositionals: 1, // "lint" is the script name (leading positional)
      });

      expect(result.leadingArgs).toEqual(["lint"]);
      expect(result.targets).toEqual(["web"]);
    });
  });

  describe("target resolution behavior", () => {
    it("should use all targets when none specified for script classes", () => {
      // Script classes should operate on all targets when none specified
      const availableTargets = ["backend", "web"];
      const argv: string[] = [];
      const result = parseTargetArgs("build", argv, availableTargets);

      expect(result.targets).toEqual([]);
      // Script should interpret empty as "all targets"
    });

    it("should use root level when no targets for host execution", () => {
      // Host execution should run at root when no targets
      // After CLI routing strips command name, argv is empty
      const availableTargets = ["backend", "web"];
      const argv: string[] = [];
      const result = parseTargetArgs("lint", argv, availableTargets);

      expect(result.targets).toEqual([]);
      // Should run: pnpm run lint (at root)
    });

    it("should use all targets when none specified for container execution", () => {
      // Container execution should run in all containers when no targets
      const availableTargets = ["backend", "web"];
      const argv = ["lint"];
      const result = parseTargetArgs("run", argv, availableTargets, {
        leadingPositionals: 1,
      });

      expect(result.leadingArgs).toEqual(["lint"]);
      expect(result.targets).toEqual([]);
      // Should run in all target containers
    });
  });
});
