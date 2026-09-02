import { describe, expect, it, vi } from "vitest";

import type { ResolvedCommand } from "../commands/index.ts";
import { serializePlan } from "../plan.ts";
import {
  executePlan,
  type HandlerDispatch,
  type PlanContext,
} from "../plan-runner.ts";
import { ScriptArgs } from "../script-args.ts";
import { mockIO } from "../test-utils/mock-io.ts";
import CommandScript, {
  commandExec,
  type CommandExecContext,
  type CommandExecPayload,
  type CommandPlanScope,
  commandPost,
  type CommandPostContext,
  commandPre,
  type CommandPreContext,
  type CommandStage,
} from "./command.ts";

// helpers

function task(service: string, command: string): ResolvedCommand {
  return { service, command, executable: `echo ${service}:${command}` };
}

function makeStage(index: number, tasks: ResolvedCommand[]): CommandStage {
  return { index, tasks };
}

function makeArgs(): ScriptArgs {
  return new ScriptArgs({});
}

function makeCtx(dispatch: HandlerDispatch): PlanContext {
  return {
    io: mockIO({ argv: ["nopo"], cwd: "/" }),
    dispatch,
  };
}

function payloadOf(
  node: { payload?: unknown } | undefined,
): CommandExecPayload {
  if (!node) throw new Error("missing node");
  // Plan nodes carry an unknown payload; tests narrow with the script's own type.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- payload contract owned by command.ts
  return node.payload as CommandExecPayload;
}

interface PrePayload {
  commandName: string;
  targets: string[];
  stageCount: number;
}

function prePayloadOf(node: { payload?: unknown } | undefined): PrePayload {
  if (!node) throw new Error("missing node");
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- pre payload contract owned by command.ts
  return node.payload as PrePayload;
}

// plan shape

describe("CommandScript.plan — shape", () => {
  it("emits pre + post when stages are empty", () => {
    const scope: CommandPlanScope = {
      targets: [],
      commandName: "lint",
      stages: [],
    };
    const plan = CommandScript.plan(makeArgs(), scope);

    expect(plan.nodes.size).toBe(2);
    expect([...plan.nodes.keys()].sort()).toEqual([
      "post_command",
      "pre_command",
    ]);

    const post = plan.nodes.get("post_command");
    expect(post?.needs).toEqual(["pre_command"]);
  });

  it("emits 3 nodes for a single stage with one task", () => {
    const scope: CommandPlanScope = {
      targets: ["a"],
      commandName: "lint",
      stages: [makeStage(0, [task("a", "lint")])],
    };
    const plan = CommandScript.plan(makeArgs(), scope);

    expect(plan.nodes.size).toBe(3);
    expect(plan.nodes.has("pre_command")).toBe(true);
    expect(plan.nodes.has("cmd:0:a:lint")).toBe(true);
    expect(plan.nodes.has("post_command")).toBe(true);

    const cmd = plan.nodes.get("cmd:0:a:lint");
    expect(cmd?.needs).toEqual(["pre_command"]);
    expect(cmd?.target).toBe("a");
    expect(cmd?.handler).toEqual({ kind: "builtin", name: "command:exec" });
  });

  it("chains stages: stage1 nodes need every stage0 node", () => {
    const scope: CommandPlanScope = {
      targets: ["a", "b"],
      commandName: "test",
      stages: [
        makeStage(0, [task("a", "test"), task("b", "test")]),
        makeStage(1, [task("a", "test:e2e"), task("b", "test:e2e")]),
      ],
    };
    const plan = CommandScript.plan(makeArgs(), scope);

    expect(plan.nodes.size).toBe(6); // pre + 2 + 2 + post

    const stage1a = plan.nodes.get("cmd:1:a:test:e2e");
    expect(stage1a?.needs).toEqual(
      expect.arrayContaining(["cmd:0:a:test", "cmd:0:b:test"]),
    );
    expect(stage1a?.needs.length).toBe(2);

    const post = plan.nodes.get("post_command");
    expect(post?.needs).toEqual(
      expect.arrayContaining([
        "cmd:0:a:test",
        "cmd:0:b:test",
        "cmd:1:a:test:e2e",
        "cmd:1:b:test:e2e",
      ]),
    );
    expect(post?.needs.length).toBe(4);
  });

  it("per-cmd payload carries commandName + stageIndex + task", () => {
    const t = task("svc-x", "lint");
    const scope: CommandPlanScope = {
      targets: ["svc-x"],
      commandName: "lint",
      stages: [makeStage(0, [t])],
    };
    const plan = CommandScript.plan(makeArgs(), scope);

    const node = plan.nodes.get("cmd:0:svc-x:lint");
    const payload = payloadOf(node);
    expect(payload.commandName).toBe("lint");
    expect(payload.stageIndex).toBe(0);
    expect(payload.task).toEqual(t);
  });

  it("pre node payload carries scope echo (commandName, targets, stageCount)", () => {
    const scope: CommandPlanScope = {
      targets: ["a", "b", "c"],
      commandName: "build",
      stages: [makeStage(0, [task("a", "build")])],
    };
    const plan = CommandScript.plan(makeArgs(), scope);

    const pre = plan.nodes.get("pre_command");
    const payload = prePayloadOf(pre);
    expect(payload.commandName).toBe("build");
    expect(payload.targets).toEqual(["a", "b", "c"]);
    expect(payload.stageCount).toBe(1);
  });

  it("empty stage between non-empty stages preserves predecessor gating", () => {
    const scope: CommandPlanScope = {
      targets: ["a"],
      commandName: "lint",
      stages: [
        makeStage(0, [task("a", "lint")]),
        makeStage(1, []),
        makeStage(2, [task("a", "lint:fix")]),
      ],
    };
    const plan = CommandScript.plan(makeArgs(), scope);

    const stage2 = plan.nodes.get("cmd:2:a:lint:fix");
    // Empty stage 1 doesn't bypass stage 0 — stage 2 still needs stage 0.
    expect(stage2?.needs).toEqual(["cmd:0:a:lint"]);
  });

  it("plan is callable without a Runner (pure static)", () => {
    expect(() =>
      CommandScript.plan(makeArgs(), {
        targets: [],
        commandName: "x",
        stages: [],
      }),
    ).not.toThrow();
  });

  it("serializePlan round-trips a multi-stage plan", () => {
    const scope: CommandPlanScope = {
      targets: ["a", "b"],
      commandName: "test",
      stages: [
        makeStage(0, [task("a", "test"), task("b", "test")]),
        makeStage(1, [task("a", "test:e2e")]),
      ],
    };
    const plan = CommandScript.plan(makeArgs(), scope);
    const round = JSON.parse(JSON.stringify(serializePlan(plan)));
    expect(round.nodes.length).toBe(plan.nodes.size);
  });
});

