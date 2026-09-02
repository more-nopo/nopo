/** Covers the root `runtimes:` map → plugin selection logic for `up`, `down`, and `status`.
 * Uses fixtures under `nopo/fixtures/runtime-dispatch/` — no real services touched, per
 * the project's "tests must use fixtures" rule. Each fixture plugin (alpha, beta) records
 * its invocations onto a global trace array; assertions check that the expected
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadPlugins,
  loadProjectConfig,
  resolveRuntimeNamespace,
  resolveRuntimePlugin,
} from "../src/config/index.ts";
import { createConfig, Logger, Runner, Script } from "../src/lib.ts";
import { Environment } from "../src/parse-env.ts";
import DownScript from "../src/scripts/down.ts";
import StatusScript from "../src/scripts/status.ts";
import UpScript from "../src/scripts/up.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_ROOT = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "nopo",
  "fixtures",
  "runtime-dispatch",
);

interface OverlayRecord {
  plugin: string;
  hook: string;
  service: string;
  runtime: string;
  cpu: string;
  port: number;
  env: Record<string, string>;
}

interface TraceTarget {
  __nopoTrace?: string[];
  __nopoOverlays?: OverlayRecord[];
}
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- attaching a typed shim onto globalThis for cross-plugin trace recording
const traceTarget = globalThis as unknown as TraceTarget;

beforeEach(() => {
  traceTarget.__nopoTrace = [];
  traceTarget.__nopoOverlays = [];
});

afterEach(() => {
  delete traceTarget.__nopoTrace;
  delete traceTarget.__nopoOverlays;
});

/**
 * Build a Runner pointing at the fixture project, with an arbitrary argv,
 * and execute the given script class. Loads plugins synchronously
 * (await) before script invocation — mirrors what `nopo` does in main().
 */
async function runWithRuntime(
  ScriptClass: typeof Script,
  argv: string[],
): Promise<void> {
  // Use a tmp env file (empty) so EnvScript dependency boots cleanly.
  const envFile = fs.mkdtempSync(path.join(os.tmpdir(), "rtd-"));
  const envPath = path.join(envFile, ".env");
  fs.writeFileSync(envPath, "", "utf-8");

  const config = createConfig({
    rootDir: FIXTURE_ROOT,
    envFile: envPath,
    silent: true,
    processEnv: {},
  });
  await loadPlugins(config.project);

  const logger = new Logger(config);
  const environment = new Environment(config);
  const runner = new Runner(config, environment, argv, logger);
  await runner.run(ScriptClass);
}

