import { describe, expect, it } from "vitest";

import type { NormalizedProjectConfig } from "../config/index.ts";
import type { DependencyGraph } from "../graph.ts";
import type { IO } from "../io.ts";
import { serializePlan } from "../plan.ts";
import {
  executePlan,
  type HandlerDispatch,
  type PlanContext,
} from "../plan-runner.ts";
import type { HookContext } from "../plugin.ts";
import { ScriptArgs } from "../script-args.ts";
import { mockIO } from "../test-utils/mock-io.ts";
import StatusScript, {
  statusMain,
  type StatusPhaseContext,
  statusPost,
  statusPre,
  type StatusRunnerLike,
} from "./status.ts";

// stubs

interface FireHooksCall {
  name: "pre_status" | "post_status";
  ctx: HookContext;
}

interface FireOverrideCall {
  name: "status";
  ctx: HookContext;
  pluginName: string | undefined;
}

interface StubRunner extends StatusRunnerLike {
  fireHooksCalls: FireHooksCall[];
  fireOverrideCalls: FireOverrideCall[];
  buildGraphCalls: number;
}

interface StubRunnerOverrides {
  /**
   * Project shape passed to `resolveRuntimePlugin`. Default: a project
   * with no `runtimes:` map, so passing an undefined runtime returns
   * `null` (no explicit plugin) and the override resolves freely.
   */
  project?: Partial<NormalizedProjectConfig>;
  /** Return value from `fireOverride`. Default: true (override fired). */
  overrideResult?: boolean;
  /** When set, `fireOverride` rejects with this error instead of returning. */
  overrideError?: Error;
  io?: IO;
}

function stubRunner(overrides: StubRunnerOverrides = {}): StubRunner {
  const io = overrides.io ?? mockIO({ argv: ["nopo"], cwd: "/" });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial project; status path only reads project.runtimes
  const project: NormalizedProjectConfig = {
    runtimes: undefined,
    plugins: [],
    ...overrides.project,
  } as unknown as NormalizedProjectConfig;

  // Minimal graph stub — handlers only thread it through HookContext; nothing in the status
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- handlers treat graph as opaque; sentinel is enough for tests
  const graph = {} as unknown as DependencyGraph;

  const runner: StubRunner = {
    fireHooksCalls: [],
    fireOverrideCalls: [],
    buildGraphCalls: 0,
    config: { project },
    buildGraph(): DependencyGraph {
      this.buildGraphCalls++;
      return graph;
    },
    contextIO() {
      return {
        io,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- exec is never invoked from the status path
        exec: (() => {
          throw new Error("exec not stubbed");
        }) as unknown as HookContext["exec"],
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- shell is never invoked from the status path
        shell: (() => {
          throw new Error("shell not stubbed");
        }) as unknown as HookContext["shell"],
      };
    },
    async fireHooks(name, ctx) {
      this.fireHooksCalls.push({ name, ctx });
    },
    async fireOverride(name, ctx, pluginName) {
      this.fireOverrideCalls.push({ name, ctx, pluginName });
      if (overrides.overrideError) throw overrides.overrideError;
      return overrides.overrideResult ?? true;
    },
  };
  return runner;
}

function phaseCtx(
  overrides: {
    runner?: StubRunner;
    args?: ScriptArgs;
    runtime?: string;
    io?: IO;
  } = {},
): StatusPhaseContext & { runner: StubRunner } {
  const io = overrides.io ?? mockIO({ argv: ["nopo"], cwd: "/" });
  return {
    io,
    args: overrides.args ?? new ScriptArgs({}),
    runtime: overrides.runtime ?? "default",
    runner: overrides.runner ?? stubRunner({ io }),
  };
}

// StatusScript.plan() — shape

