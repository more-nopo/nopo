import { describe, expect, it } from "vitest";

import { serializePlan } from "../plan.ts";
import { ScriptArgs } from "../script-args.ts";
import ActScript, {
  type ActChalk,
  type ActExec,
  type ActIO,
  type ActLogger,
  type ActPayload,
  actRun,
  type ActRunContext,
  buildActArgs,
} from "./act.ts";

function identityChalk(): ActChalk {
  const id = (...args: unknown[]) => args.map((a) => String(a)).join("");
  return { cyan: id, bold: id, red: id };
}

interface StubLogger extends ActLogger {
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

class ExitSentinel extends Error {
  constructor() {
    super("io.exit() called in test stub");
  }
}

interface ExitCall {
  code: number | null | undefined;
}

function stubIO(): { io: ActIO; exits: ExitCall[] } {
  const exits: ExitCall[] = [];
  const io: ActIO = {
    exit(code?: number | null) {
      exits.push({ code });
      // Mimic the production `never`-typed exit contract by throwing.
      throw new ExitSentinel();
    },
  };
  return { io, exits };
}

interface ExecCall {
  cmd: string;
  args: string[];
}

function stubExec(
  whichExit: number,
  actExit = 0,
): { fn: ActExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const fn: ActExec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "which") return { exitCode: whichExit };
    return { exitCode: actExit };
  };
  return { fn, calls };
}

function baseCtx(overrides: Partial<ActRunContext> = {}): ActRunContext {
  const io = stubIO();
  return {
    subcommand: undefined,
    event: "workflow_dispatch",
    verbose: false,
    inputs: [],
    cwd: "/proj",
    io: io.io,
    logger: stubLogger(),
    exec: stubExec(0).fn,
    ...overrides,
  };
}

// ActScript.plan() — shape

describe("ActScript.plan", () => {
  it("returns a single-node plan with the act:run builtin and carries args in payload", () => {
    const args = new ScriptArgs(ActScript.args.getSchema());
    args.parse(["-w", "ci.yml", "-j", "test"]);
    const plan = ActScript.plan(args, { subcommand: "run" });

    expect(plan.nodes.size).toBe(1);
    const node = plan.nodes.get("act");
    if (node === undefined) throw new Error("expected 'act' node");
    if (node.handler.kind !== "builtin") {
      throw new Error(`expected builtin handler, got ${node.handler.kind}`);
    }
    expect(node.handler.name).toBe("act:run");
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime payload narrowing for plan-shape unit test */
    const payload = node.payload as ActPayload;
    expect(payload.subcommand).toBe("run");
    expect(payload.workflow).toBe("ci.yml");
    expect(payload.job).toBe("test");
    expect(payload.event).toBe("workflow_dispatch");
  });

  it("serializePlan round-trips the act plan losslessly", () => {
    const args = new ScriptArgs(ActScript.args.getSchema());
    const plan = ActScript.plan(args, { subcommand: "list" });
    const serialized = serializePlan(plan);
    const json: unknown = JSON.parse(JSON.stringify(serialized));
    expect(json).toEqual(serialized);
  });
});

// buildActArgs — argument shaping for the `act` binary

describe("buildActArgs", () => {
  it("emits [event, -W <path>] for a minimal run", () => {
    const ctx = baseCtx({
      subcommand: "run",
      workflow: "ci.yml",
      event: "push",
    });
    expect(buildActArgs(ctx, false)).toEqual([
      "push",
      "-W",
      ".github/workflows/ci.yml",
    ]);
  });

  it("appends -j <job> when job is set", () => {
    const ctx = baseCtx({
      subcommand: "run",
      workflow: "ci.yml",
      job: "lint",
    });
    const out = buildActArgs(ctx, false);
    expect(out).toContain("-j");
    expect(out).toContain("lint");
  });

  it("appends -n for dry runs and --verbose when verbose=true", () => {
    const ctx = baseCtx({
      subcommand: "dry",
      workflow: "ci.yml",
      verbose: true,
    });
    const out = buildActArgs(ctx, true);
    expect(out).toContain("-n");
    expect(out).toContain("--verbose");
  });

  it("appends --input KEY=VALUE once per input", () => {
    const ctx = baseCtx({
      subcommand: "run",
      workflow: "ci.yml",
      inputs: ["a=1", "b=2"],
    });
    const out = buildActArgs(ctx, false);
    const pairs: (string | undefined)[] = [];
    for (let i = 0; i < out.length; i++) {
      if (out[i] === "--input") pairs.push(out[i + 1]);
    }
    expect(pairs).toEqual(["a=1", "b=2"]);
  });
});

// actRun — subcommand routing

describe("actRun", () => {
  it("exits 1 with an error message when `act` is not installed (which returns non-zero)", async () => {
    const io = stubIO();
    const logger = stubLogger();
    const exec = stubExec(1);
    const ctx: ActRunContext = {
      subcommand: "list",
      event: "workflow_dispatch",
      verbose: false,
      inputs: [],
      cwd: "/proj",
      io: io.io,
      logger,
      exec: exec.fn,
    };
    await expect(actRun(ctx)).rejects.toThrow(ExitSentinel);
    expect(io.exits[0]).toEqual({ code: 1 });
    expect(logger.lines.some((l) => l.includes("act is not installed"))).toBe(
      true,
    );
  });

  it("prints usage and returns when no subcommand is provided (act installed)", async () => {
    const io = stubIO();
    const logger = stubLogger();
    const exec = stubExec(0);
    const ctx: ActRunContext = {
      subcommand: undefined,
      event: "workflow_dispatch",
      verbose: false,
      inputs: [],
      cwd: "/proj",
      io: io.io,
      logger,
      exec: exec.fn,
    };
    await actRun(ctx);
    expect(io.exits).toEqual([]);
    expect(logger.lines.some((l) => l.includes("Usage: nopo act"))).toBe(true);
  });

  it("shells out to `act -l` for the `list` subcommand", async () => {
    const io = stubIO();
    const exec = stubExec(0, 0);
    const ctx: ActRunContext = {
      subcommand: "list",
      event: "workflow_dispatch",
      verbose: false,
      inputs: [],
      cwd: "/proj",
      io: io.io,
      logger: stubLogger(),
      exec: exec.fn,
    };
    await expect(actRun(ctx)).rejects.toThrow(ExitSentinel);
    expect(exec.calls).toEqual([
      { cmd: "which", args: ["act"] },
      { cmd: "act", args: ["-l"] },
    ]);
    expect(io.exits[0]).toEqual({ code: 0 });
  });
});
