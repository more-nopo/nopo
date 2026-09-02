/** Per-script handler dispatch table from a live {@link Runner}. Each builtin name from a
 * script's `static plan()` (`"env:apply"`, `"build:exec"`, `"up:pre"`, …) routes here. The
 * table builds the per-script `Context` that each extracted handler expects, then invokes
 * it.
 */

import { isPackageService, resolveRuntimePlugin } from "./config/index.ts";
import {
  type BaseScript,
  exec,
  type LegacyScript,
  type Runner,
} from "./lib.ts";
import type { PlanHandler, PlanNode } from "./plan.ts";
import type { HandlerDispatch, PlanContext } from "./plan-runner.ts";
import type { HookContext } from "./plugin.ts";
import { queryQueue } from "./queue-client.ts";
import { ScriptArgs } from "./script-args.ts";
import { type ActPayload, actRun, type ActRunContext } from "./scripts/act.ts";
import {
  buildExec,
  type BuildExecPayload,
  type BuildOrchestrator,
  buildPackage,
  buildPost,
  buildPre,
  defaultHostBuild,
} from "./scripts/build.ts";
import {
  commandExec,
  type CommandExecPayload,
  commandPost,
  commandPre,
  executeCommandTask,
} from "./scripts/command.ts";
import {
  downMain,
  type DownPhaseContext,
  downPost,
  downPre,
} from "./scripts/down.ts";
import { envApply } from "./scripts/env.ts";
import { installRun } from "./scripts/install.ts";
import { listRun } from "./scripts/list.ts";
import { queueRun } from "./scripts/queue.ts";
import {
  type ParsedSecretArgs,
  secretGet,
  secretKeygen,
  secretList,
  secretRotateKey,
  type SecretRunContext,
  secretSet,
  secretUnset,
} from "./scripts/secret.ts";
import {
  statusMain,
  type StatusPhaseContext,
  statusPost,
  statusPre,
} from "./scripts/status.ts";
import { syncRun } from "./scripts/sync.ts";
import { upMain, type UpPhaseContext, upPost, upPre } from "./scripts/up.ts";

/** Each `handler.name` (`"env:apply"`, `"build:exec"`, ...) routes to the extracted handler
 * function in its script module, with the per-script `Context` constructed from the
 * Runner. `executePlan(plan, { dispatch: buildDispatch(runner), ... })` is the call site
 * this exists for; M6.2 wires it into `Runner.run()`.
 */
export function buildDispatch(runner: Runner): HandlerDispatch {
  return {
    pluginHook: (node, handler, ctx) =>
      dispatchPluginHook(runner, node, handler, ctx),
    builtin: (node, handler, ctx) =>
      dispatchBuiltin(runner, node, handler, ctx),
  };
}

// builtin dispatch

