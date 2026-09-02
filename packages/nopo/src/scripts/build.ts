import fs from "node:fs";

import { baseArgs } from "../args.ts";
import {
  resolveCommandDag,
  serializeCommandDagAsShell,
} from "../command-dag.ts";
import {
  extractDependencyNames,
  isBuildCommandDeps,
  isPackageService,
  type NormalizedService,
} from "../config/index.ts";
import {
  type DepSource,
  exec,
  type Runner,
  type ScriptDependency,
  TargetScript,
} from "../lib.ts";
import { type Plan, planFromNodes, type PlanNode } from "../plan.ts";
import type { ScriptArgs } from "../script-args.ts";
import EnvScript from "./env.ts";

/** Per-target payload carried on a `build:<target>` plan node. */
export interface BuildExecPayload {
  /** Service id for this build target. */
  target: string;
  /** Whether to build without using cache. Default `false`. */
  noCache: boolean;
  /** Optional path to write build-info JSON. */
  output?: string;
  /** Optional comma-separated additional registries to push to. */
  registries?: string;
}

/** Build orchestrator surface used by {@link buildPre} / {@link buildExec} {@link
 * buildPost}. Defined locally rather than importing the full `Runner` class so the
 * handlers can be tested with a lightweight stub. Mirrors the slice of `Runner` that the
 * existing fn() reaches into: fire plugin hooks, look up a service, dispatch
 */
export interface BuildOrchestrator {
  /** Fire `pre_build` / `post_build` plugin hooks. */
  fireHooks(hookName: "pre_build" | "post_build"): Promise<void>;
  /**
   * Build a single service target. Returns `true` if a plugin override
   * handled it; `false` if the caller should fall through to a default
   * host build.
   */
  fireBuildOverride(target: string): Promise<boolean>;
  /** Run the default host build for a single non-package service. */
  defaultHostBuild(target: string): Promise<void>;
}

/** Minimal logger surface — matches `Runner#logger` (lib.ts:Logger). */
export interface BuildLogger {
  log(...args: unknown[]): void;
}

/** Inputs to {@link buildPre}. */
export interface BuildPreContext {
  orchestrator: BuildOrchestrator;
  logger: BuildLogger;
  payload: { targets: readonly string[] };
}

/** Inputs to {@link buildExec}. */
export interface BuildExecContext {
  orchestrator: BuildOrchestrator;
  logger: BuildLogger;
  payload: BuildExecPayload;
}

/** Inputs to {@link buildPost}. */
export interface BuildPostContext {
  orchestrator: BuildOrchestrator;
  logger: BuildLogger;
  payload: { targets: readonly string[]; output?: string; results?: unknown };
}

/**
 * `pre_build` slot node handler. Fires every registered plugin's
 * `pre_build` hook in plugin declaration order.
 */
export async function buildPre(ctx: BuildPreContext): Promise<void> {
  await ctx.orchestrator.fireHooks("pre_build");
}

/**
 * Per-target main-slot handler. Builds a single service: tries any
 * registered `build` override first; falls back to the default host
 * build if no plugin claimed it.
 */
export async function buildExec(ctx: BuildExecContext): Promise<void> {
  const { target } = ctx.payload;
  const overridden = await ctx.orchestrator.fireBuildOverride(target);
  if (!overridden) {
    await ctx.orchestrator.defaultHostBuild(target);
  }
}

/**
 * `post_build` slot node handler. Fires every registered plugin's
 * `post_build` hook in plugin declaration order. Optionally writes a
 * build-info JSON file at `payload.output` if supplied.
 */
export async function buildPost(ctx: BuildPostContext): Promise<void> {
  await ctx.orchestrator.fireHooks("post_build");
  if (ctx.payload.output !== undefined) {
    fs.writeFileSync(
      ctx.payload.output,
      JSON.stringify(ctx.payload.results ?? {}),
    );
  }
}

