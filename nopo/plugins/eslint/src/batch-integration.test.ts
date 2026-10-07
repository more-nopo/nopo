/** End-to-end integration of the eslint plugin's plan batch path:
 * CommandScript.plan() → N `cmd:*:*:lint` command:exec nodes
 * ↓ compactPlan(eslint BatchSpec)
 * 1 `eslint:batch` plugin-hook node (claimed eslint-delegated targets)
 * + non-eslint command:exec nodes left intact
 * ↓ executePlan eslint lintBatch hook called exactly once with the claimed target list
 */

import type { NormalizedService } from "@more-nopo/nopo/config";
import type { Plan, PlanHandler, PlanNode } from "@more-nopo/nopo/plan";
import type { CompactionContext } from "@more-nopo/nopo/plan-compact";
import { compactPlan } from "@more-nopo/nopo/plan-compact";
import type { HookContext, LoadedPlugin } from "@more-nopo/nopo/plugin";
import type { ScriptArgs } from "@more-nopo/nopo/script-args";
import { describe, expect, it } from "vitest";

import eslintPlugin, { isEslintCommandExecNode } from "./index.ts";

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