async function dispatchBuiltin(
  runner: Runner,
  node: PlanNode,
  handler: Extract<PlanHandler, { kind: "builtin" }>,
  _ctx: PlanContext,
): Promise<void> {
  switch (handler.name) {
    // env -----------------------------------------------------------------
    case "env:apply":
      return await envApply({
        environment: runner.environment,
        logger: runner.logger,
      });

    // build ---------------------------------------------------------------
    case "build:pre":
      return await buildPre({
        orchestrator: buildOrchestrator(runner),
        logger: runner.logger,
        payload: { targets: runner.resolvedTargets ?? [] },
      });
    case "build:exec":
      return await buildExec({
        orchestrator: buildOrchestrator(runner),
        logger: runner.logger,
        payload: asBuildExecPayload(node.payload),
      });
    case "build:post": {
      const postPayload = asBuildPostPayload(node.payload);
      return await buildPost({
        orchestrator: buildOrchestrator(runner),
        logger: runner.logger,
        payload: {
          targets: runner.resolvedTargets ?? [],
          ...(postPayload.output !== undefined
            ? { output: postPayload.output }
            : {}),
        },
      });
    }

    // up ------------------------------------------------------------------
    case "up:pre":
      return await upPre(buildUpPhaseCtx(runner, node));
    case "up:main":
      return await upMain(buildUpPhaseCtx(runner, node));
    case "up:post":
      return await upPost(buildUpPhaseCtx(runner, node));

    // down ----------------------------------------------------------------
    case "down:pre":
      return await downPre(buildDownPhaseCtx(runner, node));
    case "down:main":
      return await downMain(buildDownPhaseCtx(runner, node));
    case "down:post":
      return await downPost(buildDownPhaseCtx(runner, node));

    // status --------------------------------------------------------------
    case "status:pre":
      return await statusPre(buildStatusPhaseCtx(runner, node));
    case "status:main":
      return await statusMain(buildStatusPhaseCtx(runner, node));
    case "status:post":
      return await statusPost(buildStatusPhaseCtx(runner, node));

    // command -------------------------------------------------------------
    case "command:pre": {
      const payload = asCommandPrePayload(node.payload);
      return await commandPre({
        commandName: payload.commandName,
        targets: payload.targets,
        stageCount: payload.stageCount,
        logger: runner.logger,
      });
    }
    case "command:exec": {
      const payload = asCommandExecPayload(node.payload);
      return await commandExec({
        payload,
        runTask: (p) => executeCommandTask(runner, p),
      });
    }
    case "command:post": {
      const payload = asCommandPostPayload(node.payload);
      return await commandPost({
        commandName: payload.commandName,
        logger: runner.logger,
      });
    }

    // install -------------------------------------------------------------
    case "install:run":
      return await installRun({
        packageManagers: runner.getAllPackageManagers(),
        env: scriptEnv(runner),
        logger: runner.logger,
        exec,
      });

    // sync ----------------------------------------------------------------
    case "sync:run":
      return await syncRun({
        packageManagers: runner.getAllPackageManagers(),
        env: scriptEnv(runner),
        logger: runner.logger,
        exec,
      });

    // list ----------------------------------------------------------------
    case "list:run":
      return await listRun(buildListRunContext(runner));

    // queue ---------------------------------------------------------------
    case "queue:run":
      return await queueRun({
        io: runner.io,
        chalk: runner.logger.chalk,
        json: runner.argv.includes("--json") || runner.argv.includes("-j"),
        query: () => queryQueue(runner.io),
      });

    // act -----------------------------------------------------------------
    case "act:run":
      return await actRun(buildActCtx(runner, asActPayload(node.payload)));

    // secret --------------------------------------------------------------
    case "secret:keygen":
      return await secretKeygen(buildSecretRunContext(runner, node.payload));
    case "secret:set":
      return await secretSet(buildSecretRunContext(runner, node.payload));
    case "secret:list":
      return await secretList(buildSecretRunContext(runner, node.payload));
    case "secret:unset":
      return await secretUnset(buildSecretRunContext(runner, node.payload));
    case "secret:get":
      return await secretGet(buildSecretRunContext(runner, node.payload));
    case "secret:rotate-key":
      return await secretRotateKey(buildSecretRunContext(runner, node.payload));

    // legacy Back-compat for {@link LegacyScript}-derived custom scripts. The default
    // `LegacyScript.plan()` emits a single `legacy:fn` node whose payload carries the script
    case "legacy:fn":
      return await dispatchLegacyFn(runner, node.payload);

    default:
      throw new Error(`unknown builtin: ${handler.name}`);
  }
}

interface LegacyFnPayload {
  ScriptClass: typeof BaseScript;
}

function asLegacyFnPayload(payload: unknown): LegacyFnPayload {
  if (
    payload !== null &&
    typeof payload === "object" &&
    "ScriptClass" in payload &&
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing `payload`'s `ScriptClass` field after the `in` check
    typeof (payload as { ScriptClass: unknown }).ScriptClass === "function"
  ) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- shape-checked above
    return payload as LegacyFnPayload;
  }
  throw new Error("legacy:fn payload missing ScriptClass");
}