export default class BuildScript extends TargetScript {
  static override name = "build";
  static override description = "Build targets";
  // Docker image builds (all services, cold cache) legitimately run far past
  // the 5-minute default — give them 30 minutes. Override with --timeout.
  static override timeoutMs = 30 * 60 * 1000;
  /** Build resolution follows full deps so runtime prerequisites are included. */
  static override depSource: DepSource[] = ["build", "runtime"];
  // No universal preFilters — the "buildable" filter is only applied conditionally by the
  // Runner when --changed or --with-dependants is active, to strip non-buildable packages
  static override dependencies: ScriptDependency[] = [
    {
      class: EnvScript,
      enabled: true,
    },
  ];

  static override args = baseArgs.extend({
    "no-cache": {
      type: "boolean",
      description: "Build without using cache",
      default: false,
    },
    output: {
      type: "string",
      description: "Path to write build info JSON",
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- undefined default for optional arg, typed as string when provided
      default: undefined as unknown as string,
    },
    registries: {
      type: "string",
      description:
        "Comma-separated additional registries to push to (e.g., us-central1-docker.pkg.dev/project/repo)",
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- undefined default for optional arg, typed as string when provided
      default: undefined as unknown as string,
    },
  });

  /**
   * Returns extra targets that should be valid for this script.
   * Build script adds rootName (e.g., "root") as a valid target.
   */
  static getExtraTargets(runner: Runner): string[] {
    return [runner.config.project.rootName];
  }

  /** `pre_build` → one `build:<target>` per buildable target → `post_build`. Empty target
   * lists still emit pre/post so plugin hooks fire. service without a `build.command`, are
   * dropped — they have nothing to dispatch (the legacy `fn()` skipped them silently via
   * `buildPackages`' pre-filter and `defaultHostBuild`'s service-only loop). Dep ordering
   */
  static plan(
    args: ScriptArgs,
    scope: {
      targets: readonly string[];
      /** Service map from `runner.config.project.services.entries`. When omitted (e.g. low-level
       * shape unit tests that pass synthetic target ids), no filtering or dep-edge encoding
       * happens — the caller is responsible for passing only buildable targets.
       */
      entries?: Record<string, NormalizedService>;
    },
  ): Plan {
    const noCache = args.get<boolean>("no-cache") ?? false;
    const output = args.get<string>("output");
    const registries = args.get<string>("registries");

    const entries = scope.entries;

    // Drop targets that have no node to dispatch: missing service (resolver let an unknown
    // name through) package service without build.command
    const buildableTargets =
      entries === undefined
        ? [...scope.targets]
        : scope.targets.filter((t) => {
            const svc = entries[t];
            if (!svc) return false;
            if (isPackageService(svc) && !svc.build?.command) return false;
            return true;
          });

    const execIdSet = new Set(buildableTargets.map((t) => `build:${t}`));
    const execIds = buildableTargets.map((t) => `build:${t}`);

    // Package build nodes — service builds wait on all of them so the legacy "all packages
    // first, then services" ordering
    const packageBuildIds =
      entries === undefined
        ? []
        : buildableTargets
            .filter((t) => {
              const svc = entries[t];
              return svc !== undefined && isPackageService(svc);
            })
            .map((t) => `build:${t}`);

    const preNode: PlanNode = {
      id: "pre_build",
      handler: { kind: "builtin", name: "build:pre" },
      needs: [],
      meta: { script: "build" },
    };

    const execNodes: PlanNode[] = buildableTargets.map((target, i) => {
      const payload: BuildExecPayload = { target, noCache };
      if (output !== undefined) payload.output = output;
      if (registries !== undefined) payload.registries = registries;

      // Encode build.deps as `needs` edges so dispatched nodes respect the same ordering today's
      // serial `buildPackages → defaultHostBuild` pipeline produced. Only deps that landed
      const svc = entries?.[target];
      const depEdges =
        svc !== undefined
          ? svc.buildDeps
              .map((d) => `build:${d}`)
              .filter((id) => execIdSet.has(id))
          : [];

      const isPackage = svc !== undefined && isPackageService(svc);
      const ownId = `build:${target}`;
      const allPackageEdges =
        svc === undefined || isPackage
          ? []
          : packageBuildIds.filter((id) => id !== ownId);

      const needs = ["pre_build", ...depEdges, ...allPackageEdges];
      // Dedup while preserving order so a dep that's also a package
      // shows up exactly once.
      const dedupedNeeds = Array.from(new Set(needs));

      return {
        id: execIds[i]!,
        handler: { kind: "builtin", name: "build:exec" },
        needs: dedupedNeeds,
        target,
        payload,
        meta: { script: "build" },
      };
    });

    const postNode: PlanNode = {
      id: "post_build",
      handler: { kind: "builtin", name: "build:post" },
      // When there are no exec nodes, post still depends on pre so plugin
      // hooks fire in order even on a no-op build.
      needs: execIds.length > 0 ? execIds : ["pre_build"],
      // Carry `output` so the post-handler can write `{}` to the build-info path even on an
      // empty `--changed` build
      payload: output !== undefined ? { output } : undefined,
      meta: { script: "build" },
    };

    return planFromNodes([preNode, ...execNodes, postNode]);
  }
}

