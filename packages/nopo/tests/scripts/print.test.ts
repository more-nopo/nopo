/* eslint-disable @typescript-eslint/consistent-type-assertions -- JSON.parse in tests */
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DryRunOutput } from "../../src/print.ts";
import BuildScript from "../../src/scripts/build.ts";
import CommandScript from "../../src/scripts/command.ts";
import DownScript from "../../src/scripts/down.ts";
import ListScript from "../../src/scripts/list.ts";
import UpScript from "../../src/scripts/up.ts";
import { createFixtureConfig, createTmpEnv, runScript } from "../utils.ts";

// Mock exec to prevent side effects
vi.mock("../../src/lib.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib.ts")>();
  return {
    ...original,
    exec: vi.fn(
      (
        _command: string,
        _args: string[],
        _options?: { cwd?: string; env?: Record<string, string> },
      ) => {
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

// Mock GitInfo for changed files tests
let mockChangedFiles: string[] = [];

vi.mock("../../src/git-info.ts", () => ({
  GitInfo: {
    exists: () => false,
    parse: vi.fn(() => ({
      repo: "unknown",
      branch: "unknown",
      commit: "unknown",
    })),
    getChangedFiles: vi.fn(() => mockChangedFiles),
    getDefaultBranch: vi.fn(() => "main"),
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

function captureStdout(): {
  output: () => string;
  restore: () => void;
} {
  let captured = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    captured += chunk;
    return true;
  });

  return {
    output: () => captured,
    restore: () => spy.mockRestore(),
  };
}

function parseDryRunOutput(raw: string): DryRunOutput {
  return JSON.parse(raw.trim()) as DryRunOutput;
}

describe("--print dry-run mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChangedFiles = [];
  });

  describe("common behavior", () => {
    it("outputs valid JSON to stdout", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      expect(output).toBeDefined();
      expect(typeof output.command).toBe("string");
      stdout.restore();
    });

    it("includes all required fields", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      expect(output.command).toBeDefined();
      expect(output.targets).toBeInstanceOf(Array);
      expect(output.filteredTargets).toBeInstanceOf(Array);
      expect(output.finalTargets).toBeInstanceOf(Array);
      expect(output.dependencies).toBeDefined();
      expect(output.dependants).toBeInstanceOf(Array);
      expect(output.filters).toBeInstanceOf(Array);
      expect(output.plugins).toBeInstanceOf(Array);
      expect(output.scriptDependencies).toBeInstanceOf(Array);
      stdout.restore();
    });

    it("does not execute any commands", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const { exec } = await import("../../src/lib.ts");
      await runScript(BuildScript, config, ["build", "--print"]);

      // exec should not be called -- --print should short-circuit
      expect(exec).not.toHaveBeenCalled();
      stdout.restore();
    });
  });

  describe("build --print", () => {
    it("reports command name as build", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      expect(output.command).toBe("build");
      stdout.restore();
    });

    it("reports all available targets", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      // Fixture has these services
      expect(output.targets).toContain("minimal");
      expect(output.targets).toContain("complex");
      expect(output.targets).toContain("shared");
      stdout.restore();
    });

    it("reports script dependencies (env)", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      const envDep = output.scriptDependencies.find((d) => d.name === "env");
      expect(envDep).toBeDefined();
      expect(envDep!.enabled).toBe(true);
      stdout.restore();
    });

    it("reports specific targets when provided", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "minimal", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      expect(output.filteredTargets).toEqual(["minimal"]);
      expect(output.finalTargets).toEqual(["minimal"]);
      stdout.restore();
    });
  });

  describe("up --print", () => {
    it("reports command name as up", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(UpScript, config, ["up", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      expect(output.command).toBe("up");
      stdout.restore();
    });

    it("does not throw missing plugin error", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      // Without --print, up throws "No plugin provides an 'up' override"
      // With --print, it should NOT throw
      await expect(
        runScript(UpScript, config, ["up", "--print"]),
      ).resolves.not.toThrow();
      stdout.restore();
    });

    it("reports build as a script dependency", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(UpScript, config, ["up", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      const buildDep = output.scriptDependencies.find(
        (d) => d.name === "build",
      );
      expect(buildDep).toBeDefined();
      stdout.restore();
    });
  });

  describe("down --print", () => {
    it("reports command name as down", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(DownScript, config, ["down", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      expect(output.command).toBe("down");
      stdout.restore();
    });

    it("does not throw missing plugin error", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await expect(
        runScript(DownScript, config, ["down", "--print"]),
      ).resolves.not.toThrow();
      stdout.restore();
    });
  });

  describe("list --print", () => {
    it("reports command name as list", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(ListScript, config, ["list", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      expect(output.command).toBe("list");
      stdout.restore();
    });
  });

  describe("command --print", () => {
    it("reports the command name from argv", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(CommandScript, config, ["test", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      expect(output.command).toBe("test");
      stdout.restore();
    });
  });

  describe("--changed + --print", () => {
    it("applies changed filter and reports filtered targets", async () => {
      mockChangedFiles = ["services/minimal/src/main.ts"];

      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--since",
        "abc123",
        "--print",
      ]);

      const output = parseDryRunOutput(stdout.output());
      // Only minimal should be in filtered targets
      expect(output.filteredTargets).toContain("minimal");
      expect(output.filteredTargets).not.toContain("complex");
      // The changed filter should be reported
      expect(output.filters).toEqual(
        expect.arrayContaining([{ type: "preset", field: "changed" }]),
      );
      // Since value should be reported
      expect(output.since).toBe("abc123");
      stdout.restore();
    });

    it("returns empty filtered targets when nothing changed", async () => {
      mockChangedFiles = [];

      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--since",
        "abc123",
        "--print",
      ]);

      const output = parseDryRunOutput(stdout.output());
      expect(output.filteredTargets).toEqual([]);
      expect(output.finalTargets).toEqual([]);
      stdout.restore();
    });
  });

  describe("--with-dependants + --print", () => {
    it("expands targets and reports dependants", async () => {
      mockChangedFiles = ["packages/shared/src/index.ts"];

      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--with-dependants",
        "--since",
        "abc123",
        "--print",
      ]);

      const output = parseDryRunOutput(stdout.output());
      // shared changed, utils and dependent depend on shared
      expect(output.filteredTargets).toContain("shared");
      expect(output.filteredTargets).not.toContain("utils");
      // After expansion, utils and dependent should be in finalTargets
      expect(output.finalTargets).toContain("shared");
      expect(output.finalTargets).toContain("utils");
      expect(output.finalTargets).toContain("dependent");
      // Dependants should be reported
      expect(output.dependants).toContain("utils");
      expect(output.dependants).toContain("dependent");
      stdout.restore();
    });
  });

  describe("--since + --print", () => {
    it("reports plain since ref", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "--since",
        "abc123",
        "--print",
      ]);

      const output = parseDryRunOutput(stdout.output());
      expect(output.since).toBe("abc123");
      stdout.restore();
    });

    it("reports per-service since map", async () => {
      const sinceMap = JSON.stringify({
        minimal: "abc123",
        complex: "def456",
      });

      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "--since",
        sinceMap,
        "--print",
      ]);

      const output = parseDryRunOutput(stdout.output());
      expect(output.since).toEqual({
        minimal: "abc123",
        complex: "def456",
      });
      stdout.restore();
    });

    it("reports null since when not specified", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      expect(output.since).toBeNull();
      stdout.restore();
    });
  });

  describe("dependency graph in output", () => {
    it("includes dependency relationships for targeted services", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      // dependent has dependencies on shared, utils, and minimal
      expect(output.dependencies.dependent).toBeDefined();
      expect(output.dependencies.dependent).toContain("shared");
      expect(output.dependencies.dependent).toContain("utils");
      expect(output.dependencies.dependent).toContain("minimal");
      stdout.restore();
    });
  });

  describe("plugins in output", () => {
    it("reports empty plugins when none loaded", async () => {
      const stdout = captureStdout();
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "--print"]);

      const output = parseDryRunOutput(stdout.output());
      // Fixture config has no plugins
      expect(output.plugins).toEqual([]);
      stdout.restore();
    });
  });
});
