import { describe, expect, it, vi } from "vitest";

import type { DependencyGraph } from "../graph.ts";
import { serializePlan } from "../plan.ts";
import {
  executePlan,
  type HandlerDispatch,
  type PlanContext,
} from "../plan-runner.ts";
import type { HookContext } from "../plugin.ts";
import { ScriptArgs } from "../script-args.ts";
import { mockIO } from "../test-utils/mock-io.ts";
import UpScript, {
  upMain,
  type UpPhaseContext,
  type UpPlanScope,
  upPost,
  upPre,
  type UpRunner,
} from "./up.ts";

// stubs

interface StubRunner extends UpRunner {
  hookCalls: Array<{ name: string; ctx: HookContext }>;
  overrideCalls: Array<{
    name: string;
    ctx: HookContext;
    pluginName: string | undefined;
  }>;
  /** When set, fireOverride returns this value instead of `true`. */
  overrideReturns: boolean;
}

function stubRunner(overrides: { overrideReturns?: boolean } = {}): StubRunner {
  const runner: StubRunner = {
    hookCalls: [],
    overrideCalls: [],
    overrideReturns: overrides.overrideReturns ?? true,
    async fireHooks(name, ctx) {
      runner.hookCalls.push({ name, ctx });
    },
    async fireOverride(name, ctx, pluginName) {
      runner.overrideCalls.push({ name, ctx, pluginName });
      return runner.overrideReturns;
    },
  };
  return runner;
}

/**
 * Minimal `DependencyGraph` stand-in. The handlers only forward this
 * reference into the `HookContext.graph` field; nothing reads its
 * methods here, so a sentinel object is sufficient.
 */
function stubGraph(): DependencyGraph {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- handlers treat graph as opaque; sentinel is enough for tests
  return { __stub: "graph" } as unknown as DependencyGraph;
}

function stubContextIO(): Pick<HookContext, "io" | "exec" | "shell"> {
  const io = mockIO({ argv: ["nopo"], cwd: "/" });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- exec/shell are sentinels — handlers only forward them
  const exec = (() => {
    throw new Error("exec stub: not invoked in these tests");
  }) as unknown as HookContext["exec"];
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- exec/shell are sentinels — handlers only forward them
  const shell = (() => {
    throw new Error("shell stub: not invoked in these tests");
  }) as unknown as HookContext["shell"];
  return { io, exec, shell };
}

function makePhaseCtx(
  overrides: {
    runner?: StubRunner;
    args?: ScriptArgs;
    graph?: DependencyGraph;
    runtime?: string;
    pluginName?: string | undefined;
  } = {},
): UpPhaseContext & { runner: StubRunner } {
  return {
    runner: overrides.runner ?? stubRunner(),
    args: overrides.args ?? new ScriptArgs({}),
    graph: overrides.graph ?? stubGraph(),
    runtime: overrides.runtime ?? "default",
    pluginName: overrides.pluginName,
    contextIO: stubContextIO(),
  };
}

// UpScript.plan() — shape

