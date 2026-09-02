import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildExecutionPlan,
  resolveCommand,
  resolveCommandDependencies,
  validateCommandTargets,
} from "../../src/commands/index.ts";
import { loadProjectConfig } from "../../src/config/index.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
  tmpDirs.length = 0;
});

function writeFile(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf-8");
}

function createProject(structure: {
  rootConfig: string;
  services?: Record<string, string>;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-cmd-"));
  tmpDirs.push(root);

  writeFile(path.join(root, "nopo.yml"), structure.rootConfig);

  if (structure.services) {
    for (const [service, config] of Object.entries(structure.services)) {
      writeFile(path.join(root, "apps", service, "nopo.yml"), config);
    }
  }

  return root;
}

describe("Command Resolution", () => {
  describe("loadProjectConfig with commands", () => {
    it("loads commands from service nopo.yml", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const web = project.services.entries.web;

      expect(web?.commands).toBeDefined();
      expect(web?.commands?.lint).toBeDefined();
      expect(web?.commands?.lint?.command).toBe("eslint .");
    });

    it("loads command dependencies", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    dependencies:
      - backend
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const web = project.services.entries.web;

      expect(web?.commands?.lint?.dependencies).toEqual(["backend"]);
    });

    it("loads complex command dependencies with command overrides", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  banana:
    dependencies:
      web:
        - banana
      backend:
        - lint
        - clean
    command: npm start
`,
        },
      });

      const project = loadProjectConfig(root);
      const web = project.services.entries.web;

      expect(web?.commands?.banana?.dependencies).toEqual({
        web: ["banana"],
        backend: ["lint", "clean"],
      });
    });

    it("loads empty dependencies to override service dependencies", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
runtime:
  deps:
    - backend
commands:
  lint:
    dependencies: {}
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const web = project.services.entries.web;

      expect(web?.runtimeDeps).toEqual(["backend"]);
      expect(web?.commands?.lint?.dependencies).toEqual({});
    });

    it("loads service-level dependencies from build.deps and runtime.deps", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
runtime:
  deps:
    - backend
    - db
`,
          backend: `
name: backend
dockerfile: Dockerfile
runtime:
  deps:
    - db
`,
          db: `
name: db
image: postgres:16
`,
        },
      });

      const project = loadProjectConfig(root);

      expect(project.services.entries.web?.runtimeDeps).toEqual([
        "backend",
        "db",
      ]);
      expect(project.services.entries.backend?.runtimeDeps).toEqual(["db"]);
      expect(project.services.entries.db?.runtimeDeps).toEqual([]);
    });
  });

  describe("validateCommandTargets", () => {
    it("succeeds when all top-level targets have the command", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
          backend: `
name: backend
dockerfile: Dockerfile
commands:
  lint:
    command: ruff check .
`,
        },
      });

      const project = loadProjectConfig(root);
      expect(() =>
        validateCommandTargets(project, "lint", ["web", "backend"]),
      ).not.toThrow();
    });

    it("throws when a top-level target is missing the command", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
          backend: `
name: backend
dockerfile: Dockerfile
`,
        },
      });

      const project = loadProjectConfig(root);
      expect(() =>
        validateCommandTargets(project, "lint", ["web", "backend"]),
      ).toThrow(/Service 'backend' does not define command 'lint'/);
    });

    it("does not require dependencies to have the command", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
runtime:
  deps:
    - backend
commands:
  lint:
    command: eslint .
`,
          backend: `
name: backend
dockerfile: Dockerfile
`,
        },
      });

      const project = loadProjectConfig(root);
      // backend is a dependency but not a top-level target, so should not throw
      expect(() =>
        validateCommandTargets(project, "lint", ["web"]),
      ).not.toThrow();
    });
  });

  describe("resolveCommandDependencies", () => {
    it("returns empty when no dependencies", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const deps = resolveCommandDependencies(project, "lint", "web");

      expect(deps).toEqual([]);
    });

    it("uses empty dependencies to override service-level dependencies", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
runtime:
  deps:
    - backend
commands:
  lint:
    dependencies: {}
    command: eslint .
`,
          backend: `
name: backend
dockerfile: Dockerfile
`,
        },
      });

      const project = loadProjectConfig(root);
      const deps = resolveCommandDependencies(project, "lint", "web");

      expect(deps).toEqual([]);
    });

    it("uses command-specific dependencies when defined", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
runtime:
  deps:
    - api
commands:
  lint:
    dependencies:
      - backend
      - worker
    command: eslint .
`,
          api: `
name: api
dockerfile: Dockerfile
`,
          backend: `
name: backend
dockerfile: Dockerfile
commands:
  lint:
    command: python setup.py build
`,
          worker: `
name: worker
dockerfile: Dockerfile
commands:
  lint:
    command: cargo build
`,
        },
      });

      const project = loadProjectConfig(root);
      const deps = resolveCommandDependencies(project, "lint", "web");

      // Should use command-specific dependencies, not service-level
      expect(deps).toContainEqual({ service: "backend", command: "lint" });
      expect(deps).toContainEqual({ service: "worker", command: "lint" });
      expect(deps).not.toContainEqual(
        expect.objectContaining({ service: "api" }),
      );
    });

    it("resolves complex command dependencies with different commands", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  banana:
    dependencies:
      backend:
        - lint
        - clean
    command: npm start
`,
          backend: `
name: backend
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
  clean:
    command: npm run clean
`,
        },
      });

      const project = loadProjectConfig(root);
      const deps = resolveCommandDependencies(project, "banana", "web");

      expect(deps).toContainEqual({ service: "backend", command: "lint" });
      expect(deps).toContainEqual({ service: "backend", command: "clean" });
    });
  });

  describe("buildExecutionPlan", () => {
    it("creates a simple execution plan", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "lint", ["web"]);

      expect(plan.stages).toHaveLength(1);
      expect(plan.stages[0]).toHaveLength(1);
      expect(plan.stages[0]![0]).toMatchObject({
        service: "web",
        command: "lint",
      });
    });

    it("groups independent services in the same stage for parallelization", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
          backend: `
name: backend
dockerfile: Dockerfile
commands:
  lint:
    command: ruff check .
`,
          worker: `
name: worker
dockerfile: Dockerfile
commands:
  lint:
    command: cargo clippy
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "lint", [
        "web",
        "backend",
        "worker",
      ]);

      // All independent, should be in same stage
      expect(plan.stages).toHaveLength(1);
      expect(plan.stages[0]).toHaveLength(3);
    });

    it("handles services with no dependencies independently", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    dependencies: {}
    command: eslint .
`,
          backend: `
name: backend
dockerfile: Dockerfile
commands:
  lint:
    dependencies: {}
    command: ruff check .
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "lint", ["web", "backend"]);

      // Both should be in the same stage (parallel)
      expect(plan.stages).toHaveLength(1);
      expect(plan.stages[0]).toHaveLength(2);
    });
  });

  describe("CommandDependencySpec normalization", () => {
    it("normalizes array dependencies", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    dependencies:
      - backend
      - worker
    command: eslint .
`,
          backend: `
name: backend
dockerfile: Dockerfile
commands:
  lint:
    command: python setup.py build
`,
          worker: `
name: worker
dockerfile: Dockerfile
commands:
  lint:
    command: cargo build
`,
        },
      });

      const project = loadProjectConfig(root);
      const web = project.services.entries.web;

      // Array dependencies should be normalized to same command
      expect(web?.commands?.lint?.dependencies).toEqual(["backend", "worker"]);
    });

    it("normalizes object dependencies with command arrays", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  deploy:
    dependencies:
      backend:
        - lint
        - migrate
    command: npm run deploy
`,
          backend: `
name: backend
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
  migrate:
    command: npm run migrate
`,
        },
      });

      const project = loadProjectConfig(root);
      const web = project.services.entries.web;

      expect(web?.commands?.deploy?.dependencies).toEqual({
        backend: ["lint", "migrate"],
      });
    });
  });

  describe("Edge Cases", () => {
    it("handles services with only some commands defined", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
  foo:
    command: echo "foo"
`,
          backend: `
name: backend
dockerfile: Dockerfile
commands:
  lint:
    command: ruff check .
`,
        },
      });

      const project = loadProjectConfig(root);

      // web has both lint and foo, backend only has lint
      expect(project.services.entries.web?.commands?.lint).toEqual({
        command: "eslint .",
        dependencies: undefined,
        dir: undefined,
        env: undefined,
      });
      expect(project.services.entries.web?.commands?.foo).toEqual({
        command: 'echo "foo"',
        dependencies: undefined,
        dir: undefined,
        env: undefined,
      });
      expect(project.services.entries.backend?.commands?.lint).toEqual({
        command: "ruff check .",
        dependencies: undefined,
        dir: undefined,
        env: undefined,
      });
      expect(project.services.entries.backend?.commands?.foo).toBeUndefined();
    });

    it("handles service with no commands at all", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          db: `
name: db
image: postgres:16
`,
        },
      });

      const project = loadProjectConfig(root);
      expect(project.services.entries.db?.commands).toEqual({});
    });

    it("handles targets with glob patterns", () => {
      // This test documents behavior when glob patterns like packages/* are used The glob
      // resolution happens at a higher level, but buildExecutionPlan should work
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          "pkg-a": `
name: pkg-a
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
          "pkg-b": `
name: pkg-b
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
          "pkg-c": `
name: pkg-c
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      // Simulating resolved glob pattern
      const plan = buildExecutionPlan(project, "lint", [
        "pkg-a",
        "pkg-b",
        "pkg-c",
      ]);

      // All independent
      expect(plan.stages).toHaveLength(1);
      expect(plan.stages[0]).toHaveLength(3);
    });
  });

  describe("Subcommands", () => {
    it("loads subcommands from service nopo.yml", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    commands:
      ts:
        command: tsc --noEmit
      eslint:
        command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const web = project.services.entries.web;

      expect(web?.commands?.lint).toBeDefined();
      expect(web?.commands?.lint?.commands).toBeDefined();
      expect(web?.commands?.lint?.commands?.ts?.command).toBe("tsc --noEmit");
      expect(web?.commands?.lint?.commands?.eslint?.command).toBe("eslint .");
    });

    it("resolves all subcommands when running parent command", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    commands:
      ts:
        command: tsc --noEmit
      eslint:
        command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const resolved = resolveCommand(project, "lint", "web");

      // Should return both subcommands
      expect(resolved).toHaveLength(2);
      expect(resolved).toContainEqual({
        service: "web",
        command: "lint:ts",
        executable: "tsc --noEmit",
      });
      expect(resolved).toContainEqual({
        service: "web",
        command: "lint:eslint",
        executable: "eslint .",
      });
    });

    it("runs subcommands in parallel (same stage)", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  check:
    commands:
      types:
        command: tsc --noEmit
      lint:
        command: eslint .
      format:
        command: prettier --check .
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "check", ["web"]);

      // All subcommands should be in same stage (parallel)
      expect(plan.stages).toHaveLength(1);
      expect(plan.stages[0]).toHaveLength(3);
    });

    it("supports nested subcommands (up to 3 levels)", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  check:
    commands:
      lint:
        commands:
          ts:
            command: tsc --noEmit
          js:
            command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const resolved = resolveCommand(project, "check", "web");

      // Should flatten all nested subcommands
      expect(resolved).toHaveLength(2);
      expect(resolved).toContainEqual({
        service: "web",
        command: "check:lint:ts",
        executable: "tsc --noEmit",
      });
      expect(resolved).toContainEqual({
        service: "web",
        command: "check:lint:js",
        executable: "eslint .",
      });
    });

    it("can run specific subcommand directly", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    commands:
      ts:
        command: tsc --noEmit
      eslint:
        command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const resolved = resolveCommand(project, "lint:ts", "web");

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toEqual({
        service: "web",
        command: "lint:ts",
        executable: "tsc --noEmit",
      });
    });

    it("subcommands cannot define dependencies", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    commands:
      ts:
        dependencies:
          - backend
        command: tsc --noEmit
`,
        },
      });

      // Should throw when loading config because subcommands can't have dependencies
      // The Zod schema catches this with "Expected never, received array"
      expect(() => loadProjectConfig(root)).toThrow();
    });

    it("parent command with subcommands cannot also have command field", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
    commands:
      ts:
        command: tsc --noEmit
`,
        },
      });

      // Should throw because can't have both command and commands
      expect(() => loadProjectConfig(root)).toThrow(
        /Cannot combine 'command' and 'commands'/,
      );
    });

    it("handles mixed commands and subcommands", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
  check:
    commands:
      types:
        command: tsc --noEmit
      lint:
        command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);

      // build is a simple command
      const buildResolved = resolveCommand(project, "lint", "web");
      expect(buildResolved).toHaveLength(1);
      expect(buildResolved[0]).toEqual({
        service: "web",
        command: "lint",
        executable: "eslint .",
      });

      // check has subcommands
      const checkResolved = resolveCommand(project, "check", "web");
      expect(checkResolved).toHaveLength(2);
    });

    it("validates subcommand exists when running specific subcommand", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    commands:
      ts:
        command: tsc --noEmit
`,
        },
      });

      const project = loadProjectConfig(root);

      // A missing SUBCOMMAND is a skip, not a throw: one invocation has to span services that
      // declare different subsets (root-loud, subcommand-quiet). A missing ROOT is still loud
      expect(resolveCommand(project, "lint:nonexistent", "web")).toEqual([]);
      expect(() => resolveCommand(project, "nope:ts", "web")).toThrow(
        /Command 'nope:ts' not found/,
      );
    });
  });

  describe("Root Service", () => {
    it("creates root service when root commands are defined", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
root:
  commands:
    lint:
      command: eslint .
    check:
      commands:
        types: tsc --noEmit
        lint: eslint .
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);

      // Root service should exist
      expect(project.services.entries.root).toBeDefined();
      expect(project.services.entries.root?.id).toBe("root");
      expect(project.services.entries.root?.name).toBe("Root");
      expect(project.services.entries.root?.commands?.lint?.command).toBe(
        "eslint .",
      );

      // Root should be in targets
      expect(project.services.targets).toContain("root");
      expect(project.rootName).toBe("root");
    });

    it("supports custom root_name", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
root_name: workspace
root:
  commands:
    lint:
      command: eslint .
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);

      expect(project.rootName).toBe("workspace");
      expect(project.services.entries.workspace).toBeDefined();
      expect(project.services.entries.root).toBeUndefined();
      expect(project.services.targets).toContain("workspace");
    });

    it("does not create root service when no root commands defined", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);

      expect(project.services.entries.root).toBeUndefined();
      expect(project.services.targets).not.toContain("root");
    });

    it("throws when root_name conflicts with service name", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
root_name: web
root:
  commands:
    lint:
      command: eslint .
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
        },
      });

      expect(() => loadProjectConfig(root)).toThrow(
        /Service "web" conflicts with root_name/,
      );
    });

    it("throws when service has root in runtime.deps", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
root:
  commands:
    lint:
      command: eslint .
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
runtime:
  deps:
    - root
commands:
  lint:
    command: eslint .
`,
        },
      });

      expect(() => loadProjectConfig(root)).toThrow(
        /Service "web" cannot depend on "root" at service level/,
      );
    });

    it("allows root in command-level dependencies", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
root:
  commands:
    lint:
      command: eslint .
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    dependencies:
      - root
    command: eslint .
`,
        },
      });

      // Should not throw
      const project = loadProjectConfig(root);
      expect(
        project.services.entries.web?.commands?.lint?.dependencies,
      ).toEqual(["root"]);
    });

    it("resolves root commands correctly", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
root:
  commands:
    check:
      commands:
        lint: eslint .
        types: tsc --noEmit
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const resolved = resolveCommand(project, "check", "root");

      expect(resolved).toHaveLength(2);
      expect(resolved).toContainEqual({
        service: "root",
        command: "check:lint",
        executable: "eslint .",
      });
      expect(resolved).toContainEqual({
        service: "root",
        command: "check:types",
        executable: "tsc --noEmit",
      });
    });

    it("builds execution plan with root dependencies", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
root:
  commands:
    lint:
      command: eslint .
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    dependencies:
      - root
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "lint", ["web"]);

      // Root lint should run before web lint
      expect(plan.stages).toHaveLength(2);
      expect(plan.stages[0]).toContainEqual(
        expect.objectContaining({ service: "root", command: "lint" }),
      );
      expect(plan.stages[1]).toContainEqual(
        expect.objectContaining({ service: "web", command: "lint" }),
      );
    });

    it("can run root command directly", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
root:
  commands:
    lint:
      command: eslint .
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "lint", ["root"]);

      expect(plan.stages).toHaveLength(1);
      expect(plan.stages[0]).toHaveLength(1);
      expect(plan.stages[0]![0]).toMatchObject({
        service: "root",
        command: "lint",
        executable: "eslint .",
      });
    });

    it("root service path is project root directory", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
root:
  commands:
    lint:
      command: eslint .
`,
        services: {
          web: `
name: web
dockerfile: Dockerfile
commands:
  lint:
    command: eslint .
`,
        },
      });

      const project = loadProjectConfig(root);

      // Root service path should be the project root, not apps/root
      expect(project.services.entries.root?.paths.root).toBe(root);
    });
  });

  describe("deps (same-target command composition)", () => {
    it("loads deps from top-level command", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          runner: `
name: runner
commands:
  stop: echo stop
  start:
    deps:
      - stop
    command: echo start
`,
        },
      });

      const project = loadProjectConfig(root);
      const runner = project.services.entries.runner;
      expect(runner?.commands?.start?.deps).toEqual(["stop"]);
    });

    it("loads deps from subcommand", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          runner: `
name: runner
commands:
  stop: echo stop
  start: echo start
  reset:
    commands:
      act:
        deps:
          - stop
          - start
`,
        },
      });

      const project = loadProjectConfig(root);
      const runner = project.services.entries.runner;
      expect(runner?.commands?.reset?.commands?.act?.deps).toEqual([
        "stop",
        "start",
      ]);
    });

    it("accepts deps-only command (no command or commands)", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          runner: `
name: runner
commands:
  stop: echo stop
  start: echo start
  restart:
    deps:
      - stop
      - start
`,
        },
      });

      const project = loadProjectConfig(root);
      const runner = project.services.entries.runner;
      expect(runner?.commands?.restart?.deps).toEqual(["stop", "start"]);
      expect(runner?.commands?.restart?.command).toBeUndefined();
    });

    it("builds execution plan with deps as graph edges", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          runner: `
name: runner
commands:
  stop: echo stop
  start:
    deps:
      - stop
    command: echo start
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "start", ["runner"]);

      // stop must run before start (2 stages)
      expect(plan.stages.length).toBe(2);
      expect(plan.stages[0]![0]!.command).toBe("stop");
      expect(plan.stages[1]![0]!.command).toBe("start");
    });

    it("deps without ordering run in parallel", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          runner: `
name: runner
commands:
  lint: echo lint
  test: echo test
  check:
    deps:
      - lint
      - test
    command: echo check
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "check", ["runner"]);

      // lint and test have no edges between them → same stage
      // check depends on both → later stage
      expect(plan.stages.length).toBe(2);
      const firstStageCommands = plan.stages[0]!.map((t) => t.command).sort();
      expect(firstStageCommands).toEqual(["lint", "test"]);
      expect(plan.stages[1]![0]!.command).toBe("check");
    });

    it("deps-only subcommand adds dep tasks to the graph", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          runner: `
name: runner
commands:
  stop: echo stop
  start:
    deps:
      - stop
    command: echo start
  reset:
    commands:
      queue:
        command: echo cancel
      act:
        deps:
          - stop
          - start
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "reset", ["runner"]);

      // Collect all tasks across stages
      const allTasks = plan.stages.flat().map((t) => t.command);
      expect(allTasks).toContain("stop");
      expect(allTasks).toContain("start");
      expect(allTasks).toContain("reset:queue");
      // stop must come before start (start deps on stop)
      const stopStage = plan.stages.findIndex((s) =>
        s.some((t) => t.command === "stop"),
      );
      const startStage = plan.stages.findIndex((s) =>
        s.some((t) => t.command === "start"),
      );
      expect(stopStage).toBeLessThan(startStage);
    });

    it("subcommand dep resolves within same service", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          runner: `
name: runner
commands:
  setup:
    commands:
      controller: echo setup-controller
      registry:
        deps:
          - setup:controller
        command: echo setup-registry
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "setup", ["runner"]);

      const allTasks = plan.stages.flat().map((t) => t.command);
      expect(allTasks).toContain("setup:controller");
      expect(allTasks).toContain("setup:registry");

      // controller must run before registry
      const controllerStage = plan.stages.findIndex((s) =>
        s.some((t) => t.command === "setup:controller"),
      );
      const registryStage = plan.stages.findIndex((s) =>
        s.some((t) => t.command === "setup:registry"),
      );
      expect(controllerStage).toBeLessThan(registryStage);
    });

    it("cross-service dep with @ syntax", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          backend: `
name: backend
commands:
  compile: echo compile-backend
`,
          web: `
name: web
commands:
  compile:
    deps:
      - compile@backend
    command: echo compile-web
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "compile", ["web"]);

      const allTasks = plan.stages
        .flat()
        .map((t) => `${t.service}:${t.command}`);
      expect(allTasks).toContain("backend:compile");
      expect(allTasks).toContain("web:compile");

      // backend:compile must run before web:compile
      const backendStage = plan.stages.findIndex((s) =>
        s.some((t) => t.service === "backend"),
      );
      const webStage = plan.stages.findIndex((s) =>
        s.some((t) => t.service === "web"),
      );
      expect(backendStage).toBeLessThan(webStage);
    });

    it("cross-service subcommand dep with @ syntax", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          runner: `
name: runner
commands:
  setup:
    commands:
      registry: echo setup-registry
`,
          web: `
name: web
commands:
  deploy:
    deps:
      - setup:registry@runner
    command: echo deploy-web
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "deploy", ["web"]);

      const allTasks = plan.stages
        .flat()
        .map((t) => `${t.service}:${t.command}`);
      expect(allTasks).toContain("runner:setup:registry");
      expect(allTasks).toContain("web:deploy");

      // runner:setup:registry must run before web:deploy
      const runnerStage = plan.stages.findIndex((s) =>
        s.some((t) => t.service === "runner"),
      );
      const webStage = plan.stages.findIndex((s) =>
        s.some((t) => t.service === "web"),
      );
      expect(runnerStage).toBeLessThan(webStage);
    });

    it("transitive deps-only references propagate dependency edges", () => {
      const root = createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          runner: `
name: runner
commands:
  stop: echo stop
  start: echo start
  restart:
    deps:
      - stop
      - start
  full_reset:
    deps:
      - restart
    command: echo done
`,
        },
      });

      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "full_reset", ["runner"]);

      // restart is deps-only, so full_reset should transitively depend on stop and start
      const allTasks = plan.stages.flat().map((t) => t.command);
      expect(allTasks).toContain("stop");
      expect(allTasks).toContain("start");
      expect(allTasks).toContain("full_reset");

      // full_reset must run after both stop and start
      const stopStage = plan.stages.findIndex((s) =>
        s.some((t) => t.command === "stop"),
      );
      const startStage = plan.stages.findIndex((s) =>
        s.some((t) => t.command === "start"),
      );
      const fullResetStage = plan.stages.findIndex((s) =>
        s.some((t) => t.command === "full_reset"),
      );
      expect(fullResetStage).toBeGreaterThan(stopStage);
      expect(fullResetStage).toBeGreaterThan(startStage);
    });
  });

  describe("setup/teardown subcommand ordering (runner pattern)", () => {
    function createRunnerProject() {
      return createProject({
        rootConfig: `
name: Test Project
services:
  dir: ./apps
`,
        services: {
          runner: `
name: runner
commands:
  setup:
    commands:
      controller: echo setup-controller
      registry:
        deps:
          - setup:controller
        command: echo setup-registry
      buildkit:
        deps:
          - setup:controller
        command: echo setup-buildkit
  teardown:
    commands:
      registry: echo teardown-registry
      buildkit: echo teardown-buildkit
      controller:
        deps:
          - teardown:registry
          - teardown:buildkit
        command: echo teardown-controller
  info:
    commands:
      runners: echo info-runners
      registry: echo info-registry
      buildkit: echo info-buildkit
`,
        },
      });
    }

    function stageOf(plan: ReturnType<typeof buildExecutionPlan>, cmd: string) {
      return plan.stages.findIndex((s) => s.some((t) => t.command === cmd));
    }

    it("setup: controller runs before registry and buildkit", () => {
      const root = createRunnerProject();
      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "setup", ["runner"]);

      const allCmds = plan.stages.flat().map((t) => t.command);
      expect(allCmds).toContain("setup:controller");
      expect(allCmds).toContain("setup:registry");
      expect(allCmds).toContain("setup:buildkit");

      expect(stageOf(plan, "setup:controller")).toBeLessThan(
        stageOf(plan, "setup:registry"),
      );
      expect(stageOf(plan, "setup:controller")).toBeLessThan(
        stageOf(plan, "setup:buildkit"),
      );
    });

    it("setup: registry and buildkit run in parallel (same stage)", () => {
      const root = createRunnerProject();
      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "setup", ["runner"]);

      expect(stageOf(plan, "setup:registry")).toBe(
        stageOf(plan, "setup:buildkit"),
      );
    });

    it("setup:registry pulls in controller as dep", () => {
      const root = createRunnerProject();
      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "setup:registry", ["runner"]);

      const allCmds = plan.stages.flat().map((t) => t.command);
      expect(allCmds).toContain("setup:controller");
      expect(allCmds).toContain("setup:registry");
      expect(allCmds).not.toContain("setup:buildkit");

      expect(stageOf(plan, "setup:controller")).toBeLessThan(
        stageOf(plan, "setup:registry"),
      );
    });

    it("setup:controller runs alone with no extra deps", () => {
      const root = createRunnerProject();
      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "setup:controller", ["runner"]);

      const allCmds = plan.stages.flat().map((t) => t.command);
      expect(allCmds).toEqual(["setup:controller"]);
      expect(plan.stages).toHaveLength(1);
    });

    it("teardown: registry and buildkit run before controller", () => {
      const root = createRunnerProject();
      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "teardown", ["runner"]);

      const allCmds = plan.stages.flat().map((t) => t.command);
      expect(allCmds).toContain("teardown:registry");
      expect(allCmds).toContain("teardown:buildkit");
      expect(allCmds).toContain("teardown:controller");

      expect(stageOf(plan, "teardown:registry")).toBeLessThan(
        stageOf(plan, "teardown:controller"),
      );
      expect(stageOf(plan, "teardown:buildkit")).toBeLessThan(
        stageOf(plan, "teardown:controller"),
      );
    });

    it("teardown: registry and buildkit run in parallel (same stage)", () => {
      const root = createRunnerProject();
      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "teardown", ["runner"]);

      expect(stageOf(plan, "teardown:registry")).toBe(
        stageOf(plan, "teardown:buildkit"),
      );
    });

    it("teardown:controller pulls in registry and buildkit as deps", () => {
      const root = createRunnerProject();
      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "teardown:controller", [
        "runner",
      ]);

      const allCmds = plan.stages.flat().map((t) => t.command);
      expect(allCmds).toContain("teardown:registry");
      expect(allCmds).toContain("teardown:buildkit");
      expect(allCmds).toContain("teardown:controller");

      expect(stageOf(plan, "teardown:registry")).toBeLessThan(
        stageOf(plan, "teardown:controller"),
      );
      expect(stageOf(plan, "teardown:buildkit")).toBeLessThan(
        stageOf(plan, "teardown:controller"),
      );
    });

    it("teardown:registry runs alone with no extra deps", () => {
      const root = createRunnerProject();
      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "teardown:registry", ["runner"]);

      const allCmds = plan.stages.flat().map((t) => t.command);
      expect(allCmds).toEqual(["teardown:registry"]);
      expect(plan.stages).toHaveLength(1);
    });

    it("info: all subcommands run in parallel (no deps)", () => {
      const root = createRunnerProject();
      const project = loadProjectConfig(root);
      const plan = buildExecutionPlan(project, "info", ["runner"]);

      expect(plan.stages).toHaveLength(1);
      expect(plan.stages[0]).toHaveLength(3);

      const allCmds = plan.stages[0]!.map((t) => t.command).sort();
      expect(allCmds).toEqual([
        "info:buildkit",
        "info:registry",
        "info:runners",
      ]);
    });
  });
});
