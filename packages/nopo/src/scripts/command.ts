import path from "node:path";

import { baseArgs } from "../args.ts";
import {
  findCommandNode,
  type ResolvedCommand,
  resolveServiceCommandPath,
} from "../commands/index.ts";
import type { CommandContext, NormalizedService } from "../config/index.ts";
import { expandEnvValues } from "../expand-env.ts";
import type { FilterExpression } from "../filter.ts";
import {
  applyFiltersToNames,
  type FilterContext,
  parseFilterExpression,
  parseSinceArg,
} from "../filter.ts";
import {
  createLogger,
  exec,
  minimist,
  type Runner,
  Script,
  type ScriptDependency,
} from "../lib.ts";
import { type Plan, planFromNodes, type PlanNode } from "../plan.ts";
import { ScriptArgs } from "../script-args.ts";
import BuildScript from "./build.ts";
import EnvScript from "./env.ts";
import { isBuild } from "./up.ts";

function resolveNamespace(runner: Runner): string {
  const env = runner.io.env;
  if (env.CI === "true" && env.GITHUB_RUN_ID) {
    return `nopo-ci-${env.GITHUB_RUN_ID}`;
  }
  return "nopo-dev";
}

/**
 * Check if any target container is down.
 */
async function hasDownContainer(
  runner: Runner,
  targets: string[],
): Promise<boolean> {
  if (targets.length === 0) return false;

  const namespace = resolveNamespace(runner);

  try {
    const result = await exec(
      "kubectl",
      [
        "get",
        "pods",
        "-n",
        namespace,
        "-o",
        "jsonpath={.items[*].metadata.labels.app}",
      ],
      {
        cwd: runner.config.root,
        nothrow: true,
        silent: true,
      },
    );

    if (result.exitCode !== 0) return true; // namespace doesn't exist = everything is down

    const runningApps = result.stdout.trim().split(/\s+/);

    for (const target of targets) {
      if (!runningApps.includes(target)) {
        return true;
      }
    }
    return false;
  } catch {
    return true; // k8s not available = treat as down
  }
}

type CommandScriptArgs = {
  command: string;
  targets: string[];
  filters: FilterExpression[];
  since?: string;
  explicitTargets: boolean;
  contextOverride?: CommandContext; // CLI override for execution context
  changed: boolean;
  withDependants: boolean;
  skipMissing: boolean;
  noFailFast: boolean;
  print: boolean;
  /**
   * Everything after a bare `--`, appended verbatim to every task's
   * command line. Lets a caller reach the underlying tool without nopo
   * knowing its flags: `nopo integration api -- --shard=1/2`.
   */
  passthrough: string[];
};

/**
 * Check if any task will execute in container context.
 * This is used to determine if we need to build/pull images.
 */
function willExecuteInContainer(
  runner: Runner,
  args: CommandScriptArgs,
): boolean {
  // If explicit CLI override to host, no container execution
  if (args.contextOverride === "host") return false;

  // If explicit CLI override to container, yes container execution
  if (args.contextOverride === "container") return true;

  // Resolve the per-service path first so a colon path (`db:makemigrations`) is inspected
  // rather than missed.
  const project = runner.config.project;
  if (!args.command) return false;

  for (const serviceId of args.targets) {
    const service = project.services.entries[serviceId];
    if (!service) continue;
    const { path } = resolveServiceCommandPath(service, args.command);
    if (path === null) continue;
    if (findCommandNode(service, path)?.context === "container") return true;
  }

  return false;
}

/**
 * One stage from `buildExecutionPlan(...)` (commands/index.ts) — a
 * parallelizable bag of {@link ResolvedCommand} tasks. Stages run in
 * topological order; tasks within a stage are independent.
 */
export interface CommandStage {
  /** Zero-based stage index — used to derive `cmd:<index>:...` node ids. */
  index: number;
  /** Tasks in this stage; safe to run in parallel. */
  tasks: readonly ResolvedCommand[];
}

