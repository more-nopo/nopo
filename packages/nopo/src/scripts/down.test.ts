import { describe, expect, it, vi } from "vitest";

import { serializePlan } from "../plan.ts";
import {
  executePlan,
  type HandlerDispatch,
  type PlanContext,
} from "../plan-runner.ts";
import type { HookContext } from "../plugin.ts";
import { ScriptArgs } from "../script-args.ts";
import { mockIO } from "../test-utils/mock-io.ts";
import DownScript, {
  downMain,
  type DownPhaseContext,
  downPost,
  downPre,
  type DownRunner,
} from "./down.ts";

// stubs

interface StubRunnerOverrides {
  /** What `fireOverride("down", ...)` should resolve to. Default: true. */
  overrideResult?: boolean;
  /** Optional `runtimes:` map for `resolveRuntimePlugin`. */
  runtimes?: Record<string, { plugin: string; namespace?: string }>;
}

interface StubRunner extends DownRunner {
  fireHooksCalls: Array<{ name: string; ctx: HookContext }>;
  fireOverrideCalls: Array<{
    name: string;
    ctx: HookContext;
    pluginName: string | undefined;
  }>;
}

function stubRunner(overrides: StubRunnerOverrides = {}): StubRunner {
  const fireHooksCalls: StubRunner["fireHooksCalls"] = [];
  const fireOverrideCalls: StubRunner["fireOverrideCalls"] = [];

  // Minimal NormalizedProjectConfig-shaped object: only the field resolveRuntimePlugin reads
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- intentionally narrow stub: resolveRuntimePlugin only reads `runtimes`
  const project = {
    runtimes: overrides.runtimes,
  } as unknown as DownRunner["config"]["project"];

  // Empty graph stub — handlers thread it through HookContext but tests assert on identity
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- DependencyGraph is opaque to the down handlers; passing {} keeps the stub trivial
  const graphStub = {} as unknown as HookContext["graph"];

  // Handlers spread `io` / `exec` / `shell` into the HookContext but the down phase never
  // invokes exec/shell — the throw bodies guarantee that holds.
  const ioStub = mockIO({ argv: ["nopo"], cwd: "/" });
  /* eslint-disable @typescript-eslint/consistent-type-assertions -- exec/shell return ProcessPromise / ShellTag (heavy types from lib.ts); the stub never gets called so a function that throws is sufficient */
  const contextIOStub: Pick<HookContext, "io" | "exec" | "shell"> = {
    io: ioStub,
    exec: (() => {
      throw new Error("exec stub not implemented");
    }) as unknown as HookContext["exec"],
    shell: (() => {
      throw new Error("shell stub not implemented");
    }) as unknown as HookContext["shell"],
  };
  /* eslint-enable @typescript-eslint/consistent-type-assertions */

  return {
    fireHooksCalls,
    fireOverrideCalls,
    config: { project },
    buildGraph: () => graphStub,
    contextIO: () => contextIOStub,
    fireHooks: async (name, ctx) => {
      fireHooksCalls.push({ name, ctx });
    },
    fireOverride: async (name, ctx, pluginName) => {
      fireOverrideCalls.push({ name, ctx, pluginName });
      return overrides.overrideResult ?? true;
    },
  };
}

function phaseCtx(
  overrides: { runner?: StubRunner; runtime?: string; args?: ScriptArgs } = {},
): DownPhaseContext & { runner: StubRunner } {
  const runner = overrides.runner ?? stubRunner();
  return {
    io: mockIO({ argv: ["nopo"], cwd: "/" }),
    args: overrides.args ?? new ScriptArgs({}),
    runtime: overrides.runtime ?? "default",
    runner,
  };
}

// DownScript.plan() — shape (5 tests)

describe("DownScript.plan", () => {
  it("returns three nodes with ids pre_down, down, post_down", () => {
    const plan = DownScript.plan(new ScriptArgs({}), { runtime: "default" });

    expect(plan.nodes.size).toBe(3);
    expect([...plan.nodes.keys()]).toEqual(["pre_down", "down", "post_down"]);
  });

  it("encodes the linear edge structure pre_down → down → post_down", () => {
    const plan = DownScript.plan(new ScriptArgs({}), { runtime: "default" });

    const pre = plan.nodes.get("pre_down");
    const main = plan.nodes.get("down");
    const post = plan.nodes.get("post_down");
    if (!pre || !main || !post) throw new Error("missing nodes");

    expect([...pre.needs]).toEqual([]);
    expect([...main.needs]).toEqual(["pre_down"]);
    expect([...post.needs]).toEqual(["down"]);
  });

  it("uses kind:'builtin' handlers with the down:pre / down:main / down:post names", () => {
    const plan = DownScript.plan(new ScriptArgs({}), { runtime: "default" });

    for (const [id, expectedName] of [
      ["pre_down", "down:pre"],
      ["down", "down:main"],
      ["post_down", "down:post"],
    ] as const) {
      const node = plan.nodes.get(id);
      if (!node) throw new Error(`missing ${id}`);
      if (node.handler.kind !== "builtin") {
        throw new Error(`expected builtin handler for ${id}`);
      }
      expect(node.handler.name).toBe(expectedName);
    }
  });

  it("propagates the scope's runtime into every node's meta", () => {
    const plan = DownScript.plan(new ScriptArgs({}), { runtime: "prod" });

    for (const node of plan.nodes.values()) {
      expect(node.meta?.script).toBe("down");
      expect(node.meta?.runtime).toBe("prod");
    }
  });

  it("round-trips losslessly through serializePlan + JSON", () => {
    const plan = DownScript.plan(new ScriptArgs({}), { runtime: "default" });
    const serialized = serializePlan(plan);
    const json: unknown = JSON.parse(JSON.stringify(serialized));
    expect(json).toEqual(serialized);
    expect(serialized.nodes).toHaveLength(3);
    expect(serialized.nodes.map((n) => n.id)).toEqual([
      "pre_down",
      "down",
      "post_down",
    ]);
  });
});

