import { Script } from "../lib.ts";
import { type Plan, planFromNodes } from "../plan.ts";
import { ScriptArgs } from "../script-args.ts";

/** A chalk-style colorizer: callable + chainable enough for our use. */
type Colorize = (...args: unknown[]) => string;

/** Subset of the `chalk` surface {@link actRun} uses. */
export interface ActChalk {
  cyan: Colorize;
  bold: Colorize;
  red: Colorize;
}

/** Logger surface {@link actRun} uses — log + a chalk bag for colored output. */
export interface ActLogger {
  log(...args: unknown[]): void;
  chalk: ActChalk;
}

/** IO surface {@link actRun} touches. Matches the relevant slice of `Runner#io`. */
export interface ActIO {
  exit(code?: number | null): never;
}

/** Outcome of an exec call as the handler sees it. */
export interface ActExecResult {
  exitCode: number;
}

/** Options act passes to exec — narrowed from the real `ExecOptions`. */
export interface ActExecOptions {
  cwd?: string;
  stdio?: "inherit";
  nothrow?: boolean;
}

/** Structural shape of the `exec` dependency {@link actRun} consumes. */
export type ActExec = (
  cmd: string,
  args: string[],
  options?: ActExecOptions,
) => Promise<ActExecResult>;

/**
 * Inputs to {@link actRun}. The subcommand is parsed from argv by the
 * caller (dispatch table / scope builder) since act's subcommand isn't a
 * declared flag — it's the first positional after `act`.
 */
export interface ActRunContext {
  /** `"list"`, `"run"`, `"dry"`, or `undefined` (no subcommand → usage). */
  subcommand: string | undefined;
  /** Workflow file (e.g. `ci.yml`). Required for `run` / `dry`. */
  workflow?: string;
  /** Specific job to run within the workflow. */
  job?: string;
  /** Event type to simulate (default: `workflow_dispatch`). */
  event: string;
  /** Verbose output flag — added as `--verbose` to act args. */
  verbose: boolean;
  /** Workflow inputs (`key=value`), repeated as `--input key=value`. */
  inputs: readonly string[];
  /** Project root, used as `cwd` for every act invocation. */
  cwd: string;
  io: ActIO;
  logger: ActLogger;
  exec: ActExec;
}

function printUsage(ctx: ActRunContext): void {
  const { chalk } = ctx.logger;
  const { logger } = ctx;
  logger.log(
    chalk.cyan(chalk.bold("\nUsage: nopo act <subcommand> [options]\n")),
  );
  logger.log(chalk.bold("Subcommands:"));
  logger.log("  list                     List all workflows and jobs");
  logger.log("  run -w <workflow>        Run a workflow");
  logger.log("  dry -w <workflow>        Dry run (validate only)");
  logger.log("");
  logger.log(chalk.bold("Examples:"));
  logger.log("  nopo act list");
  logger.log("  nopo act run -w ci.yml");
  logger.log("  nopo act run -w ci.yml -j test");
  logger.log(
    "  nopo act dry -w _test_state_machine.yml -i scenario_name=triage",
  );
  logger.log("");
  logger.log(chalk.bold("Setup:"));
  logger.log("  cp .secrets.example .secrets   # Add your tokens");
  logger.log("  cp .vars.example .vars         # Add repo variables");
  logger.log("");
}

/**
 * Build the argv to pass to the `act` binary for `run` / `dry`. Exported
 * for unit testing — the shape is observable on `io.spawns` once act.ts
 * routes spawns through `io.spawn` (today it uses the legacy `exec()`).
 */
export function buildActArgs(ctx: ActRunContext, dryRun: boolean): string[] {
  const { workflow, job, event, verbose, inputs, logger, io } = ctx;
  const { chalk } = logger;

  if (!workflow) {
    logger.log(chalk.red("Error: --workflow (-w) is required"));
    printUsage(ctx);
    io.exit(1);
  }

  const actArgs: string[] = [event];

  // Add workflow file
  actArgs.push("-W", `.github/workflows/${workflow}`);

  // Add job if specified
  if (job) {
    actArgs.push("-j", job);
  }

  // Add dry run flag
  if (dryRun) {
    actArgs.push("-n");
  }

  // Add verbose flag
  if (verbose) {
    actArgs.push("--verbose");
  }

  // Add inputs
  for (const input of inputs) {
    actArgs.push("--input", input);
  }

  return actArgs;
}