/** Scope for {@link CommandScript.plan} — pre-resolved by the caller. */
export interface CommandPlanScope {
  /** Resolved targets (workspace package names) the command runs against. */
  targets: readonly string[];
  /** The command being run (e.g. "lint", "test"). */
  commandName: string;
  /**
   * Pre-resolved per-target command-DAG stages. Caller (CLI driver / fn()
   * adapter) uses today's `buildExecutionPlan` to compute these so plan()
   * stays pure and synchronous.
   */
  stages: readonly CommandStage[];
  /** CLI override for execution context (`--context host|container`). Passed through to every
   * `cmd:*` payload so `executeCommandTask` routes to the right host/container helper
   * regardless of the task's configured `context` field.
   */
  contextOverride?: CommandContext;
  /** Args after a bare `--`, appended to each task's executable. */
  passthrough?: readonly string[];
}

/** Per-task payload carried on every `cmd:<stage>:<service>:<command>` plan node. Contains
 * everything a dispatcher needs to invoke {@link commandExec} without re-resolving
 * anything. `serializePlan`); no functions, no class instances.
 */
export interface CommandExecPayload {
  /** The user-typed command name (root, no subcommand) — e.g. "lint". */
  commandName: string;
  /** Stage index this task belongs to. */
  stageIndex: number;
  /** The pre-resolved task. */
  task: ResolvedCommand;
  /**
   * CLI override for execution context (`--context host|container`).
   * When set, takes precedence over the task's configured `context`.
   * Plumbed from {@link CommandPlanScope.contextOverride}.
   */
  contextOverride?: CommandContext;
}

/** Inputs to {@link commandPre} — fired once before any cmd node runs. */
export interface CommandPreContext {
  commandName: string;
  targets: readonly string[];
  stageCount: number;
  logger: { log(...args: unknown[]): void };
}

/** Inputs to {@link commandExec} — fired once per task in the plan. */
export interface CommandExecContext {
  payload: CommandExecPayload;
  /**
   * Caller-supplied task runner. Receives the payload; resolves on success,
   * rejects to fail the plan node. Today's CLI adapter binds this to
   * `CommandScript#executeTask` (private); tests pass a spy.
   */
  runTask(payload: CommandExecPayload): Promise<void>;
}

/** Inputs to {@link commandPost} — fired once after every cmd node settles. */
export interface CommandPostContext {
  commandName: string;
  logger: { log(...args: unknown[]): void };
}

/** The pre-pass for the `command` plan: announces what's about to run. Mirrors the two
 * `this.log(...)` lines fn() emits before Stage 1. Sync at heart but typed `async` so it
 * composes with {@link import("../plan-runner.ts").HandlerDispatch} without a wrapper.
 */
export async function commandPre(ctx: CommandPreContext): Promise<void> {
  ctx.logger.log(
    `Executing ${ctx.commandName} across ${ctx.targets.join(", ")}`,
  );
  ctx.logger.log(`Execution plan: ${ctx.stageCount} stage(s)`);
  return await Promise.resolve();
}

/** Backs every `cmd:<stage>:<service>:<command>` node; delegates to `runTask`. */
export async function commandExec(ctx: CommandExecContext): Promise<void> {
  await ctx.runTask(ctx.payload);
}

/** Currently a no-op; reserved for `--no-fail-fast` summary rendering. */
export async function commandPost(_ctx: CommandPostContext): Promise<void> {
  return await Promise.resolve();
}

/** This is the dispatch-side adapter behind the `"command:exec"` builtin: it instantiates
 * {@link CommandScript} just to reach today's {@link CommandScript.executeTask} (and its
 * private host/container helpers) without duplicating that body. Honors
 * `payload.contextOverride` (the `--context host|container` CLI flag) by passing it
 */
export async function executeCommandTask(
  runner: Runner,
  payload: CommandExecPayload,
): Promise<void> {
  const script = new CommandScript(runner);
  await script.executeTask(payload.task, payload.contextOverride);
}