async function dispatchLegacyFn(
  runner: Runner,
  payload: unknown,
): Promise<void> {
  const { ScriptClass } = asLegacyFnPayload(payload);
  /* eslint-disable @typescript-eslint/consistent-type-assertions -- ScriptClass is a `LegacyScript` subclass; the abstract `BaseScript` constructor is only abstract at the type level */
  const Ctor = ScriptClass as unknown as new (r: Runner) => LegacyScript;
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
  const instance = new Ctor(runner);
  await instance.fn();
}

// per-script Context constructors

/** Adapt a {@link Runner} to the {@link BuildOrchestrator} surface that `buildPre` /
 * `buildExec` / `buildPost` consume. `fireBuildOverride` synthesizes a fresh per-target
 * {@link HookContext} and dispatches `runner.fireOverride("build", ...)`.
 * `defaultHostBuild` delegates to the extracted module-level helper in `scripts/build.ts`
 */
function buildOrchestrator(runner: Runner): BuildOrchestrator {
  const hookContext = (): HookContext => ({
    runner,
    args: new ScriptArgs({}, runner),
    graph: runner.buildGraph(),
    runtime: "default",
    ...runner.contextIO(),
  });
  return {
    async fireHooks(hookName) {
      await runner.fireHooks(hookName, hookContext());
    },
    async fireBuildOverride(_target) {
      return await runner.fireOverride("build", hookContext());
    },
    async defaultHostBuild(target) {
      await runBuildHostFallback(runner, target);
    },
  };
}

/** Mirrors the dispatch the legacy `BuildScript.fn()` does: packages go through
 * `buildPackage`, plain services go through `defaultHostBuild` (the extracted helper, not
 * the BuildOrchestrator method that calls back into here).
 */
async function runBuildHostFallback(
  runner: Runner,
  target: string,
): Promise<void> {
  const project = runner.config.project;
  const service = project.services.entries[target];
  if (!service) return;
  if (isPackageService(service)) {
    await buildPackage(runner, target);
    return;
  }
  await defaultHostBuild(runner, [target]);
}

/** UpScript / DownScript StatusScript all set `meta.runtime` from `scope.runtime` when
 * constructing the plan, so it's the canonical per-node source. Returns the literal
 * `--runtime` value when the user passed one, or `undefined` when they didn't. The plan
 * stores `"default"` for the unset case (`scope.runtime ?? "default"`); we map that back
 */
function nodeRuntime(node: PlanNode): string | undefined {
  const value = node.meta?.runtime;
  if (typeof value !== "string" || value === "default") return undefined;
  return value;
}

/** Build a fresh `ScriptArgs` and seed `runtime` from the node's meta so down / status
 * handlers (which still read `ctx.args.get("runtime")` to stay shape-compatible with the
 * legacy `fn()` path) see the same value the user passed on the CLI.
 */
function argsWithRuntime(
  runner: Runner,
  runtime: string | undefined,
): ScriptArgs {
  const args = new ScriptArgs({}, runner);
  if (runtime !== undefined) args.set("runtime", runtime);
  return args;
}

function buildUpPhaseCtx(runner: Runner, node: PlanNode): UpPhaseContext {
  const runtime = nodeRuntime(node);
  const pluginName = resolveRuntimePlugin(runner.config.project, runtime);
  return {
    runner,
    args: argsWithRuntime(runner, runtime),
    graph: runner.buildGraph(),
    runtime: runtime ?? "default",
    pluginName: pluginName ?? undefined,
    contextIO: runner.contextIO(),
  };
}

function buildDownPhaseCtx(runner: Runner, node: PlanNode): DownPhaseContext {
  const runtime = nodeRuntime(node);
  return {
    io: runner.io,
    args: argsWithRuntime(runner, runtime),
    runtime: runtime ?? "default",
    runner,
  };
}

function buildStatusPhaseCtx(
  runner: Runner,
  node: PlanNode,
): StatusPhaseContext {
  const runtime = nodeRuntime(node);
  return {
    io: runner.io,
    args: argsWithRuntime(runner, runtime),
    runtime: runtime ?? "default",
    runner,
  };
}