describe("UpScript.plan", () => {
  it("returns exactly 3 nodes with ids pre_up, up, post_up", () => {
    const plan = UpScript.plan(new ScriptArgs({}), {
      runtime: "default",
    } satisfies UpPlanScope);

    expect(plan.nodes.size).toBe(3);
    expect([...plan.nodes.keys()]).toEqual(["pre_up", "up", "post_up"]);
  });

  it("wires the linear chain: up.needs=[pre_up], post_up.needs=[up]", () => {
    const plan = UpScript.plan(new ScriptArgs({}), {
      runtime: "default",
    } satisfies UpPlanScope);

    const preUp = plan.nodes.get("pre_up");
    const up = plan.nodes.get("up");
    const postUp = plan.nodes.get("post_up");
    if (!preUp || !up || !postUp) throw new Error("missing node");

    expect([...preUp.needs]).toEqual([]);
    expect([...up.needs]).toEqual(["pre_up"]);
    expect([...postUp.needs]).toEqual(["up"]);
  });

  it("uses builtin handlers named up:pre, up:main, up:post", () => {
    const plan = UpScript.plan(new ScriptArgs({}), {
      runtime: "default",
    } satisfies UpPlanScope);

    for (const [id, expectedName] of [
      ["pre_up", "up:pre"],
      ["up", "up:main"],
      ["post_up", "up:post"],
    ] as const) {
      const node = plan.nodes.get(id);
      if (!node) throw new Error(`missing node ${id}`);
      if (node.handler.kind !== "builtin") {
        throw new Error(`expected builtin handler, got ${node.handler.kind}`);
      }
      expect(node.handler.name).toBe(expectedName);
    }
  });

  it("echoes scope.runtime onto every node's meta.runtime", () => {
    const plan = UpScript.plan(new ScriptArgs({}), { runtime: "prod" });

    for (const node of plan.nodes.values()) {
      expect(node.meta?.script).toBe("up");
      expect(node.meta?.runtime).toBe("prod");
    }
  });

  it("is callable without a Runner (pure function of args + scope)", () => {
    // Static method — no `this` binding required.
    const fn = UpScript.plan;
    expect(() => fn(new ScriptArgs({}), { runtime: "default" })).not.toThrow();
  });

  it("serializePlan round-trips the up plan losslessly", () => {
    const plan = UpScript.plan(new ScriptArgs({}), {
      runtime: "default",
    } satisfies UpPlanScope);
    const serialized = serializePlan(plan);
    const json: unknown = JSON.parse(JSON.stringify(serialized));
    expect(json).toEqual(serialized);

    expect(serialized.nodes).toHaveLength(3);
    expect(serialized.nodes[0]).toMatchObject({
      id: "pre_up",
      handler: { kind: "builtin", name: "up:pre" },
      needs: [],
      meta: { script: "up", runtime: "default" },
    });
    expect(serialized.nodes[1]).toMatchObject({
      id: "up",
      handler: { kind: "builtin", name: "up:main" },
      needs: ["pre_up"],
    });
    expect(serialized.nodes[2]).toMatchObject({
      id: "post_up",
      handler: { kind: "builtin", name: "up:post" },
      needs: ["up"],
    });
  });
});

// upPre / upMain / upPost — behavior

describe("upPre", () => {
  it("calls runner.fireHooks('pre_up', hookCtx) exactly once", async () => {
    const runner = stubRunner();
    const ctx = makePhaseCtx({ runner });
    await upPre(ctx);
    expect(runner.hookCalls).toHaveLength(1);
    expect(runner.hookCalls[0]?.name).toBe("pre_up");
    expect(runner.overrideCalls).toHaveLength(0);
  });

  it("forwards runtime and args onto the HookContext", async () => {
    const runner = stubRunner();
    const args = new ScriptArgs({});
    const ctx = makePhaseCtx({ runner, runtime: "prod", args });
    await upPre(ctx);
    const passed = runner.hookCalls[0]?.ctx;
    if (!passed) throw new Error("expected hookCtx");
    expect(passed.runtime).toBe("prod");
    expect(passed.args).toBe(args);
  });
});

