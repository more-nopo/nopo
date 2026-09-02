import fs from "node:fs";
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BuildScript from "../../src/scripts/build.ts";
import { createFixtureConfig, createTmpEnv, runScript } from "../utils.ts";

// Track exec calls
const mockExecCalls: Array<{
  command: string;
  args: string[];
  cwd?: string;
}> = [];

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
        mockExecCalls.push({ command, args, cwd: options?.cwd });
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

// Mock GitInfo — controls what files appear as "changed"
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

function fixtureConfig() {
  return createFixtureConfig({
    envFile: createTmpEnv({ DOCKER_TAG: "test/fixtures:local" }),
    silent: true,
  });
}

describe("build --changed / --with-dependants / --print flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecCalls.length = 0;
    mockChangedFiles = [];
  });

  describe("--print", () => {
    it("outputs JSON dry-run info and does not build", async () => {
      const config = fixtureConfig();
      const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await runScript(BuildScript, config, ["build", "--print"]);

      expect(writeSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing mock call args
        writeSpy.mock.calls[0]![0] as string,
      );
      expect(output.command).toBe("build");
      expect(output.finalTargets).toBeInstanceOf(Array);
      expect(output.finalTargets.length).toBeGreaterThan(0);
      expect(output.plugins).toBeInstanceOf(Array);
      expect(output.scriptDependencies).toBeInstanceOf(Array);

      // No exec calls — --print should not build anything
      expect(mockExecCalls).toHaveLength(0);

      writeSpy.mockRestore();
    });
  });

  describe("--changed", () => {
    it("filters targets to only changed services", async () => {
      // Simulate a file change inside services/minimal/
      mockChangedFiles = ["services/minimal/src/main.ts"];

      const config = fixtureConfig();
      const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--since",
        "abc123",
        "--print",
      ]);

      const output = JSON.parse(
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing mock call args
        writeSpy.mock.calls[0]![0] as string,
      );
      // Only minimal should be in the filtered list
      expect(output.filteredTargets).toContain("minimal");
      // Unrelated services should not be present
      expect(output.filteredTargets).not.toContain("complex");
      expect(output.filteredTargets).not.toContain("dependent");

      writeSpy.mockRestore();
    });

    it("returns empty list when no files changed", async () => {
      mockChangedFiles = [];

      const config = fixtureConfig();
      const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--since",
        "abc123",
        "--print",
      ]);

      const output = JSON.parse(
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing mock call args
        writeSpy.mock.calls[0]![0] as string,
      );
      expect(output.filteredTargets).toEqual([]);

      writeSpy.mockRestore();
    });

    it("includes changed packages in filtered targets", async () => {
      // Use the fixture `no-build` package (no `build:` section — models a real workspace like a
      // type-only library). Tests must never reference real product packages by name/path; those
      mockChangedFiles = ["packages/no-build/src/foo.ts"];

      const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await runScript(BuildScript, fixtureConfig(), [
        "build",
        "--changed",
        "--since",
        "abc123",
        "--print",
      ]);

      const output = JSON.parse(
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing mock call args
        writeSpy.mock.calls[0]![0] as string,
      );
      // The package is changed, so it appears in filteredTargets even though it has no
      // build.command (the --print dry-run reports what changed, not what's buildable).
      expect(output.filteredTargets).toContain("no-build");
      // The filter should be reported
      expect(output.filters).toEqual(
        expect.arrayContaining([{ type: "preset", field: "changed" }]),
      );

      writeSpy.mockRestore();
    });

    it("writes empty output file when --changed finds nothing", async () => {
      mockChangedFiles = [];

      const tmpOutput = `/tmp/nopo-test-build-output-${Date.now()}.json`;
      const config = fixtureConfig();

      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--since",
        "abc123",
        "--output",
        tmpOutput,
      ]);

      // Should have written empty JSON to the output file
      expect(fs.existsSync(tmpOutput)).toBe(true);
      const content = JSON.parse(fs.readFileSync(tmpOutput, "utf-8"));
      expect(content).toEqual({});

      // Should NOT have executed any builds
      expect(mockExecCalls).toHaveLength(0);

      fs.unlinkSync(tmpOutput);
    });

    it("propagates filtered targets to args for plugins", async () => {
      // Only minimal changed
      mockChangedFiles = ["services/minimal/src/main.ts"];

      const config = fixtureConfig();

      // Run without --print to exercise the full build path
      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--since",
        "abc123",
      ]);

      // Should only build minimal's build.command, not complex/dependent/etc.
      const buildCalls = mockExecCalls.filter(
        (call) => call.command === "sh" && call.args[0] === "-c",
      );
      const builtServices = buildCalls.map((c) => c.args[1]);

      // minimal has build.command: 'echo "build minimal"'
      expect(builtServices).toContain('echo "build minimal"');
      // complex should NOT be built
      expect(builtServices).not.toContain('echo "build complex"');
    });
  });

  describe("--with-dependants", () => {
    it("expands changed services to include dependants", async () => {
      // shared is a dependency of utils and dependent
      mockChangedFiles = ["packages/shared/src/index.ts"];

      const config = fixtureConfig();
      const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--with-dependants",
        "--since",
        "abc123",
        "--print",
      ]);

      const output = JSON.parse(
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing mock call args
        writeSpy.mock.calls[0]![0] as string,
      );
      // shared changed -> utils depends on shared -> dependent depends on shared
      expect(output.finalTargets).toContain("shared");
      expect(output.finalTargets).toContain("utils");
      expect(output.finalTargets).toContain("dependent");
      // dependants should be reported
      expect(output.dependants).toContain("utils");
      expect(output.dependants).toContain("dependent");

      writeSpy.mockRestore();
    });
  });

  describe("--since passthrough", () => {
    it("passes --since value through to dry-run output", async () => {
      mockChangedFiles = ["services/minimal/src/main.ts"];

      const config = fixtureConfig();
      const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      // The key test: --since abc123 must appear in the dry-run output
      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--since",
        "abc123",
        "--print",
      ]);

      const output = JSON.parse(
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing mock call args
        writeSpy.mock.calls[0]![0] as string,
      );
      // --since value should be reported in the dry-run output
      expect(output.since).toBe("abc123");

      // The changed filter should have been applied using this ref
      const { GitInfo } = await import("../../src/git-info.ts");
      expect(GitInfo.getChangedFiles).toHaveBeenCalledWith("abc123");

      writeSpy.mockRestore();
    });
  });
});