// downPre / downMain / downPost — handler behavior (6 tests)

describe("downPre", () => {
  it("calls runner.fireHooks('pre_down', ...) exactly once", async () => {
    const ctx = phaseCtx();
    await downPre(ctx);

    expect(ctx.runner.fireHooksCalls).toHaveLength(1);
    expect(ctx.runner.fireHooksCalls[0]?.name).toBe("pre_down");
  });

  it("threads runtime and args into the HookContext it builds", async () => {
    const args = new ScriptArgs({});
    const ctx = phaseCtx({ args, runtime: "prod" });
    await downPre(ctx);

    const hookCtx = ctx.runner.fireHooksCalls[0]?.ctx;
    expect(hookCtx?.runtime).toBe("prod");
    expect(hookCtx?.args).toBe(args);
  });
});

describe("downMain", () => {
  it("dispatches the 'down' override exactly once", async () => {
    const ctx = phaseCtx();
    await downMain(ctx);

    expect(ctx.runner.fireOverrideCalls).toHaveLength(1);
    expect(ctx.runner.fireOverrideCalls[0]?.name).toBe("down");
  });

  it("forwards the resolved plugin name when --runtime selects one", async () => {
    const args = new ScriptArgs({
      runtime: { type: "string", description: "rt", default: undefined },
    });
    args.set("runtime", "prod");
    const runner = stubRunner({
      runtimes: {
        default: { plugin: "docker-compose" },
        prod: { plugin: "kubernetes" },
      },
    });
    const ctx = phaseCtx({ runner, runtime: "prod", args });

    await downMain(ctx);

    expect(ctx.runner.fireOverrideCalls[0]?.pluginName).toBe("kubernetes");
  });

  it("throws verbatim when no plugin owns the down override", async () => {
    const runner = stubRunner({ overrideResult: false });
    const ctx = phaseCtx({ runner });

    await expect(downMain(ctx)).rejects.toThrow(
      "No plugin provides a 'down' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
  });
});

describe("downPost", () => {
  it("calls runner.fireHooks('post_down', ...) exactly once", async () => {
    const ctx = phaseCtx();
    await downPost(ctx);

    expect(ctx.runner.fireHooksCalls).toHaveLength(1);
    expect(ctx.runner.fireHooksCalls[0]?.name).toBe("post_down");
  });
});

// Runner integration tracer-bullet (2 tests)

describe("DownScript plan + executePlan integration", () => {
  it("runs pre_down → down → post_down via builtin dispatch and reports success", async () => {
    const plan = DownScript.plan(new ScriptArgs({}), { runtime: "default" });
    const runner = stubRunner();
    const args = new ScriptArgs({});
    const sharedCtx: DownPhaseContext = {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      args,
      runtime: "default",
      runner,
    };

    const order: string[] = [];

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        throw new Error("plugin-hook should not be called for down plan");
      },
      builtin: async (_node, handler) => {
        order.push(handler.name);
        switch (handler.name) {
          case "down:pre":
            return downPre(sharedCtx);
          case "down:main":
            return downMain(sharedCtx);
          case "down:post":
            return downPost(sharedCtx);
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
    expect(order).toEqual(["down:pre", "down:main", "down:post"]);
    expect(result.results.get("pre_down")?.status).toBe("success");
    expect(result.results.get("down")?.status).toBe("success");
    expect(result.results.get("post_down")?.status).toBe("success");

    // pre_down + post_down each fired their additive hook
    expect(runner.fireHooksCalls.map((c) => c.name)).toEqual([
      "pre_down",
      "post_down",
    ]);
    // down fired the override exactly once
    expect(runner.fireOverrideCalls).toHaveLength(1);
  });

  it("when fireOverride returns false: down fails, post_down is skipped, plan is not ok", async () => {
    const plan = DownScript.plan(new ScriptArgs({}), { runtime: "default" });
    const runner = stubRunner({ overrideResult: false });
    const sharedCtx: DownPhaseContext = {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      args: new ScriptArgs({}),
      runtime: "default",
      runner,
    };

    const downPostSpy = vi.fn(downPost);

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async (_node, handler) => {
        switch (handler.name) {
          case "down:pre":
            return downPre(sharedCtx);
          case "down:main":
            return downMain(sharedCtx);
          case "down:post":
            return downPostSpy(sharedCtx);
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
    expect(result.results.get("pre_down")?.status).toBe("success");
    expect(result.results.get("down")?.status).toBe("failure");
    expect(result.results.get("down")?.error?.message).toBe(
      "No plugin provides a 'down' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
    expect(result.results.get("post_down")?.status).toBe("skipped");
    expect(downPostSpy).not.toHaveBeenCalled();
  });
});