/**
 * Compose the env map the same way `BaseScript#env` does — used by
 * install / sync handlers when shelling out to package-manager commands.
 */
function scriptEnv(runner: Runner): Record<string, string | undefined> {
  return {
    ...runner.environment.processEnv,
    ...runner.environment.env,
    ...runner.environment.extraEnv,
  };
}

/** Build the {@link ListRunContext} from live `Runner` state. Centralized here so the
 * dispatch table forwards a fully-resolved context to {@link listRun}; the script module
 * owns the shape, the dispatcher owns the Runner→shape mapping. Arg sourcing: all of
 * `format` / `json` / `csv` / `jq` / `validate` come from the active script's parsed
 */
function buildListRunContext(
  runner: Runner,
): import("./scripts/list.ts").ListRunContext {
  const services = runner.resolvedTargets ?? runner.config.targets;
  const flags = parseListFlags(runner.argv);
  let format: "text" | "json" | "csv" =
    flags.format === "json" || flags.format === "csv" ? flags.format : "text";
  if (flags.json) format = "json";
  if (flags.csv) format = "csv";

  const ctx: import("./scripts/list.ts").ListRunContext = {
    services,
    entries: runner.config.project.services.entries,
    project: {
      name: runner.config.project.name,
      servicesDirs: runner.config.project.services.dirs,
    },
    format,
    validate: flags.validate,
    cwd: runner.config.root,
    io: runner.io,
    logger: runner.logger,
    exec,
  };
  if (flags.jq !== undefined) ctx.jqFilter = flags.jq;
  return ctx;
}

interface ListFlagState {
  format: string | undefined;
  json: boolean;
  csv: boolean;
  jq: string | undefined;
  validate: boolean;
}

/** Re-parse list's flags from `runner.argv`. `Runner.run()` already parsed them once via
 * `prepareScriptArgs`, but the dispatch table doesn't carry the resulting ScriptArgs
 * object. Re-parsing here keeps dispatch a pure function of `Runner` state. Mirrors
 * `ListScript.args` — string-typed `--format` / `--jq`, boolean `--json` / `--csv` /
 */
function parseListFlags(argv: readonly string[]): ListFlagState {
  const state: ListFlagState = {
    format: undefined,
    json: false,
    csv: false,
    jq: undefined,
    validate: false,
  };
  // Skip leading "list" (or whatever the command is); flags can appear
  // anywhere after.
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    const eq = tok.startsWith("--") ? tok.indexOf("=") : -1;
    const name = eq > 0 ? tok.slice(0, eq) : tok;
    const inlineVal = eq > 0 ? tok.slice(eq + 1) : undefined;
    switch (name) {
      case "--format": {
        state.format = inlineVal ?? argv[i + 1];
        if (eq < 0) i++;
        break;
      }
      case "--jq": {
        state.jq = inlineVal ?? argv[i + 1];
        if (eq < 0) i++;
        break;
      }
      case "--json":
      case "-j":
        state.json = true;
        break;
      case "--csv":
        state.csv = true;
        break;
      case "--validate":
      case "-v":
        state.validate = true;
        break;
      default:
        break;
    }
  }
  return state;
}

/** Build the {@link ActRunContext} from live `Runner` state and the plan node's payload.
 * The script's args were already baked into the payload by {@link
 * import("./scripts/act.ts").default.plan}; the dispatcher just wires `cwd` / `io` /
 * `logger` / `exec` from the runner.
 */
function buildActCtx(runner: Runner, payload: ActPayload): ActRunContext {
  const ctx: ActRunContext = {
    subcommand: payload.subcommand,
    event: payload.event,
    verbose: payload.verbose,
    inputs: payload.inputs,
    cwd: runner.config.root,
    io: runner.io,
    logger: runner.logger,
    exec,
  };
  if (payload.workflow !== undefined) ctx.workflow = payload.workflow;
  if (payload.job !== undefined) ctx.job = payload.job;
  return ctx;
}

