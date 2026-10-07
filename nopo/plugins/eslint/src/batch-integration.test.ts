/** End-to-end integration of the eslint plugin's plan batch path:
 * CommandScript.plan() → N `cmd:*:*:lint` command:exec nodes
 * ↓ compactPlan(eslint BatchSpec)
 * 1 `eslint:batch` plugin-hook node (claimed eslint-delegated targets)
 * + non-eslint command:exec nodes left intact
 * ↓ executePlan eslint lintBatch hook called exactly once with the claimed target list
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { NormalizedService } from "@more-nopo/nopo/config";
import type { Plan, PlanHandler, PlanNode } from "@more-nopo/nopo/plan";
import type { CompactionContext } from "@more-nopo/nopo/plan-compact";
import { compactPlan } from "@more-nopo/nopo/plan-compact";
import type { HookContext, LoadedPlugin } from "@more-nopo/nopo/plugin";
import type { ScriptArgs } from "@more-nopo/nopo/script-args";
import { afterEach, describe, expect, it } from "vitest";

import eslintPlugin, {
  isEslintCommandExecNode,
  renderMetaConfig,
} from "./index.ts";

function makeService(
  overrides: Partial<NormalizedService> & { id: string },
): NormalizedService {
  const id = overrides.id;
  const base: NormalizedService = {
    id,
    name: overrides.name ?? id,
    description: "",
    image: undefined,
    staticPath: "",
    tags: [],
    secrets: [],
    type: overrides.type ?? "package",
    env: undefined,
    runtime: undefined,
    pluginData: undefined,
    paths: {
      root: `/project/packages/${id}`,
      context: `/project/packages/${id}`,
    },
    configPath: `/project/packages/${id}/nopo.yml`,
    packageManagers: [],
    commands: {
      lint: { plugin: "eslint" },
    },
    buildDeps: [],
    runtimeDeps: [],
    systemDeps: [],
  };
  return { ...base, ...overrides, id };
}

function loadedEslintPlugin(): LoadedPlugin {
  return {
    definition: eslintPlugin({}),
    serviceConfigs: {},
  };
}

function makeCompactionCtx(
  services: Record<string, NormalizedService>,
  plugins: LoadedPlugin[],
): CompactionContext {
  /* eslint-disable @typescript-eslint/consistent-type-assertions -- partial CompactionContext for integration test */
  return {
    services,
    project: { plugins } as unknown as CompactionContext["project"],
    env: {},
    args: {} as unknown as ScriptArgs,
  };
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
}

function makeLintExecNode(
  service: string,
  command = "lint",
  stage = 0,
  extras: { plugin?: string; args?: string[]; executable?: string } = {},
): PlanNode {
  const plugin = extras.plugin ?? "eslint";
  return {
    id: `cmd:${stage}:${service}:${command}`,
    handler: { kind: "builtin", name: "command:exec" },
    needs: ["pre_command"],
    target: service,
    payload: {
      commandName: command.includes(":") ? command.split(":")[0] : command,
      stageIndex: stage,
      task: {
        service,
        command,
        executable: extras.executable ?? "run",
        plugin,
        ...(extras.args ? { args: extras.args } : {}),
      },
    },
    meta: {
      script: "command",
      phase: "exec",
      stage,
      command,
    },
  };
}

/** Same shape CommandScript.plan() emits for a single-stage lint/check:lint run. */
function makeCommandPlan(
  targets: string[],
  command = "lint",
  opts?: { shellTargets?: string[] },
): Plan {
  const nodes = new Map<string, PlanNode>();
  nodes.set("pre_command", {
    id: "pre_command",
    handler: { kind: "builtin", name: "command:pre" },
    needs: [],
    payload: {
      commandName: command,
      targets: [...targets, ...(opts?.shellTargets ?? [])],
      stageCount: 1,
    },
    meta: { script: "command", phase: "pre" },
  });

  const cmdIds: string[] = [];
  for (const target of targets) {
    const node = makeLintExecNode(target, command);
    nodes.set(node.id, node);
    cmdIds.push(node.id);
  }
  for (const target of opts?.shellTargets ?? []) {
    const node: PlanNode = {
      id: `cmd:0:${target}:${command}`,
      handler: { kind: "builtin", name: "command:exec" },
      needs: ["pre_command"],
      target,
      payload: {
        commandName: command,
        stageIndex: 0,
        task: {
          service: target,
          command,
          executable: "eslint .",
          // shell path — no plugin field
        },
      },
      meta: { script: "command", phase: "exec", stage: 0, command },
    };
    nodes.set(node.id, node);
    cmdIds.push(node.id);
  }

  nodes.set("post_command", {
    id: "post_command",
    handler: { kind: "builtin", name: "command:post" },
    needs: cmdIds.length ? cmdIds : ["pre_command"],
    payload: { commandName: command },
    meta: { script: "command", phase: "post" },
  });
  return { nodes };
}

