import { describe, expect, it } from "vitest";

import { serializePlan } from "../plan.ts";
import {
  executePlan,
  type HandlerDispatch,
  type PlanContext,
} from "../plan-runner.ts";
import { ScriptArgs } from "../script-args.ts";
import { mockIO } from "../test-utils/mock-io.ts";
import EnvScript, {
  type ChalkLike,
  envApply,
  type EnvApplyContext,
  type EnvDiff,
  type EnvLogger,
  type EnvSource,
} from "./env.ts";

// stubs

/** Identity colorizer: keeps assertions readable. */
function identityChalk(): ChalkLike {
  const id = (...args: unknown[]) => args.map((a) => String(a)).join("");
  return {
    magenta: id,
    yellow: id,
    white: id,
    red: id,
    gray: id,
    underline: id,
  };
}

interface StubLogger extends EnvLogger {
  lines: string[];
}

function stubLogger(): StubLogger {
  const lines: string[] = [];
  return {
    lines,
    chalk: identityChalk(),
    log: (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    },
  };
}

interface StubEnvironment extends EnvSource {
  saveCalls: number;
}

interface StubEnvOverrides {
  envFile?: string;
  hasPrevEnv?: boolean;
  diff?: Partial<EnvDiff>;
}

function stubEnvironment(overrides: StubEnvOverrides = {}): StubEnvironment {
  const env: StubEnvironment = {
    saveCalls: 0,
    envFile: overrides.envFile ?? "/tmp/.env",
    hasPrevEnv: overrides.hasPrevEnv ?? false,
    diff: {
      added: overrides.diff?.added ?? [],
      updated: overrides.diff?.updated ?? [],
      removed: overrides.diff?.removed ?? [],
      unchanged: overrides.diff?.unchanged ?? [],
    },
    save() {
      this.saveCalls++;
    },
  };
  return env;
}

function applyCtx(
  overrides: {
    environment?: StubEnvironment;
    logger?: StubLogger;
  } = {},
): EnvApplyContext & { environment: StubEnvironment; logger: StubLogger } {
  return {
    environment: overrides.environment ?? stubEnvironment(),
    logger: overrides.logger ?? stubLogger(),
  };
}

// EnvScript.plan() — shape

describe("EnvScript.plan", () => {
  it("returns a single-node plan with the env:apply builtin", () => {
    const plan = EnvScript.plan(new ScriptArgs({}));

    expect(plan.nodes.size).toBe(1);
    const node = plan.nodes.get("env");
    if (node === undefined) throw new Error("expected 'env' node");
    expect(node.id).toBe("env");
    if (node.handler.kind !== "builtin") {
      throw new Error(`expected builtin handler, got ${node.handler.kind}`);
    }
    expect(node.handler.name).toBe("env:apply");
    expect([...node.needs]).toEqual([]);
    expect(node.meta?.script).toBe("env");
  });

  it("is callable without a Runner (pure function of args)", () => {
    // Static method — no `this` binding required.
    const fn = EnvScript.plan;
    expect(() => fn(new ScriptArgs({}))).not.toThrow();
  });

  it("serializePlan round-trips the env plan losslessly", () => {
    const plan = EnvScript.plan(new ScriptArgs({}));
    const serialized = serializePlan(plan);
    // Round-trip through JSON to confirm the serialized form is JSON-safe.
    const json: unknown = JSON.parse(JSON.stringify(serialized));
    expect(json).toEqual(serialized);
    expect(serialized.nodes).toHaveLength(1);
    expect(serialized.nodes[0]).toMatchObject({
      id: "env",
      handler: { kind: "builtin", name: "env:apply" },
      needs: [],
      meta: { script: "env" },
    });
  });
});

// envApply — behavior

