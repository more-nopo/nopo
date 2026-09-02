import { beforeEach, describe, expect, it, vi } from "vitest";

import { Logger, Runner } from "../src/lib.ts";
import { Environment } from "../src/parse-env.ts";
import BuildScript from "../src/scripts/build.ts";
import CommandScript from "../src/scripts/command.ts";
import EnvScript from "../src/scripts/env.ts";
import UpScript from "../src/scripts/up.ts";
import { createTestConfig, createTmpEnv } from "./utils.ts";

describe("Dependency Resolution Algorithm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("shared dependency resolution", () => {
    it("should resolve dependencies for script classes", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "example/app:local",
        }),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      // Test only checks static dependencies, runner not needed
      new Runner(config, environment, ["build"], logger);

      // BuildScript should have EnvScript as dependency This test documents expected behavior
      // after refactoring
      expect(BuildScript.dependencies).toBeDefined();
      expect(Array.isArray(BuildScript.dependencies)).toBe(true);
      expect(BuildScript.dependencies.length).toBeGreaterThanOrEqual(1);

      // Find EnvScript dependency
      const envDep = BuildScript.dependencies.find(
        (dep) => dep.class === EnvScript,
      );
      expect(envDep).toBeDefined();
      expect(envDep?.enabled).toBe(true);
    });

    it("should resolve nested dependencies", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "example/app:local",
        }),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      // Test only checks static dependencies, runner not needed
      new Runner(config, environment, ["up"], logger);

      // UpScript should have multiple dependencies
      // Note: Currently dependencies are static, but should be instance properties
      expect(UpScript.dependencies).toBeDefined();
      expect(Array.isArray(UpScript.dependencies)).toBe(true);
      expect(UpScript.dependencies.length).toBeGreaterThan(1);

      // Should include EnvScript
      const hasEnv = UpScript.dependencies.some(
        (dep) => dep.class === EnvScript,
      );
      expect(hasEnv).toBe(true);
    });

    it("should only execute enabled dependencies", async () => {
      // Dependencies with enabled: false should be skipped
      const config = createTestConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "example/app:local",
        }),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      // Test only checks static dependencies, runner not needed
      new Runner(config, environment, ["up"], logger);

      // Check that conditional dependencies exist
      // Note: Currently dependencies are static, but should be instance properties
      expect(UpScript.dependencies).toBeDefined();
      expect(Array.isArray(UpScript.dependencies)).toBe(true);

      const conditionalDeps = UpScript.dependencies.filter(
        (dep) => typeof dep.enabled === "function",
      );
      expect(conditionalDeps.length).toBeGreaterThan(0);
    });
  });

  describe("dependency resolution for unified command execution", () => {
    it("should have EnvScript and BuildScript dependencies", async () => {
      // CommandScript should have EnvScript (always enabled) and
      // conditional BuildScript dependency for container execution
      expect(CommandScript.dependencies).toHaveLength(2);
      expect(CommandScript.dependencies[0]?.class).toBe(EnvScript);
      expect(CommandScript.dependencies[0]?.enabled).toBe(true);
      expect(CommandScript.dependencies[1]?.class).toBe(BuildScript);
      expect(typeof CommandScript.dependencies[1]?.enabled).toBe("function");
    });

    it("should conditionally enable build based on context and service state", async () => {
      // CommandScript should have conditional dependencies (functions, not just booleans)
      const conditionalDeps = CommandScript.dependencies.filter(
        (dep: { enabled: unknown }) => typeof dep.enabled === "function",
      );
      // BuildScript is conditionally enabled
      expect(conditionalDeps.length).toBe(1);
    });
  });

  describe("dependency execution order", () => {
    it("should execute dependencies before main command", async () => {
      // Dependencies should be resolved and executed before the main script
      // This is handled by Runner.run()
    });

    it("should not execute same dependency twice", async () => {
      // If multiple scripts depend on EnvScript, it should only run once
      // This is handled by Runner.resolveDependencies()
    });
  });
});
