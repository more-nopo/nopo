import { describe, expect, it, vi } from "vitest";

import { buildDispatch } from "./dispatch.ts";
import type { IO } from "./io.ts";
import type { Runner } from "./lib.ts";
import type { PlanHandler, PlanNode } from "./plan.ts";
import type { PlanContext } from "./plan-runner.ts";
import type { HookContext } from "./plugin.ts";
import type { BuildExecPayload } from "./scripts/build.ts";
import type { CommandExecPayload } from "./scripts/command.ts";
import { mockIO } from "./test-utils/mock-io.ts";

// stubs

interface StubRunnerOptions {
  /** Override fireOverride return value (default: true). */
  overrideReturns?: boolean;
  /** Optional resolved targets for build:* nodes. */
  resolvedTargets?: string[];
  /** Optional `runtimes:` map for resolveRuntimePlugin. */
  runtimes?: Record<string, { plugin: string; namespace?: string }>;
  /** argv passed to mockIO; ScriptArgs reads `runner` for `runtime` arg. */
  argv?: string[];
}

interface StubRunner {
  fireHooksCalls: Array<{ name: string; ctx: HookContext }>;
  fireOverrideCalls: Array<{
    name: string;
    ctx: HookContext;
    pluginName: string | undefined;
  }>;
  /** Calls to environment.save() — used by env:apply. */
  envSaveCalls: number;
  /** Lines passed to logger.log — used by command:pre. */
  loggerLines: string[];
  runner: Runner;
}

function stubRunner(options: StubRunnerOptions = {}): StubRunner {
  const fireHooksCalls: StubRunner["fireHooksCalls"] = [];
  const fireOverrideCalls: StubRunner["fireOverrideCalls"] = [];
  let envSaveCalls = 0;
  const loggerLines: string[] = [];

  const io: IO = mockIO({ argv: options.argv ?? ["nopo"], cwd: "/" });

  // Minimal Environment surface used by env:apply
  const environment = {
    envFile: "/tmp/.env",
    hasPrevEnv: false,
    diff: { added: [], updated: [], removed: [], unchanged: [] },
    env: {},
    extraEnv: {},
    processEnv: {},
    save() {
      envSaveCalls++;
    },
  };

  // Identity chalk so log output is readable
  const id = (...a: unknown[]) => a.map((x) => String(x)).join("");
  const chalk = {
    magenta: id,
    yellow: id,
    white: id,
    red: id,
    gray: id,
    underline: id,
    cyan: id,
  };

  const logger = {
    chalk,
    log(...args: unknown[]) {
      loggerLines.push(args.map((a) => String(a)).join(" "));
    },
    error(..._args: unknown[]) {},
  };

  // Minimal NormalizedProjectConfig — only `runtimes` is consumed by
  // resolveRuntimePlugin; everything else is sentinel.
  const project = {
    runtimes: options.runtimes,
    services: { entries: {}, targets: [] },
  };

  const config = {
    project,
    root: "/tmp",
    targets: [],
    silent: true,
  };

  const graph = { __stub: "graph" };

  const overrideReturns = options.overrideReturns ?? true;

  const contextIOBag = {
    io,
    exec: () => {
      throw new Error("exec stub: not invoked in dispatch tests");
    },
    shell: () => {
      throw new Error("shell stub: not invoked in dispatch tests");
    },
  };

  const runnerObj = {
    io,
    argv: options.argv ?? ["nopo"],
    config,
    environment,
    logger,
    resolvedTargets: options.resolvedTargets ?? null,
    buildGraph: () => graph,
    contextIO: () => contextIOBag,
    fireHooks: async (name: string, ctx: HookContext) => {
      fireHooksCalls.push({ name, ctx });
    },
    fireOverride: async (
      name: string,
      ctx: HookContext,
      pluginName?: string,
    ) => {
      fireOverrideCalls.push({ name, ctx, pluginName });
      return overrideReturns;
    },
  };

  /* eslint-disable @typescript-eslint/consistent-type-assertions -- tests assemble a partial Runner shape; the dispatch module reads only the fields stubbed above. Same convention used in env.test.ts / up.test.ts. */
  const runner = runnerObj as unknown as Runner;
  /* eslint-enable @typescript-eslint/consistent-type-assertions */

  return {
    fireHooksCalls,
    fireOverrideCalls,
    get envSaveCalls() {
      return envSaveCalls;
    },
    loggerLines,
    runner,
  };
}