/** Backs the `"act:run"` builtin. Routes to the requested subcommand, shells out to `act`
 * for `list` / `run` / `dry`, prints usage otherwise. Mirrors the legacy `ActScript.fn()`
 * body — including the legacy `exec()` path for the subprocess (gap §2 in the utility
 * contract suite). Migrating to `io.spawn` is a separate concern; this PR only moves
 */
export async function actRun(ctx: ActRunContext): Promise<void> {
  const { chalk } = ctx.logger;

  // Check if act is installed
  const actCheck = await ctx.exec("which", ["act"], { nothrow: true });
  if (actCheck.exitCode !== 0) {
    ctx.logger.log(
      chalk.red("Error: act is not installed. Install with: brew install act"),
    );
    ctx.io.exit(1);
  }

  switch (ctx.subcommand) {
    case "list": {
      const result = await ctx.exec("act", ["-l"], {
        cwd: ctx.cwd,
        stdio: "inherit",
        nothrow: true,
      });
      ctx.io.exit(result.exitCode);
      return;
    }
    case "run": {
      const actArgs = buildActArgs(ctx, false);
      const result = await ctx.exec("act", actArgs, {
        cwd: ctx.cwd,
        stdio: "inherit",
        nothrow: true,
      });
      ctx.io.exit(result.exitCode);
      return;
    }
    case "dry": {
      const actArgs = buildActArgs(ctx, true);
      const result = await ctx.exec("act", actArgs, {
        cwd: ctx.cwd,
        stdio: "inherit",
        nothrow: true,
      });
      ctx.io.exit(result.exitCode);
      return;
    }
    default:
      printUsage(ctx);
      return;
  }
}

export default class ActScript extends Script {
  static override skipQueue = true; // long-lived runner — would hold a slot for its whole runtime
  static override name = "act";
  static override description = "Run GitHub Actions locally with act";

  static override args = new ScriptArgs({
    workflow: {
      type: "string",
      description: "Workflow file to run (e.g., ci.yml)",
      alias: ["w"],
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- undefined default for optional arg, typed as string when provided
      default: undefined as unknown as string,
    },
    job: {
      type: "string",
      description: "Specific job to run",
      alias: ["j"],
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- undefined default for optional arg, typed as string when provided
      default: undefined as unknown as string,
    },
    event: {
      type: "string",
      description: "Event type to simulate (default: workflow_dispatch)",
      alias: ["e"],
      default: "workflow_dispatch",
    },
    dry: {
      type: "boolean",
      description: "Dry run (validate without executing)",
      alias: ["n"],
      default: false,
    },
    verbose: {
      type: "boolean",
      description: "Verbose output",
      alias: ["v"],
      default: false,
    },
    input: {
      type: "string[]",
      description: "Workflow inputs (key=value)",
      alias: ["i"],
      default: [],
    },
  });

  /** Single-node plan dispatching to {@link actRun} via `"act:run"`. */
  static plan(
    args: ScriptArgs,
    scope: { subcommand: string | undefined },
  ): Plan {
    const payload: ActPayload = {
      subcommand: scope.subcommand,
      event: args.get<string>("event") || "workflow_dispatch",
      verbose: args.get<boolean>("verbose") ?? false,
      inputs: args.get<string[]>("input") ?? [],
    };
    const workflow = args.get<string | undefined>("workflow");
    if (workflow !== undefined) payload.workflow = workflow;
    const job = args.get<string | undefined>("job");
    if (job !== undefined) payload.job = job;
    return planFromNodes([
      {
        id: "act",
        handler: { kind: "builtin", name: "act:run" },
        needs: [],
        payload,
        meta: { script: "act" },
      },
    ]);
  }
}

/** Payload carried on the `act:run` plan node — JSON-safe. */
export interface ActPayload {
  subcommand: string | undefined;
  workflow?: string;
  job?: string;
  event: string;
  verbose: boolean;
  inputs: readonly string[];
}
