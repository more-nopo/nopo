import type { NormalizedService } from "./config/index.ts";
import type { FilterExpression } from "./filter.ts";
import { parseFilterExpression, parseSinceArg } from "./filter.ts";
import type { BaseScript, Runner } from "./lib.ts";
import { type Plan, type SerializedPlan, serializePlan } from "./plan.ts";
import { type CompactionContext, compactPlan } from "./plan-compact.ts";
import { buildScopeForScript, getStaticPlan } from "./scope.ts";
import { ScriptArgs } from "./script-args.ts";

/** Which plan flavor `--print` should serialize. `"compacted"` (default) — the
 * post-compaction plan, i.e. the one that actually runs at execution time. This is the
 * plan a user should reason about: every batch-fold a plugin would apply is already
 * reflected in the output. `"raw"` — the pre-compaction plan returned by `static plan()`
 */
export type PrintMode = "compacted" | "raw";

/**
 * The JSON schema output for --print dry-run mode.
 * CI workflows parse this with `jq -r '.services | join(" ")'`.
 */
export interface DryRunOutput {
  /** Final resolved targets (CI-compat: same as finalTargets) */
  services: string[];
  /** The command name (e.g., "up", "build", "test") */
  command: string;
  /** All available targets before filtering */
  targets: string[];
  /** Targets from explicit argv / --filter (before --changed / graph expansion) */
  filteredTargets: string[];
  /** Final targets after the full pipeline (same as services) */
  finalTargets: string[];
  /** Dependency graph for final targets: target -> its dependencies */
  dependencies: Record<string, string[]>;
  /** Dependants that were added by --with-dependants */
  dependants: string[];
  /** Active filter expressions */
  filters: FilterExpression[];
  /** Since configuration (per-service or global) */
  since: Record<string, string> | string | null;
  /** Loaded plugin names */
  plugins: string[];
  /** Script dependencies (e.g., build depends on env) */
  scriptDependencies: Array<{ name: string; enabled: boolean }>;
  /**
   * Execution-DAG snapshot from `script.plan(args, scope)`. `null` for
   * scripts that don't expose `static plan()`. Strictly additive — does
   * not affect any existing field.
   */
  plan: SerializedPlan | null;
}

/** Builds the per-script scope from runner state (via {@link buildScopeForScript}) and
 * calls `ScriptClass.plan?.(args, scope)`. Returns `null` for scripts without a `static
 * plan()` or whose scope can't yet be resolved. When {@link printMode} is `"compacted"`
 * (default) the returned plan is passed through {@link compactPlan} using
 */
function tryBuildPlan(
  runner: Runner,
  ScriptClass: typeof BaseScript,
  scriptArgs: ScriptArgs | undefined,
  printMode: PrintMode,
  compactionCtx: CompactionContext | null,
): Plan | null {
  const planFn = getStaticPlan(ScriptClass);
  if (planFn === null) return null;

  const args = scriptArgs ?? new ScriptArgs({});
  try {
    const scope = buildScopeForScript(runner, ScriptClass, args);
    if (scope === null) return null;
    const raw = planFn(args, scope);
    if (printMode === "raw" || compactionCtx === null) return raw;
    return compactPlan(raw, compactionCtx);
  } catch {
    // Don't break --print on a partial-resolution plan() failure;
    // the resolution snapshot is still useful on its own.
    return null;
  }
}

interface CollectDryRunInfoParams {
  runner: Runner;
  ScriptClass: typeof BaseScript;
  scriptArgs: ScriptArgs | undefined;
  depMap: Map<typeof BaseScript, boolean[]>;
  withDependants: (
    filteredServices: string[],
    entries: Record<string, NormalizedService>,
    allServices: string[],
  ) => string[];
  withDependencies: (
    filteredServices: string[],
    entries: Record<string, NormalizedService>,
    allServices: string[],
  ) => string[];
  /**
   * Which plan flavor to serialize on the `plan` field. Defaults to
   * `"compacted"` — the plan that actually runs at execution time.
   * Callers wire this from `--print` vs `--print=raw`.
   */
  printMode?: PrintMode;
  /** Compaction context — the same one `runViaPlan` builds before calling {@link
   * compactPlan}. Required for the compaction pass; if `null`, the raw plan is returned
   * regardless of {@link printMode} (degraded mode: callers that don't have a compaction
   * context yet still get a plan snapshot rather than `null`).
   */
  compactionCtx?: CompactionContext | null;
}

