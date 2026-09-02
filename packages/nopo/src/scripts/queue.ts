import { basename } from "node:path";

import { baseArgs } from "../args.ts";
import { Script } from "../lib.ts";
import { type Plan, planFromNodes } from "../plan.ts";
import type { QueueStatus } from "../queue-protocol.ts";
import type { ScriptArgs } from "../script-args.ts";

/** A chalk-style colorizer: callable, returns a string. */
type Colorize = (...args: unknown[]) => string;

/** The slice of `chalk` {@link queueRun} renders with. Stubbable in tests. */
export interface QueueChalk {
  cyan: Colorize;
  bold: Colorize;
  gray: Colorize;
  yellow: Colorize;
  green: Colorize;
}

/** IO surface {@link queueRun} writes to. Matches `Runner#io`. */
export interface QueueIO {
  stdout: { write(s: string): void };
}

/**
 * Inputs to {@link queueRun}. `query` is injected so the renderer can be
 * tested without a live broker; the dispatcher wires it to the real
 * `queryQueue`.
 */
export interface QueueRunContext {
  io: QueueIO;
  chalk: QueueChalk;
  json: boolean;
  query: () => Promise<QueueStatus | null>;
}

const EMPTY: QueueStatus = { budget: 0, used: 0, running: [], pending: [] };

/** Human-friendly elapsed time, e.g. `8s`, `1m20s`, `2h05m`. */
function humanDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Backs the `"queue:run"` builtin. Single source of truth for what
 * `nopo queue` prints. */
export async function queueRun(ctx: QueueRunContext): Promise<void> {
  const { chalk, io } = ctx;
  const status = await ctx.query();

  if (ctx.json) {
    io.stdout.write(JSON.stringify(status ?? EMPTY, null, 2) + "\n");
    return;
  }

  if (!status) {
    io.stdout.write(chalk.gray("Worker queue is empty (no broker running).\n"));
    return;
  }

  const { budget, used, running, pending } = status;
  io.stdout.write(
    chalk.bold(
      chalk.cyan(`Worker queue — budget ${budget}, ${used}/${budget} in use`),
    ) + "\n",
  );

  io.stdout.write("\n" + chalk.bold(`RUNNING (${running.length})`) + "\n");
  if (running.length === 0) {
    io.stdout.write(chalk.gray("  none\n"));
  } else {
    for (const r of running) {
      io.stdout.write(
        "  " +
          chalk.green("▶ ") +
          chalk.yellow(r.cmd.padEnd(24)) +
          chalk.gray(
            `${r.slots} slot${r.slots === 1 ? "" : "s"}  ` +
              `${basename(r.cwd).padEnd(16)}  pid ${r.pid}  ${humanDuration(r.runningMs)}`,
          ) +
          "\n",
      );
    }
  }

  io.stdout.write("\n" + chalk.bold(`PENDING (${pending.length})`) + "\n");
  if (pending.length === 0) {
    io.stdout.write(chalk.gray("  none\n"));
  } else {
    for (const p of pending) {
      io.stdout.write(
        "  " +
          chalk.gray(`#${p.position} `) +
          chalk.yellow(p.cmd.padEnd(24)) +
          chalk.gray(
            `want ${p.want}  ${basename(p.cwd).padEnd(16)}  pid ${p.pid}  ` +
              `waiting ${humanDuration(p.waitingMs)}`,
          ) +
          "\n",
      );
    }
  }
}

export default class QueueScript extends Script {
  static override skipQueue = true; // introspection — never wait on itself
  static override name = "queue";
  static override description =
    "Show the cross-session worker queue (running + pending commands)";

  static override args = baseArgs.extend({
    json: {
      type: "boolean",
      description: "Output the queue snapshot as JSON",
      alias: ["j"],
      default: false,
    },
  });

  /** Single-node plan dispatching to {@link queueRun} via `"queue:run"`. */
  static plan(_args: ScriptArgs, _scope: { targets: readonly string[] }): Plan {
    return planFromNodes([
      {
        id: "queue",
        handler: { kind: "builtin", name: "queue:run" },
        needs: [],
        meta: { script: "queue" },
      },
    ]);
  }
}