/**
 * Build the {@link SecretRunContext} from live `Runner` state. The parsed
 * argv is carried verbatim on `payload.parsed` by
 * {@link import("./scripts/secret.ts").default.plan}.
 */
function buildSecretRunContext(
  runner: Runner,
  payload: unknown,
): SecretRunContext {
  return {
    parsed: asSecretPayload(payload).parsed,
    project: {
      getService: (id) => runner.getService(id),
      services: runner.config.project.services.entries,
    },
    io: runner.io,
    logger: runner.logger,
  };
}

// pluginHook dispatch

/** Dispatch a coalesced batch (or any other `plugin-hook` plan node) to the hook function
 * registered on the named plugin's `hooks` map. The {@link HookContext} mirrors the
 * factory used by {@link buildOrchestrator} for `build` overrides — same runner, args,
 * graph, runtime defaults, and IO surface. The plan node's `payload` flows through
 */
async function dispatchPluginHook(
  runner: Runner,
  node: PlanNode,
  handler: Extract<PlanHandler, { kind: "plugin-hook" }>,
  _ctx: PlanContext,
): Promise<void> {
  const loaded = runner.config.project.plugins.find(
    (p) => p.definition.name === handler.plugin,
  );
  if (!loaded) {
    throw new Error(
      `Plugin "${handler.plugin}" is not registered. Cannot dispatch hook "${handler.hook}".`,
    );
  }
  const hook = loaded.definition.hooks?.[handler.hook];
  if (!hook) {
    throw new Error(
      `Plugin "${handler.plugin}" defines no hook "${handler.hook}".`,
    );
  }

  const hookContext: HookContext = {
    runner,
    args: new ScriptArgs({}, runner),
    graph: runner.buildGraph(),
    runtime: "default",
    ...runner.contextIO(),
    payload: node.payload,
  };

  await hook(hookContext);
}

// payload narrowing

/** Plan node payloads are stored as `unknown` by design (handlers own their schemas). These
 * helpers narrow at the dispatch boundary so the downstream switch arms see the right
 * shape; a malformed payload would already have surfaced in the script's `static plan()`
 * test suite.
 */

function asBuildExecPayload(payload: unknown): BuildExecPayload {
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Plan.payload is `unknown`; build:exec contract owned by build.ts */
  return payload as BuildExecPayload;
}

/** `build:post` carries `{ output? }` so it can write build-info JSON. */
interface BuildPostNodePayload {
  output?: string;
}

function asBuildPostPayload(payload: unknown): BuildPostNodePayload {
  if (payload === undefined || payload === null) return {};
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Plan.payload is `unknown`; build:post contract owned by build.ts */
  return payload as BuildPostNodePayload;
}

interface CommandPrePayload {
  commandName: string;
  targets: readonly string[];
  stageCount: number;
}

function asCommandPrePayload(payload: unknown): CommandPrePayload {
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Plan.payload is `unknown`; command:pre contract owned by command.ts */
  return payload as CommandPrePayload;
}

function asCommandExecPayload(payload: unknown): CommandExecPayload {
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Plan.payload is `unknown`; command:exec contract owned by command.ts */
  return payload as CommandExecPayload;
}

interface CommandPostPayload {
  commandName: string;
}

function asCommandPostPayload(payload: unknown): CommandPostPayload {
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Plan.payload is `unknown`; command:post contract owned by command.ts */
  return payload as CommandPostPayload;
}

function asActPayload(payload: unknown): ActPayload {
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Plan.payload is `unknown`; act:run contract owned by act.ts */
  return payload as ActPayload;
}

interface SecretNodePayload {
  parsed: ParsedSecretArgs;
}

function asSecretPayload(payload: unknown): SecretNodePayload {
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Plan.payload is `unknown`; secret:* contract owned by secret.ts */
  return payload as SecretNodePayload;
}