describe("eslint BatchSpec — CommandScript.plan ∘ compactPlan", () => {
  it("folds N plugin:eslint command:exec nodes into ONE eslint:batch plugin-hook", () => {
    const services = {
      web: makeService({ id: "web" }),
      api: makeService({ id: "api" }),
      ui: makeService({ id: "ui" }),
    };
    const plan = makeCommandPlan(["web", "api", "ui"], "check:lint");

    const compacted = compactPlan(
      plan,
      makeCompactionCtx(services, [loadedEslintPlugin()]),
    );

    expect([...compacted.nodes.keys()]).toEqual([
      "pre_command",
      "eslint:batch",
      "post_command",
    ]);
    const batch = compacted.nodes.get("eslint:batch")!;
    expect(batch.handler).toEqual({
      kind: "plugin-hook",
      plugin: "eslint",
      hook: "lintBatch",
    });
    expect(batch.payload).toEqual({
      targets: ["web", "api", "ui"],
    });
    expect(batch.meta).toEqual({
      batchOf: [
        "cmd:0:web:check:lint",
        "cmd:0:api:check:lint",
        "cmd:0:ui:check:lint",
      ],
    });
    expect(batch.needs).toEqual(["pre_command"]);
  });

  it("leaves non-eslint (shell) command:exec nodes alone", () => {
    const services = {
      web: makeService({ id: "web" }),
      legacy: makeService({
        id: "legacy",
        commands: { lint: { command: "eslint ." } },
      }),
    };
    const plan = makeCommandPlan(["web"], "lint", { shellTargets: ["legacy"] });

    const compacted = compactPlan(
      plan,
      makeCompactionCtx(services, [loadedEslintPlugin()]),
    );

    expect([...compacted.nodes.keys()]).toEqual([
      "pre_command",
      "eslint:batch",
      "cmd:0:legacy:lint",
      "post_command",
    ]);
    const legacy = compacted.nodes.get("cmd:0:legacy:lint")!;
    expect(legacy.handler).toEqual({ kind: "builtin", name: "command:exec" });
    expect(isEslintCommandExecNode(legacy)).toBe(false);
  });

  it("rewrites post_command needs to the batch id", () => {
    const services = {
      a: makeService({ id: "a" }),
      b: makeService({ id: "b" }),
    };
    const plan = makeCommandPlan(["a", "b"], "lint");
    const compacted = compactPlan(
      plan,
      makeCompactionCtx(services, [loadedEslintPlugin()]),
    );
    expect([...compacted.nodes.get("post_command")!.needs]).toEqual([
      "eslint:batch",
    ]);
  });

  it("lifts delegated task.args onto the batch payload", () => {
    const services = {
      a: makeService({ id: "a" }),
      b: makeService({ id: "b" }),
    };
    const plan = makeCommandPlan(["a", "b"], "lint");
    // Force args onto first claimed node.
    const first = plan.nodes.get("cmd:0:a:lint")!;
    /* eslint-disable @typescript-eslint/consistent-type-assertions -- test mutates payload shape */
    const payload = first.payload as {
      task: { args?: string[] };
    };
    payload.task.args = ["--max-warnings=0"];
    /* eslint-enable @typescript-eslint/consistent-type-assertions */

    const compacted = compactPlan(
      plan,
      makeCompactionCtx(services, [loadedEslintPlugin()]),
    );
    expect(compacted.nodes.get("eslint:batch")!.payload).toEqual({
      targets: ["a", "b"],
      args: ["--max-warnings=0"],
    });
  });
});

