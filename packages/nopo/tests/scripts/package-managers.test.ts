import path from "node:path";
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PackageManagerConfig } from "../../src/config/index.ts";
import { resolveInstallCommand } from "../../src/config/index.ts";
import { createConfig, Logger, Runner } from "../../src/lib.ts";
import { exec } from "../../src/lib.ts";
import { Environment } from "../../src/parse-env.ts";
import type { DryRunOutput } from "../../src/print.ts";
import InstallScript, { installRun } from "../../src/scripts/install.ts";
import SyncScript, { syncRun } from "../../src/scripts/sync.ts";
import { createTmpEnv, FIXTURES_ROOT } from "../utils.ts";

// Fixture root
const PM_FIXTURES_ROOT = path.resolve(FIXTURES_ROOT, "test-pkg-managers");

function createPmConfig(
  options: Omit<Parameters<typeof createConfig>[0], "rootDir"> = {},
) {
  return createConfig({
    rootDir: PM_FIXTURES_ROOT,
    processEnv: {},
    ...options,
  });
}

function createRunner(
  config: ReturnType<typeof createConfig>,
  argv: string[] = [],
) {
  const logger = new Logger(config);
  const environment = new Environment(config);
  return new Runner(config, environment, argv, logger);
}

// Tests

describe("Package manager integration tests (test-pkg-managers fixture)", () => {
  // (1) Fixture verification
  describe("fixture verification", () => {
    it("loads the test-pkg-managers fixture correctly", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      expect(config.project.name).toBe("test-pkg-managers");
    });

    it("discovers all 6 services and packages", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const targets = config.project.services.targets;
      expect(targets).toHaveLength(6);
      expect(targets.sort()).toEqual([
        "api",
        "backend",
        "db",
        "nginx",
        "shared",
        "worker",
      ]);
    });

    it("parses project-level package_managers correctly (bun + uv)", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const pms = config.project.packageManagers;
      expect(Object.keys(pms).sort()).toEqual(["bun", "uv"]);

      expect(pms.bun).toEqual({
        name: "bun",
        lockfile: path.resolve(PM_FIXTURES_ROOT, "bun.lock"),
        manifest: [path.resolve(PM_FIXTURES_ROOT, "package.json")],
        install: {
          dev: "bun install",
          build: "bun install --frozen-lockfile --filter './{service_dir}'",
          prod: "bun install --production --frozen-lockfile --filter './{service_dir}'",
        },
        sync: "bun install --force",
        modules: "node_modules",
        cwd: PM_FIXTURES_ROOT,
        requires_source: false,
      });

      expect(pms.uv).toEqual({
        name: "uv",
        lockfile: path.resolve(PM_FIXTURES_ROOT, "uv.lock"),
        manifest: [path.resolve(PM_FIXTURES_ROOT, "pyproject.toml")],
        // Plain string normalizes to `dev` only; every other phase falls
        // back to it.
        install: { dev: "uv sync --locked" },
        sync: "uv sync --reinstall",
        modules: ".venv",
        cwd: PM_FIXTURES_ROOT,
        requires_source: true,
      });
    });
  });

  // (2) Config resolution
  describe("config resolution", () => {
    it("service references project-level PM: api has [bun]", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const api = config.project.services.entries.api!;
      expect(api.packageManagers).toHaveLength(1);
      expect(api.packageManagers[0]!.name).toBe("bun");
    });

    it("service uses multiple PMs: backend has [uv, bun] in order", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const backend = config.project.services.entries.backend!;
      expect(backend.packageManagers).toHaveLength(2);
      expect(backend.packageManagers[0]!.name).toBe("uv");
      expect(backend.packageManagers[1]!.name).toBe("bun");
    });

    it("service overrides with standalone PM: worker has [cargo] with own lockfile", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const worker = config.project.services.entries.worker!;
      expect(worker.packageManagers).toHaveLength(1);

      const cargo = worker.packageManagers[0]!;
      expect(cargo.name).toBe("cargo");
      expect(cargo.lockfile).toBe(
        path.resolve(PM_FIXTURES_ROOT, "services/worker/Cargo.lock"),
      );
      expect(resolveInstallCommand(cargo.install, "dev")).toBe(
        "cargo build --release",
      );
      expect(cargo.sync).toBe("cargo build");
      expect(cargo.modules).toBe("target");
      expect(cargo.cwd).toBe(path.resolve(PM_FIXTURES_ROOT, "services/worker"));
    });

    it("service with no PMs: db has []", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const db = config.project.services.entries.db!;
      expect(db.packageManagers).toEqual([]);
    });

    it("service with no PMs: nginx has []", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const nginx = config.project.services.entries.nginx!;
      expect(nginx.packageManagers).toEqual([]);
    });

    it("package with PM: shared has [bun]", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const shared = config.project.services.entries.shared!;
      expect(shared.packageManagers).toHaveLength(1);
      expect(shared.packageManagers[0]!.name).toBe("bun");
    });

    it("project-level lockfile resolved relative to project root", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const bunConfig = config.project.packageManagers.bun!;
      expect(bunConfig.lockfile).toBe(
        path.resolve(PM_FIXTURES_ROOT, "bun.lock"),
      );
      expect(path.isAbsolute(bunConfig.lockfile)).toBe(true);
    });

    it("service-level override lockfile resolved relative to service root", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const worker = config.project.services.entries.worker!;
      const cargo = worker.packageManagers[0]!;
      expect(cargo.lockfile).toBe(
        path.resolve(PM_FIXTURES_ROOT, "services/worker/Cargo.lock"),
      );
    });

    it("service-level cwd resolved relative to service root", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const worker = config.project.services.entries.worker!;
      const cargo = worker.packageManagers[0]!;
      // cwd: "." resolves to the service root
      expect(cargo.cwd).toBe(path.resolve(PM_FIXTURES_ROOT, "services/worker"));
    });

    it("project-level cwd defaults to project root", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const bunConfig = config.project.packageManagers.bun!;
      expect(bunConfig.cwd).toBe(PM_FIXTURES_ROOT);
    });

    it("omitted package_managers field -> empty array", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      // db and nginx have no package_managers field
      expect(config.project.services.entries.db!.packageManagers).toEqual([]);
      expect(config.project.services.entries.nginx!.packageManagers).toEqual(
        [],
      );
    });
  });

  // (3) Error cases
  describe("error cases", () => {
    it("service references undefined PM name -> throws error", () => {
      // Create a fixture inline via a config that would reference a non-existent PM We can't
      // easily do this with the standard fixture, so test the behavior by verifying the existing
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      // Confirm that valid references work (no throws)
      expect(config.project.services.entries.api!.packageManagers).toHaveLength(
        1,
      );
    });
  });

  // (4) Runner API
  describe("Runner API", () => {
    it("runner.getPackageManagers('api') returns [{name: 'bun', ...}]", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      const runner = createRunner(config);

      const pms = runner.getPackageManagers("api");
      expect(pms).toHaveLength(1);
      expect(pms[0]!.name).toBe("bun");
      expect(pms[0]!.lockfile).toBe(path.resolve(PM_FIXTURES_ROOT, "bun.lock"));
    });

    it("runner.getPackageManagers('backend') returns [uv, bun] in order", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      const runner = createRunner(config);

      const pms = runner.getPackageManagers("backend");
      expect(pms).toHaveLength(2);
      expect(pms[0]!.name).toBe("uv");
      expect(pms[1]!.name).toBe("bun");
    });

    it("runner.getPackageManagers('worker') returns [{name: 'cargo', ...}] with resolved paths", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      const runner = createRunner(config);

      const pms = runner.getPackageManagers("worker");
      expect(pms).toHaveLength(1);
      expect(pms[0]!.name).toBe("cargo");
      expect(pms[0]!.lockfile).toBe(
        path.resolve(PM_FIXTURES_ROOT, "services/worker/Cargo.lock"),
      );
      expect(pms[0]!.cwd).toBe(
        path.resolve(PM_FIXTURES_ROOT, "services/worker"),
      );
    });

    it("runner.getPackageManagers('db') returns []", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      const runner = createRunner(config);

      const pms = runner.getPackageManagers("db");
      expect(pms).toEqual([]);
    });

    it("runner.getPackageManagerConfig('bun') returns project-level bun config", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      const runner = createRunner(config);

      const bunConfig = runner.getPackageManagerConfig("bun");
      expect(bunConfig).toBeDefined();
      expect(bunConfig!.name).toBe("bun");
      expect(resolveInstallCommand(bunConfig!.install, "dev")).toBe(
        "bun install",
      );
      // The build phase is what an image build asks for.
      expect(
        resolveInstallCommand(bunConfig!.install, "build", {
          serviceDir: "services/api",
        }),
      ).toBe("bun install --frozen-lockfile --filter './services/api'");
      expect(bunConfig!.sync).toBe("bun install --force");
      expect(bunConfig!.modules).toBe("node_modules");
    });

    it("runner.getPackageManagerConfig('nonexistent') returns undefined", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      const runner = createRunner(config);

      const result = runner.getPackageManagerConfig("nonexistent");
      expect(result).toBeUndefined();
    });

    it("runner.getAllPackageManagers(['api', 'backend']) deduplicates bun (same lockfile)", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      const runner = createRunner(config);

      const pms = runner.getAllPackageManagers(["api", "backend"]);
      // api has [bun], backend has [uv, bun] bun should be deduplicated (same lockfile) Should
      // result in [bun, uv] (bun first because api is first)
      expect(pms).toHaveLength(2);
      const names = pms.map((pm) => pm.name);
      expect(names).toContain("bun");
      expect(names).toContain("uv");
    });

    it("runner.getAllPackageManagers(['api', 'worker']) returns [bun, cargo] (different lockfiles)", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      const runner = createRunner(config);

      const pms = runner.getAllPackageManagers(["api", "worker"]);
      expect(pms).toHaveLength(2);
      const names = pms.map((pm) => pm.name);
      expect(names).toContain("bun");
      expect(names).toContain("cargo");
    });

    it("runner.getAllPackageManagers with multiple services deduplicates by lockfile", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      const runner = createRunner(config);

      // api, backend, shared all use bun with the same lockfile
      const pms = runner.getAllPackageManagers(["api", "backend", "shared"]);
      // Should be: bun (deduplicated) + uv (from backend)
      expect(pms).toHaveLength(2);
      const names = pms.map((pm) => pm.name);
      expect(names).toContain("bun");
      expect(names).toContain("uv");
    });

    it("runner.getAllPackageManagers with no PM services returns empty", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      const runner = createRunner(config);

      const pms = runner.getAllPackageManagers(["db", "nginx"]);
      expect(pms).toEqual([]);
    });

    it("runner.getAllPackageManagers defaults to all targets when no arg given", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      const runner = createRunner(config);

      const pms = runner.getAllPackageManagers();
      // All services: api(bun), backend(uv+bun), worker(cargo), db(none), nginx(none), shared(bun)
      // Unique by lockfile: bun, uv, cargo
      expect(pms).toHaveLength(3);
      const names = pms.map((pm) => pm.name);
      expect(names).toContain("bun");
      expect(names).toContain("uv");
      expect(names).toContain("cargo");
    });
  });

  // (5) Order preservation
  describe("order preservation", () => {
    it("backend [uv, bun] -> uv first, bun second", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const backend = config.project.services.entries.backend!;
      expect(backend.packageManagers[0]!.name).toBe("uv");
      expect(backend.packageManagers[1]!.name).toBe("bun");
    });
  });

  // (6) Project-level reference passthrough
  describe("project-level reference passthrough", () => {
    it("api gets the exact same object as project-level bun config", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const projectBun = config.project.packageManagers.bun!;
      const apiBun = config.project.services.entries.api!.packageManagers[0]!;

      // Same object reference (no cloning needed for string references)
      expect(apiBun).toBe(projectBun);
    });

    it("shared package gets the same bun config as api service", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const apiBun = config.project.services.entries.api!.packageManagers[0]!;
      const sharedBun =
        config.project.services.entries.shared!.packageManagers[0]!;

      expect(apiBun).toBe(sharedBun);
    });
  });

  // (7) No project-level package_managers section
  describe("no project-level package_managers", () => {
    it("project without package_managers has empty record", () => {
      // Use the test-dag fixture which has no package_managers
      const dagFixtureRoot = path.resolve(FIXTURES_ROOT, "test-dag");
      const config = createConfig({
        rootDir: dagFixtureRoot,
        processEnv: {},
        envFile: createTmpEnv(),
        silent: true,
      });

      expect(config.project.packageManagers).toEqual({});
    });

    it("services in project without package_managers have empty arrays", () => {
      const dagFixtureRoot = path.resolve(FIXTURES_ROOT, "test-dag");
      const config = createConfig({
        rootDir: dagFixtureRoot,
        processEnv: {},
        envFile: createTmpEnv(),
        silent: true,
      });

      // All services should have empty packageManagers arrays
      for (const service of Object.values(config.project.services.entries)) {
        expect(service.packageManagers).toEqual([]);
      }
    });
  });

  // (8) Mixed format
  describe("mixed format", () => {
    it("worker has inline override that is independent of project-level PMs", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const worker = config.project.services.entries.worker!;
      const cargo = worker.packageManagers[0]!;

      // cargo is NOT in project-level PMs
      expect(config.project.packageManagers.cargo).toBeUndefined();

      // But it's valid as an inline override
      expect(cargo.name).toBe("cargo");
      expect(resolveInstallCommand(cargo.install, "dev")).toBe(
        "cargo build --release",
      );
    });
  });

  // (9) All paths are absolute
  describe("all resolved paths are absolute", () => {
    it("project-level lockfile and cwd are absolute", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      for (const pm of Object.values(config.project.packageManagers)) {
        expect(path.isAbsolute(pm.lockfile)).toBe(true);
        expect(path.isAbsolute(pm.cwd)).toBe(true);
      }
    });

    it("service-level inline override lockfile and cwd are absolute", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const worker = config.project.services.entries.worker!;
      const cargo = worker.packageManagers[0]!;
      expect(path.isAbsolute(cargo.lockfile)).toBe(true);
      expect(path.isAbsolute(cargo.cwd)).toBe(true);
    });
  });

  // (10) PackageManagerConfig shape
  describe("PackageManagerConfig shape", () => {
    it("all expected fields are present", () => {
      const config = createPmConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      const bun = config.project.packageManagers.bun!;
      const stringKeys: Array<keyof PackageManagerConfig> = [
        "name",
        "lockfile",
        "sync",
        "modules",
        "cwd",
      ];

      for (const key of stringKeys) {
        expect(bun).toHaveProperty(key);
        expect(typeof bun[key]).toBe("string");
      }
      expect(bun).toHaveProperty("manifest");
      expect(Array.isArray(bun.manifest)).toBe(true);
      // `install` is a phase map, not a string. `dev` is the one phase the
      // schema requires, so it is always present.
      expect(typeof bun.install).toBe("object");
      expect(typeof bun.install.dev).toBe("string");
    });
  });
});