describe("upMain", () => {
  it("calls runner.fireOverride('up', hookCtx, pluginName) exactly once", async () => {
    const runner = stubRunner();
    const ctx = makePhaseCtx({ runner, pluginName: "docker-compose" });
    await upMain(ctx);
    expect(runner.overrideCalls).toHaveLength(1);
    expect(runner.overrideCalls[0]?.name).toBe("up");
    expect(runner.overrideCalls[0]?.pluginName).toBe("docker-compose");
    expect(runner.hookCalls).toHaveLength(0);
  });

  it("forwards undefined pluginName when scope has no resolved runtime plugin", async () => {
    const runner = stubRunner();
    const ctx = makePhaseCtx({ runner, pluginName: undefined });
    await upMain(ctx);
    expect(runner.overrideCalls[0]?.pluginName).toBeUndefined();
  });

  it("throws the legacy 'No plugin provides...' error verbatim when fireOverride returns false", async () => {
    const runner = stubRunner({ overrideReturns: false });
    const ctx = makePhaseCtx({ runner });
    await expect(upMain(ctx)).rejects.toThrow(
      "No plugin provides an 'up' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
  });
});

describe("upPost", () => {
  it("calls runner.fireHooks('post_up', hookCtx) exactly once", async () => {
    const runner = stubRunner();
    const ctx = makePhaseCtx({ runner });
    await upPost(ctx);
    expect(runner.hookCalls).toHaveLength(1);
    expect(runner.hookCalls[0]?.name).toBe("post_up");
    expect(runner.overrideCalls).toHaveLength(0);
  });

  it("forwards runtime onto the HookContext", async () => {
    const runner = stubRunner();
    const ctx = makePhaseCtx({ runner, runtime: "staging" });
    await upPost(ctx);
    expect(runner.hookCalls[0]?.ctx.runtime).toBe("staging");
  });
});

// Plan + executePlan integration tracer-bullet

describe("UpScript plan + executePlan integration", () => {
  it("dispatches all three phases in order via the builtin dispatch table", async () => {
    const plan = UpScript.plan(new ScriptArgs({}), {
      runtime: "default",
    } satisfies UpPlanScope);
    const runner = stubRunner();
    const phaseCtx = makePhaseCtx({
      runner,
      pluginName: "docker-compose",
    });

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        throw new Error("plugin-hook should not be called for up plan");
      },
      builtin: async (_node, handler) => {
        switch (handler.name) {
          case "up:pre":
            return await upPre(phaseCtx);
          case "up:main":
            return await upMain(phaseCtx);
          case "up:post":
            return await upPost(phaseCtx);
          default:
            throw new Error(`unexpected builtin: ${handler.name}`);
        }
      },
    };

    const ctx: PlanContext = {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      dispatch,
    };

    const result = await executePlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.results.get("pre_up")?.status).toBe("success");
    expect(result.results.get("up")?.status).toBe("success");
    expect(result.results.get("post_up")?.status).toBe("success");

    // Each phase fired exactly once on the stubbed runner.
    expect(runner.hookCalls.map((c) => c.name)).toEqual(["pre_up", "post_up"]);
    expect(runner.overrideCalls).toHaveLength(1);
    expect(runner.overrideCalls[0]?.name).toBe("up");
    expect(runner.overrideCalls[0]?.pluginName).toBe("docker-compose");
  });

  it("when fireOverride returns false the up node fails and post_up is skipped", async () => {
    const plan = UpScript.plan(new ScriptArgs({}), {
      runtime: "default",
    } satisfies UpPlanScope);
    const runner = stubRunner({ overrideReturns: false });
    const phaseCtx = makePhaseCtx({ runner });

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async (_node, handler) => {
        switch (handler.name) {
          case "up:pre":
            return await upPre(phaseCtx);
          case "up:main":
            return await upMain(phaseCtx);
          case "up:post":
            return await upPost(phaseCtx);
          default:
            throw new Error(`unexpected builtin: ${handler.name}`);
        }
      },
    };

    const result = await executePlan(plan, {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      dispatch,
    });

    expect(result.ok).toBe(false);
    expect(result.results.get("pre_up")?.status).toBe("success");
    const upResult = result.results.get("up");
    expect(upResult?.status).toBe("failure");
    expect(upResult?.error?.message).toBe(
      "No plugin provides an 'up' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
    // keep-going default → post_up is skipped because its only dep failed.
    const postResult = result.results.get("post_up");
    expect(postResult?.status).toBe("skipped");
    expect(postResult?.skippedDueTo).toBe("up");

    // post_up's hook never fired.
    expect(runner.hookCalls.map((c) => c.name)).toEqual(["pre_up"]);
  });

  it("emits node-success events for every phase on the happy path", async () => {
    const plan = UpScript.plan(new ScriptArgs({}), {
      runtime: "default",
    } satisfies UpPlanScope);
    const runner = stubRunner();
    const phaseCtx = makePhaseCtx({ runner });
    const events: string[] = [];

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async (_node, handler) => {
        switch (handler.name) {
          case "up:pre":
            return await upPre(phaseCtx);
          case "up:main":
            return await upMain(phaseCtx);
          case "up:post":
            return await upPost(phaseCtx);
          default:
            throw new Error(`unexpected builtin: ${handler.name}`);
        }
      },
    };

    const onEvent = vi.fn((event: { type: string; nodeId?: string }) => {
      if (event.type === "node-success" && event.nodeId !== undefined) {
        events.push(event.nodeId);
      }
    });

    const result = await executePlan(plan, {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      dispatch,
      onEvent,
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual(["pre_up", "up", "post_up"]);
  });
});
