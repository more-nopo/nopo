import type { z } from "zod";

import type { DependencyGraph } from "./graph.ts";
import type { IO } from "./io.ts";
import type { ExecOptions, ProcessPromise, Runner, ShellTag } from "./lib.ts";
import type { BatchSpec } from "./plan-compact.ts";
import type { ScriptArgs } from "./script-args.ts";

// Hook Types

/**
 * Context passed to every plugin hook invocation.
 * All hooks receive the same unified context — the full dependency graph
 * with mutable metadata on each target node.
 */
/**
 * Details for the "run" override — a container command to execute.
 */
export interface RunContext {
  /** Service ID to run the command in */
  service: string;
  /** The shell command to execute */
  command: string;
  /** Working directory inside the container */
  workdir: string;
  /** Environment variables for the command */
  env: Record<string, string>;
}

export interface HookContext {
  runner: Runner;
  args: ScriptArgs;
  graph: DependencyGraph;
  /** The active runtime name from the root `runtimes:` map. Populated for every hook
   * invocation, including non-runtime-dispatched hooks (build, compile, etc.) where it
   * defaults to `"default"`. Plugins read this to pick the right per-runtime overlay when
   * resolving a service's runtime config: `resolveRuntime(svc.runtimes, ctx.runtime)`.
   */
  runtime: string;
  /** Set when the "run" override is being called */
  runContext?: RunContext;
  /**
   * Positional arguments for plugin commands (everything in argv that
   * isn't a flag or option). For overrides this is empty. For plugin
   * commands this is everything after `nopo <plugin> <command>`.
   */
  positionals?: string[];

  /** The active plan node's `payload`, opaque to the runtime — hook authors narrow at the
   * entry point (e.g. `const p = ctx.payload as { targets: string[] };`). Mirrors how
   * `PlanNode.payload` is already untyped at the plan layer; threading a generic through
   * `HookFn` would couple the dispatch table to every hook's payload schema for no real win.
   */
  payload?: unknown;

  // I/O surface (M2.1) Plugins reach for process I/O (spawning subprocesses, reading env,
  // etc.) through the context — never via `process.*` or top-level imports from `nopo/lib`.

  /** Same instance as `runner.io`. Use `io.spawn` for direct command execution that does NOT
   * throw on non-zero exit (e.g. probes, health checks). For the typical "run a command,
   * throw if it fails" pattern, prefer {@link HookContext.exec}.
   */
  io: IO;

  /** Run a command with explicit args, throwing `ProcessOutput` on a non-zero exit code.
   * Equivalent to the old `exec()` import from `nopo/lib`, but routed through `ctx.io` so
   * tests can intercept. Honors `opts.nothrow` for callers that need to inspect a failing
   * exit code without an exception.
   */
  exec(cmd: string, args: string[], opts?: ExecOptions): ProcessPromise;

  /** Equivalent to the old `$(opts)` import from `nopo/lib`. Use sparingly — explicit
   * `exec(cmd, args, opts)` is preferred for argv hygiene. Reach for `shell()` only when you
   * genuinely need template-style command construction (e.g. `kubectl apply -f ${path}`).
   */
  shell(opts?: ExecOptions): ShellTag;
}

/** Hook function signature — all hooks are async */
export type HookFn = (context: HookContext) => Promise<void>;

/**
 * Additive hook names — any number of plugins can define these.
 * Called in plugin declaration order.
 */
export type AdditiveHookName =
  | "pre_build"
  | "post_build"
  | "pre_up"
  | "post_up"
  | "pre_down"
  | "post_down"
  | "pre_status"
  | "post_status";

/**
 * Override hook names — one plugin max per key.
 * Replaces the core default implementation.
 * Conflict = error at plugin load time.
 */
export type OverrideHookName = "build" | "up" | "down" | "status" | "run";

/** Override hooks dispatched per-invocation via the root nopo.yml `runtimes:` map. Multiple
 * plugins may register the same hook — the runtime map (or `--runtime <name>` arg) selects
 * which plugin fires for each invocation. Excluded from the "single owner per override"
 * rule in loadPlugins.
 */
export const RUNTIME_DISPATCHED_HOOKS = new Set<OverrideHookName>([
  "up",
  "down",
  "status",
  "run",
]);

// Plugin Command

/**
 * A plugin-provided CLI subcommand.
 * Registered under `nopo <pluginName> <commandName>`.
 */
export interface PluginCommand {
  name: string;
  description: string;
  args?: ScriptArgs;
  fn: (context: HookContext, args: ScriptArgs) => Promise<void>;
}

// Plugin Definition

/**
 * The plugin definition object returned by a plugin factory.
 */
export interface NopoPlugin {
  /** Unique plugin name (matches the name in nopo.yml plugins array) */
  name: string;

  /** Optional description shown in help output */
  description?: string;

  /**
   * Zod schemas for validating plugin config sections.
   * - project: validates `plugins.<name>.config` in root nopo.yml
   * - service: validates `plugins.<name>` in service-level nopo.yml
   */
  configSchema?: {
    project?: z.ZodType;
    service?: z.ZodType;
  };

  /** Two kinds share this single map: Additive lifecycle hooks** (keys in {@link
   * AdditiveHookName} — `pre_build`, `post_build`, `pre_up`, `post_up`, `pre_down`,
   * `post_down`, `pre_status`, `post_status`) are called by the runtime in plugin
   * declaration order at the corresponding phase. Batch handlers** — any other string key
   */
  hooks?: Record<string, HookFn>;

  /**
   * Override hooks — one plugin max per key.
   * Replaces the core default implementation for that command.
   * If two plugins define the same override, an error is thrown at load time.
   */
  overrides?: Partial<Record<OverrideHookName, HookFn>>;

  /**
   * New subcommands registered under `nopo <pluginName> <commandName>`.
   * No conflict with built-in or user-defined commands.
   */
  commands?: PluginCommand[];

  /** Declarative claim+coalesce specs that fold N plan nodes into a single batch node during
   * the compaction pass that runs between `static plan()` and `executePlan`. See {@link
   * BatchSpec} and `plan-compact.ts` for the contract.
   */
  batches?: BatchSpec[];
}

/**
 * Alias for {@link NopoPlugin} — the name used externally when
 * referring to the plugin definition object (what a factory returns).
 */
export type NopoPluginDefinition = NopoPlugin;

/**
 * Plugin factory function.
 * Receives the validated plugin config from nopo.yml and returns the plugin definition.
 */
export type NopoPluginFactory = (config?: unknown) => NopoPlugin;

// Loaded Plugin (internal representation after loading)

/**
 * A plugin after loading, validation, and factory invocation.
 * Stored on NormalizedProjectConfig.plugins.
 */
export interface LoadedPlugin {
  /** The plugin definition returned by the factory */
  definition: NopoPlugin;
  /** Validated plugin config from root nopo.yml `plugins.<name>.config` */
  projectConfig?: unknown;
  /** Per-service plugin config keyed by service ID */
  serviceConfigs: Record<string, unknown>;
}

/**
 * Plugin reference as declared in nopo.yml.
 */
export interface PluginReference {
  name: string;
  path?: string;
  config?: Record<string, unknown>;
}