describe("StatusScript.plan", () => {
  it("returns a 3-node plan with pre_status, status, post_status", () => {
    const plan = StatusScript.plan(new ScriptArgs({}), { runtime: "default" });

    expect(plan.nodes.size).toBe(3);
    expect([...plan.nodes.keys()]).toEqual([
      "pre_status",
      "status",
      "post_status",
    ]);
  });

  it("wires the pre→main→post edges via `needs`", () => {
    const plan = StatusScript.plan(new ScriptArgs({}), { runtime: "default" });

    const pre = plan.nodes.get("pre_status");
    const main = plan.nodes.get("status");
    const post = plan.nodes.get("post_status");
    if (pre === undefined || main === undefined || post === undefined) {
      throw new Error("expected all 3 nodes present");
    }
    expect([...pre.needs]).toEqual([]);
    expect([...main.needs]).toEqual(["pre_status"]);
    expect([...post.needs]).toEqual(["status"]);
  });

  it("uses builtin handlers with status:pre / status:main / status:post names", () => {
    const plan = StatusScript.plan(new ScriptArgs({}), { runtime: "default" });

    for (const [id, expectedName] of [
      ["pre_status", "status:pre"],
      ["status", "status:main"],
      ["post_status", "status:post"],
    ] as const) {
      const node = plan.nodes.get(id);
      if (node === undefined) throw new Error(`missing node ${id}`);
      if (node.handler.kind !== "builtin") {
        throw new Error(
          `node ${id} expected builtin, got ${node.handler.kind}`,
        );
      }
      expect(node.handler.name).toBe(expectedName);
    }
  });

  it("threads the scope.runtime onto every node's meta", () => {
    const plan = StatusScript.plan(new ScriptArgs({}), { runtime: "prod" });

    for (const node of plan.nodes.values()) {
      expect(node.meta?.script).toBe("status");
      expect(node.meta?.runtime).toBe("prod");
    }
  });

  it("serializePlan round-trips the status plan losslessly", () => {
    const plan = StatusScript.plan(new ScriptArgs({}), { runtime: "default" });
    const serialized = serializePlan(plan);
    const json: unknown = JSON.parse(JSON.stringify(serialized));
    expect(json).toEqual(serialized);
    expect(serialized.nodes).toHaveLength(3);
    expect(serialized.nodes.map((n) => n.id)).toEqual([
      "pre_status",
      "status",
      "post_status",
    ]);
    expect(serialized.nodes[1]).toMatchObject({
      id: "status",
      handler: { kind: "builtin", name: "status:main" },
      needs: ["pre_status"],
      meta: { script: "status", runtime: "default" },
    });
  });
});

// statusPre / statusMain / statusPost — behavior

describe("statusPre", () => {
  it("calls runner.fireHooks('pre_status', ...) exactly once", async () => {
    const ctx = phaseCtx();
    await statusPre(ctx);
    expect(ctx.runner.fireHooksCalls).toHaveLength(1);
    expect(ctx.runner.fireHooksCalls[0]?.name).toBe("pre_status");
    expect(ctx.runner.fireOverrideCalls).toHaveLength(0);
  });

  it("threads runtime + args onto the HookContext", async () => {
    const args = new ScriptArgs({});
    const ctx = phaseCtx({ runtime: "prod", args });
    await statusPre(ctx);
    const hookCtx = ctx.runner.fireHooksCalls[0]?.ctx;
    if (hookCtx === undefined) throw new Error("expected hook ctx");
    expect(hookCtx.runtime).toBe("prod");
    expect(hookCtx.args).toBe(args);
  });
});