/**
 * Collect dry-run information from the resolved CLI state.
 * This is called by Runner.run() when --print is set, after resolveExecutionPlan().
 * The runner already holds the final resolved targets -- we just report them.
 */
export function collectDryRunInfo(
  params: CollectDryRunInfoParams,
): DryRunOutput {
  const { runner, ScriptClass, scriptArgs, depMap } = params;

  const project = runner.config.project;
  const entries = project.services.entries;
  const allTargets = project.services.targets;

  // Command name: use argv[0] or the script's static name
  const command = runner.argv[0] || ScriptClass.name || "unknown";

  // The runner already resolved everything in resolveExecutionPlan().
  // We read the final result from runner.resolvedTargets.
  const finalTargets = runner.resolvedTargets ?? [];

  // Pre-expansion targets: what the pipeline produced before --with-dependants/--with-dependencies
  const preExpansion = runner.preExpansionTargets ?? finalTargets;

  // Extract reporting info from ScriptArgs
  let filters: FilterExpression[] = [];
  let sinceInfo: Record<string, string> | string | null = null;
  let filteredTargets: string[] = [...preExpansion];

  if (scriptArgs) {
    // Reconstruct filteredTargets: explicit argv targets (before --changed/graph expansion)
    // When --changed is active, use preExpansionTargets
    const changed = scriptArgs.get<boolean>("changed") ?? false;
    if (changed) {
      filteredTargets = [...preExpansion];
    } else {
      const explicitTargets = scriptArgs.get<string[]>("targets") ?? [];
      filteredTargets =
        explicitTargets.length > 0 ? [...explicitTargets] : [...allTargets];
    }

    // Extract filter info for reporting
    const filterValue = scriptArgs.get<string[] | undefined>("filter");
    if (filterValue) {
      const filterArgs = filterValue
        .flatMap((v: string) => v.split(","))
        .filter(Boolean);
      filters = filterArgs.map(parseFilterExpression);
    }

    // Report --changed as a filter
    if (changed) {
      filters.push(parseFilterExpression("changed"));
    }

    // Extract since info
    const sinceRaw = scriptArgs.get<string | undefined>("since");
    if (sinceRaw) {
      const parsed = parseSinceArg(sinceRaw);
      if (parsed.sinceMap) {
        sinceInfo = parsed.sinceMap;
      } else if (parsed.since) {
        sinceInfo = parsed.since;
      }
    }
  }

  // Compute dependants that were added by --with-dependants
  // (targets in finalTargets that weren't in the pre-expansion set)
  const preExpansionSet = new Set(preExpansion);
  const addedDependants = finalTargets.filter((t) => !preExpansionSet.has(t));

  // Build dependency map for final targets
  const dependencyMap: Record<string, string[]> = {};
  for (const targetId of finalTargets) {
    const service = entries[targetId];
    if (service) {
      const allDeps = [
        ...new Set([...service.buildDeps, ...service.runtimeDeps]),
      ];
      dependencyMap[targetId] = allDeps.filter((dep) =>
        finalTargets.includes(dep),
      );
    } else {
      dependencyMap[targetId] = [];
    }
  }

  // Collect plugin info
  const pluginNames = project.plugins.map((p) => p.definition.name);

  // Collect script dependency info
  const scriptDependencies: Array<{ name: string; enabled: boolean }> = [];
  for (const [DepScript, enabledArr] of depMap.entries()) {
    scriptDependencies.push({
      name: DepScript.name,
      enabled: enabledArr.some(Boolean),
    });
  }

  const printMode: PrintMode = params.printMode ?? "compacted";
  const compactionCtx = params.compactionCtx ?? null;
  const builtPlan = tryBuildPlan(
    runner,
    ScriptClass,
    scriptArgs,
    printMode,
    compactionCtx,
  );
  const plan: SerializedPlan | null = builtPlan
    ? serializePlan(builtPlan)
    : null;

  return {
    services: finalTargets,
    command,
    targets: allTargets,
    filteredTargets,
    finalTargets,
    dependencies: dependencyMap,
    dependants: addedDependants,
    filters,
    since: sinceInfo,
    plugins: pluginNames,
    scriptDependencies,
    plan,
  };
}
