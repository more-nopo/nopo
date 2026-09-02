import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";

import ListScript from "../../src/scripts/list.ts";
import {
  createFixtureConfig,
  createTmpEnv,
  FIXTURES_ROOT,
  runScript,
} from "../utils.ts";

vi.mock("../../src/git-info", () => ({
  GitInfo: {
    exists: () => false,
    parse: vi.fn(() => ({
      repo: "unknown",
      branch: "unknown",
      commit: "unknown",
    })),
    getChangedFiles: () => [],
    getDefaultBranch: () => "main",
  },
}));

describe("filter", () => {
  describe("package preset", () => {
    it("filters to packages (no runtime) with --filter package (singular)", async () => {
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
        "package",
      ]);

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typing JSON.parse output for test assertions
      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, { type: string }>;
      };
      const services = Object.keys(parsed.services);

      // Packages: shared, utils (no runtime config)
      expect(services).toContain("shared");
      expect(services).toContain("utils");

      // Services should be excluded (they have runtime)
      expect(services).not.toContain("complex");
      expect(services).not.toContain("minimal");
      expect(services).not.toContain("dependent");

      // Verify all returned items have type "package"
      for (const name of services) {
        expect(parsed.services[name]!.type).toBe("package");
      }

      stdoutSpy.mockRestore();
    });

    it("filters to packages with --filter packages (plural)", async () => {
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
        "packages",
      ]);

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typing JSON.parse output for test assertions
      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, { type: string }>;
      };
      const services = Object.keys(parsed.services);

      // Packages: shared, utils (no runtime config)
      expect(services).toContain("shared");
      expect(services).toContain("utils");

      // Services should be excluded (they have runtime)
      expect(services).not.toContain("complex");
      expect(services).not.toContain("minimal");
      expect(services).not.toContain("dependent");

      stdoutSpy.mockRestore();
    });

    it("works with CSV output", async () => {
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
        "--csv",
        "--filter",
        "package",
      ]);

      const services = output.trim().split(",");
      expect(services).toContain("shared");
      expect(services).toContain("utils");
      expect(services).not.toContain("complex");
      expect(services).not.toContain("minimal");
      expect(services).not.toContain("dependent");
      stdoutSpy.mockRestore();
    });
  });

  describe("service preset", () => {
    it("filters to services (has runtime) with --filter service (singular)", async () => {
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
        "service",
      ]);

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typing JSON.parse output for test assertions
      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, { type: string }>;
      };
      const services = Object.keys(parsed.services);

      // Services: complex, minimal, dependent (have runtime config)
      expect(services).toContain("complex");
      expect(services).toContain("minimal");
      expect(services).toContain("dependent");

      // Packages should be excluded (no runtime)
      expect(services).not.toContain("shared");
      expect(services).not.toContain("utils");

      // Verify all returned items have type "service"
      for (const name of services) {
        expect(parsed.services[name]!.type).toBe("service");
      }

      stdoutSpy.mockRestore();
    });

    it("filters to services with --filter services (plural)", async () => {
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
        "services",
      ]);

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typing JSON.parse output for test assertions
      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, { type: string }>;
      };
      const services = Object.keys(parsed.services);

      // Services: complex, minimal, dependent (have runtime config)
      expect(services).toContain("complex");
      expect(services).toContain("minimal");
      expect(services).toContain("dependent");

      // Packages should be excluded (no runtime)
      expect(services).not.toContain("shared");
      expect(services).not.toContain("utils");

      stdoutSpy.mockRestore();
    });

    it("works with CSV output", async () => {
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
        "--csv",
        "--filter",
        "service",
      ]);

      const services = output.trim().split(",");
      expect(services).toContain("complex");
      expect(services).toContain("minimal");
      expect(services).toContain("dependent");
      expect(services).not.toContain("shared");
      expect(services).not.toContain("utils");
      stdoutSpy.mockRestore();
    });
  });

  describe("type field", () => {
    it("filters by type=package using field equality", async () => {
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
        "type=package",
      ]);

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typing JSON.parse output for test assertions
      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);

      // Should match packages only
      expect(services).toContain("shared");
      expect(services).toContain("utils");
      expect(services).not.toContain("complex");
      expect(services).not.toContain("minimal");
      expect(services).not.toContain("dependent");
      stdoutSpy.mockRestore();
    });

    it("filters by type=service using field equality", async () => {
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
        "type=service",
      ]);

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typing JSON.parse output for test assertions
      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);

      // Should match services only
      expect(services).toContain("complex");
      expect(services).toContain("minimal");
      expect(services).toContain("dependent");
      expect(services).not.toContain("shared");
      expect(services).not.toContain("utils");
      stdoutSpy.mockRestore();
    });
  });

  describe("combined filters", () => {
    it("combines --filter package with --filter buildable", async () => {
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
        "package",
        "--filter",
        "buildable",
      ]);

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typing JSON.parse output for test assertions
      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);

      // Packages without dockerfiles are buildable if they have build.command
      // All three packages (shared, utils, virtual) have build.command so they're buildable
      expect(services).toEqual(["shared", "utils", "virtual"]);
      stdoutSpy.mockRestore();
    });

    it("combines --filter service with --filter buildable", async () => {
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
        "service",
        "--filter",
        "buildable",
      ]);

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typing JSON.parse output for test assertions
      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, unknown>;
      };
      const services = Object.keys(parsed.services);

      // Services with build commands: complex, minimal, dependent
      expect(services).toContain("complex");
      expect(services).toContain("minimal");
      expect(services).toContain("dependent");
      expect(services).not.toContain("shared");
      expect(services).not.toContain("utils");
      stdoutSpy.mockRestore();
    });
  });

  describe("fixture structure verification", () => {
    it("fixture has expected packages and services", async () => {
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
      await runScript(ListScript, config, ["list", "--json"]);

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- typing JSON.parse output for test assertions
      const parsed = JSON.parse(output.trim()) as {
        services: Record<string, { type: string; dependencies: string[] }>;
      };
      const services = Object.keys(parsed.services);

      // Verify all expected targets exist
      expect(services).toContain("shared");
      expect(services).toContain("utils");
      expect(services).toContain("complex");
      expect(services).toContain("minimal");
      expect(services).toContain("dependent");

      // Verify types are correct
      expect(parsed.services.shared!.type).toBe("package");
      expect(parsed.services.utils!.type).toBe("package");
      expect(parsed.services.complex!.type).toBe("service");
      expect(parsed.services.minimal!.type).toBe("service");
      expect(parsed.services.dependent!.type).toBe("service");

      stdoutSpy.mockRestore();
    });

    it("services can depend on packages", async () => {
      const config = createFixtureConfig({
        envFile: createTmpEnv(),
        silent: true,
      });

      // Access the project config directly to verify dependencies
      const entries = config.project.services.entries;

      // dependent service has runtime deps on services and build deps on packages
      expect(entries.dependent!.runtimeDeps).toContain("minimal");
      expect(entries.dependent!.buildDeps).toContain("shared");
      expect(entries.dependent!.buildDeps).toContain("utils");

      // utils package has build dep on shared package
      expect(entries.utils!.buildDeps).toContain("shared");
    });

    it("packages directory is at correct location", () => {
      const packagesDir = path.join(FIXTURES_ROOT, "packages");
      expect(fs.existsSync(packagesDir)).toBe(true);

      const sharedDir = path.join(packagesDir, "shared");
      expect(fs.existsSync(sharedDir)).toBe(true);

      const utilsDir = path.join(packagesDir, "utils");
      expect(fs.existsSync(utilsDir)).toBe(true);
    });
  });
});