// Module-level host-build helpers Consumed by `dispatch.ts` so the plan-runner can execute
// host builds without instantiating a `BuildScript`.

/** Logger surface matching `Runner#logger` — only `log()` is used here. */
function logBuild(runner: Runner, ...message: unknown[]): void {
  runner.logger.log(runner.logger.chalk.yellow(...message));
}

/** Compose the env map the same way `Script#env` does. */
function buildEnv(runner: Runner): Record<string, string | undefined> {
  return {
    ...runner.environment.processEnv,
    ...runner.environment.env,
    ...runner.environment.extraEnv,
  };
}

/** Default host-based build when no plugin overrides the build hook. Runs `build.command`
 * on host for each non-package service. @public — consumed by the upcoming Phase 4
 * dispatch table (M6.2).
 */
export async function defaultHostBuild(
  runner: Runner,
  targets: string[],
): Promise<void> {
  const serviceTargets =
    targets.length > 0
      ? targets.filter((t) => {
          const service = runner.config.project.services.entries[t];
          return service && !isPackageService(service);
        })
      : runner.config.targets.filter((t) => {
          const service = runner.config.project.services.entries[t];
          return service && !isPackageService(service);
        });

  for (const target of serviceTargets) {
    const service = runner.getService(target);
    if (!service.build?.command) continue;

    logBuild(runner, `Building '${target}' on host...`);
    const shellScript = resolveBuildCommandScript(service);
    const result = await exec("sh", ["-c", shellScript], {
      cwd: service.paths.root,
      env: { ...buildEnv(runner), ...service.build.env },
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Service '${target}' build failed with exit code ${result.exitCode}\n${result.stderr}`,
      );
    }
    logBuild(runner, `Service '${target}' built successfully`);
  }
}

/** Build all package services (those satisfying `isPackageService`) that either appear in
 * `requestedTargets` or are reachable as build deps of the requested targets.
 * Topologically ordered so leaf deps build first. @public — consumed by the upcoming Phase
 * 4 dispatch table (M6.2).
 */
export async function buildPackages(
  runner: Runner,
  requestedTargets: string[],
): Promise<void> {
  const targets = runner.config.targets;

  // Skip packages without build.command — they're dependencies
  // pulled in by the target resolver, not explicit build targets.

  const allPackages = targets.filter((t) => {
    const service = runner.getService(t);
    return isPackageService(service) && service.build?.command;
  });

  if (allPackages.length === 0) return;

  const packagesToConsider =
    requestedTargets.length > 0
      ? requestedTargets.filter((t) => allPackages.includes(t))
      : allPackages;

  const packagesWithDeps = resolvePackageDependencies(
    runner,
    requestedTargets.length > 0 ? requestedTargets : targets,
    allPackages,
  );

  const packagesToBuild = [
    ...new Set([...packagesToConsider, ...packagesWithDeps]),
  ];

  if (packagesToBuild.length === 0) return;

  const sortedPackages = sortPackagesByDependency(runner, packagesToBuild);

  logBuild(
    runner,
    `Building ${sortedPackages.length} package(s): ${sortedPackages.join(", ")}`,
  );

  for (const packageName of sortedPackages) {
    await buildPackage(runner, packageName);
  }
}

/**
 * Walk `build.depends_on` from each target and collect any deps that are
 * themselves package services. Throws if a dep is a package without a
 * `build.command`.
 */
function resolvePackageDependencies(
  runner: Runner,
  targets: string[],
  allPackages: string[],
): string[] {
  const packageDeps = new Set<string>();
  const visited = new Set<string>();

  const collectDeps = (targetName: string) => {
    if (visited.has(targetName)) return;
    visited.add(targetName);

    const service = runner.config.project.services.entries[targetName];
    if (!service) return;

    const buildDepsField = service.build?.depends_on;
    const deps = buildDepsField ? extractDependencyNames(buildDepsField) : [];

    for (const dep of deps) {
      const depService = runner.config.project.services.entries[dep];
      if (
        depService &&
        isPackageService(depService) &&
        !depService.build?.command
      ) {
        throw new Error(
          `Package dependency '${dep}' of '${targetName}' cannot be built because it does not define build.command`,
        );
      }
      if (allPackages.includes(dep)) {
        packageDeps.add(dep);
        collectDeps(dep);
      }
    }
  };

  for (const target of targets) {
    collectDeps(target);
  }

  return Array.from(packageDeps);
}

/**
 * Topological sort of `packages` by `build.depends_on`. Throws on cycles.
 */
function sortPackagesByDependency(
  runner: Runner,
  packages: string[],
): string[] {
  const packageSet = new Set(packages);
  const result: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(
        `Circular dependency detected involving package '${name}'`,
      );
    }

    visiting.add(name);

    const service = runner.config.project.services.entries[name];
    if (service) {
      const buildDepsField = service.build?.depends_on;
      const deps = buildDepsField ? extractDependencyNames(buildDepsField) : [];
      for (const dep of deps) {
        if (packageSet.has(dep)) visit(dep);
      }
    }

    visiting.delete(name);
    visited.add(name);
    result.push(name);
  };

  for (const pkg of packages) {
    visit(pkg);
  }

  return result;
}

/**
 * Build a single package service on host using its `build.command`.
 *
 * @public — consumed by the upcoming Phase 4 dispatch table (M6.2).
 */
export async function buildPackage(
  runner: Runner,
  packageName: string,
): Promise<void> {
  const service = runner.getService(packageName);
  if (!service.build?.command) {
    throw new Error(`Package '${packageName}' has no build command configured`);
  }

  logBuild(runner, `Building package '${packageName}'...`);

  const shellScript = resolveBuildCommandScript(service);
  const result = await exec("sh", ["-c", shellScript], {
    cwd: service.paths.root,
    env: { ...buildEnv(runner), ...service.build.env },
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Package '${packageName}' build failed with exit code ${result.exitCode}\n${result.stderr}`,
    );
  }

  logBuild(runner, `Package '${packageName}' built successfully`);
}

/** Resolve `service.build.command` to a plain shell script. Legacy string commands pass
 * through untouched. `{ deps: [...] }` commands get resolved against the service's own
 * top-level commands via the shared DAG primitive, then serialized to shell — the same
 * primitive the docker plugin uses for its heredoc RUN, so host and docker builds stay
 */
function resolveBuildCommandScript(service: NormalizedService): string {
  const cmd = service.build?.command;
  if (cmd === undefined) {
    throw new Error(`Service '${service.id}' has no build command`);
  }
  if (!isBuildCommandDeps(cmd)) {
    return cmd;
  }
  const steps = resolveCommandDag({
    serviceId: service.id,
    commands: service.commands,
    roots: cmd.deps,
  });
  return serializeCommandDagAsShell(steps);
}
