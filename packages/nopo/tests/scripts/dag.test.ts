import path from "node:path";
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createConfig, Logger, Runner } from "../../src/lib.ts";
import { Environment } from "../../src/parse-env.ts";
import BuildScript from "../../src/scripts/build.ts";
import CommandScript from "../../src/scripts/command.ts";
import ListScript from "../../src/scripts/list.ts";
import { createTmpEnv, FIXTURES_ROOT } from "../utils.ts";

// Fixture root for the test-dag fixture set
const DAG_FIXTURES_ROOT = path.resolve(FIXTURES_ROOT, "test-dag");

function createDagConfig(
  options: Omit<Parameters<typeof createConfig>[0], "rootDir"> = {},
) {
  return createConfig({
    rootDir: DAG_FIXTURES_ROOT,
    processEnv: {},
    ...options,
  });
}

// Mocks

// Mock exec to prevent actual command execution
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
    getDefaultBranch: () => "main",
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

// Helpers

/**
 * Capture stdout from a --print invocation and parse the JSON output.
 * Returns a restore function and a getter for the captured output.
 */
function captureStdout(): {
  restore: () => void;
  getOutput: () => string;
} {
  let output = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += chunk;
    return true;
  });
  return {
    restore: () => {
      spy.mockRestore();
    },
    getOutput: () => output.trim(),
  };
}

interface PrintOutput {
  services: string[];
  finalTargets: string[];
  filteredTargets: string[];
  dependencies: Record<string, string[]>;
}

function parsePrintOutput(raw: string): PrintOutput {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsing known --print JSON structure
  const parsed = JSON.parse(raw) as PrintOutput;
  // Normalize: new --print uses finalTargets, old uses services
  if (!parsed.services && parsed.finalTargets) {
    parsed.services = parsed.finalTargets;
  }
  return parsed;
}

function runScript(
  script: typeof import("../../src/lib.ts").Script,
  config: ReturnType<typeof createConfig>,
  argv: string[] = [],
) {
  // M5: --print defaults to a rendered ASCII DAG; legacy JSON shape
  // is opt-in via --print --json. parsePrintOutput expects JSON.
  const finalArgv =
    argv.includes("--print") && !argv.includes("--json")
      ? [...argv, "--json"]
      : argv;
  const logger = new Logger(config);
  const environment = new Environment(config);
  const runner = new Runner(config, environment, finalArgv, logger);
  return runner.run(script);
}

// All 8 expected targets in the DAG fixture, sorted alphabetically
const ALL_TARGETS = [
  "api",
  "db",
  "nginx",
  "types",
  "ui",
  "utils",
  "web",
  "worker",
];

const ALL_SERVICES = ["api", "db", "nginx", "web", "worker"];
const ALL_PACKAGES = ["types", "ui", "utils"];

// Tests

