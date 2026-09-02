import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isBuildableService,
  loadProjectConfig,
  resolveRuntime,
} from "../src/config/index.ts";
import { FIXTURES_ROOT, PROJECT_ROOT } from "./utils.ts";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-config-"));
  tmpDirs.push(root);

  writeFile(path.join(root, "nopo.yml"), structure.rootConfig);

  if (structure.services) {
    for (const [service, config] of Object.entries(structure.services)) {
      writeFile(path.join(root, "apps", service, "nopo.yml"), config);
    }
  }

  return root;
}

describe("loadProjectConfig", () => {
  it("loads directory services", () => {
    const root = createProject({
      rootConfig: `
name: Example Project
services:
  dir: ./apps
`,
      services: {
        api: `
name: api
description: Public API
dockerfile: Dockerfile
static_path: build
runtime:
  cpu: "2"
  memory: "1Gi"
  port: 8080
`,
      },
    });

    const project = loadProjectConfig(root);

    expect(project.name).toBe("Example Project");
    expect(project.services.targets).toEqual(["api"]);

    const api = project.services.entries.api;
    expect(api).toBeDefined();
    expect(api?.runtime?.cpu).toBe("2");
    expect(api?.staticPath).toBe("build");
  });

  it("loads services with image instead of dockerfile", () => {
    const root = createProject({
      rootConfig: `
name: Image Project
services:
  dir: ./apps
`,
      services: {
        db: `
name: db
description: Database
image: postgres:16
runtime:
  port: 5432
`,
      },
    });

    const project = loadProjectConfig(root);

    expect(project.services.targets).toEqual(["db"]);

    const db = project.services.entries.db;
    expect(db).toBeDefined();
    expect(db?.image).toBe("postgres:16");
  });

  it("applies defaults when fields are omitted", () => {
    const root = createProject({
      rootConfig: `
name: Defaults
`,
      services: {
        worker: `
name: worker
dockerfile: Dockerfile
runtime: {}
`,
      },
    });

    const project = loadProjectConfig(root);
    const worker = project.services.entries.worker;

    expect(project.os.base.from).toBe("node:22.16.0-slim");
    expect(project.os.dependencies).toEqual({
      "build-essential": "",
      jq: "",
      curl: "",
    });
    expect(worker?.runtime?.memory).toBe("512Mi");
    expect(worker?.runtime?.port).toBe(3000);
  });

  it("skips directories without nopo.yml", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-config-"));
    tmpDirs.push(root);
    writeFile(
      path.join(root, "nopo.yml"),
      `
name: Missing Service Config
services:
  dir: ./apps
`,
    );
    fs.mkdirSync(path.join(root, "apps", "ghost"), { recursive: true });

    // Should not throw - directories without nopo.yml are silently skipped
    const config = loadProjectConfig(root);
    expect(config.services.entries["ghost"]).toBeUndefined();
  });

  it("allows services without dockerfile or image (command-only services)", () => {
    const root = createProject({
      rootConfig: `
name: Command Only Services
services:
  dir: ./apps
`,
      services: {
        "command-only": `
name: command-only
description: Command-only service (no docker)
commands:
  test: echo hello
`,
      },
    });

    // Should not throw - services can now exist without dockerfile/image
    const config = loadProjectConfig(root);
    const commandOnlyService = config.services.entries["command-only"];
    expect(commandOnlyService).toBeDefined();
    expect(commandOnlyService?.image).toBeUndefined();
  });

  it("identifies packages (no runtime) vs services", () => {
    const root = createProject({
      rootConfig: `
name: Mixed Project
services:
  dir: ./apps
`,
      services: {
        // Service: has runtime
        backend: `
name: backend
dockerfile: Dockerfile
runtime:
  port: 8080
`,
        // Package: no runtime
        ui: `
name: ui
description: Shared UI components
commands:
  compile: pnpm build
`,
      },
    });

    const config = loadProjectConfig(root);

    // Backend is a service (has runtime)
    const backend = config.services.entries.backend;
    expect(backend).toBeDefined();
    expect(backend?.type).toBe("service");

    // UI is a package (no runtime)
    const ui = config.services.entries.ui;
    expect(ui).toBeDefined();
    expect(ui?.type).toBe("package");
  });

  it("supports runtime schema with command", () => {
    const root = createProject({
      rootConfig: `
name: Runtime Schema
services:
  dir: ./apps
`,
      services: {
        api: `
name: api
dockerfile: Dockerfile
runtime:
  command: node server.js
  port: 3000
  cpu: "2"
  memory: "1Gi"
`,
      },
    });

    const config = loadProjectConfig(root);
    const api = config.services.entries.api;

    expect(api).toBeDefined();
    expect(api?.type).toBe("service");
    expect(api?.runtime).toBeDefined();
    expect(api?.runtime?.command).toBe("node server.js");
    expect(api?.runtime?.port).toBe(3000);
    expect(api?.runtime?.cpu).toBe("2");
  });

  it("supports new build schema", () => {
    const root = createProject({
      rootConfig: `
name: Build Schema
services:
  dir: ./apps
`,
      services: {
        web: `
name: web
build:
  command: pnpm build
  output:
    - ./dist
    - ./public
  dockerfile: Dockerfile
  packages:
    - chromium
  env:
    NODE_ENV: production
runtime:
  port: 3000
`,
      },
    });

    const config = loadProjectConfig(root);
    const web = config.services.entries.web;

    expect(web).toBeDefined();
    expect(web?.build).toBeDefined();
    expect(web?.build?.command).toBe("pnpm build");
    expect(web?.build?.output).toEqual(["./dist", "./public"]);
    expect(web?.build?.packages).toEqual(["chromium"]);
    expect(web?.build?.env).toEqual({ NODE_ENV: "production" });
  });

  it("normalizes build.output from string to array", () => {
    const root = createProject({
      rootConfig: `
name: Single Output
services:
  dir: ./apps
`,
      services: {
        lib: `
name: lib
build:
  command: pnpm build
  output: ./dist
`,
      },
    });

    const config = loadProjectConfig(root);
    const lib = config.services.entries.lib;

    expect(lib?.build?.output).toEqual(["./dist"]);
  });

  it("identifies services with image as services (not packages)", () => {
    const root = createProject({
      rootConfig: `
name: Image Service
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

    const config = loadProjectConfig(root);
    const db = config.services.entries.db;

    expect(db).toBeDefined();
    expect(db?.type).toBe("service");
    expect(db?.runtime).toBeUndefined();
  });

  describe("build.depends_on", () => {
    it("parses build.depends_on as array format", () => {
      const root = createProject({
        rootConfig: `
name: Build Dependencies Array
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
build:
  command: pnpm build
  depends_on: ["ui", "shared"]
runtime:
  port: 3000
`,
        },
      });

      const config = loadProjectConfig(root);
      const web = config.services.entries.web;

      expect(web).toBeDefined();
      expect(web?.build?.depends_on).toEqual(["ui", "shared"]);
    });

    it("parses build.depends_on as object format", () => {
      const root = createProject({
        rootConfig: `
name: Build Dependencies Object
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
build:
  command: pnpm build
  depends_on:
    ui: ["compile", "test"]
    shared: ["build"]
runtime:
  port: 3000
`,
        },
      });

      const config = loadProjectConfig(root);
      const web = config.services.entries.web;

      expect(web).toBeDefined();
      expect(web?.build?.depends_on).toEqual({
        ui: ["compile", "test"],
        shared: ["build"],
      });
    });
  });

  describe("tags", () => {
    it("parses tags array and normalizes on service", () => {
      const root = createProject({
        rootConfig: `
name: Tags Config
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
tags:
  - github-actions
  - frontend
dockerfile: Dockerfile
`,
        },
      });

      const config = loadProjectConfig(root);
      const web = config.services.entries.web;

      expect(web).toBeDefined();
      expect(web?.tags).toEqual(["github-actions", "frontend"]);
    });

    it("defaults to empty array when tags omitted", () => {
      const root = createProject({
        rootConfig: `
name: No Tags
services:
  dir: ./apps
`,
        services: {
          api: `
name: api
dockerfile: Dockerfile
`,
        },
      });

      const config = loadProjectConfig(root);
      const api = config.services.entries.api;

      expect(api).toBeDefined();
      expect(api?.tags).toEqual([]);
    });
  });

  describe("context-specific dependencies (build and runtime)", () => {
    it("allows build.depends_on without runtime.depends_on (package)", () => {
      const root = createProject({
        rootConfig: `
name: Build-only Dependencies
services:
  dir: ./apps
`,
        services: {
          ui: `
name: ui
build:
  command: pnpm build
  depends_on: ["shared"]
`,
        },
      });

      const config = loadProjectConfig(root);
      const ui = config.services.entries.ui;

      expect(ui).toBeDefined();
      expect(ui?.type).toBe("package");
      expect(ui?.build?.depends_on).toEqual(["shared"]);
      expect(ui?.runtime).toBeUndefined();
    });

    it("supports object format for build.depends_on with specific commands", () => {
      const root = createProject({
        rootConfig: `
name: Build Object Dependencies
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
build:
  command: pnpm build
  depends_on:
    ui:
      - compile
      - test
    shared:
      - build
runtime:
  port: 3000
`,
        },
      });

      const config = loadProjectConfig(root);
      const web = config.services.entries.web;

      expect(web).toBeDefined();
      expect(web?.build?.depends_on).toEqual({
        ui: ["compile", "test"],
        shared: ["build"],
      });
    });

    it("allows empty object for build.depends_on (explicit no dependencies)", () => {
      const root = createProject({
        rootConfig: `
name: Empty Build Dependencies
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
build:
  command: pnpm build
  depends_on: {}
`,
        },
      });

      const config = loadProjectConfig(root);
      const web = config.services.entries.web;

      expect(web).toBeDefined();
      expect(web?.build?.depends_on).toEqual({});
    });
  });

  describe("multi-directory discovery", () => {
    it("discovers services from multiple directories", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-config-"));
      tmpDirs.push(root);

      writeFile(
        path.join(root, "nopo.yml"),
        `
name: Multi-Dir Project
services:
  dirs:
    - ./apps
    - ./packages
`,
      );

      // Service in apps directory
      writeFile(
        path.join(root, "apps", "backend", "nopo.yml"),
        `
name: backend
runtime:
  port: 8080
`,
      );

      // Package in packages directory
      writeFile(
        path.join(root, "packages", "ui", "nopo.yml"),
        `
name: ui
commands:
  compile: pnpm build
`,
      );

      const config = loadProjectConfig(root);

      expect(config.services.targets).toEqual(["backend", "ui"]);
      expect(config.services.entries.backend?.type).toBe("service");
      expect(config.services.entries.ui?.type).toBe("package");
    });

    it("discovers services using glob patterns", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-config-"));
      tmpDirs.push(root);

      writeFile(
        path.join(root, "nopo.yml"),
        `
name: Glob Pattern Project
services:
  dirs:
    - "./projects/*"
`,
      );

      // Create service parent directories matching glob pattern
      // Each matched directory (projects/frontend, projects/backend) is then searched for services
      writeFile(
        path.join(root, "projects", "frontend", "web", "nopo.yml"),
        `
name: web
runtime:
  port: 3000
`,
      );

      writeFile(
        path.join(root, "projects", "backend", "api", "nopo.yml"),
        `
name: api
runtime:
  port: 8080
`,
      );

      // Create a non-service directory (no nopo.yml) - should be skipped
      fs.mkdirSync(path.join(root, "projects", "docs"), { recursive: true });
      writeFile(path.join(root, "projects", "docs", "README.md"), "# Docs");

      const config = loadProjectConfig(root);

      // Should find services from within glob-matched parent directories
      expect(config.services.targets).toEqual(["api", "web"]);
    });

    it("excludes directories using exclusion patterns", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-config-"));
      tmpDirs.push(root);

      writeFile(
        path.join(root, "nopo.yml"),
        `
name: Exclusion Pattern Project
services:
  dirs:
    - ./apps
    - ./packages
    - "!./packages/internal"
`,
      );

      // Services that should be included
      writeFile(
        path.join(root, "apps", "api", "nopo.yml"),
        `
name: api
runtime:
  port: 8080
`,
      );

      writeFile(
        path.join(root, "packages", "shared", "nopo.yml"),
        `
name: shared
commands:
  compile: pnpm build
`,
      );

      // Service in excluded directory - should not be discovered
      writeFile(
        path.join(root, "packages", "internal", "secret", "nopo.yml"),
        `
name: secret
commands:
  test: echo secret
`,
      );

      const config = loadProjectConfig(root);

      // Should only find services NOT in excluded directories
      expect(config.services.targets).toEqual(["api", "shared"]);
      expect(config.services.entries.secret).toBeUndefined();
    });

    it("supports glob exclusion patterns", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-config-"));
      tmpDirs.push(root);

      writeFile(
        path.join(root, "nopo.yml"),
        `
name: Glob Exclusion Project
services:
  dirs:
    - "./services/*"
    - "!./services/test-*"
`,
      );

      // Regular service parent directories (services/api and services/worker match the glob)
      // Inside these we have actual service subdirectories
      writeFile(
        path.join(root, "services", "api", "main", "nopo.yml"),
        `
name: main
runtime:
  port: 8080
`,
      );

      writeFile(
        path.join(root, "services", "worker", "processor", "nopo.yml"),
        `
name: processor
runtime:
  port: 9000
`,
      );

      // Test directories that should be excluded (services/test-api and services/test-worker)
      writeFile(
        path.join(root, "services", "test-api", "mock", "nopo.yml"),
        `
name: mock
commands:
  test: echo mock
`,
      );

      writeFile(
        path.join(root, "services", "test-worker", "stub", "nopo.yml"),
        `
name: stub
commands:
  test: echo stub
`,
      );

      const config = loadProjectConfig(root);

      // Should only find services from non-excluded directories
      expect(config.services.targets).toEqual(["main", "processor"]);
    });

    it("throws error for duplicate service IDs across directories", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-config-"));
      tmpDirs.push(root);

      writeFile(
        path.join(root, "nopo.yml"),
        `
name: Duplicate ID Project
services:
  dirs:
    - ./apps
    - ./packages
`,
      );

      // Same service name in both directories
      writeFile(
        path.join(root, "apps", "shared", "nopo.yml"),
        `
name: shared
runtime:
  port: 8080
`,
      );

      writeFile(
        path.join(root, "packages", "shared", "nopo.yml"),
        `
name: shared
commands:
  compile: pnpm build
`,
      );

      expect(() => loadProjectConfig(root)).toThrow(
        /Duplicate service "shared"/,
      );
      expect(() => loadProjectConfig(root)).toThrow(
        /Service IDs must be unique/,
      );
    });

    it("handles empty glob pattern results gracefully", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-config-"));
      tmpDirs.push(root);

      writeFile(
        path.join(root, "nopo.yml"),
        `
name: Empty Glob Project
services:
  dirs:
    - "./nonexistent/*"
`,
      );

      // No services exist - should not throw
      const config = loadProjectConfig(root);
      expect(config.services.targets).toEqual([]);
    });
  });

  describe("build.dockerfile", () => {
    it("parses build.dockerfile as custom Dockerfile path", () => {
      const root = createProject({
        rootConfig: `
name: Dockerfile Project
services:
  dir: ./apps
`,
        services: {
          agent: `
name: agent
description: Agent with custom Dockerfile
build:
  dockerfile: Dockerfile.agent
runtime:
  port: 8080
`,
        },
      });

      const project = loadProjectConfig(root);
      const agent = project.services.entries.agent;
      expect(agent?.build?.dockerfile).toBe("Dockerfile.agent");
    });

    it("isBuildableService returns true for build.dockerfile", () => {
      const root = createProject({
        rootConfig: `
name: Dockerfile Project
services:
  dir: ./apps
`,
        services: {
          agent: `
name: agent
build:
  dockerfile: Dockerfile
runtime:
  port: 8080
`,
        },
      });

      const project = loadProjectConfig(root);
      const agent = project.services.entries.agent;
      expect(agent).toBeDefined();
      expect(isBuildableService(agent!)).toBe(true);
    });

    it("isBuildableService returns true for build.command (no regression)", () => {
      const root = createProject({
        rootConfig: `
name: Command Project
services:
  dir: ./apps
`,
        services: {
          web: `
name: web
build:
  command: echo "build"
runtime:
  port: 3000
`,
        },
      });

      const project = loadProjectConfig(root);
      const web = project.services.entries.web;
      expect(isBuildableService(web!)).toBe(true);
    });

    it("isBuildableService returns false without build", () => {
      const root = createProject({
        rootConfig: `
name: No Build Project
services:
  dir: ./apps
`,
        services: {
          db: `
name: db
image: postgres:16
runtime:
  port: 5432
`,
        },
      });

      const project = loadProjectConfig(root);
      const db = project.services.entries.db;
      expect(isBuildableService(db!)).toBe(false);
    });
  });

  describe("runtime map", () => {
    it("flat-shape runtime auto-wraps to runtimes.default (back-compat)", () => {
      const root = createProject({
        rootConfig: `
name: Flat Auto-Wrap
services:
  dir: ./apps
`,
        services: {
          api: `
name: api
runtime:
  command: node server.js
  port: 3000
  cpu: "2"
`,
        },
      });

      const project = loadProjectConfig(root);
      const api = project.services.entries.api!;

      // Legacy view still populated for existing plugin consumers.
      expect(api.runtime?.command).toBe("node server.js");
      expect(api.runtime?.port).toBe(3000);
      expect(api.runtime?.cpu).toBe("2");

      // New `runtimes` field exposes the auto-wrapped map.
      expect(api.runtimes).toBeDefined();
      expect(Object.keys(api.runtimes!)).toEqual(["default"]);
      expect(api.runtimes!.default?.command).toBe("node server.js");
      expect(api.runtimes!.default?.port).toBe(3000);
    });

    it("map-shape runtime parses with default + named runtimes", () => {
      const root = createProject({
        rootConfig: `
name: Map Shape
services:
  dir: ./apps
`,
        services: {
          api: `
name: api
runtime:
  default:
    command: node server.js
    port: 3000
    env:
      LOG_LEVEL: info
  prod:
    cpu: "2"
    env:
      LOG_LEVEL: warn
  dev:
    env:
      LOG_LEVEL: debug
`,
        },
      });

      const project = loadProjectConfig(root);
      const api = project.services.entries.api!;

      expect(Object.keys(api.runtimes!).sort()).toEqual([
        "default",
        "dev",
        "prod",
      ]);
      expect(api.runtimes!.default?.command).toBe("node server.js");
      expect(api.runtimes!.prod?.cpu).toBe("2");
      expect(api.runtimes!.dev?.env).toEqual({ LOG_LEVEL: "debug" });
    });

    it("map-shape rejects services missing `default`", () => {
      const root = createProject({
        rootConfig: `
name: No Default
services:
  dir: ./apps
`,
        services: {
          api: `
name: api
runtime:
  prod:
    command: node server.js
    port: 3000
`,
        },
      });

      expect(() => loadProjectConfig(root)).toThrow(/default/);
    });

    it("rejects plaintext under runtime.default.secrets", () => {
      const root = createProject({
        rootConfig: `
name: Plaintext Secret
services:
  dir: ./apps
`,
        services: {
          api: `
name: api
runtime:
  default:
    command: x
    secrets:
      DATABASE_URL: "postgres://u:p@host/db"
`,
        },
      });

      expect(() => loadProjectConfig(root)).toThrow(/ENC\[\.\.\.\] ciphertext/);
    });

    it("rejects plaintext under runtime.<name>.secrets", () => {
      const root = createProject({
        rootConfig: `
name: Plaintext Named Secret
services:
  dir: ./apps
`,
        services: {
          api: `
name: api
runtime:
  default:
    command: x
  prod:
    secrets:
      API_KEY: "raw-plaintext-key"
`,
        },
      });

      expect(() => loadProjectConfig(root)).toThrow(/ENC\[\.\.\.\] ciphertext/);
    });

    it("resolveRuntime applies the 4-layer override priority on a real service", () => {
      const root = createProject({
        rootConfig: `
name: Override Priority
services:
  dir: ./apps
`,
        services: {
          api: `
name: api
runtime:
  default:
    command: node x.js
    port: 3000
    env:
      LOG_LEVEL: info
      FEATURE_X: "true"
    secrets:
      DATABASE_URL: "ENC[default-db]"
  prod:
    cpu: "2"
    env:
      LOG_LEVEL: warn
    secrets:
      DATABASE_URL: "ENC[prod-db]"
`,
        },
      });

      const project = loadProjectConfig(root);
      const api = project.services.entries.api!;

      const dev = resolveRuntime(api.runtimes!, "default");
      expect(dev.envs.effective).toEqual({
        LOG_LEVEL: "info",
        FEATURE_X: "true",
        DATABASE_URL: "ENC[default-db]",
      });

      const prod = resolveRuntime(api.runtimes!, "prod");
      expect(prod.cpu).toBe("2");
      expect(prod.command).toBe("node x.js");
      // command inherits. prod.env overrides LOG_LEVEL; default.env
      // keeps FEATURE_X; prod.secrets overrides DATABASE_URL.
      expect(prod.envs.effective).toEqual({
        LOG_LEVEL: "warn",
        FEATURE_X: "true",
        DATABASE_URL: "ENC[prod-db]",
      });
      expect(prod.envs.secrets.DATABASE_URL).toBe("ENC[prod-db]");
      expect(prod.envs.env.DATABASE_URL).toBeUndefined(); // masked by secret
    });

    it("loads the runtime-map fixture cleanly", () => {
      // Fixture nopo/fixtures/services/runtime-map. loadProjectConfig
      // against checked-in YAML, per the fixture-first test rule.
      const project = loadProjectConfig(FIXTURES_ROOT);
      const svc = project.services.entries["runtime-map"]!;
      expect(svc).toBeDefined();
      expect(svc.runtimes).toBeDefined();
      expect(Object.keys(svc.runtimes!).sort()).toEqual([
        "default",
        "prod",
        "test",
      ]);

      const test = resolveRuntime(svc.runtimes!, "test");
      // name.env overrides default.secret for same key.
      expect(test.envs.effective.API_KEY).toBe("deterministic-test-api-key");
      expect(test.envs.env.API_KEY).toBe("deterministic-test-api-key");
      expect(test.envs.secrets.API_KEY).toBeUndefined();

      const prod = resolveRuntime(svc.runtimes!, "prod");
      expect(prod.cpu).toBe("2");
      expect(prod.envs.secrets.API_KEY).toMatch(/^ENC\[/);
    });
  });

  describe("back-compat sweep — every nopo.yml in the repo parses", () => {
    /**
     * Load the real repo root. Every nopo.yml must parse. Do not assert
     * service contents (fixture-first). Every service with a runtime
     * block must have a populated `runtimes.default`.
     */
    it("loadProjectConfig succeeds against the real repo root", () => {
      const project = loadProjectConfig(PROJECT_ROOT);
      expect(project.services.targets.length).toBeGreaterThan(0);
    });

    it("every service with a runtime ends up with runtimes.default", () => {
      const project = loadProjectConfig(PROJECT_ROOT);
      for (const [id, svc] of Object.entries(project.services.entries)) {
        if (svc.runtime) {
          expect(
            svc.runtimes,
            `service "${id}" has legacy runtime but no runtimes map`,
          ).toBeDefined();
          expect(
            svc.runtimes!.default,
            `service "${id}" runtimes map missing default block`,
          ).toBeDefined();
        }
      }
    });
  });

  describe("system_deps", () => {
    it("injects project-level system_deps into every service's build + runtime deps", () => {
      const root = createProject({
        rootConfig: `
name: System Deps
services:
  dir: ./apps
system_deps:
  - shared-tool
`,
        services: {
          "shared-tool": `
name: shared-tool
description: A package every other service depends on
`,
          api: `
name: api
runtime:
  command: node server.js
  port: 3000
`,
          worker: `
name: worker
runtime:
  command: node worker.js
  port: 3001
`,
        },
      });

      const project = loadProjectConfig(root);
      const api = project.services.entries.api!;
      const worker = project.services.entries.worker!;
      const shared = project.services.entries["shared-tool"]!;

      // systemDeps is its own field — not buildDeps or runtimeDeps — so
      // plugins (docker bake, compose, terraform) do not see concrete edges.
      expect(api.systemDeps).toContain("shared-tool");
      expect(worker.systemDeps).toContain("shared-tool");
      expect(api.buildDeps).not.toContain("shared-tool");
      expect(api.runtimeDeps).not.toContain("shared-tool");
      expect(worker.buildDeps).not.toContain("shared-tool");
      expect(worker.runtimeDeps).not.toContain("shared-tool");
      // system_deps service itself does not get a self-edge.
      expect(shared.systemDeps).not.toContain("shared-tool");
    });

    it("rejects system_deps that reference a service that doesn't exist", () => {
      const root = createProject({
        rootConfig: `
name: Bad System Dep
services:
  dir: ./apps
system_deps:
  - missing
`,
        services: {
          api: `
name: api
runtime:
  command: node server.js
`,
        },
      });

      expect(() => loadProjectConfig(root)).toThrow(
        /system_deps references unknown service "missing"/,
      );
    });
  });

  describe("unknown named runtime warning", () => {
    /**
     * Replace `console.warn` for `fn` and return captured calls.
     * `vi.spyOn` fails (vitest 3 intercepts console); swap the global instead.
     */
    function captureWarnings<T>(fn: () => T): {
      result: T;
      calls: unknown[][];
    } {
      const original = console.warn;
      const captured: unknown[][] = [];
      console.warn = (...args: unknown[]) => {
        captured.push(args);
      };
      try {
        const result = fn();
        return { result, calls: captured };
      } finally {
        console.warn = original;
      }
    }

    it("warns when a service declares a named overlay missing from root runtimes:", () => {
      const root = createProject({
        rootConfig: `
name: Cross Ref Warn
services:
  dir: ./apps
runtimes:
  default: docker-compose
  prod: terraform
`,
        services: {
          api: `
name: api
runtime:
  default:
    command: node server.js
    port: 3000
  staging:
    command: node staging.js
`,
        },
      });

      const { calls } = captureWarnings(() => loadProjectConfig(root));

      expect(calls).toHaveLength(1);
      const message = calls[0]?.[0];
      expect(message).toContain("[api]");
      expect(message).toContain("runtime.staging");
      expect(message).toMatch(/root `runtimes:` map/);
      expect(message).toMatch(/Add it to root nopo\.yml/);
    });

    it("does not warn when every named overlay is present in root runtimes:", () => {
      const root = createProject({
        rootConfig: `
name: All Known
services:
  dir: ./apps
runtimes:
  default: docker-compose
  prod: terraform
`,
        services: {
          api: `
name: api
runtime:
  default:
    command: node server.js
    port: 3000
  prod:
    cpu: "2"
`,
        },
      });

      const { calls } = captureWarnings(() => loadProjectConfig(root));

      expect(calls).toEqual([]);
    });

    it("does not warn when root has no runtimes: map (legacy project)", () => {
      const root = createProject({
        rootConfig: `
name: Legacy
services:
  dir: ./apps
`,
        services: {
          api: `
name: api
runtime:
  default:
    command: node server.js
    port: 3000
  staging:
    command: node staging.js
`,
        },
      });

      const { calls } = captureWarnings(() => loadProjectConfig(root));

      expect(calls).toEqual([]);
    });
  });
});
