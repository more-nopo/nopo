import { Script } from "../lib.ts";
import { type Plan, planFromNodes } from "../plan.ts";
import { ScriptArgs } from "../script-args.ts";

/** Tuple shape from Environment#diff: `[name, value]`. Local structural alias — keeps
 * env.ts decoupled from `parse-env.ts`'s private types while matching them at runtime.
 */
export type EnvDiffEntry = readonly [string, string | undefined];

/**
 * Diff buckets the env section logger walks. Mirrors
 * `Environment#diff` (parse-env.ts) — local structural alias so this
 * module doesn't widen `parse-env.ts`'s public surface.
 */
export interface EnvDiff {
  added: readonly EnvDiffEntry[];
  updated: readonly EnvDiffEntry[];
  removed: readonly EnvDiffEntry[];
  unchanged: readonly EnvDiffEntry[];
}

/** The narrow surface of `Runner#environment` that {@link envApply} touches. Defined
 * locally rather than importing the full `Environment` class so the `envApply` builtin can
 * be tested with a lightweight stub and so this module doesn't widen `parse-env.ts`.
 */
export interface EnvSource {
  envFile: string;
  hasPrevEnv: boolean;
  diff: EnvDiff;
  save(): void;
}

/** A chalk-style colorizer: callable + chainable enough for our use. */
type Colorize = (...args: unknown[]) => string;

/**
 * The subset of the `chalk` surface {@link envApply} uses. Defined
 * locally so tests can pass a trivial stub (e.g. identity functions)
 * without dragging in the real chalk instance.
 */
export interface ChalkLike {
  magenta: Colorize;
  yellow: Colorize;
  white: Colorize;
  red: Colorize;
  gray: Colorize;
  underline: Colorize;
}

/**
 * Logger surface {@link envApply} uses — just `log()` and `chalk`.
 * Matches the relevant slice of `Runner#logger` (lib.ts:Logger).
 */
export interface EnvLogger {
  log(...args: unknown[]): void;
  chalk: ChalkLike;
}

/** Inputs to {@link envApply}. */
export interface EnvApplyContext {
  environment: EnvSource;
  logger: EnvLogger;
}

/**
 * Saves the resolved env file and logs the added / updated / removed /
 * unchanged sections. Backs the `"env:apply"` builtin and is also the
 * single source of truth for {@link EnvScript.fn}.
 */
export async function envApply(ctx: EnvApplyContext): Promise<void> {
  const { environment, logger } = ctx;
  const { chalk } = logger;

  environment.save();

  const colors = {
    added: chalk.magenta,
    updated: chalk.yellow,
    unchanged: chalk.white,
    removed: chalk.red,
    background: chalk.gray,
  } as const;

  const action = environment.hasPrevEnv ? "Updated" : "Created";
  const actionColor = environment.hasPrevEnv ? colors.updated : colors.added;
  const title = `${action}: ${actionColor(environment.envFile)}`;
  const breakLine = chalk.gray(Array(title.length).fill("-").join(""));

  logger.log(title);
  logger.log(breakLine);

  const diffKeys = ["added", "updated", "removed", "unchanged"] as const;
  for (const key of diffKeys) {
    const section = environment.diff[key];
    if (section.length === 0) continue;
    const colorFn = colors[key];
    logger.log(chalk.underline(colorFn(key)));
    for (const [name, value] of section) {
      logger.log(`${colors.background(name)}: ${colorFn(value ?? "")}`);
    }
  }

  // satisfies the async return contract; behavior is sync.
  return await Promise.resolve();
}

export default class EnvScript extends Script {
  static override skipQueue = true; // instant, read-only — never wait
  static override name = "env";
  static override description = "Set up environment variables";

  static override args = new ScriptArgs({});

  /** Single-node plan dispatching to {@link envApply} via `"env:apply"`. */
  static plan(_args: ScriptArgs): Plan {
    return planFromNodes([
      {
        id: "env",
        handler: { kind: "builtin", name: "env:apply" },
        needs: [],
        meta: { script: "env" },
      },
    ]);
  }
}