describe("eslint lintBatch dispatch shape", () => {
  it("invokes hooks.lintBatch once with coalesced targets", async () => {
    const services = {
      web: makeService({ id: "web" }),
      api: makeService({ id: "api" }),
    };
    const plan = makeCommandPlan(["web", "api"], "lint");
    const factoryCalls: Array<{ payload: unknown }> = [];
    const capture: LoadedPlugin = {
      serviceConfigs: {},
      definition: {
        name: "eslint",
        batches: eslintPlugin({}).batches,
        hooks: {
          lintBatch: async (ctx: HookContext) => {
            factoryCalls.push({ payload: ctx.payload });
          },
        },
      },
    };

    const compacted = compactPlan(plan, makeCompactionCtx(services, [capture]));
    const batch = compacted.nodes.get("eslint:batch")!;
    expect(batch.handler.kind).toBe("plugin-hook");
    /* eslint-disable @typescript-eslint/consistent-type-assertions -- narrowed above */
    const handler = batch.handler as Extract<
      PlanHandler,
      { kind: "plugin-hook" }
    >;
    /* eslint-enable @typescript-eslint/consistent-type-assertions */
    expect(handler).toEqual({
      kind: "plugin-hook",
      plugin: "eslint",
      hook: "lintBatch",
    });

    /* eslint-disable @typescript-eslint/consistent-type-assertions -- stub HookContext */
    await capture.definition.hooks!.lintBatch!({
      payload: batch.payload,
    } as unknown as HookContext);
    /* eslint-enable @typescript-eslint/consistent-type-assertions */

    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0]?.payload).toEqual({ targets: ["web", "api"] });
  });
});

/** Real ESLint run over a root target + a nested workspace target through the
 * lintBatch hook. Regression for kevin-mind/nopo#11374: scoping a global-ignore
 * entry with `files` turned it into a no-op local ignore, so the root target
 * linted dist output and every nested workspace.
 */
