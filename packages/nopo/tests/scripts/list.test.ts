/* eslint-disable @typescript-eslint/consistent-type-assertions -- JSON.parse in tests */
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import ListScript from "../../src/scripts/list.ts";
import {
  createFixtureConfig,
  createTestConfig,
  createTmpEnv,
  HAS_PRODUCT_GRAPH,
  runScript,
} from "../utils.ts";

// Track mock calls for assertions

const mockGetChangedFiles = vi.fn((_ref?: string) => [
  "products/example/backend/src/index.ts",
]);
const mockGetDefaultBranch = vi.fn(() => "main");

vi.mock("../../src/git-info", () => ({
  GitInfo: {
    exists: () => false,
    parse: vi.fn(() => ({
      repo: "unknown",
      branch: "unknown",
      commit: "unknown",
    })),
    getChangedFiles: (ref?: string) => mockGetChangedFiles(ref),
    getDefaultBranch: () => mockGetDefaultBranch(),
  },
}));

describe.skipIf(!HAS_PRODUCT_GRAPH)("list", () => {
  describe("output formats", () => {
    it("outputs JSON with config and services", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, ["list", "--json"]);

      const parsed = JSON.parse(output.trim()) as {
        config: unknown;
        services: unknown;
      };
      expect(parsed.config).toBeDefined();
      expect(parsed.services).toBeDefined();

      expect(Object.keys(parsed.services as object)).toContain("backend");
      stdoutSpy.mockRestore();
    });

    it("outputs JSON with -j flag", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, ["list", "-j"]);

      const parsed = JSON.parse(output.trim()) as {
        config: unknown;
        services: unknown;
      };
      expect(parsed.config).toBeDefined();
      expect(parsed.services).toBeDefined();
      stdoutSpy.mockRestore();
    });

    it("outputs JSON with --format json", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, ["list", "--format", "json"]);

      const parsed = JSON.parse(output.trim()) as {
        config: unknown;
        services: unknown;
      };
      expect(parsed.config).toBeDefined();
      expect(parsed.services).toBeDefined();
      stdoutSpy.mockRestore();
    });

    it("outputs CSV with --csv flag", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, ["list", "--csv"]);

      // CSV output is comma-separated service names (may include hyphens)
      expect(output.trim()).toMatch(/^[\w,-]*$/);
      stdoutSpy.mockRestore();
    });

    it("outputs CSV with --format csv", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, ["list", "--format", "csv"]);

      expect(output.trim()).toMatch(/^[\w,-]*$/);
      stdoutSpy.mockRestore();
    });

    it("includes project config in JSON output", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, ["list", "--json"]);

      const parsed = JSON.parse(output.trim()) as {
        config: { name: string; services_dirs: string[] };
      };
      expect(parsed.config.name).toBeDefined();
      expect(parsed.config.services_dirs).toBeDefined();
      stdoutSpy.mockRestore();
    });

    it("includes all services in JSON output", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, ["list", "--json"]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, { cpu: string }>;
      };
      // Should include directory services like backend, web, db, nginx, packages, and root
      expect(Object.keys(parsed.services).length).toBeGreaterThanOrEqual(5);
      expect(Object.keys(parsed.services)).toContain("backend");
      expect(Object.keys(parsed.services)).toContain("web");
      expect(Object.keys(parsed.services)).toContain("db");
      expect(Object.keys(parsed.services)).toContain("nginx");
      expect(Object.keys(parsed.services)).toContain("root");
      // Each service should have config
      expect(parsed.services.backend!.cpu).toBeDefined();

      stdoutSpy.mockRestore();
    });
  });

  describe("filters", () => {
    it("filters to buildable services with --filter buildable", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "buildable",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      // buildable services have dockerfile, not image (backend, web)
      expect(services).toContain("backend");
      expect(services).toContain("web");
      expect(services).not.toContain("db");
      expect(services).not.toContain("nginx");
      stdoutSpy.mockRestore();
    });

    it("filters to buildable services with -F buildable", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "buildable",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      expect(services).toContain("backend");
      expect(services).toContain("web");
      expect(services).not.toContain("db");
      expect(services).not.toContain("nginx");
      stdoutSpy.mockRestore();
    });

    it("filters services that have image field with --filter image", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "image",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      // db and nginx have image field
      expect(services).toContain("db");
      expect(services).toContain("nginx");
      expect(services).not.toContain("backend");
      expect(services).not.toContain("web");
      stdoutSpy.mockRestore();
    });

    it("filters services without image field with --filter !image", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "!image",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      // backend and web don't have image field
      expect(services).toContain("backend");
      expect(services).toContain("web");
      expect(services).not.toContain("db");
      expect(services).not.toContain("nginx");
      stdoutSpy.mockRestore();
    });

    it("filters by field value with --filter type=package", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "type=package",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      expect(services.length).toBeGreaterThan(0);
      expect(services).not.toContain("backend");
      expect(services).not.toContain("db");
      stdoutSpy.mockRestore();
    });

    it("combines multiple filters with AND logic", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "buildable",
        "--filter",
        "service",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      expect(services).toContain("backend");
      expect(services).not.toContain("db");
      stdoutSpy.mockRestore();
    });

    it("returns empty services when no services match filter", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "nonexistent.field=value",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      expect(Object.keys(parsed.services)).toEqual([]);
      stdoutSpy.mockRestore();
    });

    it("filters work with CSV output", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--csv",
        "--filter",
        "buildable",
      ]);

      const services = output.trim().split(",");
      expect(services).toContain("backend");
      expect(services).toContain("web");
      expect(services).not.toContain("db");
      expect(services).not.toContain("nginx");
      stdoutSpy.mockRestore();
    });

    it("filters to changed services with --filter changed", async () => {
      mockGetChangedFiles.mockClear();
      mockGetChangedFiles.mockReturnValueOnce([
        "products/example/backend/src/index.ts",
      ]);

      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "changed",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      // Only backend has changed files in products/example/backend/
      expect(services).toContain("backend");
      expect(services).not.toContain("web");
      expect(services).not.toContain("db");
      expect(services).not.toContain("nginx");
      stdoutSpy.mockRestore();
    });

    it("uses default branch when --since is not specified", async () => {
      mockGetChangedFiles.mockClear();
      mockGetDefaultBranch.mockClear();
      mockGetChangedFiles.mockReturnValueOnce(["apps/web/src/App.tsx"]);
      mockGetDefaultBranch.mockReturnValueOnce("main");

      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          void chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "changed",
      ]);

      // getDefaultBranch should be called since --since was not provided
      expect(mockGetDefaultBranch).toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });

    it("uses --since value when specified with --filter changed", async () => {
      mockGetChangedFiles.mockClear();
      mockGetDefaultBranch.mockClear();
      mockGetChangedFiles.mockReturnValueOnce([
        "products/example/backend/src/api.ts",
      ]);

      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          void chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "changed",
        "--since",
        "feature-branch",
      ]);

      // getChangedFiles should be called with the specified branch
      expect(mockGetChangedFiles).toHaveBeenCalledWith("feature-branch");
      // getDefaultBranch should not be called when --since is provided
      expect(mockGetDefaultBranch).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });

    it("returns empty when no services have changed files", async () => {
      mockGetChangedFiles.mockClear();
      mockGetChangedFiles.mockReturnValueOnce([]);

      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "changed",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      expect(Object.keys(parsed.services)).toEqual([]);
      stdoutSpy.mockRestore();
    });

    it("combines --filter changed with other filters using AND logic", async () => {
      mockGetChangedFiles.mockClear();
      // Both backend and db have changes
      mockGetChangedFiles.mockReturnValueOnce([
        "products/example/backend/src/index.ts",
        "apps/db/init.sql",
      ]);

      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "changed,buildable",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      // Only backend is both changed AND buildable (db has changes but is not buildable)
      expect(Object.keys(parsed.services)).toEqual(["backend"]);
      stdoutSpy.mockRestore();
    });

    it("changed + testable + service + buildable (CI testable_services scenario)", async () => {
      mockGetChangedFiles.mockClear();
      // backend has changes — it's a testable, buildable service
      mockGetChangedFiles.mockReturnValueOnce([
        "products/example/backend/src/views.py",
      ]);

      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "changed,testable,service,buildable",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const names = Object.keys(parsed.services);
      // backend is changed + testable + service + buildable
      expect(names).toContain("backend");
      // web is NOT changed
      expect(names).not.toContain("web");
      stdoutSpy.mockRestore();
    });

    it("changed + service + buildable with --with-dependants (CI deploy scenario)", async () => {
      mockGetChangedFiles.mockClear();
      // web changed — backend is NOT changed
      mockGetChangedFiles.mockReturnValueOnce([
        "products/example/web/app/root.tsx",
      ]);

      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "changed,service,buildable",
        "--with-dependants",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const names = Object.keys(parsed.services);
      // web is changed + service + buildable
      expect(names).toContain("web");
      // backend should NOT be included — it doesn't depend on web
      expect(names).not.toContain("backend");
      stdoutSpy.mockRestore();
    });

    it("changed + testable + package (CI testable_packages scenario)", async () => {
      mockGetChangedFiles.mockClear();
      // Only a package changed, not a service
      mockGetChangedFiles.mockReturnValueOnce(["packages/ui/src/button.tsx"]);

      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "changed,testable,package",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const names = Object.keys(parsed.services);
      // ui is changed + testable + package
      expect(names).toContain("ui");
      // backend is NOT a package
      expect(names).not.toContain("backend");
      stdoutSpy.mockRestore();
    });

    it("returns empty when changed files don't match any filter combination", async () => {
      mockGetChangedFiles.mockClear();
      // Only root config changed — not a buildable service
      mockGetChangedFiles.mockReturnValueOnce(["eslint.config.ts"]);

      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "changed,service,buildable",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      expect(Object.keys(parsed.services)).toHaveLength(0);
      stdoutSpy.mockRestore();
    });
  });

  describe("jq processing", () => {
    it("processes JSON output through jq with --jq flag", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--jq",
        ".services | length",
      ]);

      // Service count includes apps, packages, and root
      const count = parseInt(output.trim(), 10);
      expect(count).toBeGreaterThanOrEqual(5);
      stdoutSpy.mockRestore();
    });

    it("extracts service config with jq", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--jq",
        ".services.backend.cpu",
      ]);

      expect(output.trim()).toBe('"1"');
      stdoutSpy.mockRestore();
    });

    it("gets service keys with jq", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--jq",
        '.services | keys | join(",")',
      ]);

      // Service keys include apps, packages, and root - verify required ones exist
      const keys = output.trim().replace(/"/g, "").split(",");
      expect(keys).toContain("backend");
      expect(keys).toContain("db");
      expect(keys).toContain("nginx");
      expect(keys).toContain("root");
      expect(keys).toContain("web");
      stdoutSpy.mockRestore();
    });

    it("combines --filter with --jq", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "buildable",
        "--jq",
        '.services | keys | join(",")',
      ]);

      // Verify required buildable services are present (list grows as new services are added)
      const keys = output.trim().replace(/"/g, "").split(",");
      for (const required of ["actions-ts", "backend", "ui", "web"]) {
        expect(keys).toContain(required);
      }
      stdoutSpy.mockRestore();
    });

    it("extracts project config with jq", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--jq",
        ".config.name",
      ]);

      expect(output.trim()).toBe('"Nopo Project"');
      stdoutSpy.mockRestore();
    });

    it("throws error when --jq used without --json", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      await expect(
        runScript(ListScript, config, ["list", "--jq", "length"]),
      ).rejects.toThrow("--jq requires --json format");
    });

    it("throws error for invalid jq filter", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      // We expect an error, but also want to prevent EPIPE from leaking due to broken pipe when process.stdout is closed.
      // So, temporarily stub process.stdout.write to a noop for this test.
      const originalWrite = process.stdout.write;

      process.stdout.write = (() => true) as typeof process.stdout.write;

      try {
        await expect(
          runScript(ListScript, config, [
            "list",
            "--json",
            "--jq",
            "invalid[[",
          ]),
        ).rejects.toThrow("jq filter failed");
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  describe("validate", () => {
    it("completes successfully with --validate flag", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      // Should not throw - validates config is valid
      await expect(
        runScript(ListScript, config, ["list", "--validate"]),
      ).resolves.not.toThrow();
    });

    it("completes successfully with -v shorthand", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await expect(
        runScript(ListScript, config, ["list", "-v"]),
      ).resolves.not.toThrow();
    });

    it("does not output JSON when --validate is used", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createTestConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, ["list", "--validate"]);

      // --validate should not produce stdout output (logs go to logger)
      expect(output).toBe("");
      stdoutSpy.mockRestore();
    });
  });

  // Dependency graph expansion tests use the fixture config which has clear dependency
  // relationships: dependent -> shared, utils (build.depends_on), minimal
  describe("--with-dependencies", () => {
    it("includes direct dependencies of a filtered service", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "name=Dependent Fixture Service",
        "--with-dependencies",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      // dependent itself
      expect(services).toContain("dependent");
      // Its direct dependencies: shared, utils (build), minimal (runtime)
      expect(services).toContain("shared");
      expect(services).toContain("utils");
      expect(services).toContain("minimal");
      // Should NOT include unrelated services
      expect(services).not.toContain("complex");
      stdoutSpy.mockRestore();
    });

    it("includes only direct deps, not transitive", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      // Filter to utils only - it depends on shared shared has no deps of its own, so nothing
      // transitive to worry about here. But the key invariant: only DIRECT deps are added.
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "name=Utils Package",
        "--with-dependencies",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      expect(services).toContain("utils");
      expect(services).toContain("shared");
      // Should NOT include dependent (which also depends on shared but isn't in the filtered set)
      expect(services).not.toContain("dependent");
      expect(services).toHaveLength(2);
      stdoutSpy.mockRestore();
    });

    it("does nothing when no filters are applied", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      // Get baseline (no flags)
      await runScript(ListScript, config, ["list", "--csv"]);
      const baseline = output.trim();

      output = "";
      // With --with-dependencies but no filter, all services already included
      await runScript(ListScript, config, [
        "list",
        "--csv",
        "--with-dependencies",
      ]);
      const expanded = output.trim();

      expect(expanded).toBe(baseline);
      stdoutSpy.mockRestore();
    });
  });

  describe("--with-dependants", () => {
    it("includes services that depend on a filtered service", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      // Filter to shared only - dependent and utils both depend on shared
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "name=Shared Package",
        "--with-dependants",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      expect(services).toContain("shared");
      // Both dependent and utils depend on shared
      expect(services).toContain("dependent");
      expect(services).toContain("utils");
      // Should NOT include unrelated services
      expect(services).not.toContain("complex");
      expect(services).not.toContain("minimal");
      stdoutSpy.mockRestore();
    });

    it("does not include non-dependants of the filtered service", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      // Filter to minimal - dependent depends on minimal (runtime)
      // dependent also depends on shared/utils, but those are NOT dependants of minimal
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "name=Minimal Fixture Service",
        "--with-dependants",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      expect(services).toContain("minimal");
      expect(services).toContain("dependent");
      // shared is NOT a dependant of minimal
      expect(services).not.toContain("shared");
      expect(services).not.toContain("utils");
      stdoutSpy.mockRestore();
    });
  });

  describe("--with-dependencies and --with-dependants combined", () => {
    it("expands in both directions", async () => {
      let output = "";
      const stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output += chunk;
          return true;
        });

      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });
      // Filter to utils: depends on shared (dep), depended on by dependent (dependant)
      await runScript(ListScript, config, [
        "list",
        "--json",
        "--filter",
        "name=Utils Package",
        "--with-dependencies",
        "--with-dependants",
      ]);

      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);
      expect(services).toContain("utils");
      // Direct dependency of utils
      expect(services).toContain("shared");
      // Direct dependant of utils
      expect(services).toContain("dependent");
      // minimal is NOT a dep or dependant of utils
      expect(services).not.toContain("minimal");
      stdoutSpy.mockRestore();
    });
  });
});
