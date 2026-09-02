import process from "node:process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { exec, Logger, Runner } from "../../src/lib.ts";
import { Environment } from "../../src/parse-env.ts";
import CommandScript from "../../src/scripts/command.ts";
import {
  createTestConfig,
  createTmpEnv,
  FIXTURES_ROOT,
  HAS_PRODUCT_GRAPH,
} from "../utils.ts";

// Mock the exec function
vi.mock("../../src/lib.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib.ts")>();
  return {
    ...original,
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  };
});

describe.skipIf(!HAS_PRODUCT_GRAPH)(
  "CommandScript (run commands defined in nopo.yml)",
  () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Default values for the new flags added to parseCommandArgs
  const defaultNewFlags = {
    changed: false,
    withDependants: false,
    skipMissing: false,
    noFailFast: false,
    print: false,
  };

  describe("parseArgs", () => {
    it("should parse command with target: nopo build web", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(config, environment, ["build", "web"], logger);

      const args = CommandScript.parseCommandArgs(runner);
      expect(args).toEqual({
        command: "build",
        passthrough: [],
        targets: ["web"],
        filters: [],
        since: undefined,
        explicitTargets: true,
        contextOverride: undefined,
        ...defaultNewFlags,
      });
    });

    it("should parse command without targets", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(config, environment, ["build"], logger);

      const args = CommandScript.parseCommandArgs(runner);
      expect(args).toEqual({
        command: "build",
        passthrough: [],
        targets: [],
        filters: [],
        since: undefined,
        explicitTargets: false,
        contextOverride: undefined,
        ...defaultNewFlags,
      });
    });

    it("should parse a colon subcommand with a target: nopo fix:py web", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(config, environment, ["fix:py", "web"], logger);

      const args = CommandScript.parseCommandArgs(runner);
      // The colon path is carried whole in `command`; positionals are targets.
      expect(args).toEqual({
        command: "fix:py",
        passthrough: [],
        targets: ["web"],
        filters: [],
        since: undefined,
        explicitTargets: true,
        contextOverride: undefined,
        ...defaultNewFlags,
      });
    });

    it("should parse a colon subcommand with no target: nopo fix:py", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(config, environment, ["fix:py"], logger);

      const args = CommandScript.parseCommandArgs(runner);
      expect(args).toEqual({
        command: "fix:py",
        passthrough: [],
        targets: [],
        filters: [],
        since: undefined,
        explicitTargets: false,
        contextOverride: undefined,
        ...defaultNewFlags,
      });
    });

    it("should validate targets", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["build", "invalid"],
        logger,
      );

      // Every positional is a target, so this fails target validation.
      // and should fail validation
      expect(() => {
        CommandScript.parseCommandArgs(runner);
      }).toThrow("Unknown target 'invalid'");
    });

    it("should parse multiple targets: nopo build backend web", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["build", "backend", "web"],
        logger,
      );

      const args = CommandScript.parseCommandArgs(runner);
      expect(args).toEqual({
        command: "build",
        passthrough: [],
        targets: ["backend", "web"],
        filters: [],
        since: undefined,
        explicitTargets: true,
        contextOverride: undefined,
        ...defaultNewFlags,
      });
    });

    it("should parse --changed flag", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "--changed"],
        logger,
      );

      const args = CommandScript.parseCommandArgs(runner);
      expect(args.changed).toBe(true);
      expect(args.withDependants).toBe(false);
    });

    it("should parse --with-dependants flag", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "--changed", "--with-dependants"],
        logger,
      );

      const args = CommandScript.parseCommandArgs(runner);
      expect(args.changed).toBe(true);
      expect(args.withDependants).toBe(true);
    });

    it("should parse --skip-missing flag", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "--skip-missing"],
        logger,
      );

      const args = CommandScript.parseCommandArgs(runner);
      expect(args.skipMissing).toBe(true);
    });

    it("should parse --no-fail-fast flag", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "--no-fail-fast"],
        logger,
      );

      const args = CommandScript.parseCommandArgs(runner);
      expect(args.noFailFast).toBe(true);
    });

    it("should parse --print flag", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "--print", "--json"],
        logger,
      );

      const args = CommandScript.parseCommandArgs(runner);
      expect(args.print).toBe(true);
    });

    it("should parse --since with --changed", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "--changed", "--since", "abc123"],
        logger,
      );

      const args = CommandScript.parseCommandArgs(runner);
      expect(args.changed).toBe(true);
      expect(args.since).toBe("abc123");
    });
  });

  describe("dependencies", () => {
    it("should have EnvScript and BuildScript dependencies", async () => {
      // CommandScript has 2 dependencies: EnvScript (always enabled) BuildScript (conditionally
      // enabled for container execution)
      expect(CommandScript.dependencies).toHaveLength(2);
      expect(CommandScript.dependencies[0]?.class.name).toBe("env");
      expect(CommandScript.dependencies[0]?.enabled).toBe(true);
      expect(CommandScript.dependencies[1]?.class.name).toBe("build");
      expect(typeof CommandScript.dependencies[1]?.enabled).toBe("function");
    });
  });

  describe("execution", () => {
    it("should execute command on target service", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(config, environment, ["test", "web"], logger);

      // fn() parses command args internally, so we pass an empty ScriptArgs
      await runner.run(CommandScript);

      expect(exec).toHaveBeenCalled();
      // Check that exec was called with the right command
      expect(exec).toHaveBeenCalledWith(
        "sh",
        ["-c", "echo 'test'"],
        expect.objectContaining({
          cwd: expect.stringContaining("products/example/web"),
        }),
      );
    });

    it("should execute command on multiple targets", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["clean", "backend", "web"],
        logger,
      );

      // fn() parses command args internally, so we pass an empty ScriptArgs
      await runner.run(CommandScript);

      // Should execute on both backend and web
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it("should respect --concurrency flag to limit parallel tasks", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["clean", "backend", "web", "--concurrency", "1"],
        logger,
      );

      // Track concurrent execution
      let maxConcurrent = 0;
      let currentConcurrent = 0;
      vi.mocked(exec).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test mock
        (async () => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise((r) => setTimeout(r, 10));
          currentConcurrent--;
          return { stdout: "", stderr: "", exitCode: 0 };
        }) as never,
      );

      // Run via the production plan path so `--concurrency` flows from
      // CLI args into PlanContext.maxConcurrency.
      await runner.run(CommandScript);

      // With concurrency=1, only 1 task should run at a time
      expect(maxConcurrent).toBe(1);
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it("should throw error for undefined command", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["undefined-command", "web"],
        logger,
      );

      // fn() parses command args internally, so we pass an empty ScriptArgs
      await expect(runner.run(CommandScript)).rejects.toThrow(
        /does not define command 'undefined-command'/,
      );
    });

    it("should output JSON with --print and not execute", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv({}),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "--print", "--json"],
        logger,
      );

      await runner.run(CommandScript);

      // Should output JSON
      const parsed = JSON.parse(output.trim());
      expect(parsed.services).toBeDefined();
      expect(Array.isArray(parsed.services)).toBe(true);
      // Should include services that have a 'test' command
      expect(parsed.services.length).toBeGreaterThan(0);

      // Should NOT execute any command
      expect(exec).not.toHaveBeenCalled();

      stdoutSpy.mockRestore();
    });

    it("should skip services without the command when --skip-missing is set", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      // "undefined-command" does not exist on web, but --skip-missing should not throw
      const runner = new Runner(
        config,
        environment,
        ["undefined-command", "web", "--skip-missing"],
        logger,
      );

      // Should not throw — should silently skip
      await runner.run(CommandScript);
      expect(exec).not.toHaveBeenCalled();
    });

    it("should continue on failures with --no-fail-fast and report all errors", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["clean", "backend", "web", "--no-fail-fast"],
        logger,
      );

      // Make execs fail, then restore default behavior
      vi.mocked(exec)
        .mockRejectedValueOnce(new Error("command failed"))
        .mockRejectedValueOnce(new Error("command failed"));

      await expect(runner.run(CommandScript)).rejects.toThrow(
        /2 task\(s\) failed/,
      );

      // Both tasks should have been attempted
      expect(exec).toHaveBeenCalledTimes(2);
    });
  });

  describe("colon subcommand addressing", () => {
    it("carries the whole colon path as the command: nopo fix:py", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(config, environment, ["fix:py"], logger);

      const args = CommandScript.parseCommandArgs(runner);
      expect(args.command).toBe("fix:py");
      expect(args.command).toBe("fix:py");
      expect(args.targets).toEqual([]);
    });

    it("keeps positionals as targets: nopo fix:py backend", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["fix:py", "backend"],
        logger,
      );

      const args = CommandScript.parseCommandArgs(runner);
      expect(args.command).toBe("fix:py");
      expect(args.command).toBe("fix:py");
      expect(args.targets).toEqual(["backend"]);
    });

    it("should treat unknown arg as target when it's a valid service", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(config, environment, ["build", "web"], logger);

      const args = CommandScript.parseCommandArgs(runner);
      // Every positional is a target now — there is nothing to detect.
      expect(args.command).toBe("build");
      expect(args.command).toBe("build");
      expect(args.targets).toEqual(["web"]);
    });
  });

  describe("container execution", () => {
    // Ensure consistent namespace in tests (CI=true would use dynamic namespace)
    const originalCI = process.env.CI;
    const originalRunId = process.env.GITHUB_RUN_ID;
    beforeEach(() => {
      delete process.env.CI;
      delete process.env.GITHUB_RUN_ID;
    });
    afterAll(() => {
      if (originalCI) process.env.CI = originalCI;
      if (originalRunId) process.env.GITHUB_RUN_ID = originalRunId;
    });

    it("should execute in container when command has context: container in config", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        rootDir: FIXTURES_ROOT,
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      // "dev" command in complex fixture has context: container
      const runner = new Runner(
        config,
        environment,
        ["dev", "complex"],
        logger,
      );

      // fn() parses command args internally, so we pass an empty ScriptArgs
      await runner.run(CommandScript);

      // Should use kubectl exec for container execution
      expect(exec).toHaveBeenCalledWith(
        "kubectl",
        expect.arrayContaining([
          "exec",
          "-n",
          "nopo-dev",
          "deploy/complex",
          "--",
          "sh",
          "-c",
          expect.stringContaining('echo "FIXTURE_COMPLEX_DEV_SUCCESS"'),
        ]),
        expect.any(Object),
      );
    });

    it("should execute in container when --context container flag is passed", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        rootDir: FIXTURES_ROOT,
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      // "test" command in complex fixture has no context (defaults to host)
      // but we override with --context container
      const runner = new Runner(
        config,
        environment,
        ["test", "complex", "--context", "container"],
        logger,
      );

      const args = CommandScript.parseCommandArgs(runner);
      expect(args.contextOverride).toBe("container");

      // fn() parses command args internally, so we pass an empty ScriptArgs
      await runner.run(CommandScript);

      // Should use kubectl exec due to --context container flag
      expect(exec).toHaveBeenCalledWith(
        "kubectl",
        expect.arrayContaining([
          "exec",
          "-n",
          "nopo-dev",
          "deploy/complex",
          "--",
          "sh",
          "-c",
          expect.stringContaining('echo "FIXTURE_COMPLEX_TEST_SUCCESS"'),
        ]),
        expect.any(Object),
      );
    });

    it("should execute on host when --context host flag overrides container config", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        rootDir: FIXTURES_ROOT,
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      // "dev" command in complex fixture has context: container
      // but we override with --context host
      const runner = new Runner(
        config,
        environment,
        ["dev", "complex", "--context", "host"],
        logger,
      );

      const args = CommandScript.parseCommandArgs(runner);
      expect(args.contextOverride).toBe("host");

      // fn() parses command args internally, so we pass an empty ScriptArgs
      await runner.run(CommandScript);

      // Should use exec (host) due to --context host override
      expect(exec).toHaveBeenCalled();
      expect(exec).toHaveBeenCalledWith(
        "sh",
        ["-c", 'echo "FIXTURE_COMPLEX_DEV_SUCCESS"'],
        expect.objectContaining({
          cwd: expect.stringContaining("fixtures/services/complex"),
        }),
      );
      // kubectl exec should NOT be called for host execution
      expect(exec).not.toHaveBeenCalledWith(
        "kubectl",
        expect.arrayContaining(["exec"]),
        expect.any(Object),
      );
    });

    it("should inherit container context to subcommands", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        rootDir: FIXTURES_ROOT,
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      // "lint" command in complex fixture has context: container with subcommands
      const runner = new Runner(
        config,
        environment,
        ["lint:py", "complex"],
        logger,
      );

      // fn() parses command args internally, so we pass an empty ScriptArgs
      await runner.run(CommandScript);

      // Subcommand should inherit container context from parent (kubectl exec)
      expect(exec).toHaveBeenCalledWith(
        "kubectl",
        expect.arrayContaining([
          "exec",
          "-n",
          "nopo-dev",
          "deploy/complex",
          "--",
          "sh",
          "-c",
          expect.stringContaining('echo "FIXTURE_COMPLEX_LINT_PY_SUCCESS"'),
        ]),
        expect.any(Object),
      );
    });

    it("should set correct workdir for container execution", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        rootDir: FIXTURES_ROOT,
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["dev", "complex"],
        logger,
      );

      // fn() parses command args internally, so we pass an empty ScriptArgs
      await runner.run(CommandScript);

      // Should set workdir via cd in the kubectl exec command (path is single-quoted for safety)
      expect(exec).toHaveBeenCalledWith(
        "kubectl",
        expect.arrayContaining([
          "exec",
          "-n",
          "nopo-dev",
          "deploy/complex",
          "--",
          "sh",
          "-c",
          expect.stringContaining("cd '/app/services/complex'"),
        ]),
        expect.any(Object),
      );
    });

    it("should delegate to 'run' override when plugin provides one", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv({}),
        rootDir: FIXTURES_ROOT,
        silent: true,
      });
      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["dev", "complex"],
        logger,
      );

      // Register a mock "run" override
      const runOverride = vi.fn().mockResolvedValue(undefined);
      runner.config.project.plugins.push({
        definition: {
          name: "test-run-override",
          overrides: { run: runOverride },
        },
        serviceConfigs: {},
      });

      await runner.run(CommandScript);

      // Should call the plugin override instead of kubectl exec
      expect(runOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          runContext: expect.objectContaining({
            service: "complex",
            command: 'echo "FIXTURE_COMPLEX_DEV_SUCCESS"',
            workdir: expect.stringContaining("/app/services/complex"),
          }),
        }),
      );

      // kubectl exec should NOT be called when override handles it
      expect(exec).not.toHaveBeenCalledWith(
        "kubectl",
        expect.arrayContaining(["exec"]),
        expect.any(Object),
      );
    });
  });
});