describe("eslint lintBatch meta config — global ignores", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function write(file: string, contents: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }

  function workspace() {
    const root = mkdtempSync(path.join(tmpdir(), "nopo-eslint-ignores-"));
    roots.push(root);
    const manifest = createRequire(import.meta.url).resolve(
      "eslint/package.json",
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.dirname(manifest),
      path.join(root, "node_modules/eslint"),
      "junction",
    );
    const nested = path.join(root, "products/nested");
    // Root: an includeIgnoreFile()-style entry plus a workspace ignore, both global.
    write(
      path.join(root, "eslint.config.mjs"),
      `export default [
  { name: "Imported .gitignore patterns", ignores: ["**/dist/", ".legacy"] },
  { ignores: ["products/nested/**"] },
  { rules: { "no-debugger": "error" } },
];
`,
    );
    write(path.join(root, "src/index.js"), "debugger;\n");
    write(path.join(root, "dist/index.cjs"), "debugger;\n");
    write(path.join(root, ".legacy/old.js"), "debugger;\n");
    // Nested workspace: its own global ignores, including a negated pattern.
    write(
      path.join(nested, "eslint.config.mjs"),
      `export default [
  { ignores: ["build/", "./generated/*.js", "!generated/keep.js", "../../src/**"] },
  { rules: { "no-console": "warn" } },
];
`,
    );
    write(path.join(nested, "src/app.js"), "debugger;\nconsole.log(1);\n");
    write(path.join(nested, "build/out.js"), "console.log(1);\n");
    write(path.join(nested, "generated/skip.js"), "console.log(1);\n");
    write(path.join(nested, "generated/keep.js"), "console.log(1);\n");
    write(path.join(nested, "dist/index.cjs"), "console.log(1);\n");
    // Config-less target (opted in via plugin: eslint): standalone, ESLint finds
    // the root config for it, so the batch lints it with root's entries/ignores.
    const actions = path.join(root, ".github/actions");
    write(path.join(actions, "src/main.js"), "debugger;\n");
    write(path.join(actions, "dist/index.cjs"), "debugger;\n");
    return { root, nested, actions };
  }

  function service(id: string, root: string): NormalizedService {
    return makeService({
      id,
      paths: { root, context: root },
      pluginData: { eslint: {} },
    });
  }

  it("keeps target global ignores global, rebased, and re-including nested targets", () => {
    const { root, nested, actions } = workspace();
    const file = path.join(root, "meta.eslint.config.mjs");
    writeFileSync(
      file,
      renderMetaConfig(
        [
          {
            id: "nested",
            root: nested,
            config: path.join(nested, "eslint.config.mjs"),
            env: {},
          },
          { id: "root", root, config: path.join(root, "eslint.config.mjs"), env: {} },
          { id: "actions", root: actions, env: {} },
        ],
        root,
      ),
    );
    // Load it the way ESLint does (plain Node ESM), outside vite's module graph.
    const loaded = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); console.log(JSON.stringify(m.default));`,
      ],
      { encoding: "utf8" },
    );
    expect(loaded.stderr).toBe("");
    expect(JSON.parse(loaded.stdout)).toEqual([
      // Shallowest target first; its ignores never hide a nested target's root.
      {
        name: "nopo:root:global-ignores",
        ignores: [
          "**/dist/",
          "**/dist/**",
          ".legacy",
          ".legacy/**",
          "products/nested/**",
          "!products/",
          "!products/nested/**",
        ],
      },
      {
        name: "nopo:nested:global-ignores",
        ignores: [
          "products/nested/build/",
          "products/nested/build/**",
          "products/nested/generated/*.js",
          "products/nested/generated/*.js/**",
          "!products/nested/generated/keep.js",
          "!products/nested/generated/keep.js/**",
        ],
      },
      // Rule entries are scoped by `files`; root's rules skip the nested target.
      {
        name: "nopo:root",
        rules: { "no-debugger": "error" },
        files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
        ignores: ["products/nested/**"],
      },
      {
        name: "nopo:nested",
        rules: { "no-console": "warn" },
        files: ["products/nested/**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
      },
    ]);
  });

  it("root target skips its ignored dist and nested workspace; nested target lints its own files", async () => {
    const { root, nested, actions } = workspace();
    const services = {
      root: service("root", root),
      nested: service("nested", nested),
      actions: service("actions", actions),
    };
    const stderr: string[] = [];
    const results: Array<{ filePath: string; messages: Array<{ ruleId: string }> }> = [];
    /* eslint-disable @typescript-eslint/consistent-type-assertions -- minimal HookContext for a real ESLint run */
    const context = {
      payload: { targets: ["root", "nested", "actions"] },
      io: {
        env: { ...process.env },
        stdout: { write: () => true },
        stderr: { write: (chunk: string) => stderr.push(chunk) },
      },
      runner: {
        config: { root, project: { services: { entries: services } } },
        environment: { env: {}, extraEnv: {} },
        logger: { log: () => undefined },
      },
      exec: async (
        binary: string,
        args: string[],
        options: { cwd: string; env: Record<string, string> },
      ) => {
        const child = spawnSync("node", [binary, ...args], {
          cwd: options.cwd,
          env: options.env,
          encoding: "utf8",
        });
        results.push(...JSON.parse(child.stdout || "[]"));
        return {
          exitCode: child.status ?? 1,
          stdout: child.stdout,
          stderr: child.stderr,
        };
      },
    } as unknown as HookContext;
    /* eslint-enable @typescript-eslint/consistent-type-assertions */

    await expect(
      eslintPlugin({}).hooks!.lintBatch!(context),
    ).rejects.toThrow("Lint failed for root, actions");

    const linted = results
      .map((result) => path.relative(root, result.filePath).split(path.sep).join("/"))
      .sort();
    // Root's global ignores (dist/, .legacy, the nested workspace) no longer leak
    // into root's lint; the nested target applies only its own ignores, like a
    // standalone run in that workspace would (so its dist/ is still linted).
    expect(linted).toEqual([
      ".github/actions/src/main.js",
      "eslint.config.mjs",
      "products/nested/dist/index.cjs",
      "products/nested/eslint.config.mjs",
      "products/nested/generated/keep.js",
      "products/nested/src/app.js",
      "src/index.js",
    ]);
    const rules = (file: string) =>
      results
        .find((result) => result.filePath === path.join(root, file))!
        .messages.map((message) => message.ruleId);
    expect(rules("src/index.js")).toEqual(["no-debugger"]);
    // Root's no-debugger must not reach the nested workspace.
    expect(rules("products/nested/src/app.js")).toEqual(["no-console"]);
    const text = stderr.join("");
    expect(text).toContain("[eslint] root: 1 error(s), 0 warning(s) in 1 file(s)");
    expect(text).toContain("[eslint] actions: 1 error(s), 0 warning(s) in 1 file(s)");
    expect(text).toContain("[eslint] nested: 0 error(s), 3 warning(s) in 3 file(s)");
  });
});