function makeNode(
  name: string,
  payload?: unknown,
): { node: PlanNode; handler: Extract<PlanHandler, { kind: "builtin" }> } {
  const handler: Extract<PlanHandler, { kind: "builtin" }> = {
    kind: "builtin",
    name,
  };
  const node: PlanNode = {
    id: name,
    handler,
    needs: [],
    ...(payload !== undefined ? { payload } : {}),
  };
  return { node, handler };
}

function fakePlanCtx(): PlanContext {
  return {
    io: mockIO({ argv: ["nopo"], cwd: "/" }),
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- tests don't recurse through dispatch.dispatch; sentinel is enough */
    dispatch: {} as unknown as PlanContext["dispatch"],
  };
}

async function dispatch(
  stub: StubRunner,
  name: string,
  payload?: unknown,
): Promise<void> {
  const dispatchTable = buildDispatch(stub.runner);
  const { node, handler } = makeNode(name, payload);
  await dispatchTable.builtin(node, handler, fakePlanCtx());
}

// env:apply

describe("buildDispatch — env:apply", () => {
  it("calls environment.save() once", async () => {
    const stub = stubRunner();
    await dispatch(stub, "env:apply");
    expect(stub.envSaveCalls).toBe(1);
  });
});

// build:pre / build:exec / build:post

describe("buildDispatch — build:pre", () => {
  it("fires the pre_build hook on the runner", async () => {
    const stub = stubRunner();
    await dispatch(stub, "build:pre");
    expect(stub.fireHooksCalls.map((c) => c.name)).toEqual(["pre_build"]);
  });
});

describe("buildDispatch — build:exec", () => {
  it("calls fireOverride('build', ...) when no plugin claims (returns false)", async () => {
    const stub = stubRunner({ overrideReturns: false });
    const payload: BuildExecPayload = { target: "svc", noCache: false };
    await dispatch(stub, "build:exec", payload);
    expect(stub.fireOverrideCalls.map((c) => c.name)).toEqual(["build"]);
  });

  it("does not call fireHooks when plugin claims target", async () => {
    const stub = stubRunner({ overrideReturns: true });
    const payload: BuildExecPayload = { target: "svc", noCache: true };
    await dispatch(stub, "build:exec", payload);
    expect(stub.fireOverrideCalls).toHaveLength(1);
    expect(stub.fireHooksCalls).toHaveLength(0);
  });
});

describe("buildDispatch — build:post", () => {
  it("fires the post_build hook on the runner", async () => {
    const stub = stubRunner();
    await dispatch(stub, "build:post");
    expect(stub.fireHooksCalls.map((c) => c.name)).toEqual(["post_build"]);
  });
});

// up:pre / up:main / up:post

describe("buildDispatch — up:pre", () => {
  it("fires the pre_up hook on the runner", async () => {
    const stub = stubRunner();
    await dispatch(stub, "up:pre");
    expect(stub.fireHooksCalls.map((c) => c.name)).toEqual(["pre_up"]);
  });
});