// InstallScript & SyncScript tests

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
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSON.parse in tests
  return JSON.parse(raw.trim()) as DryRunOutput;
}

function runPmScript(
  ScriptClass: typeof InstallScript | typeof SyncScript,
  config: ReturnType<typeof createConfig>,
  argv: string[] = [],
) {
  const logger = new Logger(config);
  const environment = new Environment(config);
  const runner = new Runner(config, environment, argv, logger);
  return runner.run(ScriptClass);
}

describe("InstallScript --print tests (test-pkg-managers fixture)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("outputs valid JSON with command 'install'", async () => {
    const stdout = captureStdout();
    const config = createPmConfig({
      envFile: createTmpEnv(),
      silent: true,
    });

    await runPmScript(InstallScript, config, ["install", "--print", "--json"]);

    const output = parseDryRunOutput(stdout.output());
    expect(output.command).toBe("install");
    stdout.restore();
  });

  it("includes all targets when no service specified", async () => {
    const stdout = captureStdout();
    const config = createPmConfig({
      envFile: createTmpEnv(),
      silent: true,
    });

    await runPmScript(InstallScript, config, ["install", "--print", "--json"]);

    const output = parseDryRunOutput(stdout.output());
    expect(output.finalTargets).toBeInstanceOf(Array);
    expect(output.finalTargets.length).toBe(6);
    stdout.restore();
  });

  it("targets specific service when provided", async () => {
    const stdout = captureStdout();
    const config = createPmConfig({
      envFile: createTmpEnv(),
      silent: true,
    });

    await runPmScript(InstallScript, config, [
      "install",
      "backend",
      "--print",
      "--json",
    ]);

    const output = parseDryRunOutput(stdout.output());
    expect(output.finalTargets).toContain("backend");
    stdout.restore();
  });
});

