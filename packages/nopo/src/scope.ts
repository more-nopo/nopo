/** Per-script scope construction shared by `print.ts` (the --print path) and `lib.ts` (the
 * live `Runner.run()` execution path). Each built-in script that exposes `static
 * plan(args, scope)` expects a scope shape unique to it
 */

import {
  buildExecutionPlan,
  resolveServiceCommandPath,
} from "./commands/index.ts";
import type { BaseScript, Runner } from "./lib.ts";
import type { Plan } from "./plan.ts";
import type { ScriptArgs } from "./script-args.ts";
import type { CommandPlanScope, CommandStage } from "./scripts/command.ts";

/* eslint-disable @typescript-eslint/consistent-type-assertions -- optional `static plan` not on BaseScript */
type StaticPlanFn = (args: ScriptArgs, scope: unknown) => Plan;

/** Returns the script's `static plan` function if present, else `null`. The returned
 * function is bound to its owning class so that callers can invoke it as a plain function
 * while `LegacyScript`-style implementations (which read `this.name` to wire the
 * dispatched script class) still see the right `this`.
 */
export function getStaticPlan(
  ScriptClass: typeof BaseScript,
): StaticPlanFn | null {
  const planFn = (ScriptClass as unknown as { plan?: StaticPlanFn }).plan;
  return typeof planFn === "function" ? planFn.bind(ScriptClass) : null;
}
/* eslint-enable @typescript-eslint/consistent-type-assertions */

/** Build the per-script scope from live `Runner` state. Returns `null` when the scope
 * genuinely can't be assembled (e.g. CommandScript with no command name on argv) — the
 * caller surfaces that as an error. Scope shapes: `env` → `{}` `up`/`down`/`status` → `{
 * runtime }` `build` → `{ targets }` CommandScript (`name === ""`) → `CommandPlanScope`
 */
export function buildScopeForScript(
  runner: Runner,
  ScriptClass: typeof BaseScript,
  args: ScriptArgs,
): unknown | null {
  const name = ScriptClass.name;

  if (name === "env") return {};

  if (name === "up" || name === "down" || name === "status") {
    const runtime = args.get<string | undefined>("runtime") ?? "default";
    return { runtime };
  }

  if (name === "build") {
    const targets = runner.resolvedTargets ?? [];
    return { targets, entries: runner.config.project.services.entries };
  }

  // install / sync / list all share the same scope shape — `{ targets }`. The dispatcher
  // reads the rest (PMs, format, etc.) from the live Runner so the plan stays minimal.
  if (name === "install" || name === "sync" || name === "list") {
    const targets = runner.resolvedTargets ?? runner.config.targets;
    return { targets };
  }

  // act parses its subcommand from argv (it's the first positional after `act`, not a
  // declared flag). Pre-resolve here so plan() stays pure. Inlined rather than imported
  if (name === "act") {
    return { subcommand: firstPositional(runner.argv.slice(1)) };
  }

  // secret carries the raw argv — its plan() does its own argv parse and emits a
  // verb-specific handler name. The argv slice starts at the command name ("secret") which
  if (name === "secret") {
    return { argv: runner.argv };
  }

  // CommandScript sets `static override name = ""` — there's no static string id we can
  // match against, and importing the class value here would create a load-order cycle
  if (name === "") {
    return buildCommandScope(runner, args);
  }

  // Out-of-tree scripts (e.g. `LegacyScript` subclasses) don't need a specific scope shape —
  // their `plan()` ignores it. Return an empty object so the dispatcher can still build
  return {};
}

/** Resolve {@link CommandScript}'s scope from live `Runner` state. Returns `null` when the
 * command name isn't on argv (e.g. bare `nopo`, or a script whose dispatcher reaches
 * CommandScript without setting argv[0]) — `plan()` would have nothing to fan out across.
 */
function buildCommandScope(
  runner: Runner,
  args: ScriptArgs,
): CommandPlanScope | null {
  const commandName = runner.argv[0];
  if (!commandName) return null;
  const targets = runner.resolvedTargets ?? [];

  // Targets can resolve the SAME user-typed name to DIFFERENT paths: `makemigrations` is
  // top-level on the Django backend but nested at `db:makemigrations` on af-api. Resolve
  const entries = runner.config.project.services.entries;
  const commandPaths = new Map<string, string>();
  for (const target of targets) {
    const service = entries[target];
    if (!service) continue;
    const { path } = resolveServiceCommandPath(service, commandName);
    if (path !== null) commandPaths.set(target, path);
  }

  // `CommandScript.targetFilter` deliberately retains AMBIGUOUS services (`lint` matching
  // both `check:lint` and `fix:lint`) so the dispatch guard can name the candidates. Feeding
  const plannable = targets.filter((t) => commandPaths.has(t));

  const { stages: rawStages } = buildExecutionPlan(
    runner.config.project,
    commandName,
    plannable,
    commandPaths,
  );
  // Args after a bare `--` go to EVERY resolved task. nopo is a generic appends verbatim and
  // lets the tool complain. Each arg is single-quoted because the executable string is
  const dashIndex = runner.argv.indexOf("--");
  const passthrough = dashIndex >= 0 ? runner.argv.slice(dashIndex + 1) : [];
  const suffix = passthrough
    .map((a) => `'${a.replaceAll("'", `'\\''`)}'`)
    .join(" ");
  const stages: CommandStage[] = rawStages.map((tasks, index) => ({
    index,
    tasks: suffix
      ? tasks.map((t) => ({ ...t, executable: `${t.executable} ${suffix}` }))
      : tasks,
  }));
  // CLI override for execution context (`--context host|container`).
  // CommandScript.parseCommandArgs validates the value strictly upstream
  const ctxRaw = args.get<string | undefined>("context");
  const contextOverride =
    ctxRaw === "host" || ctxRaw === "container" ? ctxRaw : undefined;
  return {
    commandName,
    targets,
    stages,
    ...(contextOverride !== undefined ? { contextOverride } : {}),
    ...(passthrough.length > 0 ? { passthrough } : {}),
  };
}

/** Find the first non-flag positional in `argv`. Mirrors `minimist(argv)._[0]` for the
 * narrow case that act needs to extract its subcommand: skip any `-flag` / `--flag value`
 * pairs and return the first bare token. Tokens are skipped greedily — `-w ci.yml`
 * consumes both, then `run` is the first positional. We don't know the schema here, so any
 */
function firstPositional(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok === "--") {
      return argv[i + 1];
    }
    if (tok.startsWith("--")) {
      // --flag=value: single token, advance by 1.
      if (tok.includes("=")) continue;
      // --flag value: skip the value too, unless next token is itself a flag.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) i++;
      continue;
    }
    if (tok.startsWith("-")) {
      // -f or -f value
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) i++;
      continue;
    }
    return tok;
  }
  return undefined;
}
