import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadPlugins, loadProjectConfig } from "../src/config/index.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs.length = 0;
});

function writeFile(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf-8");
}

function createProject(rootConfig: string, extras?: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-plugin-"));
  tmpDirs.push(root);
  // Create the default services dir so config loading doesn't fail
  fs.mkdirSync(path.join(root, "apps"), { recursive: true });
  writeFile(path.join(root, "nopo.yml"), rootConfig);
  if (extras) {
    for (const [relPath, content] of Object.entries(extras)) {
      writeFile(path.join(root, relPath), content);
    }
  }
  return root;
}

describe("Plugin System", () => {
  describe("loadProjectConfig with plugins", () => {
    it("parses plugins field from nopo.yml", () => {
      const root = createProject(`
name: Test
plugins:
  - name: test-plugin
    config:
      key: value
`);
      const project = loadProjectConfig(root);

      expect(project.pluginRefs).toHaveLength(1);
      expect(project.pluginRefs[0]!.name).toBe("test-plugin");
      expect(project.pluginRefs[0]!.config).toEqual({ key: "value" });
      // Plugins not loaded yet (async)
      expect(project.plugins).toEqual([]);
    });

    it("defaults to empty plugins array", () => {
      const root = createProject("name: Test\n");
      const project = loadProjectConfig(root);
      expect(project.pluginRefs).toEqual([]);
      expect(project.plugins).toEqual([]);
    });
  });

  describe("loadPlugins", () => {
    it("loads plugin from local path", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: my-plugin
    path: ./my-plugin.cjs
`);

      // Write a CJS plugin file
      writeFile(
        path.join(root, "my-plugin.cjs"),
        `
        module.exports.default = function(config) {
          return {
            name: 'my-plugin',
            description: 'Test plugin',
          };
        };
      `,
      );

      const project = loadProjectConfig(root);
      await loadPlugins(project);

      expect(project.plugins).toHaveLength(1);
      expect(project.plugins[0]!.definition.name).toBe("my-plugin");
      expect(project.plugins[0]!.definition.description).toBe("Test plugin");
    });

    it("passes config to plugin factory", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: configured
    path: ./plugin.cjs
    config:
      debug: true
      port: 3000
`);

      writeFile(
        path.join(root, "plugin.cjs"),
        `
        module.exports.default = function(config) {
          return {
            name: 'configured',
            receivedConfig: config,
          };
        };
      `,
      );

      const project = loadProjectConfig(root);
      await loadPlugins(project);

      expect(project.plugins[0]!.projectConfig).toEqual({
        debug: true,
        port: 3000,
      });
    });

    it("detects override conflicts between plugins", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: plugin-a
    path: ./a.cjs
  - name: plugin-b
    path: ./b.cjs
`);

      writeFile(
        path.join(root, "a.cjs"),
        `
        module.exports.default = function() {
          return {
            name: 'plugin-a',
            overrides: { build: async () => {} },
          };
        };
      `,
      );

      writeFile(
        path.join(root, "b.cjs"),
        `
        module.exports.default = function() {
          return {
            name: 'plugin-b',
            overrides: { build: async () => {} },
          };
        };
      `,
      );

      const project = loadProjectConfig(root);
      await expect(loadPlugins(project)).rejects.toThrow(
        /override 'build' conflicts/,
      );
    });

    it("throws on invalid factory return (missing name)", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: bad-plugin
    path: ./bad.cjs
`);

      writeFile(
        path.join(root, "bad.cjs"),
        `
        module.exports.default = function() {
          return { description: 'no name field' };
        };
      `,
      );

      const project = loadProjectConfig(root);
      await expect(loadPlugins(project)).rejects.toThrow(
        /must return an object with a 'name' field/,
      );
    });

    it("throws on non-function export", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: bad-export
    path: ./bad.cjs
`);

      writeFile(
        path.join(root, "bad.cjs"),
        `
        module.exports.default = { notAFunction: true };
      `,
      );

      const project = loadProjectConfig(root);
      await expect(loadPlugins(project)).rejects.toThrow(
        /must export a default function/,
      );
    });

    it("throws on missing local path", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: missing
    path: ./does-not-exist.cjs
`);

      const project = loadProjectConfig(root);
      await expect(loadPlugins(project)).rejects.toThrow(/not found/);
    });

    it("allows multiple plugins with different overrides", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: builder
    path: ./builder.cjs
  - name: runner
    path: ./runner.cjs
`);

      writeFile(
        path.join(root, "builder.cjs"),
        `
        module.exports.default = function() {
          return {
            name: 'builder',
            overrides: { build: async () => {} },
          };
        };
      `,
      );

      writeFile(
        path.join(root, "runner.cjs"),
        `
        module.exports.default = function() {
          return {
            name: 'runner',
            overrides: { up: async () => {} },
          };
        };
      `,
      );

      const project = loadProjectConfig(root);
      await loadPlugins(project);
      expect(project.plugins).toHaveLength(2);
    });

    it("skips loading when no plugins defined", async () => {
      const root = createProject("name: Test\n");
      const project = loadProjectConfig(root);
      await loadPlugins(project);
      expect(project.plugins).toEqual([]);
    });

    it("re-throws real errors from plugin modules (not swallowed as 'not found')", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: broken
    path: ./broken.cjs
`);

      writeFile(
        path.join(root, "broken.cjs"),
        `
        throw new Error("Intentional syntax error in plugin");
      `,
      );

      const project = loadProjectConfig(root);
      await expect(loadPlugins(project)).rejects.toThrow(
        "Intentional syntax error in plugin",
      );
    });

    it("detects duplicate plugin names", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: dupe
    path: ./dupe.cjs
  - name: dupe
    path: ./dupe.cjs
`);

      writeFile(
        path.join(root, "dupe.cjs"),
        `
        module.exports.default = function() {
          return { name: 'dupe' };
        };
      `,
      );

      const project = loadProjectConfig(root);
      await expect(loadPlugins(project)).rejects.toThrow(
        /Duplicate plugin name 'dupe'/,
      );
    });

    it("rejects plugin names that collide with built-in commands", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: shadower
    path: ./shadower.cjs
`);

      writeFile(
        path.join(root, "shadower.cjs"),
        `
        module.exports.default = function() {
          return { name: 'build' };
        };
      `,
      );

      const project = loadProjectConfig(root);
      await expect(loadPlugins(project)).rejects.toThrow(
        /conflicts with built-in command 'build'/,
      );
    });

    it("accepts arbitrary hook names (used for batch handler dispatch)", async () => {
      // `definition.hooks` doubles as the batch handler registry — coalesced plan nodes dispatch
      // by hook name (see `plan-compact.ts`), so unknown names are NOT rejected here.
      const root = createProject(`
name: Test
plugins:
  - name: batch-plugin
    path: ./batch.cjs
`);

      writeFile(
        path.join(root, "batch.cjs"),
        `
        module.exports.default = function() {
          return {
            name: 'batch-plugin',
            hooks: { custom_batch_handler: async () => {} },
          };
        };
      `,
      );

      const project = loadProjectConfig(root);
      await expect(loadPlugins(project)).resolves.toBeUndefined();
    });

    it("validates project config with configSchema.project", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: validated
    path: ./validated.cjs
    config:
      port: not-a-number
`);

      writeFile(
        path.join(root, "validated.cjs"),
        `
        const z = require("zod");
        module.exports.default = function(config) {
          return {
            name: 'validated',
            configSchema: {
              project: z.object({ port: z.number() }),
            },
          };
        };
      `,
      );

      const project = loadProjectConfig(root);
      await expect(loadPlugins(project)).rejects.toThrow();
    });

    it("validates project config even when config is undefined", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: requires-config
    path: ./requires.cjs
`);

      writeFile(
        path.join(root, "requires.cjs"),
        `
        const z = require("zod");
        module.exports.default = function(config) {
          return {
            name: 'requires-config',
            configSchema: {
              project: z.object({ port: z.number() }),
            },
          };
        };
      `,
      );

      const project = loadProjectConfig(root);
      // config is undefined, but schema requires { port: number } — should throw
      await expect(loadPlugins(project)).rejects.toThrow();
    });

    it("rejects unknown override names", async () => {
      const root = createProject(`
name: Test
plugins:
  - name: typo-override
    path: ./typo.cjs
`);

      writeFile(
        path.join(root, "typo.cjs"),
        `
        module.exports.default = function() {
          return {
            name: 'typo-override',
            overrides: { bild: async () => {} },
          };
        };
      `,
      );

      const project = loadProjectConfig(root);
      await expect(loadPlugins(project)).rejects.toThrow(
        /unknown override 'bild'/,
      );
    });
  });
});