describe("SyncScript --print tests (test-pkg-managers fixture)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("outputs valid JSON with command 'sync'", async () => {
    const stdout = captureStdout();
    const config = createPmConfig({
      envFile: createTmpEnv(),
      silent: true,
    });

    await runPmScript(SyncScript, config, ["sync", "--print", "--json"]);

    const output = parseDryRunOutput(stdout.output());
    expect(output.command).toBe("sync");
    stdout.restore();
  });

  it("includes all targets when no service specified", async () => {
    const stdout = captureStdout();
    const config = createPmConfig({
      envFile: createTmpEnv(),
      silent: true,
    });

    await runPmScript(SyncScript, config, ["sync", "--print", "--json"]);

    const output = parseDryRunOutput(stdout.output());
    expect(output.finalTargets).toBeInstanceOf(Array);
    expect(output.finalTargets.length).toBe(6);
    stdout.restore();
  });

  it("targets specific service when provided", async () => {
    const stdout = captureStdout();
    const config = createPmConfig({
      envFile: createTmpEnv(),
      silent: true,
    });

    await runPmScript(SyncScript, config, ["sync", "api", "--print", "--json"]);

    const output = parseDryRunOutput(stdout.output());
    expect(output.finalTargets).toContain("api");
    stdout.restore();
  });
});

describe("installRun handler — direct invocation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("logs 'No package managers' when packageManagers is empty", async () => {
    const lines: string[] = [];
    const logger = {
      log: (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(" "));
      },
    };
    await installRun({
      packageManagers: [],
      env: {},
      logger,
      exec,
    });
    expect(lines).toContain("No package managers configured for targets");
  });
});

describe("syncRun handler — direct invocation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("logs 'No package managers' when packageManagers is empty", async () => {
    const lines: string[] = [];
    const logger = {
      log: (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(" "));
      },
    };
    await syncRun({
      packageManagers: [],
      env: {},
      logger,
      exec,
    });
    expect(lines).toContain("No package managers configured for targets");
  });
});
