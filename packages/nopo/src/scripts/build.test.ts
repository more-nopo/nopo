import { describe, expect, it } from "vitest";

import { serializePlan } from "../plan.ts";
import {
  executePlan,
  type HandlerDispatch,
  type PlanContext,
} from "../plan-runner.ts";
import { ScriptArgs } from "../script-args.ts";
import { mockIO } from "../test-utils/mock-io.ts";
import BuildScript, {
  buildExec,
  type BuildExecContext,
  type BuildExecPayload,
  type BuildLogger,
  type BuildOrchestrator,
  buildPost,
  type BuildPostContext,
  buildPre,
  type BuildPreContext,
} from "./build.ts";

// stubs

interface StubLogger extends BuildLogger {
  lines: string[];
}

function stubLogger(): StubLogger {
  const lines: string[] = [];
  return {
    lines,
    log: (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    },
  };
}

interface OrchestratorCalls {
  hooks: string[];
  overrides: string[];
  hostBuilds: string[];
}

interface OrchestratorStub extends BuildOrchestrator {
  calls: OrchestratorCalls;
}

interface OrchestratorOverrides {
  /** Targets the override claims (returns true). Default: claim none. */
  overrideClaims?: ReadonlySet<string>;
  /** Throws from defaultHostBuild for these targets. */
  failHostBuild?: ReadonlySet<string>;
  /** Throws from fireHooks for these hook names. */
  failHooks?: ReadonlySet<"pre_build" | "post_build">;
}

function stubOrchestrator(
  overrides: OrchestratorOverrides = {},
): OrchestratorStub {
  const calls: OrchestratorCalls = {
    hooks: [],
    overrides: [],
    hostBuilds: [],
  };
  return {
    calls,
    async fireHooks(hookName) {
      calls.hooks.push(hookName);
      if (overrides.failHooks?.has(hookName)) {
        throw new Error(`hook ${hookName} failed`);
      }
    },
    async fireBuildOverride(target) {
      calls.overrides.push(target);
      return overrides.overrideClaims?.has(target) ?? false;
    },
    async defaultHostBuild(target) {
      calls.hostBuilds.push(target);
      if (overrides.failHostBuild?.has(target)) {
        throw new Error(`host build ${target} failed`);
      }
    },
  };
}

/** Narrow a plan node's `unknown` payload to {@link BuildExecPayload} for test assertions.
 * The Plan type stores payload as `unknown` by design (handlers own their payload
 * schemas), so a single, justified cast here keeps each test site clean.
 */
function asExecPayload(payload: unknown): BuildExecPayload {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Plan.payload is `unknown`; tests own the schema for build:exec
  return payload as BuildExecPayload;
}

function args(values: Record<string, unknown> = {}): ScriptArgs {
  // ScriptArgs#get reads from `values` populated by parse(); we want to construct one with
  // explicit values without going through argv. Using a fresh ScriptArgs and poking values
  const argv: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "boolean") {
      if (v) argv.push(`--${k}`);
    } else if (v !== undefined) {
      argv.push(`--${k}`, String(v));
    }
  }
  // BuildScript.args is the schema; clone and parse argv into a new
  // ScriptArgs so plan() reads the populated values.

  return BuildScript.args!.extend({}).parse(argv);
}

// BuildScript.plan() — shape