// handlers

describe("commandPre / commandExec / commandPost", () => {
  it("commandPre logs the announce + execution-plan lines", async () => {
    const lines: string[] = [];
    const ctx: CommandPreContext = {
      commandName: "lint",
      targets: ["a", "b"],
      stageCount: 2,
      logger: { log: (...a) => lines.push(a.join(" ")) },
    };
    await commandPre(ctx);
    expect(lines).toEqual([
      "Executing lint across a, b",
      "Execution plan: 2 stage(s)",
    ]);
  });

  it("commandExec delegates to runTask with the payload", async () => {
    const runTask = vi.fn(async () => {});
    const payload: CommandExecPayload = {
      commandName: "lint",
      stageIndex: 0,
      task: task("a", "lint"),
    };
    const ctx: CommandExecContext = { payload, runTask };
    await commandExec(ctx);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledWith(payload);
  });

  it("commandExec propagates runTask errors", async () => {
    const runTask = vi.fn(async () => {
      throw new Error("task blew up");
    });
    const payload: CommandExecPayload = {
      commandName: "lint",
      stageIndex: 0,
      task: task("a", "lint"),
    };
    await expect(commandExec({ payload, runTask })).rejects.toThrow(
      "task blew up",
    );
  });

  it("commandPost is a no-op (tracer-bullet)", async () => {
    const lines: string[] = [];
    const ctx: CommandPostContext = {
      commandName: "lint",
      logger: { log: (...a) => lines.push(a.join(" ")) },
    };
    await expect(commandPost(ctx)).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });
});

// runner integration tracer bullet

describe("CommandScript — executePlan tracer bullet", () => {
  it("runs pre, every cmd in stage order, then post — all success", async () => {
    const scope: CommandPlanScope = {
      targets: ["a", "b"],
      commandName: "lint",
      stages: [
        makeStage(0, [task("a", "lint"), task("b", "lint")]),
        makeStage(1, [task("a", "lint:fix")]),
      ],
    };
    const plan = CommandScript.plan(makeArgs(), scope);

    const preCalls: number[] = [];
    const execCalls: CommandExecPayload[] = [];
    const postCalls: number[] = [];

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        throw new Error("no plugin-hook nodes expected");
      },
      builtin: async (node, handler) => {
        if (handler.name === "command:pre") {
          preCalls.push(1);
          return;
        }
        if (handler.name === "command:exec") {
          await commandExec({
            payload: payloadOf(node),
            runTask: async (p) => {
              execCalls.push(p);
            },
          });
          return;
        }
        if (handler.name === "command:post") {
          postCalls.push(1);
          return;
        }
        throw new Error(`unknown builtin: ${handler.name}`);
      },
    };

    const result = await executePlan(plan, makeCtx(dispatch));
    expect(result.ok).toBe(true);
    expect(preCalls).toEqual([1]);
    expect(postCalls).toEqual([1]);
    expect(execCalls.length).toBe(3);
    expect(
      execCalls
        .map((p) => `${p.stageIndex}:${p.task.service}:${p.task.command}`)
        .sort(),
    ).toEqual(["0:a:lint", "0:b:lint", "1:a:lint:fix"]);
  });

  it("runTask failure → that cmd fails, downstream skipped, ok=false", async () => {
    const scope: CommandPlanScope = {
      targets: ["a"],
      commandName: "lint",
      stages: [
        makeStage(0, [task("a", "lint")]),
        makeStage(1, [task("a", "lint:fix")]),
      ],
    };
    const plan = CommandScript.plan(makeArgs(), scope);

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async (node, handler) => {
        if (handler.name === "command:exec") {
          const p = payloadOf(node);
          if (p.stageIndex === 0) throw new Error("stage0 boom");
          // never reached
        }
      },
    };

    const result = await executePlan(plan, makeCtx(dispatch));
    expect(result.ok).toBe(false);

    const stage0 = result.results.get("cmd:0:a:lint");
    const stage1 = result.results.get("cmd:1:a:lint:fix");
    const post = result.results.get("post_command");

    expect(stage0?.status).toBe("failure");
    expect(stage1?.status).toBe("skipped");
    expect(post?.status).toBe("skipped");
  });
});