describe("DAG integration tests (test-dag fixture)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecCalls.length = 0;
    mockChangedFiles = [];
  });

  // (1) Fixture verification
  describe("fixture verification", () => {
    it("loads the test-dag fixture correctly", () => {
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      expect(config.project.name).toBe("test-dag");
    });

    it("discovers all 8 services and packages", () => {
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const targets = config.project.services.targets;
      expect(targets).toHaveLength(8);
      expect(targets).toEqual(ALL_TARGETS);
    });

    it("correctly identifies service vs package types", () => {
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const entries = config.project.services.entries;

      // Services (have runtime)
      for (const name of ALL_SERVICES) {
        expect(entries[name]!.type).toBe("service");
      }

      // Packages (no runtime)
      for (const name of ALL_PACKAGES) {
        expect(entries[name]!.type).toBe("package");
      }
    });

    it("parses dependency edges correctly", () => {
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const entries = config.project.services.entries;

      // api: build deps = [types], runtime deps = [db]
      expect(entries.api!.buildDeps).toEqual(["types"]);
      expect(entries.api!.runtimeDeps).toEqual(["db"]);

      // web: build deps = [ui, api], runtime deps = [api]
      expect(entries.web!.buildDeps).toEqual(
        expect.arrayContaining(["ui", "api"]),
      );
      expect(entries.web!.runtimeDeps).toEqual(["api"]);

      // worker: no build deps, runtime deps = [api, db]
      expect(entries.worker!.buildDeps).toHaveLength(0);
      expect(entries.worker!.runtimeDeps).toEqual(
        expect.arrayContaining(["api", "db"]),
      );

      // db has no dependencies
      expect(entries.db!.buildDeps).toHaveLength(0);
      expect(entries.db!.runtimeDeps).toHaveLength(0);

      // nginx: no build deps, runtime deps = [api, web]
      expect(entries.nginx!.buildDeps).toHaveLength(0);
      expect(entries.nginx!.runtimeDeps).toEqual(
        expect.arrayContaining(["api", "web"]),
      );

      // ui: build deps = [types]
      expect(entries.ui!.buildDeps).toEqual(["types"]);

      // types has no dependencies (leaf node)
      expect(entries.types!.buildDeps).toHaveLength(0);
      expect(entries.types!.runtimeDeps).toHaveLength(0);

      // utils: build deps = [types]
      expect(entries.utils!.buildDeps).toEqual(["types"]);
    });

    it("db has an image and no build command", () => {
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const db = config.project.services.entries.db!;
      expect(db.image).toBe("postgres:16");
      expect(db.build).toBeUndefined();
    });
  });

  // (2) build <target> --print scenarios
  describe("build <target> --print", () => {
    it("build api --print expands to [api, db, types]", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "api",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services.sort()).toEqual(["api", "db", "types"]);
      expect(result.filteredTargets).toEqual(["api"]);
      expect(mockExecCalls).toHaveLength(0);
      restore();
    });

    it("build web --print expands to [api, db, types, ui, web]", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "web",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services.sort()).toEqual([
        "api",
        "db",
        "types",
        "ui",
        "web",
      ]);
      expect(result.filteredTargets).toEqual(["web"]);
      restore();
    });

    it("build nginx --print expands to full transitive graph", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "nginx",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services.sort()).toEqual([
        "api",
        "db",
        "nginx",
        "types",
        "ui",
        "web",
      ]);
      expect(result.filteredTargets).toEqual(["nginx"]);
      restore();
    });

    it("build types --print returns [types] (leaf node)", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "types",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services).toEqual(["types"]);
      restore();
    });

    it("build ui --print expands to [types, ui]", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "ui",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services.sort()).toEqual(["types", "ui"]);
      restore();
    });

    it("build utils --print expands to [types, utils]", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "utils",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services.sort()).toEqual(["types", "utils"]);
      restore();
    });

    it("build worker --print expands to [api, db, types, worker]", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "worker",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services.sort()).toEqual(["api", "db", "types", "worker"]);
      restore();
    });

    it("build db --print returns [db] (no deps)", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "db",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services).toEqual(["db"]);
      restore();
    });

    it("build api web --print returns union of both dep trees", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "api",
        "web",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services.sort()).toEqual([
        "api",
        "db",
        "types",
        "ui",
        "web",
      ]);
      restore();
    });

    it("build types ui --print returns [types, ui]", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "types",
        "ui",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services.sort()).toEqual(["types", "ui"]);
      restore();
    });

    it("build --print with no targets returns all targets", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, ["build", "--print", "--json"]);

      const result = parsePrintOutput(getOutput());
      expect(result.services.sort()).toEqual(ALL_TARGETS);
      restore();
    });
  });

  // (3) test/check <target> --print scenarios (CommandScript)
  describe("test <target> --print", () => {
    it("test api --print returns [api]", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "api", "--print", "--json"],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      // Plan-path --print includes DAG-resolved deps (api test → db, types).
      // Legacy fn() --print returned only the explicit target.
      expect(result.services.sort()).toEqual(["api", "db", "types"]);
      restore();
    });

    it("test types --print returns [types]", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "types", "--print", "--json"],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      expect(result.services).toEqual(["types"]);
      restore();
    });

    it("test --print with no target returns all services with test command", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
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

      const result = parsePrintOutput(getOutput());
      // All 8 targets have a test command
      expect(result.services.sort()).toEqual(ALL_TARGETS);
      restore();
    });

    it("check --print excludes db (no check command)", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["check", "--print", "--json"],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      // db does not have a check command
      expect(result.services).not.toContain("db");
      // All others do
      expect(result.services).toContain("api");
      expect(result.services).toContain("web");
      expect(result.services).toContain("worker");
      expect(result.services).toContain("nginx");
      expect(result.services).toContain("types");
      expect(result.services).toContain("ui");
      expect(result.services).toContain("utils");
      restore();
    });
  });

  // (4) --with-dependants scenarios
  describe("--with-dependants", () => {
    it("types --changed --with-dependants includes everything that depends on types", async () => {
      // types is the root dependency of the graph
      mockChangedFiles = ["packages/types/src/index.ts"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        [
          "test",
          "--changed",
          "--with-dependants",
          "--since",
          "abc123",
          "--print",
          "--json",
        ],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      // types -> ui, utils, api (via types) api -> web, worker, nginx (via api) ui -> web (via
      // ui) web -> nginx (via web) Everything except db should be included
      expect(result.services).toContain("types");
      expect(result.services).toContain("ui");
      expect(result.services).toContain("utils");
      expect(result.services).toContain("api");
      expect(result.services).toContain("web");
      expect(result.services).toContain("worker");
      expect(result.services).toContain("nginx");
      // db does not depend on types (directly or transitively)
      // but db has a test command, it's just not a dependant of types
      expect(result.services).not.toContain("db");
      restore();
    });

    it("api --changed --with-dependants includes web, worker, nginx", async () => {
      mockChangedFiles = ["services/api/src/main.ts"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        [
          "test",
          "--changed",
          "--with-dependants",
          "--since",
          "abc123",
          "--print",
          "--json",
        ],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      expect(result.services).toContain("api");
      expect(result.services).toContain("web");
      expect(result.services).toContain("worker");
      expect(result.services).toContain("nginx");
      // These should not be included (not dependants of api)
      expect(result.services).not.toContain("db");
      expect(result.services).not.toContain("types");
      expect(result.services).not.toContain("ui");
      expect(result.services).not.toContain("utils");
      restore();
    });

    it("db --changed --with-dependants includes api, worker, web, nginx", async () => {
      mockChangedFiles = ["services/db/migrations/001.sql"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        [
          "test",
          "--changed",
          "--with-dependants",
          "--since",
          "abc123",
          "--print",
          "--json",
        ],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      // db -> api, worker (direct dependants) api -> web, worker, nginx (transitive) web ->
      // nginx (transitive)
      expect(result.services).toContain("db");
      expect(result.services).toContain("api");
      expect(result.services).toContain("worker");
      expect(result.services).toContain("web");
      expect(result.services).toContain("nginx");
      // Packages don't depend on db
      expect(result.services).not.toContain("types");
      expect(result.services).not.toContain("ui");
      expect(result.services).not.toContain("utils");
      restore();
    });

    it("nginx --changed --with-dependants includes only nginx (nothing depends on it)", async () => {
      mockChangedFiles = ["services/nginx/conf.d/default.conf"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        [
          "test",
          "--changed",
          "--with-dependants",
          "--since",
          "abc123",
          "--print",
          "--json",
        ],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      expect(result.services).toEqual(["nginx"]);
      restore();
    });

    it("ui --changed --with-dependants includes ui and web, nginx (transitive)", async () => {
      mockChangedFiles = ["packages/ui/src/Button.tsx"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        [
          "test",
          "--changed",
          "--with-dependants",
          "--since",
          "abc123",
          "--print",
          "--json",
        ],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      // ui -> web (direct), web -> nginx (transitive)
      expect(result.services).toContain("ui");
      expect(result.services).toContain("web");
      expect(result.services).toContain("nginx");
      expect(result.services).not.toContain("api");
      expect(result.services).not.toContain("db");
      expect(result.services).not.toContain("worker");
      expect(result.services).not.toContain("types");
      expect(result.services).not.toContain("utils");
      restore();
    });

    it("utils --changed --with-dependants includes only utils (nothing depends on it)", async () => {
      mockChangedFiles = ["packages/utils/src/helpers.ts"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        [
          "test",
          "--changed",
          "--with-dependants",
          "--since",
          "abc123",
          "--print",
          "--json",
        ],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      // utils is a leaf in the dependant graph (nothing depends on it)
      expect(result.services).toEqual(["utils"]);
      restore();
    });

    it("build --changed --with-dependants for types includes all buildable dependants", async () => {
      mockChangedFiles = ["packages/types/src/index.ts"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--with-dependants",
        "--since",
        "abc123",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      // All dependants of types that are buildable db has no build command so it won't be
      // included types, ui, utils, api, web, worker, nginx all have build commands
      expect(result.services).toContain("types");
      expect(result.services).toContain("ui");
      expect(result.services).toContain("utils");
      expect(result.services).toContain("api");
      expect(result.services).toContain("web");
      expect(result.services).toContain("worker");
      expect(result.services).toContain("nginx");
      restore();
    });
  });

  // (5) --changed scenarios (without --with-dependants)
  describe("--changed (without --with-dependants)", () => {
    it("returns empty when no files changed", async () => {
      mockChangedFiles = [];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "--changed", "--since", "abc123", "--print", "--json"],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      expect(result.services).toEqual([]);
      restore();
    });

    it("returns only the changed service without expanding dependants", async () => {
      mockChangedFiles = ["services/api/src/main.ts"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "--changed", "--since", "abc123", "--print", "--json"],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      // Only api is changed, no --with-dependants
      expect(result.services).toEqual(["api"]);
      restore();
    });

    it("returns multiple changed services", async () => {
      mockChangedFiles = [
        "packages/types/src/index.ts",
        "services/worker/src/main.ts",
      ];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "--changed", "--since", "abc123", "--print", "--json"],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      expect(result.services).toContain("types");
      expect(result.services).toContain("worker");
      expect(result.services).toHaveLength(2);
      restore();
    });
  });

  // (6) --filter combinations
  describe("--filter combinations", () => {
    it("--filter service returns only services", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(ListScript, config, [
        "list",
        "--print",
        "--json",
        "--filter",
        "service",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services.sort()).toEqual(ALL_SERVICES);
      restore();
    });

    it("--filter package returns only packages", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(ListScript, config, [
        "list",
        "--print",
        "--json",
        "--filter",
        "package",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services.sort()).toEqual(ALL_PACKAGES);
      restore();
    });

    it("--filter buildable excludes db (no build command)", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(ListScript, config, [
        "list",
        "--print",
        "--json",
        "--filter",
        "buildable",
      ]);

      const result = parsePrintOutput(getOutput());
      // db has no build section at all (only image: postgres:16)
      expect(result.services).not.toContain("db");
      // All others have build.command
      const expected = ALL_TARGETS.filter((t) => t !== "db");
      expect(result.services.sort()).toEqual(expected);
      restore();
    });

    it("--filter service --changed with types changed returns empty (no service changed)", async () => {
      mockChangedFiles = ["packages/types/src/index.ts"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(ListScript, config, [
        "list",
        "--print",
        "--json",
        "--filter",
        "service",
        "--changed",
        "--since",
        "abc123",
      ]);

      const result = parsePrintOutput(getOutput());
      // types is a package, not a service. No services have changed files.
      expect(result.services).toEqual([]);
      restore();
    });

    it("--filter service --changed with api changed returns [api]", async () => {
      mockChangedFiles = ["services/api/src/main.ts"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(ListScript, config, [
        "list",
        "--print",
        "--json",
        "--filter",
        "service",
        "--changed",
        "--since",
        "abc123",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services).toEqual(["api"]);
      restore();
    });
  });

  // (7) list --with-dependencies scenarios
  describe("list --with-dependencies", () => {
    it("list --filter service --with-dependencies expands to include package deps", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(ListScript, config, [
        "list",
        "--print",
        "--json",
        "--filter",
        "service",
        "--with-dependencies",
      ]);

      const result = parsePrintOutput(getOutput());
      // Their dependencies include: db, types, api, ui, web After expansion: all services +
      // types + ui (package deps of services)
      expect(result.services).toContain("api");
      expect(result.services).toContain("db");
      expect(result.services).toContain("nginx");
      expect(result.services).toContain("web");
      expect(result.services).toContain("worker");
      // types is a dep of api, ui is a dep of web
      expect(result.services).toContain("types");
      expect(result.services).toContain("ui");
      // utils is NOT a dep of any service
      expect(result.services).not.toContain("utils");
      restore();
    });
  });

  // (8) Edge cases
  describe("edge cases", () => {
    it("build unknown-target throws error", async () => {
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await expect(
        runScript(BuildScript, config, ["build", "nonexistent"]),
      ).rejects.toThrow("Unknown target 'nonexistent'");
    });

    it("test unknown-target --print throws error", async () => {
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "nonexistent", "--print", "--json"],
        logger,
      );

      // parseCommandArgs validates targets
      expect(() => CommandScript.parseCommandArgs(runner)).toThrow(
        "Unknown target 'nonexistent'",
      );
    });

    it("build --changed --print with no changes returns empty", async () => {
      mockChangedFiles = [];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--since",
        "abc123",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      expect(result.services).toEqual([]);
      restore();
    });

    it("--with-dependants without --changed on explicit target expands dependants", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const logger = new Logger(config);
      const environment = new Environment(config);
      const runner = new Runner(
        config,
        environment,
        ["test", "types", "--with-dependants", "--print", "--json"],
        logger,
      );
      await runner.run(CommandScript);

      const result = parsePrintOutput(getOutput());
      // types is explicitly targeted, --with-dependants expands to all transitive dependants
      expect(result.services).toContain("types");
      expect(result.services).toContain("ui");
      expect(result.services).toContain("utils");
      expect(result.services).toContain("api");
      expect(result.services).toContain("web");
      expect(result.services).toContain("worker");
      expect(result.services).toContain("nginx");
      restore();
    });

    it("build --changed --with-dependants --print for db does not include non-buildable targets as packages", async () => {
      mockChangedFiles = ["services/db/init.sql"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "--changed",
        "--with-dependants",
        "--since",
        "abc123",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      // db changed -> dependants: api, worker api -> web, worker, nginx (transitive) web ->
      // nginx (transitive) db itself has no build.command but IS a service (not a package)
      expect(result.services).toContain("db");
      expect(result.services).toContain("api");
      expect(result.services).toContain("worker");
      expect(result.services).toContain("web");
      expect(result.services).toContain("nginx");
      restore();
    });

    it("build dependency ordering: packages built before services that depend on them", async () => {
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      // Build api which depends on types (a package)
      await runScript(BuildScript, config, ["build", "api"]);

      // Find the package build calls (sh -c)
      const buildCalls = mockExecCalls.filter(
        (call) => call.command === "sh" && call.args[0] === "-c",
      );

      // types should be built (as a package dependency of api)
      const typesIdx = buildCalls.findIndex((call) =>
        call.args.includes('echo "build types"'),
      );
      const apiIdx = buildCalls.findIndex((call) =>
        call.args.includes('echo "build api"'),
      );

      // types (package dep) must be built before api
      expect(typesIdx).toBeGreaterThanOrEqual(0);
      expect(apiIdx).toBeGreaterThanOrEqual(0);
      expect(typesIdx).toBeLessThan(apiIdx);
    });

    it("multiple targets with overlapping deps: build web worker --print", async () => {
      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv({ DOCKER_TAG: "test:local" }),
        silent: true,
      });

      await runScript(BuildScript, config, [
        "build",
        "web",
        "worker",
        "--print",
        "--json",
      ]);

      const result = parsePrintOutput(getOutput());
      // Both targets + their transitive deps, no duplication
      expect(result.services.sort()).toEqual([
        "api",
        "db",
        "types",
        "ui",
        "web",
        "worker",
      ]);
      restore();
    });

    it("list --with-dependants for a single changed package", async () => {
      mockChangedFiles = ["packages/types/src/index.ts"];

      const { restore, getOutput } = captureStdout();
      const config = createDagConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await runScript(ListScript, config, [
        "list",
        "--print",
        "--json",
        "--changed",
        "--with-dependants",
        "--since",
        "abc123",
      ]);

      const result = parsePrintOutput(getOutput());
      // types changed -> all its transitive dependants
      expect(result.services).toContain("types");
      expect(result.services).toContain("ui");
      expect(result.services).toContain("utils");
      expect(result.services).toContain("api");
      expect(result.services).toContain("web");
      expect(result.services).toContain("worker");
      expect(result.services).toContain("nginx");
      // db doesn't depend on types
      expect(result.services).not.toContain("db");
      restore();
    });
  });
});