describe("statusMain", () => {
  it("calls runner.fireOverride('status', ...) exactly once on the happy path", async () => {
    const ctx = phaseCtx();
    await statusMain(ctx);
    expect(ctx.runner.fireOverrideCalls).toHaveLength(1);
    expect(ctx.runner.fireOverrideCalls[0]?.name).toBe("status");
    expect(ctx.runner.fireHooksCalls).toHaveLength(0);
  });

  it("forwards the resolved plugin name when --runtime is mapped", async () => {
    // Project with a `runtimes:` map: prod → docker-compose.
    const runner = stubRunner({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial project; only runtimes matters here
      project: {
        runtimes: { prod: { plugin: "docker-compose" } },
      } as Partial<NormalizedProjectConfig>,
    });
    const args = new ScriptArgs({
      runtime: { type: "string", description: "runtime", default: undefined },
    });
    args.set("runtime", "prod");
    await statusMain(phaseCtx({ runner, args, runtime: "prod" }));
    expect(runner.fireOverrideCalls[0]?.pluginName).toBe("docker-compose");
  });

  it("throws verbatim when fireOverride returns false", async () => {
    const runner = stubRunner({ overrideResult: false });
    await expect(statusMain(phaseCtx({ runner }))).rejects.toThrow(
      "No plugin provides a 'status' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
  });
});

describe("statusPost", () => {
  it("calls runner.fireHooks('post_status', ...) exactly once", async () => {
    const ctx = phaseCtx();
    await statusPost(ctx);
    expect(ctx.runner.fireHooksCalls).toHaveLength(1);
    expect(ctx.runner.fireHooksCalls[0]?.name).toBe("post_status");
    expect(ctx.runner.fireOverrideCalls).toHaveLength(0);
  });
});

// Runner integration — executePlan + dispatch tracer-bullet

describe("StatusScript plan + executePlan integration", () => {
  it("dispatches all 3 phases in topological order via the builtin table", async () => {
    const plan = StatusScript.plan(new ScriptArgs({}), { runtime: "default" });
    const runner = stubRunner();
    const args = new ScriptArgs({});
    const ctx: StatusPhaseContext = {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      args,
      runtime: "default",
      runner,
    };

    const dispatched: string[] = [];
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        throw new Error("plugin-hook should not fire for status plan");
      },
      builtin: async (_node, handler) => {
        dispatched.push(handler.name);
        switch (handler.name) {
          case "status:pre":
            await statusPre(ctx);
            return;
          case "status:main":
            await statusMain(ctx);
            return;
          case "status:post":
            await statusPost(ctx);
            return;
          default:
            throw new Error(`unexpected builtin: ${handler.name}`);
        }
      },
    };

    const planCtx: PlanContext = {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      dispatch,
    };
    const result = await executePlan(plan, planCtx);

    expect(result.ok).toBe(true);
    expect(dispatched).toEqual(["status:pre", "status:main", "status:post"]);
    expect(result.results.get("pre_status")?.status).toBe("success");
    expect(result.results.get("status")?.status).toBe("success");
    expect(result.results.get("post_status")?.status).toBe("success");
    expect(runner.fireHooksCalls.map((c) => c.name)).toEqual([
      "pre_status",
      "post_status",
    ]);
    expect(runner.fireOverrideCalls).toHaveLength(1);
  });

  it("fails the status node and skips post_status when fireOverride returns false", async () => {
    const plan = StatusScript.plan(new ScriptArgs({}), { runtime: "default" });
    const runner = stubRunner({ overrideResult: false });
    const ctx: StatusPhaseContext = {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      args: new ScriptArgs({}),
      runtime: "default",
      runner,
    };

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async (_node, handler) => {
        switch (handler.name) {
          case "status:pre":
            await statusPre(ctx);
            return;
          case "status:main":
            await statusMain(ctx);
            return;
          case "status:post":
            await statusPost(ctx);
            return;
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
    expect(result.results.get("pre_status")?.status).toBe("success");
    const mainResult = result.results.get("status");
    expect(mainResult?.status).toBe("failure");
    expect(mainResult?.error?.message).toBe(
      "No plugin provides a 'status' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
    const postResult = result.results.get("post_status");
    expect(postResult?.status).toBe("skipped");
    expect(postResult?.skippedDueTo).toBe("status");
  });
});