describe("buildDispatch — up:main", () => {
  it("fires the up override on the runner", async () => {
    const stub = stubRunner({ overrideReturns: true });
    await dispatch(stub, "up:main");
    expect(stub.fireOverrideCalls.map((c) => c.name)).toEqual(["up"]);
  });

  it("throws the verbatim 'No plugin provides...' error when fireOverride returns false", async () => {
    const stub = stubRunner({ overrideReturns: false });
    await expect(dispatch(stub, "up:main")).rejects.toThrow(
      "No plugin provides an 'up' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
  });
});

describe("buildDispatch — up:post", () => {
  it("fires the post_up hook on the runner", async () => {
    const stub = stubRunner();
    await dispatch(stub, "up:post");
    expect(stub.fireHooksCalls.map((c) => c.name)).toEqual(["post_up"]);
  });
});

// down:pre / down:main / down:post

describe("buildDispatch — down:pre/main/post", () => {
  it("down:pre fires pre_down", async () => {
    const stub = stubRunner();
    await dispatch(stub, "down:pre");
    expect(stub.fireHooksCalls.map((c) => c.name)).toEqual(["pre_down"]);
  });

  it("down:main fires the down override", async () => {
    const stub = stubRunner({ overrideReturns: true });
    await dispatch(stub, "down:main");
    expect(stub.fireOverrideCalls.map((c) => c.name)).toEqual(["down"]);
  });

  it("down:main throws verbatim when fireOverride returns false", async () => {
    const stub = stubRunner({ overrideReturns: false });
    await expect(dispatch(stub, "down:main")).rejects.toThrow(
      "No plugin provides a 'down' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
  });

  it("down:post fires post_down", async () => {
    const stub = stubRunner();
    await dispatch(stub, "down:post");
    expect(stub.fireHooksCalls.map((c) => c.name)).toEqual(["post_down"]);
  });
});

// status:pre / status:main / status:post

describe("buildDispatch — status:pre/main/post", () => {
  it("status:pre fires pre_status", async () => {
    const stub = stubRunner();
    await dispatch(stub, "status:pre");
    expect(stub.fireHooksCalls.map((c) => c.name)).toEqual(["pre_status"]);
  });

  it("status:main fires the status override", async () => {
    const stub = stubRunner({ overrideReturns: true });
    await dispatch(stub, "status:main");
    expect(stub.fireOverrideCalls.map((c) => c.name)).toEqual(["status"]);
  });

  it("status:main throws verbatim when fireOverride returns false", async () => {
    const stub = stubRunner({ overrideReturns: false });
    await expect(dispatch(stub, "status:main")).rejects.toThrow(
      "No plugin provides a 'status' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
  });

  it("status:post fires post_status", async () => {
    const stub = stubRunner();
    await dispatch(stub, "status:post");
    expect(stub.fireHooksCalls.map((c) => c.name)).toEqual(["post_status"]);
  });
});

// command:pre / command:exec / command:post

describe("buildDispatch — command:pre", () => {
  it("logs announce + execution-plan lines from payload", async () => {
    const stub = stubRunner();
    const payload = {
      commandName: "lint",
      targets: ["a", "b"],
      stageCount: 2,
    };
    await dispatch(stub, "command:pre", payload);
    // Identity chalk leaves text intact; commandPre logs two lines.
    expect(stub.loggerLines.length).toBe(2);
    expect(stub.loggerLines[0]).toContain("Executing lint across a, b");
    expect(stub.loggerLines[1]).toContain("Execution plan: 2 stage(s)");
  });
});

describe("buildDispatch — command:exec", () => {
  it("forwards payload through executeCommandTask", async () => {
    // Spy on the command module so we don't actually run shell.
    const commandModule = await import("./scripts/command.ts");
    const spy = vi
      .spyOn(commandModule, "executeCommandTask")
      .mockResolvedValue(undefined);
    try {
      const stub = stubRunner();
      const payload: CommandExecPayload = {
        commandName: "lint",
        stageIndex: 0,
        /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- task is opaque to the dispatch test; only the runTask wiring is under test */
        task: {
          service: "svc",
          command: "lint",
          executable: "echo hi",
        } as unknown as CommandExecPayload["task"],
      };
      await dispatch(stub, "command:exec", payload);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(stub.runner, payload);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("buildDispatch — command:post", () => {
  it("is a no-op (does not throw)", async () => {
    const stub = stubRunner();
    await expect(
      dispatch(stub, "command:post", { commandName: "lint" }),
    ).resolves.toBeUndefined();
    expect(stub.fireHooksCalls).toHaveLength(0);
    expect(stub.fireOverrideCalls).toHaveLength(0);
  });
});

// pluginHook + unknown

interface PluginHookStubOptions extends StubRunnerOptions {
  plugins?: Array<{
    name: string;
    hooks?: Record<string, (ctx: HookContext) => Promise<void>>;
  }>;
}

/**
 * Extends {@link stubRunner} with a configurable `config.project.plugins`
 * list so the plugin-hook dispatcher can look up hooks the same way the
 * real `Runner.fireHooks` does (`p.definition.hooks?.[name]`).
 */
function stubRunnerWithPlugins(options: PluginHookStubOptions): StubRunner {
  const base = stubRunner(options);
  const loaded = (options.plugins ?? []).map((p) => ({
    definition: { name: p.name, hooks: p.hooks },
    serviceConfigs: {},
  }));
  /* eslint-disable @typescript-eslint/consistent-type-assertions -- mutating the runner's project.plugins for the test */
  const cfg = base.runner.config as unknown as {
    project: { plugins: unknown[] };
  };
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
  cfg.project.plugins = loaded;
  return base;
}

describe("buildDispatch — pluginHook branch", () => {
  it("invokes the named plugin's hook with the plan node's payload threaded onto ctx.payload", async () => {
    let received: HookContext | null = null;
    const stub = stubRunnerWithPlugins({
      plugins: [
        {
          name: "docker",
          hooks: {
            buildBatch: async (ctx: HookContext) => {
              received = ctx;
            },
          },
        },
      ],
    });
    const dispatchTable = buildDispatch(stub.runner);
    const handler: Extract<PlanHandler, { kind: "plugin-hook" }> = {
      kind: "plugin-hook",
      plugin: "docker",
      hook: "buildBatch",
    };
    const node: PlanNode = {
      id: "build:bake",
      handler,
      needs: [],
      payload: { targets: ["svc-a", "svc-b"] },
    };
    await dispatchTable.pluginHook(node, handler, fakePlanCtx());
    expect(received).not.toBeNull();
    /* eslint-disable @typescript-eslint/consistent-type-assertions -- received is set inside the hook above */
    const ctx = received as unknown as HookContext;
    /* eslint-enable @typescript-eslint/consistent-type-assertions */
    expect(ctx.payload).toEqual({ targets: ["svc-a", "svc-b"] });
    expect(ctx.runner).toBe(stub.runner);
    // IO surface mirrors the buildOrchestrator factory pattern.
    expect(typeof ctx.exec).toBe("function");
    expect(typeof ctx.shell).toBe("function");
    expect(ctx.runtime).toBe("default");
  });

  it("throws a clear error when the named plugin is not registered", async () => {
    const stub = stubRunnerWithPlugins({ plugins: [] });
    const dispatchTable = buildDispatch(stub.runner);
    const handler: Extract<PlanHandler, { kind: "plugin-hook" }> = {
      kind: "plugin-hook",
      plugin: "docker",
      hook: "buildBatch",
    };
    const node: PlanNode = { id: "n", handler, needs: [] };
    await expect(
      dispatchTable.pluginHook(node, handler, fakePlanCtx()),
    ).rejects.toThrow(
      /Plugin "docker" is not registered\. Cannot dispatch hook "buildBatch"\./,
    );
  });

  it("throws a clear error when the plugin defines no hook with that name", async () => {
    const stub = stubRunnerWithPlugins({
      plugins: [{ name: "docker", hooks: { otherHook: async () => {} } }],
    });
    const dispatchTable = buildDispatch(stub.runner);
    const handler: Extract<PlanHandler, { kind: "plugin-hook" }> = {
      kind: "plugin-hook",
      plugin: "docker",
      hook: "buildBatch",
    };
    const node: PlanNode = { id: "n", handler, needs: [] };
    await expect(
      dispatchTable.pluginHook(node, handler, fakePlanCtx()),
    ).rejects.toThrow(/Plugin "docker" defines no hook "buildBatch"\./);
  });
});

describe("buildDispatch — unknown builtin", () => {
  it("throws an explicit unknown-builtin error", async () => {
    const stub = stubRunner();
    await expect(dispatch(stub, "totally:bogus")).rejects.toThrow(
      "unknown builtin: totally:bogus",
    );
  });
});