/** Builtin handler names emitted by {@link CommandScript.plan}. */
const COMMAND_PRE_BUILTIN = "command:pre";
const COMMAND_EXEC_BUILTIN = "command:exec";
const COMMAND_POST_BUILTIN = "command:post";

const PRE_NODE_ID = "pre_command";
const POST_NODE_ID = "post_command";

/** Stable id for a per-task cmd node. */
function cmdNodeId(
  stageIndex: number,
  service: string,
  command: string,
): string {
  return `cmd:${stageIndex}:${service}:${command}`;
}

export default class CommandScript extends Script {
  static override name = "";
  static override description = "Run a command defined in nopo.yml";

  /** Filter targets to only services that can actually run the command. Resolution goes
   * through {@link resolveServiceCommandPath}. For a service the user NAMED on the CLI, a
   * bare name declared only under a grouping parent still matches (api's
   * `db:makemigrations` answers to `nopo makemigrations api`). That leaf fallback is
   */
  static override targetFilter = (
    service: NormalizedService,
    runner: Runner,
  ): boolean => {
    const commandName = runner.argv[0];
    if (!commandName) return true;
    const { path, candidates } = resolveServiceCommandPath(
      service,
      commandName,
    );
    return path !== null || candidates.length > 0;
  };

  static override args = baseArgs.extend({
    context: {
      type: "string",
      description: "Execution context (host or container)",
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- undefined default for optional arg, typed as string when provided
      default: undefined as unknown as string,
    },
    concurrency: {
      type: "number",
      description:
        "Max parallel tasks per stage. Default (0) auto-detects from the " +
        "cgroup CPU quota and memory limit; pass a number to override (it may " +
        "exceed the detected budget). Also settable via NOPO_CONCURRENCY.",
      alias: ["j"],
      default: 0,
    },
    "skip-missing": {
      type: "boolean",
      description:
        "Skip services that don't have the command instead of erroring",
      default: false,
    },
    "no-fail-fast": {
      type: "boolean",
      description: "Continue running all targets even if one fails",
      default: false,
    },
  });

  static override dependencies: ScriptDependency[] = [
    {
      class: EnvScript,
      enabled: true,
    },
    {
      class: BuildScript,
      enabled: async (runner) => {
        const args = CommandScript.parseCommandArgs(runner);
        if (args.targets.length === 0) return false;
        if (!willExecuteInContainer(runner, args)) return false;
        return (
          (await hasDownContainer(runner, args.targets)) && isBuild(runner)
        );
      },
    },
  ];