describe("envApply", () => {
  it("calls environment.save() exactly once", async () => {
    const ctx = applyCtx();
    await envApply(ctx);
    expect(ctx.environment.saveCalls).toBe(1);
  });

  it("emits 'Created: <envFile>' when hasPrevEnv is false", async () => {
    const ctx = applyCtx({
      environment: stubEnvironment({
        envFile: "/tmp/.env",
        hasPrevEnv: false,
      }),
    });
    await envApply(ctx);
    expect(ctx.logger.lines[0]).toBe("Created: /tmp/.env");
  });

  it("emits 'Updated: <envFile>' when hasPrevEnv is true", async () => {
    const ctx = applyCtx({
      environment: stubEnvironment({
        envFile: "/tmp/.env",
        hasPrevEnv: true,
      }),
    });
    await envApply(ctx);
    expect(ctx.logger.lines[0]).toBe("Updated: /tmp/.env");
  });

  it("emits a separator line of '-' matching the title length", async () => {
    const ctx = applyCtx({
      environment: stubEnvironment({
        envFile: "/tmp/.env",
        hasPrevEnv: false,
      }),
    });
    await envApply(ctx);
    const title = ctx.logger.lines[0]!;
    const sep = ctx.logger.lines[1]!;
    expect(sep).toBe("-".repeat(title.length));
  });

  it("emits diff sections in order: added, updated, removed, unchanged", async () => {
    const ctx = applyCtx({
      environment: stubEnvironment({
        diff: {
          added: [["A", "1"]],
          updated: [["U", "2"]],
          removed: [["R", undefined]],
          unchanged: [["X", "9"]],
        },
      }),
    });
    await envApply(ctx);
    // Drop title + separator.
    const sectionHeaders = ctx.logger.lines
      .slice(2)
      .filter((l) => ["added", "updated", "removed", "unchanged"].includes(l));
    expect(sectionHeaders).toEqual([
      "added",
      "updated",
      "removed",
      "unchanged",
    ]);
  });

  it("skips empty diff sections (no header emitted)", async () => {
    const ctx = applyCtx({
      environment: stubEnvironment({
        diff: {
          added: [["A", "1"]],
          // updated, removed, unchanged all empty
        },
      }),
    });
    await envApply(ctx);
    expect(ctx.logger.lines).not.toContain("updated");
    expect(ctx.logger.lines).not.toContain("removed");
    expect(ctx.logger.lines).not.toContain("unchanged");
    expect(ctx.logger.lines).toContain("added");
  });

  it("emits each entry as 'name: value' with undefined value rendered empty", async () => {
    const ctx = applyCtx({
      environment: stubEnvironment({
        diff: {
          added: [["FOO", "bar"]],
          removed: [["GONE", undefined]],
        },
      }),
    });
    await envApply(ctx);
    expect(ctx.logger.lines).toContain("FOO: bar");
    expect(ctx.logger.lines).toContain("GONE: ");
  });

  it("handles a fully-empty diff (only title + separator emitted)", async () => {
    const ctx = applyCtx();
    await envApply(ctx);
    expect(ctx.logger.lines).toHaveLength(2);
  });
});

// Runner integration smoke — executePlan + dispatch tracer-bullet

describe("EnvScript plan + executePlan integration", () => {
  it("runs envApply via the runner's builtin dispatch and reports success", async () => {
    const plan = EnvScript.plan(new ScriptArgs({}));
    const env = stubEnvironment({
      envFile: "/tmp/.env",
      hasPrevEnv: false,
      diff: {
        added: [["FOO", "bar"]],
      },
    });
    const logger = stubLogger();

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        throw new Error("plugin-hook should not be called for env plan");
      },
      builtin: async (_node, handler) => {
        if (handler.name !== "env:apply") {
          throw new Error(`unexpected builtin: ${handler.name}`);
        }
        await envApply({ environment: env, logger });
      },
    };

    const ctx: PlanContext = {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      dispatch,
    };

    const result = await executePlan(plan, ctx);

    expect(result.ok).toBe(true);
    expect(result.results.get("env")?.status).toBe("success");
    expect(env.saveCalls).toBe(1);
    expect(logger.lines[0]).toBe("Created: /tmp/.env");
    expect(logger.lines).toContain("added");
    expect(logger.lines).toContain("FOO: bar");
  });

  it("propagates a save() failure as a plan node failure", async () => {
    const plan = EnvScript.plan(new ScriptArgs({}));
    const env = stubEnvironment();
    env.save = () => {
      throw new Error("disk full");
    };
    const logger = stubLogger();

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async () => {
        await envApply({ environment: env, logger });
      },
    };

    const result = await executePlan(plan, {
      io: mockIO({ argv: ["nopo"], cwd: "/" }),
      dispatch,
    });

    expect(result.ok).toBe(false);
    const nodeResult = result.results.get("env");
    expect(nodeResult?.status).toBe("failure");
    expect(nodeResult?.error?.message).toBe("disk full");
  });
});