describe("BuildScript.plan", () => {
  it("emits only pre + post nodes when target list is empty", () => {
    const plan = BuildScript.plan(args(), { targets: [] });

    expect(plan.nodes.size).toBe(2);
    expect([...plan.nodes.keys()]).toEqual(["pre_build", "post_build"]);
    // Empty target list still emits pre/post so plugin hooks fire.
    const post = plan.nodes.get("post_build");
    if (post === undefined) throw new Error("expected post_build node");
    // post has nothing to wait on except pre when there are no exec nodes.
    expect([...post.needs]).toEqual(["pre_build"]);
  });

  it("emits 3 nodes for a single target (pre, build:t, post)", () => {
    const plan = BuildScript.plan(args(), { targets: ["a"] });

    expect(plan.nodes.size).toBe(3);
    expect([...plan.nodes.keys()]).toEqual([
      "pre_build",
      "build:a",
      "post_build",
    ]);

    const exec = plan.nodes.get("build:a");
    if (exec === undefined) throw new Error("expected build:a node");
    expect([...exec.needs]).toEqual(["pre_build"]);
    expect(exec.target).toBe("a");

    const post = plan.nodes.get("post_build");
    if (post === undefined) throw new Error("expected post_build node");
    expect([...post.needs]).toEqual(["build:a"]);
  });

  it("emits 5 nodes for three targets with proper dependencies", () => {
    const plan = BuildScript.plan(args(), { targets: ["a", "b", "c"] });

    expect(plan.nodes.size).toBe(5);
    expect([...plan.nodes.keys()]).toEqual([
      "pre_build",
      "build:a",
      "build:b",
      "build:c",
      "post_build",
    ]);

    for (const id of ["build:a", "build:b", "build:c"]) {
      const node = plan.nodes.get(id);
      if (node === undefined) throw new Error(`expected ${id} node`);
      expect([...node.needs]).toEqual(["pre_build"]);
    }

    const post = plan.nodes.get("post_build");
    if (post === undefined) throw new Error("expected post_build node");
    expect([...post.needs]).toEqual(["build:a", "build:b", "build:c"]);
  });

  it("uses 'builtin' handlers with the build:pre / build:exec / build:post names", () => {
    const plan = BuildScript.plan(args(), { targets: ["x"] });

    const pre = plan.nodes.get("pre_build");
    const exec = plan.nodes.get("build:x");
    const post = plan.nodes.get("post_build");

    if (!pre || !exec || !post) throw new Error("missing nodes");

    if (pre.handler.kind !== "builtin") throw new Error("pre not builtin");
    expect(pre.handler.name).toBe("build:pre");

    if (exec.handler.kind !== "builtin") throw new Error("exec not builtin");
    expect(exec.handler.name).toBe("build:exec");

    if (post.handler.kind !== "builtin") throw new Error("post not builtin");
    expect(post.handler.name).toBe("build:post");
  });

  it("sets per-target node.target to the service id", () => {
    const plan = BuildScript.plan(args(), { targets: ["alpha", "beta"] });

    expect(plan.nodes.get("build:alpha")?.target).toBe("alpha");
    expect(plan.nodes.get("build:beta")?.target).toBe("beta");
  });

  it("threads --no-cache / --output / --registries into per-target payload", () => {
    const plan = BuildScript.plan(
      args({
        "no-cache": true,
        output: "/tmp/build.json",
        registries: "us-central1-docker.pkg.dev/p/r",
      }),
      { targets: ["svc"] },
    );

    const exec = plan.nodes.get("build:svc");
    if (exec === undefined) throw new Error("expected build:svc node");
    const payload = asExecPayload(exec.payload);
    expect(payload).toEqual({
      target: "svc",
      noCache: true,
      output: "/tmp/build.json",
      registries: "us-central1-docker.pkg.dev/p/r",
    });
  });

  it("defaults noCache to false and omits output/registries when unset", () => {
    const plan = BuildScript.plan(args(), { targets: ["svc"] });
    const exec = plan.nodes.get("build:svc");
    if (exec === undefined) throw new Error("expected build:svc node");
    const payload = asExecPayload(exec.payload);
    expect(payload.target).toBe("svc");
    expect(payload.noCache).toBe(false);
    expect(payload.output).toBeUndefined();
    expect(payload.registries).toBeUndefined();
  });

  it("is callable without a Runner (pure function of args + scope)", () => {
    const fn = BuildScript.plan;
    expect(() => fn(args(), { targets: ["a"] })).not.toThrow();
  });

  it("serializePlan round-trips the build plan losslessly", () => {
    const plan = BuildScript.plan(args({ "no-cache": true }), {
      targets: ["a", "b"],
    });
    const serialized = serializePlan(plan);
    const json: unknown = JSON.parse(JSON.stringify(serialized));
    expect(json).toEqual(serialized);
    expect(serialized.nodes).toHaveLength(4);
    expect(serialized.nodes[0]).toMatchObject({
      id: "pre_build",
      handler: { kind: "builtin", name: "build:pre" },
      needs: [],
    });
    expect(serialized.nodes[3]).toMatchObject({
      id: "post_build",
      handler: { kind: "builtin", name: "build:post" },
      needs: ["build:a", "build:b"],
    });
  });
});

// buildPre — behavior

describe("buildPre", () => {
  it("fires the pre_build hook on the orchestrator", async () => {
    const orchestrator = stubOrchestrator();
    const ctx: BuildPreContext = {
      orchestrator,
      logger: stubLogger(),
      payload: { targets: ["a", "b"] },
    };
    await buildPre(ctx);
    expect(orchestrator.calls.hooks).toEqual(["pre_build"]);
  });

  it("propagates a hook failure", async () => {
    const orchestrator = stubOrchestrator({
      failHooks: new Set(["pre_build"]),
    });
    await expect(
      buildPre({
        orchestrator,
        logger: stubLogger(),
        payload: { targets: [] },
      }),
    ).rejects.toThrow("hook pre_build failed");
  });
});

// buildExec — behavior

