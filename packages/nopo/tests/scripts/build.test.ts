import { beforeEach, describe, expect, it, vi } from "vitest";

import BuildScript from "../../src/scripts/build.ts";
import {
  createFixtureConfig,
  createTestConfig,
  createTmpEnv,
  HAS_PRODUCT_GRAPH,
  runScript,
} from "../utils.ts";

// Track all exec calls for host builds
const mockExecCalls: Array<{
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}> = [];

// Mock the exec function from lib.ts
vi.mock("../../src/lib.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib.ts")>();
  return {
    ...original,
    exec: vi.fn(
      (
        command: string,
        args: string[],
        options?: { cwd?: string; env?: Record<string, string> },
      ) => {
        mockExecCalls.push({
          command,
          args,
          cwd: options?.cwd,
          env: options?.env,
        });
        return Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
          combined: "",
          signal: null,
        });
      },
    ),
  };
});

vi.mock("../../src/git-info", () => ({
  GitInfo: {
    exists: () => false,
    parse: vi.fn(() => ({
      repo: "unknown",
      branch: "unknown",
      commit: "unknown",
    })),
  },
}));

vi.mock("node:net", () => ({
  default: {
    createServer: vi.fn().mockImplementation(() => ({
      listen: vi.fn(),
      address: vi.fn().mockReturnValue({ port: 80 }),
      close: vi.fn(),
    })),
  },
}));

describe.skipIf(!HAS_PRODUCT_GRAPH)("build", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecCalls.length = 0;
  });

  it("has correct dependencies", () => {
    expect(BuildScript.dependencies).toHaveLength(1);
    expect(BuildScript.dependencies[0]?.enabled).toBe(true);
  });

  describe("default host build (no plugin)", () => {
    it("runs build.command on host for services when no override", async () => {
      const config = createFixtureConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "test/fixtures:local",
        }),
        silent: true,
      });

      // No plugins loaded → default host build path
      await runScript(BuildScript, config);

      // Should have exec calls for packages + services with build commands
      const hostBuildCalls = mockExecCalls.filter(
        (call) => call.command === "sh" && call.args[0] === "-c",
      );

      // At minimum, packages with build.command should be built
      expect(hostBuildCalls.length).toBeGreaterThan(0);
    });

    it("throws error for unknown target", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "example/app:local",
        }),
        silent: true,
      });

      await expect(
        runScript(BuildScript, config, ["build", "unknown-service"]),
      ).rejects.toThrow("Unknown target 'unknown-service'");
    });
  });

  describe("package builds", () => {
    it("builds packages on host with build.command", async () => {
      const config = createFixtureConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "test/fixtures:local",
        }),
        silent: true,
      });

      await runScript(BuildScript, config);

      const packageBuildCalls = mockExecCalls.filter(
        (call) => call.command === "sh" && call.args[0] === "-c",
      );

      // Should have at least 3 host calls: shared, utils, and virtual packages
      // (may also have service builds in default host mode)
      expect(packageBuildCalls.length).toBeGreaterThanOrEqual(3);

      // All three package builds must be present somewhere in the call sequence.
      // Position-of-virtual vs utils is incidental — the only contractual ordering is
      const has = (needle: string) =>
        packageBuildCalls.some(
          (c) => Array.isArray(c.args) && c.args.includes(needle),
        );
      expect(has('echo "FIXTURE_SHARED_BUILD_SUCCESS"')).toBe(true);
      expect(has('echo "FIXTURE_UTILS_BUILD_SUCCESS"')).toBe(true);
      expect(has('echo "Building virtual package"')).toBe(true);
    });

    it("respects dependency ordering (dependencies built first)", async () => {
      const config = createFixtureConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "test/fixtures:local",
        }),
        silent: true,
      });

      await runScript(BuildScript, config);

      const packageBuildCalls = mockExecCalls.filter(
        (call) => call.command === "sh" && call.args[0] === "-c",
      );

      // 'shared' must be built before 'utils' since utils depends on shared
      const sharedIndex = packageBuildCalls.findIndex((call) =>
        call.args.includes('echo "FIXTURE_SHARED_BUILD_SUCCESS"'),
      );
      const utilsIndex = packageBuildCalls.findIndex((call) =>
        call.args.includes('echo "FIXTURE_UTILS_BUILD_SUCCESS"'),
      );

      expect(sharedIndex).toBeLessThan(utilsIndex);
    });

    it("runs package builds from the package directory", async () => {
      const config = createFixtureConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "test/fixtures:local",
        }),
        silent: true,
      });

      await runScript(BuildScript, config);

      const packageBuildCalls = mockExecCalls.filter(
        (call) => call.command === "sh" && call.args[0] === "-c",
      );

      expect(
        packageBuildCalls.some((call) =>
          call.cwd?.endsWith("/packages/shared"),
        ),
      ).toBe(true);
      expect(
        packageBuildCalls.some((call) => call.cwd?.endsWith("/packages/utils")),
      ).toBe(true);
      expect(
        packageBuildCalls.some((call) =>
          call.cwd?.endsWith("/packages/virtual"),
        ),
      ).toBe(true);
    });

    it("passes build environment variables to host package build", async () => {
      const config = createFixtureConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "test/fixtures:local",
        }),
        silent: true,
      });

      await runScript(BuildScript, config);

      const packageBuildCalls = mockExecCalls.filter(
        (call) => call.command === "sh" && call.args[0] === "-c",
      );

      // 'shared' package has build.env configured
      const sharedCall = packageBuildCalls.find((call) =>
        call.args.includes('echo "FIXTURE_SHARED_BUILD_SUCCESS"'),
      );

      expect(sharedCall?.env?.NODE_ENV).toBe("production");
    });

    it("does not attempt to build packages without build.command", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "example/app:local",
        }),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "backend"]);

      // Building a service target should not try to build package-only targets
      // that don't define build.command (e.g., packages/ui)
      const uiBuildCalls = mockExecCalls.filter((call) =>
        call.cwd?.endsWith("/packages/ui"),
      );
      expect(uiBuildCalls).toHaveLength(0);
    });

    it("skips targeted package without build.command", async () => {
      mockExecCalls.length = 0;
      const config = createTestConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "example/app:local",
        }),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "prompt-factory"]);

      const pfCalls = mockExecCalls.filter((call) =>
        call.cwd?.includes("prompt-factory"),
      );
      expect(pfCalls).toHaveLength(0);
    });

    it("builds only packages matching --tags", async () => {
      const config = createFixtureConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "test/fixtures:local",
        }),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "--tags", "fixture-tag"]);

      const packageBuildCalls = mockExecCalls.filter(
        (call) => call.command === "sh" && call.args[0] === "-c",
      );

      const sharedIndex = packageBuildCalls.findIndex((call) =>
        call.args.includes('echo "FIXTURE_SHARED_BUILD_SUCCESS"'),
      );
      const utilsIndex = packageBuildCalls.findIndex((call) =>
        call.args.includes('echo "FIXTURE_UTILS_BUILD_SUCCESS"'),
      );
      expect(sharedIndex).toBeGreaterThanOrEqual(0);
      expect(utilsIndex).toBeGreaterThanOrEqual(0);
      expect(sharedIndex).toBeLessThan(utilsIndex);
    });
  });
});