  /**
   * Parse command arguments including command name, targets, and filters.
   * This is a static helper used by both dependencies and fn().
   */
  static parseCommandArgs(runner: Runner): CommandScriptArgs {
    if (runner.argv.length === 0) {
      return {
        command: "",
        targets: [],
        filters: [],
        explicitTargets: false,
        changed: false,
        withDependants: false,
        skipMissing: false,
        noFailFast: false,
        print: false,
        passthrough: [],
      };
    }

    const argv = runner.argv;
    const command = argv[0]!;

    // Skip parsing if "help" is the script name (handled by main entry point)
    if (command === "help") {
      return {
        command: "",
        targets: [],
        filters: [],
        explicitTargets: false,
        changed: false,
        withDependants: false,
        skipMissing: false,
        noFailFast: false,
        print: false,
        passthrough: [],
      };
    }

    const rawRemaining = argv.slice(1);
    // Split on the first bare `--`. Everything after it is passthrough for
    // the underlying tool and must never reach nopo's own flag parser.
    const dashIndex = rawRemaining.indexOf("--");
    const passthrough = dashIndex >= 0 ? rawRemaining.slice(dashIndex + 1) : [];
    const remaining =
      dashIndex >= 0 ? rawRemaining.slice(0, dashIndex) : rawRemaining;
    const availableTargets = runner.config.targets;

    // Parse with minimist to extract options
    const parsed = minimist(remaining, {
      string: ["filter", "since", "context"],
      boolean: [
        "changed",
        "with-dependants",
        "skip-missing",
        "no-fail-fast",
        "print",
        "json",
      ],
      alias: { F: "filter" },
    });

    // Parse context override
    let contextOverride: CommandContext | undefined;
    if (parsed.context === "host" || parsed.context === "container") {
      contextOverride = parsed.context;
    } else if (parsed.context !== undefined) {
      throw new Error(
        `Invalid --context value '${parsed.context}'. Must be 'host' or 'container'.`,
      );
    }

    // Parse filter expressions
    let filters: FilterExpression[] = [];
    const filterValue = parsed.filter;
    if (filterValue) {
      const filterArgs = Array.isArray(filterValue)
        ? filterValue
        : [filterValue];
      filters = filterArgs
        .filter((f): f is string => typeof f === "string" && f.length > 0)
        .map(parseFilterExpression);
    }

    // Get since value
    const since = typeof parsed.since === "string" ? parsed.since : undefined;

    // Subcommands are reached only through colon syntax (`nopo test:integration api`), so
    // there is nothing to disambiguate — `nopo test integration api` fails
    const positionalArgs: string[] = parsed._ || [];
    let targets: string[] = positionalArgs.map((t) => t.toLowerCase());
    const explicitTargets = targets.length > 0;

    // Apply filters to get filtered target list
    let filteredTargets = availableTargets;
    if (filters.length > 0) {
      const context: FilterContext = {
        projectRoot: runner.config.root,
        ...parseSinceArg(since),
      };
      filteredTargets = applyFiltersToNames(
        availableTargets,
        runner.config.project.services.entries,
        filters,
        context,
      );
    }

    // Validate explicit targets
    if (targets.length > 0) {
      const unknown = targets.filter((t) => !availableTargets.includes(t));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown target${unknown.length > 1 ? "s" : ""} '${unknown.join("', '")}'. ` +
            `Available targets: ${availableTargets.join(", ")}`,
        );
      }
      // Intersect with filtered targets
      if (filters.length > 0) {
        targets = targets.filter((t) => filteredTargets.includes(t));
      }
    } else if (filters.length > 0) {
      // No explicit targets - use filtered targets
      targets = filteredTargets;
    }

    return {
      command,
      targets,
      filters,
      since,
      explicitTargets,
      contextOverride,
      changed: Boolean(parsed["changed"]),
      withDependants: Boolean(parsed["with-dependants"]),
      skipMissing: Boolean(parsed["skip-missing"]),
      noFailFast: Boolean(parsed["no-fail-fast"]),
      print: Boolean(parsed["print"]),
      passthrough,
    };
  }

  /** ``` pre_command ├── cmd:0:<svc>:<cmd> (stage 0, needs: [pre_command]) ├──
   * cmd:1:<svc>:<cmd> (stage 1, needs: every stage 0 node) ... post_command (needs: every
   * cmd:* node) ``` Empty `scope.stages` still emits pre/post so post-pass hooks fire.
   */
  static plan(_args: ScriptArgs, scope: CommandPlanScope): Plan {
    const nodes: PlanNode[] = [];

    nodes.push({
      id: PRE_NODE_ID,
      handler: { kind: "builtin", name: COMMAND_PRE_BUILTIN },
      needs: [],
      payload: {
        commandName: scope.commandName,
        targets: [...scope.targets],
        stageCount: scope.stages.length,
      },
      meta: { script: "command", phase: "pre" },
    });

    // Track ids per stage so stage `s+1` can `needs` all of stage `s`.
    const stageNodeIds: string[][] = [];
    let prevStageIds: readonly string[] = [PRE_NODE_ID];
    const allCmdNodeIds: string[] = [];

    for (const stage of scope.stages) {
      const thisStageIds: string[] = [];
      for (const task of stage.tasks) {
        const id = cmdNodeId(stage.index, task.service, task.command);
        const payload: CommandExecPayload = {
          commandName: scope.commandName,
          stageIndex: stage.index,
          task,
          ...(scope.contextOverride !== undefined
            ? { contextOverride: scope.contextOverride }
            : {}),
        };
        nodes.push({
          id,
          handler: { kind: "builtin", name: COMMAND_EXEC_BUILTIN },
          needs: [...prevStageIds],
          target: task.service,
          payload,
          meta: {
            script: "command",
            phase: "exec",
            stage: stage.index,
            command: task.command,
          },
        });
        thisStageIds.push(id);
        allCmdNodeIds.push(id);
      }
      stageNodeIds.push(thisStageIds);
      // If a stage was empty, keep the previous stage's ids as the gate so an empty stage
      // doesn't accidentally let downstream stages bypass their predecessors.
      if (thisStageIds.length > 0) prevStageIds = thisStageIds;
    }

    nodes.push({
      id: POST_NODE_ID,
      handler: { kind: "builtin", name: COMMAND_POST_BUILTIN },
      // Post depends on every cmd node so it only runs after all settle. If there are no cmd
      // nodes, gate on pre_command instead so the plan remains connected.
      needs: allCmdNodeIds.length > 0 ? allCmdNodeIds : [PRE_NODE_ID],
      payload: { commandName: scope.commandName },
      meta: { script: "command", phase: "post" },
    });

    return planFromNodes(nodes);
  }

  /** Routes to host or container execution based on context. Public so the dispatch table
   * ({@link executeCommandTask}) can reach it without duplicating the host/container split.
   * Private helpers it calls remain `#`-private.
   */
  async executeTask(
    task: ResolvedCommand,
    contextOverride?: CommandContext,
  ): Promise<void> {
    const service = this.runner.config.project.services.entries[task.service];
    if (!service) {
      throw new Error(`Service '${task.service}' not found`);
    }

    if (!task.executable) {
      throw new Error(`Empty command for ${task.service}:${task.command}`);
    }

    // Merge service-level env into task env (command-level overrides service-level)
    const mergedTask = service.env
      ? { ...task, env: { ...service.env, ...task.env } }
      : task;

    // Determine effective context: CLI override > task config > default (host)
    const effectiveContext = contextOverride ?? task.context ?? "host";

    if (effectiveContext === "container") {
      await this.#executeInContainer(mergedTask, service.paths.root);
    } else {
      await this.#executeOnHost(mergedTask, service.paths.root);
    }
  }

  /**
   * Execute a task on the host machine.
   */
  async #executeOnHost(
    task: ResolvedCommand,
    serviceRoot: string,
  ): Promise<void> {
    // Resolve working directory
    const cwd = this.#resolveWorkingDirectory(task, serviceRoot);

    // Merge environment variables: expand shell-style references, then merge
    const expandedTaskEnv = task.env ? expandEnvValues(task.env, this.env) : {};
    const taskEnv = task.env ? { ...this.env, ...expandedTaskEnv } : this.env;

    // Create a prefixed logger for this task
    const logPrefix = `${task.service}:${task.command}`;

    // Log that we're starting this task
    this.log(`[${logPrefix}] ${task.executable}`);

    // Execute the command through a shell to support shell operators like &&, ||, |, etc.
    await exec("sh", ["-c", task.executable], {
      cwd,
      env: taskEnv,
      stdio: "pipe",
      callback: createLogger(logPrefix, "cyan"),
    });
  }

  /** If a plugin provides a "run" override, delegates to it (the plugin handles deploying
   * deps, running the command, and cleanup). Otherwise falls back to kubectl exec into an
   * already-running deployment.
   */
  async #executeInContainer(
    task: ResolvedCommand,
    serviceRoot: string,
  ): Promise<void> {
    const logPrefix = `${task.service}:${task.command}`;
    const expandedTaskEnv = task.env ? expandEnvValues(task.env, this.env) : {};
    const taskEnv = task.env ? { ...this.env, ...expandedTaskEnv } : this.env;
    const containerWorkdir = this.#resolveContainerWorkdir(task, serviceRoot);

    // Try plugin "run" override first (handles dep deployment + cleanup)
    const runContext: import("../plugin.ts").RunContext = {
      service: task.service,
      command: task.executable,
      workdir: containerWorkdir,
      env: expandedTaskEnv,
    };
    // command.ts dispatches `run` via the legacy "first plugin with this override" fallback in
    // fireOverride() — no explicit --runtime gate here. Use the default runtime so plugins
    const hookContext: import("../plugin.ts").HookContext = {
      runner: this.runner,
      args: new ScriptArgs({}, this.runner),
      graph: this.runner.buildGraph(),
      runtime: "default",
      runContext,
      ...this.runner.contextIO(),
    };

    const overridden = await this.runner.fireOverride("run", hookContext);
    if (overridden) return;

    // Fallback: kubectl exec into existing deployment
    const namespace = resolveNamespace(this.runner);

    // Build env flags for kubectl exec (using expanded values).
    // Escape single quotes in values to prevent shell injection.
    const envFlags: string[] = [];
    if (task.env) {
      for (const [key, value] of Object.entries(expandedTaskEnv)) {
        const escaped = value.replace(/'/g, "'\\''");
        envFlags.push(`export ${key}='${escaped}';`);
      }
    }

    const envPrefix = envFlags.length > 0 ? envFlags.join(" ") + " " : "";
    const escapedWorkdir = containerWorkdir.replace(/'/g, "'\\''");
    const fullCommand = `cd '${escapedWorkdir}' && ${envPrefix}${task.executable}`;

    this.log(
      `[${logPrefix}] kubectl exec -n ${namespace} deploy/${task.service} -- sh -c "${task.executable}"`,
    );

    await exec(
      "kubectl",
      [
        "exec",
        "-n",
        namespace,
        `deploy/${task.service}`,
        "--",
        "sh",
        "-c",
        fullCommand,
      ],
      {
        cwd: this.runner.config.root,
        stdio: "pipe",
        callback: createLogger(logPrefix, "cyan"),
        env: taskEnv,
      },
    );
  }

  /** "root": use project root absolute path: use as-is relative path: resolve relative to
   * service root
   */
  #resolveWorkingDirectory(task: ResolvedCommand, serviceRoot: string): string {
    const dir = task.dir;

    // Default: service root
    if (!dir) {
      return serviceRoot;
    }

    // "root" means project root
    if (dir === "root") {
      return this.runner.config.root;
    }

    // Absolute path: use as-is
    if (path.isAbsolute(dir)) {
      return dir;
    }

    // Relative path: resolve relative to service root
    return path.resolve(serviceRoot, dir);
  }

  /** Converts host paths to container paths. "root": use project root absolute path: use
   * as-is (assumed to be container path) relative path: resolve relative to service root
   */
  #resolveContainerWorkdir(task: ResolvedCommand, serviceRoot: string): string {
    const dir = task.dir;
    const hostRoot = this.runner.config.root;
    // Container mount point - project is mounted at /app
    const containerRoot = "/app";

    // Helper to convert host path to container path
    const toContainerPath = (hostPath: string): string => {
      if (hostPath.startsWith(hostRoot)) {
        const relativePath = path.relative(hostRoot, hostPath);
        return path.posix.join(containerRoot, relativePath);
      }
      // Already a container path or unknown - return as-is
      return hostPath;
    };

    // Default: service root
    if (!dir) {
      return toContainerPath(serviceRoot);
    }

    // "root" means project root
    if (dir === "root") {
      return containerRoot;
    }

    // Absolute path starting with container root: use as-is
    if (dir.startsWith(containerRoot) || dir.startsWith("/")) {
      return dir;
    }

    // Relative path: resolve relative to service root, then convert
    const hostPath = path.resolve(serviceRoot, dir);
    return toContainerPath(hostPath);
  }
}