describe("runtime dispatch", () => {
  describe("loadProjectConfig", () => {
    it("parses the root `runtimes:` map", () => {
      const project = loadProjectConfig(FIXTURE_ROOT);
      expect(project.runtimes).toEqual({
        default: { plugin: "alpha" },
        prod: { plugin: "beta" },
      });
    });
  });

  describe("loadPlugins validation", () => {
    it("rejects runtimes pointing at a non-registered plugin", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtd-bad-"));
      try {
        fs.mkdirSync(path.join(tmp, "apps"));
        fs.writeFileSync(
          path.join(tmp, "nopo.yml"),
          [
            "name: Bad",
            "plugins:",
            "  - name: alpha",
            `    path: ${path.join(FIXTURE_ROOT, "plugins", "alpha.ts")}`,
            "runtimes:",
            "  default: alpha",
            "  prod: ghost", // not registered
          ].join("\n"),
        );
        const project = loadProjectConfig(tmp);
        await expect(loadPlugins(project)).rejects.toThrow(
          /runtimes\.prod: plugin "ghost" is not registered/,
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("rejects a runtimes map missing `default`", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtd-nodef-"));
      try {
        fs.mkdirSync(path.join(tmp, "apps"));
        fs.writeFileSync(
          path.join(tmp, "nopo.yml"),
          ["name: NoDefault", "runtimes:", "  prod: docker-compose"].join("\n"),
        );
        expect(() => loadProjectConfig(tmp)).toThrow(
          /must declare a `default:` entry/,
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("resolveRuntimePlugin", () => {
    it("resolves `default` when name is omitted", () => {
      const project = loadProjectConfig(FIXTURE_ROOT);
      expect(resolveRuntimePlugin(project, undefined)).toBe("alpha");
    });

    it("resolves a named runtime", () => {
      const project = loadProjectConfig(FIXTURE_ROOT);
      expect(resolveRuntimePlugin(project, "prod")).toBe("beta");
    });

    it("throws on an unknown runtime name", () => {
      const project = loadProjectConfig(FIXTURE_ROOT);
      expect(() => resolveRuntimePlugin(project, "ghost")).toThrow(
        /Unknown runtime "ghost"/,
      );
    });

    it("returns null when no `runtimes:` map declared and no name requested", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtd-empty-"));
      try {
        fs.mkdirSync(path.join(tmp, "apps"));
        fs.writeFileSync(
          path.join(tmp, "nopo.yml"),
          ["name: NoRuntimes"].join("\n"),
        );
        const project = loadProjectConfig(tmp);
        expect(resolveRuntimePlugin(project, undefined)).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("throws when a name is requested but no `runtimes:` map exists", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtd-empty2-"));
      try {
        fs.mkdirSync(path.join(tmp, "apps"));
        fs.writeFileSync(
          path.join(tmp, "nopo.yml"),
          ["name: NoRuntimes"].join("\n"),
        );
        const project = loadProjectConfig(tmp);
        expect(() => resolveRuntimePlugin(project, "prod")).toThrow(
          /no `runtimes:` map declared/,
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("resolveRuntimeNamespace", () => {
    it("returns the namespace from a runtime entry", () => {
      const tmp = fs.mkdtempSync(
        path.join(os.tmpdir(), "nopo-runtime-ns-test-"),
      );
      try {
        fs.mkdirSync(path.join(tmp, "services"));
        fs.writeFileSync(
          path.join(tmp, "nopo.yml"),
          [
            "name: NamespaceBinding",
            "services:",
            "  dirs:",
            "    - ./services",
            "runtimes:",
            "  default: docker-compose",
            "  preview:",
            "    plugin: terraform",
            "    namespace: nopo-prev",
          ].join("\n"),
        );
        const p = loadProjectConfig(tmp);
        expect(resolveRuntimeNamespace(p, "preview")).toBe("nopo-prev");
        expect(resolveRuntimeNamespace(p, "default")).toBeNull();
        expect(resolveRuntimeNamespace(p, "prod")).toBeNull();
        expect(resolveRuntimeNamespace(p, undefined)).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("returns null when no runtimes map is declared", () => {
      const tmp = fs.mkdtempSync(
        path.join(os.tmpdir(), "nopo-runtime-ns-test-"),
      );
      try {
        fs.mkdirSync(path.join(tmp, "services"));
        fs.writeFileSync(
          path.join(tmp, "nopo.yml"),
          ["name: NoRuntimes", "services:", "  dirs:", "    - ./services"].join(
            "\n",
          ),
        );
        const project = loadProjectConfig(tmp);
        expect(resolveRuntimeNamespace(project, "preview")).toBeNull();
        expect(resolveRuntimeNamespace(project, undefined)).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("CLI dispatch (snapshot of plugin invocation)", () => {
    it("`up` (no flag) → default plugin (alpha)", async () => {
      await runWithRuntime(UpScript, ["up"]);
      expect(traceTarget.__nopoTrace).toContain("alpha:up");
      expect(traceTarget.__nopoTrace).not.toContain("beta:up");
    });

    it("`up --runtime prod` → beta", async () => {
      await runWithRuntime(UpScript, ["up", "--runtime", "prod"]);
      expect(traceTarget.__nopoTrace).toContain("beta:up");
      expect(traceTarget.__nopoTrace).not.toContain("alpha:up");
    });

    it("`down` (no flag) → default plugin (alpha)", async () => {
      await runWithRuntime(DownScript, ["down"]);
      expect(traceTarget.__nopoTrace).toContain("alpha:down");
      expect(traceTarget.__nopoTrace).not.toContain("beta:down");
    });

    it("`down --runtime prod` → beta", async () => {
      await runWithRuntime(DownScript, ["down", "--runtime", "prod"]);
      expect(traceTarget.__nopoTrace).toContain("beta:down");
      expect(traceTarget.__nopoTrace).not.toContain("alpha:down");
    });

    it("`status` (no flag) → default plugin (alpha)", async () => {
      await runWithRuntime(StatusScript, ["status"]);
      expect(traceTarget.__nopoTrace).toContain("alpha:status");
      expect(traceTarget.__nopoTrace).not.toContain("beta:status");
    });

    it("`status --runtime prod` → beta", async () => {
      await runWithRuntime(StatusScript, ["status", "--runtime", "prod"]);
      expect(traceTarget.__nopoTrace).toContain("beta:status");
      expect(traceTarget.__nopoTrace).not.toContain("alpha:status");
    });

    it("`up --runtime ghost` errors fast before any plugin runs", async () => {
      await expect(
        runWithRuntime(UpScript, ["up", "--runtime", "ghost"]),
      ).rejects.toThrow(/Unknown runtime "ghost"/);
      expect(traceTarget.__nopoTrace ?? []).toEqual([]);
    });
  });

  describe("overlay resolution flows through dispatch", () => {
    // svc-b declares an explicit map-shape runtime: default + prod overlay. The plugin (alpha
    // for default, beta for prod) records the cpu/port/env it observes

    function overlayFor(
      records: OverlayRecord[] | undefined,
      pluginName: string,
      service: string,
    ): OverlayRecord | undefined {
      return (records ?? []).find(
        (r) => r.plugin === pluginName && r.service === service,
      );
    }

    it("`up` (default runtime) → alpha sees svc-b's default overlay", async () => {
      await runWithRuntime(UpScript, ["up"]);
      const rec = overlayFor(traceTarget.__nopoOverlays, "alpha", "svc-b");
      expect(rec).toBeDefined();
      expect(rec?.runtime).toBe("default");
      expect(rec?.cpu).toBe("1");
      expect(rec?.port).toBe(3000);
      expect(rec?.env.LOG).toBe("info");
    });

    it("`up --runtime prod` → beta sees svc-b's merged prod overlay", async () => {
      await runWithRuntime(UpScript, ["up", "--runtime", "prod"]);
      const rec = overlayFor(traceTarget.__nopoOverlays, "beta", "svc-b");
      expect(rec).toBeDefined();
      expect(rec?.runtime).toBe("prod");
      // cpu overridden by prod
      expect(rec?.cpu).toBe("2");
      // port inherited from default (prod doesn't override)
      expect(rec?.port).toBe(3000);
      // env.LOG overridden by prod
      expect(rec?.env.LOG).toBe("warn");
    });

    it("alpha is not invoked when --runtime prod targets beta", async () => {
      await runWithRuntime(UpScript, ["up", "--runtime", "prod"]);
      // Alpha records nothing — it wasn't dispatched.
      const alphaRecords = (traceTarget.__nopoOverlays ?? []).filter(
        (r) => r.plugin === "alpha",
      );
      expect(alphaRecords).toEqual([]);
    });

    it("svc-a (flat-shape) gets the schema-default scalars when not declared", async () => {
      // svc-a declares only `command` + `port: 3000` in flat shape (no cpu).
      // DefaultRuntimeBlockSchema baked cpu="1" — alpha must see that.
      await runWithRuntime(UpScript, ["up"]);
      const rec = overlayFor(traceTarget.__nopoOverlays, "alpha", "svc-a");
      expect(rec).toBeDefined();
      expect(rec?.cpu).toBe("1");
      expect(rec?.port).toBe(3000);
    });
  });
});