describe("buildExec", () => {
  it("falls through to defaultHostBuild when no plugin override claims the target", async () => {
    const orchestrator = stubOrchestrator();
    const ctx: BuildExecContext = {
      orchestrator,
      logger: stubLogger(),
      payload: { target: "svc", noCache: false },
    };
    await buildExec(ctx);
    expect(orchestrator.calls.overrides).toEqual(["svc"]);
    expect(orchestrator.calls.hostBuilds).toEqual(["svc"]);
  });

  it("skips defaultHostBuild when a plugin override claims the target", async () => {
    const orchestrator = stubOrchestrator({
      overrideClaims: new Set(["svc"]),
    });
    await buildExec({
      orchestrator,
      logger: stubLogger(),
      payload: { target: "svc", noCache: false },
    });
    expect(orchestrator.calls.overrides).toEqual(["svc"]);
    expect(orchestrator.calls.hostBuilds).toEqual([]);
  });

  it("propagates a host build failure", async () => {
    const orchestrator = stubOrchestrator({
      failHostBuild: new Set(["svc"]),
    });
    await expect(
      buildExec({
        orchestrator,
        logger: stubLogger(),
        payload: { target: "svc", noCache: true },
      }),
    ).rejects.toThrow("host build svc failed");
  });

  it("only builds the single target named in payload (no fan-out inside the handler)", async () => {
    const orchestrator = stubOrchestrator();
    await buildExec({
      orchestrator,
      logger: stubLogger(),
      payload: { target: "only-me", noCache: false },
    });
    expect(orchestrator.calls.overrides).toEqual(["only-me"]);
    expect(orchestrator.calls.hostBuilds).toEqual(["only-me"]);
  });
});

// buildPost — behavior

describe("buildPost", () => {
  it("fires the post_build hook on the orchestrator", async () => {
    const orchestrator = stubOrchestrator();
    const ctx: BuildPostContext = {
      orchestrator,
      logger: stubLogger(),
      payload: { targets: ["a"] },
    };
    await buildPost(ctx);
    expect(orchestrator.calls.hooks).toEqual(["post_build"]);
  });

  it("propagates a post-hook failure", async () => {
    const orchestrator = stubOrchestrator({
      failHooks: new Set(["post_build"]),
    });
    await expect(
      buildPost({
        orchestrator,
        logger: stubLogger(),
        payload: { targets: [] },
      }),
    ).rejects.toThrow("hook post_build failed");
  });
});

// Runner integration tracer bullet — plan + executePlan smoke

describe("BuildScript plan + executePlan integration", () => {
  it("runs pre / per-target exec / post via the dispatch table", async () => {
    const plan = BuildScript.plan(args(), { targets: ["a", "b"] });
    const orchestrator = stubOrchestrator();
    const logger = stubLogger();

    let execCalls = 0;
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        throw new Error("plugin-hook should not be called for build plan");
      },
      builtin: async (node, handler) => {
        if (handler.name === "build:pre") {
          await buildPre({
            orchestrator,
            logger,
            payload: { targets: ["a", "b"] },
          });
          return;
        }
        if (handler.name === "build:exec") {
          execCalls++;
          await buildExec({
            orchestrator,
            logger,
            payload: asExecPayload(node.payload),
          });
          return;
        }
        if (handler.name === "build:post") {
          await buildPost({
            orchestrator,
            logger,
            payload: { targets: ["a", "b"] },
          });
          return;
        }
        throw new Error(`unexpected builtin: ${handler.name}`);
      },
    };

    const ctx: PlanContext = {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      dispatch,
    };

    const result = await executePlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.results.get("pre_build")?.status).toBe("success");
    expect(result.results.get("build:a")?.status).toBe("success");
    expect(result.results.get("build:b")?.status).toBe("success");
    expect(result.results.get("post_build")?.status).toBe("success");

    // Per-target exec ran exactly once per target.
    expect(execCalls).toBe(2);
    // Hooks fired once each, in order.
    expect(orchestrator.calls.hooks).toEqual(["pre_build", "post_build"]);
    // Per-target overrides + host builds checked for every target.
    expect(new Set(orchestrator.calls.overrides)).toEqual(new Set(["a", "b"]));
    expect(new Set(orchestrator.calls.hostBuilds)).toEqual(new Set(["a", "b"]));
  });

  it("propagates a per-target buildExec failure as a plan node failure", async () => {
    const plan = BuildScript.plan(args(), { targets: ["good", "bad"] });
    const orchestrator = stubOrchestrator({
      failHostBuild: new Set(["bad"]),
    });
    const logger = stubLogger();

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async (node, handler) => {
        if (handler.name === "build:pre") {
          await buildPre({
            orchestrator,
            logger,
            payload: { targets: ["good", "bad"] },
          });
        } else if (handler.name === "build:exec") {
          await buildExec({
            orchestrator,
            logger,
            payload: asExecPayload(node.payload),
          });
        } else if (handler.name === "build:post") {
          await buildPost({
            orchestrator,
            logger,
            payload: { targets: ["good", "bad"] },
          });
        }
      },
    };

    const result = await executePlan(plan, {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      dispatch,
    });

    expect(result.ok).toBe(false);
    expect(result.results.get("build:bad")?.status).toBe("failure");
    expect(result.results.get("build:bad")?.error?.message).toBe(
      "host build bad failed",
    );
    // post_build is poisoned because one of its `needs` failed.
    expect(result.results.get("post_build")?.status).toBe("skipped");
    // Independent good build still ran to completion.
    expect(result.results.get("build:good")?.status).toBe("success");
  });
});
