import { spawn, type SpawnOptions, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

import { trackChild } from "./child-registry.ts";
import { assertCommandDispatches } from "./commands/index.ts";
import {
  loadProjectConfig,
  type NormalizedProjectConfig,
  type NormalizedService,
  type PackageManagerConfig,
} from "./config/index.ts";
import {
  withDependants,
  withDependencies,
  withTransitiveDependencies,
} from "./dependency-graph.ts";
import {
  applyFiltersToNames,
  type FilterContext,
  parseFilterExpression,
  parseSinceArg,
} from "./filter.ts";
import { DependencyGraph } from "./graph.ts";
import { type IO, realIO } from "./io.ts";
import { deserializePlan, type Plan, type PlanNode } from "./plan.ts";
import { type CompactionContext, compactPlan } from "./plan-compact.ts";
import { renderPlanDag, renderTrivialSummary } from "./plan-dag-render.ts";
import { createStreamingRenderer } from "./plan-render.ts";
import { executePlan, type PlanEvent } from "./plan-runner.ts";
import type {
  AdditiveHookName,
  HookContext,
  HookFn,
  OverrideHookName,
} from "./plugin.ts";
import {
  collectDryRunInfo,
  type DryRunOutput,
  type PrintMode,
} from "./print.ts";
import { buildScopeForScript, getStaticPlan } from "./scope.ts";
import { ScriptArgs } from "./script-args.ts";
import { parseTargetArgs } from "./target-args.ts";

const BaseConfigSchema = z.object({
  root: z.string(),
  envFile: z.string(),
  processEnv: z.record(z.string(), z.string()),
  silent: z.boolean(),
});

type BaseConfig = z.infer<typeof BaseConfigSchema>;

export interface Config extends BaseConfig {
  targets: string[];
  project: NormalizedProjectConfig;
}

// Chalk replacement - Simple terminal color utility
type ColorLevel = 0 | 1 | 2 | 3;
type ColorArgs = unknown[];
type ColorFunction = (...text: ColorArgs) => string;

interface ChalkInstance {
  level: ColorLevel;
  black: ColorFunction;
  red: ColorFunction;
  green: ColorFunction;
  yellow: ColorFunction;
  blue: ColorFunction;
  magenta: ColorFunction;
  cyan: ColorFunction;
  white: ColorFunction;
  gray: ColorFunction;
  grey: ColorFunction;
  bold: ColorFunction;
  underline: ColorFunction;
}

class Chalk implements ChalkInstance {
  level: ColorLevel = 2;

  private colorize(code: string, ...text: ColorArgs): string {
    if (this.level === 0) return String(text);
    return `\x1b[${code}m${String(text)}\x1b[0m`;
  }

  black = (...text: ColorArgs) => this.colorize("30", ...text);
  red = (...text: ColorArgs) => this.colorize("31", ...text);
  green = (...text: ColorArgs) => this.colorize("32", ...text);
  yellow = (...text: ColorArgs) => this.colorize("33", ...text);
  blue = (...text: ColorArgs) => this.colorize("34", ...text);
  magenta = (...text: ColorArgs) => this.colorize("35", ...text);
  cyan = (...text: ColorArgs) => this.colorize("36", ...text);
  white = (...text: ColorArgs) => this.colorize("37", ...text);
  gray = (...text: ColorArgs) => this.colorize("90", ...text);
  grey = (...text: ColorArgs) => this.colorize("90", ...text);
  bold = (...text: ColorArgs) => this.colorize("1", ...text);
  underline = (...text: ColorArgs) => this.colorize("4", ...text);
}

export const chalk = new Chalk();

// Minimist replacement - Simple argument parser
export interface ParsedArgs {
  _: string[];
  [key: string]: string | boolean | undefined | string[];
}

interface MinimistOptions {
  boolean?: string[];
  string?: string[];
  alias?: Record<string, string | string[]>;
  default?: Record<string, unknown>;
}

export function minimist(
  args: string[],
  options: MinimistOptions = {},
): ParsedArgs {
  const result: ParsedArgs = { _: [] };
  const booleanSet = new Set(options.boolean || []);
  const aliasMap = new Map<string, string>();

  // Build alias map (both directions)
  if (options.alias) {
    for (const [key, aliases] of Object.entries(options.alias)) {
      const aliasList = Array.isArray(aliases) ? aliases : [aliases];
      for (const alias of aliasList) {
        aliasMap.set(alias, key);
        aliasMap.set(key, alias);
      }
    }
  }

  // Apply defaults
  if (options.default) {
    for (const [key, value] of Object.entries(options.default)) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimist default values are string | boolean at runtime
      result[key] = value as string | boolean;
    }
  }

  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (!arg) {
      i++;
      continue;
    }

    if (arg === "--") {
      result._.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      if (!key) {
        i++;
        continue;
      }
      const isBoolean = booleanSet.has(key);
      if (value !== undefined) {
        result[key] =
          value === "true" ? true : value === "false" ? false : value;
      } else if (isBoolean) {
        result[key] = true;
      } else if (i + 1 < args.length && !args[i + 1]?.startsWith("-")) {
        const nextValue = args[i + 1];
        result[key] =
          nextValue === "true"
            ? true
            : nextValue === "false"
              ? false
              : nextValue;
        i++;
      } else {
        result[key] = true;
      }
      // Apply aliases
      const alias = aliasMap.get(key);
      if (alias) {
        result[alias] = result[key];
      }
    } else if (arg.startsWith("-") && !arg.startsWith("--")) {
      const flags = arg.slice(1).split("");
      for (const flag of flags) {
        result[flag] = true;
        const alias = aliasMap.get(flag);
        if (alias) {
          result[alias] = true;
        }
      }
    } else {
      result._.push(arg);
    }
    i++;
  }

  return result;
}

// Dotenv replacement - Parse and stringify .env files
export const dotenv = {
  load(filePath: string): Record<string, string> {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return this.parse(content);
  },

  parse(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const equalIndex = trimmed.indexOf("=");
      if (equalIndex === -1) continue;

      const key = trimmed.slice(0, equalIndex).trim();
      let value = trimmed.slice(equalIndex + 1).trim();

      // Remove quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      result[key] = value;
    }

    return result;
  },

  stringify(env: Record<string, string | undefined>): string {
    return Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}="${value}"`)
      .join("\n");
  },
};

// Tmpfile replacement - Create temporary files
export function tmpfile(filename: string, content: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-"));
  const tmpPath = path.join(tmpDir, filename);
  fs.writeFileSync(tmpPath, content);
  return tmpPath;
}

// Process execution replacement for $ from zx

/** Plugins now thread I/O through `HookContext.exec` / `HookContext.shell`
 * `HookContext.io.spawn`, all of which close over a per-Runner `IO` instance. `exec` / `$`
 * below remain for internal scripts and the lib test suite — they always use `realIO` for
 * stdout/stderr writes and spawn `child_process` directly, since they're never reached
 */
export class ProcessOutput extends Error {
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly combined: string;

  constructor(
    exitCode: number,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string,
    message?: string,
  ) {
    super(message || `Process exited with code ${exitCode}`);
    this.name = "ProcessOutput";
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
    this.combined = stdout + stderr;
  }
}

export interface ProcessPromise extends Promise<ProcessOutput> {
  nothrow(): ProcessPromise;
  pipe(destination: ProcessPromise): ProcessPromise;
  kill(signal?: NodeJS.Signals): void;
  text(): Promise<string>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: "pipe" | "inherit";
  /** Suppress mid-stream forwarding of subprocess stdout/stderr to `io.stdout` / `io.stderr`.
   * The buffered `ProcessOutput` is unaffected — `result.stdout` / `result.stderr` are
   * always populated. Use this for data-fetch calls that parse stdout (e.g. `git rev-parse
   * HEAD`, `docker imagetools inspect --raw`) where streaming the raw output to the runner
   */
  silent?: boolean;
  nothrow?: boolean;
  input?: string;
  callback?: (chunk: Buffer, streamSource?: "stdout" | "stderr") => void;
  /**
   * IO handle subprocess output streams to. Defaults to `realIO`.
   * The HookContext-bound helpers (`ctx.exec` / `ctx.shell`) thread
   * `ctx.io` through here so test mocks see the streamed output.
   */
  io?: IO;
}

/**
 * Tagged-template type returned by `$()`. Splits the assembled command
 * on whitespace and runs `cmd args...`.
 */
export type ShellTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => ProcessPromise;

class ProcessPromiseImpl implements ProcessPromise {
  private promise: Promise<ProcessOutput>;
  private proc: ReturnType<typeof spawn> | null = null;
  private _nothrow = false;

  constructor(command: string, args: string[], options: ExecOptions = {}) {
    const io: IO = options.io ?? realIO;
    // Subprocess output streams to `io.stdout` / `io.stderr` by default — `silent: true` opts
    // out for data-fetch calls that parse the buffered `result.stdout`. A `callback` also
    const shouldStream = !options.silent && !options.callback;
    this.promise = new Promise((resolve, reject) => {
      // Spawn the real child process directly — `child_process.spawn` gives us streaming chunks,
      // mid-stream `callback` delivery, stdin `input`, and `kill()` that the buffered `IO.spawn`
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      const spawnOptions: SpawnOptions = {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdio: options.stdio || "pipe",
        shell: false,
      };

      this.proc = spawn(command, args, spawnOptions);
      // Register so a command timeout can terminate in-flight subprocesses.
      trackChild(this.proc);

      // Write input to stdin if provided
      if (options.input && this.proc.stdin) {
        this.proc.stdin.on("error", (err) => {
          if ("code" in err && err.code === "EPIPE") return;
          reject(new ProcessOutput(1, null, "", err.message));
        });
        try {
          this.proc.stdin.write(options.input);
          this.proc.stdin.end();
        } catch (err) {
          if (err instanceof Error && "code" in err && err.code === "EPIPE")
            return;
          reject(
            new ProcessOutput(
              1,
              null,
              "",
              err instanceof Error ? err.message : String(err),
            ),
          );
          return;
        }
      }

      if (this.proc.stdout) {
        this.proc.stdout.on("data", (chunk) => {
          stdout.push(chunk);
          if (options.callback) {
            options.callback(chunk, "stdout");
          } else if (shouldStream) {
            io.stdout.write(chunk.toString());
          }
        });
      }

      if (this.proc.stderr) {
        this.proc.stderr.on("data", (chunk) => {
          stderr.push(chunk);
          if (options.callback) {
            options.callback(chunk, "stderr");
          } else if (shouldStream) {
            io.stderr.write(chunk.toString());
          }
        });
      }

      this.proc.on("close", (code, signal) => {
        const stdoutStr = Buffer.concat(stdout).toString();
        const stderrStr = Buffer.concat(stderr).toString();
        const output = new ProcessOutput(
          code || 0,
          signal,
          stdoutStr,
          stderrStr,
        );

        if (code !== 0 && !this._nothrow && !options.nothrow) {
          reject(output);
        } else {
          resolve(output);
        }
      });

      this.proc.on("error", (err) => {
        reject(new ProcessOutput(1, null, "", err.message));
      });
    });
  }

  nothrow(): ProcessPromise {
    this._nothrow = true;
    return this;
  }

  pipe(destination: ProcessPromise): ProcessPromise {
    // Simple pipe implementation - would need more work for full compatibility
    return destination;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.proc) {
      this.proc.kill(signal);
    }
  }

  then<TResult1 = ProcessOutput, TResult2 = never>(
    onfulfilled?:
      | ((value: ProcessOutput) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<ProcessOutput | TResult> {
    return this.promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<ProcessOutput> {
    return this.promise.finally(onfinally);
  }

  text() {
    return this.then((output) => output.stdout);
  }

  get [Symbol.toStringTag](): string {
    return "ProcessPromise";
  }
}

// Template literal function for command execution
export function $(options: ExecOptions = {}) {
  return function exec(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): ProcessPromise {
    let command = "";
    for (let i = 0; i < strings.length; i++) {
      command += strings[i];
      if (i < values.length) {
        const value = values[i];
        if (Array.isArray(value)) {
          command += value.join(" ");
        } else {
          command += String(value);
        }
      }
    }

    const parts = command.trim().split(/\s+/);
    const [cmd, ...args] = parts;

    if (!cmd) throw new Error("No command provided");

    return new ProcessPromiseImpl(cmd, args, options);
  };
}

/**
 * Execute a command with explicit arguments (no whitespace splitting).
 * Useful when arguments contain spaces.
 */
export function exec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): ProcessPromise {
  return new ProcessPromiseImpl(command, args, options);
}

// HookContext-bound helpers (M2.1) These wrap `io.spawn` (the mock-aware primitive) and
// present the same `ProcessPromise` surface plugins expect from the legacy `exec` / `$`.

class IOBackedProcessPromise implements ProcessPromise {
  private promise: Promise<ProcessOutput>;
  private _nothrow = false;

  constructor(io: IO, command: string, args: string[], options: ExecOptions) {
    this.promise = new Promise<ProcessOutput>((resolve, reject) => {
      const env = options.env
        ? { ...process.env, ...options.env }
        : { ...process.env };
      const spawnEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string") spawnEnv[k] = v;
      }
      // Stream subprocess output to `io.stdout` / `io.stderr` by default — long-running commands
      // (`docker buildx bake`, `kubectl apply`, etc.) need visible progress. `silent: true` opts
      const shouldStream = !options.silent && !options.callback;
      const onChunk =
        options.callback || shouldStream
          ? (chunk: Buffer, source: "stdout" | "stderr") => {
              if (options.callback) {
                options.callback(chunk, source);
              } else {
                const sink = source === "stdout" ? io.stdout : io.stderr;
                sink.write(chunk.toString());
              }
            }
          : undefined;
      io.spawn(command, args, {
        cwd: options.cwd,
        env: spawnEnv,
        stdio: options.stdio === "inherit" ? "inherit" : "pipe",
        input: options.input,
        onChunk,
      })
        .then((result) => {
          const output = new ProcessOutput(
            result.exitCode,
            null,
            result.stdout,
            result.stderr,
          );
          if (result.exitCode !== 0 && !this._nothrow && !options.nothrow) {
            reject(output);
          } else {
            resolve(output);
          }
        })
        .catch((err: unknown) => {
          reject(
            new ProcessOutput(
              1,
              null,
              "",
              err instanceof Error ? err.message : String(err),
            ),
          );
        });
    });
  }

  nothrow(): ProcessPromise {
    this._nothrow = true;
    return this;
  }

  pipe(destination: ProcessPromise): ProcessPromise {
    return destination;
  }

  kill(_signal: NodeJS.Signals = "SIGTERM"): void {
    // No-op: io.spawn is buffered and we don't keep a child handle. Plugins
    // needing process control should call `ctx.io.spawn` directly.
  }

  then<TResult1 = ProcessOutput, TResult2 = never>(
    onfulfilled?:
      | ((value: ProcessOutput) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<ProcessOutput | TResult> {
    return this.promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<ProcessOutput> {
    return this.promise.finally(onfinally);
  }

  text() {
    return this.then((output) => output.stdout);
  }

  get [Symbol.toStringTag](): string {
    return "ProcessPromise";
  }
}

/** Build the `exec` method bound to a HookContext's IO. Plugins call this via
 * `ctx.exec(cmd, args, opts)` — same throw-on-non-zero contract as the legacy `exec()`
 * import, but routed through `ctx.io.spawn` so test mocks can intercept.
 */
export function makeCtxExec(io: IO) {
  return function ctxExec(
    command: string,
    args: string[],
    options: ExecOptions = {},
  ): ProcessPromise {
    return new IOBackedProcessPromise(io, command, args, options);
  };
}

/**
 * Build the `shell` method bound to a HookContext's IO. Plugins call this
 * via `ctx.shell(opts)\`cmd ${arg}\`` — same template-literal contract as
 * the legacy `$()` import.
 */
export function makeCtxShell(io: IO) {
  return function ctxShell(options: ExecOptions = {}): ShellTag {
    return function shellTag(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): ProcessPromise {
      let command = "";
      for (let i = 0; i < strings.length; i++) {
        command += strings[i];
        if (i < values.length) {
          const value = values[i];
          if (Array.isArray(value)) {
            command += value.join(" ");
          } else {
            command += String(value);
          }
        }
      }
      const parts = command.trim().split(/\s+/);
      const [cmd, ...args] = parts;
      if (!cmd) throw new Error("No command provided");
      return new IOBackedProcessPromise(io, cmd, args, options);
    };
  };
}

// Synchronous version for $.sync
$.sync = function execSync(
  strings: TemplateStringsArray,
  ...values: unknown[]
): ProcessOutput {
  let command = "";
  for (let i = 0; i < strings.length; i++) {
    command += strings[i];
    if (i < values.length) {
      const value = values[i];
      if (Array.isArray(value)) {
        command += value.join(" ");
      } else {
        command += String(value);
      }
    }
  }

  const parts = command.trim().split(/\s+/);
  const [cmd, ...args] = parts;

  if (!cmd) throw new Error("No command provided");

  try {
    const result = spawnSync(cmd, args, {
      encoding: "utf-8",
      shell: false,
    });

    return new ProcessOutput(
      result.status || 0,
      result.signal,
      result.stdout || "",
      result.stderr || "",
    );
  } catch (error) {
    throw new ProcessOutput(
      1,
      null,
      "",
      error instanceof Error ? error.message : String(error),
    );
  }
};

// Original lib.ts code starts here
const defaultRoot = process.cwd();

interface CreateConfigOptions {
  envFile?: string | undefined;
  processEnv?: Record<string, string>;
  silent?: boolean;
  rootDir?: string;
  configPath?: string;
  /** When provided, defaults for `rootDir` and `processEnv` come from `io.cwd()` / `io.env`
   * instead of the real `process.*`. Tests with a mock IO get isolation; existing callers
   * that don't pass an IO keep falling through to `process.*`.
   */
  io?: IO;
}

/** Snapshot a `process.env`-like object into a strict `Record<string, string>`, dropping
 * any keys whose value is `undefined`. Node's `process.env` is `Record<string, string |
 * undefined>` (index access can return undefined), but the live env never literally stores
 * `undefined` values — this helper enforces that at the type level without a cast.
 */
function compactEnv(
  source: NodeJS.ProcessEnv | Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function createConfig(options: CreateConfigOptions = {}): Config {
  const { io, rootDir, configPath } = options;
  const envFile = options.envFile ?? ".env";
  const silent = options.silent ?? false;
  const sourceEnv = io ? io.env : process.env;
  const processEnv: Record<string, string> =
    options.processEnv ?? compactEnv(sourceEnv);

  const resolvedRoot = path.resolve(rootDir ?? (io ? io.cwd() : defaultRoot));
  const baseConfig = BaseConfigSchema.parse({
    root: resolvedRoot,
    envFile: path.resolve(resolvedRoot, envFile),
    processEnv,
    silent,
  });

  const project = loadProjectConfig(resolvedRoot, configPath);

  return {
    ...baseConfig,
    project,
    targets: project.services.targets,
  };
}

type Color = "black" | "red" | "blue" | "yellow" | "green" | "cyan";

export function createLogger(name: string, color: Color = "black") {
  return (chunk: Buffer, streamSource?: "stdout" | "stderr"): void => {
    const messages = chunk.toString().trim().split("\n");
    const log = streamSource === "stdout" ? console.log : console.error;
    for (const message of messages) {
      log(chalk[color](`[${name}] ${message}`));
    }
  };
}

/** Count the stages in a `CommandPlanScope` that actually carry tasks. `scope` is typed
 * `unknown` at the `runViaPlan` call site (each script owns its own scope shape), so this
 * narrows structurally rather than asserting. Empty stages are excluded: a stage list of
 * `[{tasks: []}]` dispatches exactly as much work as `[]` — none — and both must trip
 */
function countNonEmptyStages(scope: unknown): number {
  if (!scope || typeof scope !== "object" || !("stages" in scope)) return 0;
  const { stages } = scope;
  if (!Array.isArray(stages)) return 0;
  return stages.filter(
    (stage) =>
      !!stage &&
      typeof stage === "object" &&
      "tasks" in stage &&
      Array.isArray(stage.tasks) &&
      stage.tasks.length > 0,
  ).length;
}

/** Writes through the supplied `IO` so that tests with a mock IO can capture output.
 * Defaults to `realIO` for back-compat with callers (mostly tests) that construct a Logger
 * without explicitly threading an IO through.
 */
export class Logger {
  config: Config;
  io: IO;

  constructor(config: Config, io: IO = realIO) {
    chalk.level = 2;
    this.config = config;
    this.io = io;
  }

  get chalk(): typeof chalk {
    return chalk;
  }

  /** Logger output stays on `console.log` / `console.error` (not `this.io.stdout/stderr`) on
   * purpose: tests across the suite spy on `console.log` to capture log output. Routing
   * through `io.stdout` would silently break that capture pattern. Raw stdout writes that
   * AREN'T log output (e.g. `--print` JSON dumps) still use `runner.io.stdout.write`
   */
  log(...args: unknown[]): void {
    if (this.config.silent) return;
    console.log(...args);
  }

  /** Diagnostic output — section banners, plugin lists, deprecation warnings. Goes to stderr
   * so that command stdout stays clean for pipelines like `nopo secret get ... | head`. Same
   * console-vs-io reasoning as `log()`.
   */
  error(...args: unknown[]): void {
    if (this.config.silent) return;
    console.error(...args);
  }
}

export interface ScriptDependency {
  class: typeof BaseScript;
  enabled: boolean | ((runner: Runner) => boolean | Promise<boolean>);
  args?: (parentArgs: ScriptArgs, runner: Runner) => Record<string, unknown>;
}

export type DepSource = "build" | "runtime";

export abstract class BaseScript {
  static name = "";
  static description = "";
  static dependencies: ScriptDependency[] = [];
  /** Preset filter names always applied (e.g., ["buildable"]) */
  static preFilters: string[] = [];
  /** Dynamic target filter -- return true to include the service */
  static targetFilter?: (service: NormalizedService, runner: Runner) => boolean;
  /** Which dependency edges to follow when expanding targets. Default: both. */
  static depSource: DepSource[] = ["build", "runtime"];
  /** Whether this command opts OUT of the cross-session worker-slot queue. Default `false`:
   * every command — including every arbitrary `nopo <cmd>` routed through CommandScript — is
   * queued, so core never decides participation from a command-name string. Only a handful
   * of built-in core scripts set this `true`: instant read-only ones
   */
  static skipQueue = false;
  /** `undefined` (the default) means use the framework default ({@link DEFAULT_TIMEOUT_MS}, 5
   * min). Set a larger value for commands that legitimately run long (e.g. docker builds); a
   * non-positive value disables the timeout. Overridden at runtime by `--timeout` /
   * `NOPO_TIMEOUT`. Only applies to queued commands — long-lived lifecycle commands
   */
  static timeoutMs: number | undefined = undefined;

  runner: Runner;
  isDependency: boolean;

  constructor(runner: Runner, isDependency = false) {
    this.runner = runner;
    this.isDependency = isDependency;
  }

  get env() {
    return {
      ...this.runner.environment.processEnv,
      ...this.runner.environment.env,
      ...this.runner.environment.extraEnv,
    };
  }

  get exec() {
    const shell = $({
      cwd: this.runner.config.root,
      stdio: "pipe",
      env: this.env,
    });

    return shell;
  }

  log(...message: unknown[]) {
    this.runner.logger.log(this.runner.logger.chalk.yellow(...message));
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TArgs is kept for backwards-compatible subclass declarations
export class Script<TArgs = void> extends BaseScript {
  static args?: ScriptArgs;
  static parseArgs?(runner: Runner, isDependency: boolean): unknown;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TArgs is kept for backwards-compatible subclass declarations
export abstract class TargetScript<TArgs = void> extends BaseScript {
  static args?: ScriptArgs;

  static parseArgs(_runner: Runner, _isDependency: boolean): unknown {
    throw new Error("parseArgs must be implemented by TargetScript subclasses");
  }
}

/** Back-compat escape hatch for out-of-tree user scripts that haven't migrated to `static
 * plan()`. `LegacyScript` provides a default `static plan()` that emits a single-node plan
 * whose `legacy:fn` builtin handler instantiates the script and invokes `fn()` — so even
 * legacy scripts route through `Runner.run()`'s single `executePlan(...)` path. Prefer
 */
export abstract class LegacyScript<TArgs = void> extends BaseScript {
  static args?: ScriptArgs;

  async fn(_args?: TArgs | unknown): Promise<void> {
    throw new Error("Not implemented");
  }

  /** Default `static plan()` wraps the instance's `fn()` into a single-node {@link Plan}. The
   * `legacy:fn` builtin handler in `dispatch.ts` constructs an instance from the captured
   * class reference on the payload and awaits `fn()`. The plan is not serializable (the
   * payload carries a class reference), which is the documented trade-off for the legacy
   */
  static plan(_args: ScriptArgs, _scope: unknown): Plan {
    const nodes = new Map<string, PlanNode>();
    nodes.set("legacy", {
      id: "legacy",
      handler: { kind: "builtin", name: "legacy:fn" },
      needs: [],
      payload: { ScriptClass: this },
      meta: { script: this.name },
    });
    return { nodes };
  }
}

export class Runner {
  config: Config;
  environment: import("./parse-env.ts").Environment;
  logger: Logger;
  argv: string[];
  io: IO;
  /** Built eagerly so that: (1) Cycles fail fast (constructor throws via `graph.order()`). 2.
   * Plugins / scripts always see the same graph instance — node metadata mutations stick
   * across `pre_*`, `post_*`, and override hooks within one invocation. `selection` on each
   * TargetNode starts as `"excluded"` and is updated by `resolveExecutionPlan()` once
   */
  readonly graph: DependencyGraph;
  /** Resolved target set — includes explicit targets + transitive dependencies */
  resolvedTargets: string[] | null = null;
  /** Targets before --with-dependants / --with-dependencies expansion (for reporting) */
  preExpansionTargets: string[] | null = null;

  constructor(
    config: Config,
    environment: import("./parse-env.ts").Environment,
    argv: string[] = [],
    logger: Logger = new Logger(config),
    io: IO = realIO,
  ) {
    this.config = config;
    this.environment = environment;
    this.logger = logger;
    this.argv = argv;
    this.io = io;
    // `io` via `HookContext` (built by per-script HookContext sites), and `ctx.exec` /
    // `ctx.shell` close over that IO so test mocks see every spawn. The legacy `exec` / `$`
    this.graph = new DependencyGraph(config.project);
    // Fail-fast on cycles: order() throws "Circular dependency detected ..." when the project
    // graph isn't a DAG. Surfacing this in the constructor means plugin commands, --print,
    this.graph.order();
  }

  /** Build the I/O surface attached to every {@link HookContext}: the IO handle plus IO-bound
   * `exec` / `shell` helpers. Centralized here so that every site that constructs a
   * HookContext gets identical wiring — never reach into `process.*` or import `exec`/`$`
   * from `nopo/lib` inside a plugin again.
   */
  contextIO(): {
    io: IO;
    exec: ReturnType<typeof makeCtxExec>;
    shell: ReturnType<typeof makeCtxShell>;
  } {
    return {
      io: this.io,
      exec: makeCtxExec(this.io),
      shell: makeCtxShell(this.io),
    };
  }

  /**
   * Resolve the target DAG: parse explicit targets from argv, expand with
   * transitive dependencies from nopo.yml, and store the result.
   * This is the single source of truth for "what targets are in scope."
   */
  /**
   * Parse explicit targets from argv (positional args matching known services).
   * Cached — does not expand with deps.
   */
  private _explicitTargets: string[] | null = null;
  parseExplicitTargets(): string[] {
    if (this._explicitTargets !== null) return this._explicitTargets;

    const allTargets = this.config.targets;
    const positionalArgs = this.argv
      .slice(1) // skip command name
      .filter((arg) => !arg.startsWith("-")) // skip flags
      .map((arg) => arg.toLowerCase());

    this._explicitTargets = positionalArgs.filter((arg) =>
      allTargets.includes(arg),
    );
    return this._explicitTargets;
  }

  /**
   * Resolve the target DAG: expand explicit targets with transitive deps.
   * depSource controls which edges to follow: "build", "runtime", or both.
   */
  resolveTargetDAG(depSource: DepSource[] = ["build", "runtime"]): string[] {
    const explicitTargets = this.parseExplicitTargets();

    if (explicitTargets.length === 0) {
      this.resolvedTargets = [];
      return this.resolvedTargets;
    }

    const entries = this.config.project.services.entries;
    const allTargets = this.config.targets;

    // Map depSource to the DepType expected by withTransitiveDependencies
    let depType: "build" | "runtime" | "all";
    if (depSource.length === 2) {
      depType = "all";
    } else if (depSource.length === 1) {
      depType = depSource[0]!;
    } else {
      // Empty depSource — no expansion, just the explicit targets
      this.resolvedTargets = allTargets.filter((t) =>
        explicitTargets.includes(t),
      );
      return this.resolvedTargets;
    }

    this.resolvedTargets = withTransitiveDependencies(
      explicitTargets,
      entries,
      allTargets,
      depType,
    );

    return this.resolvedTargets;
  }

  /** Resolves targets through all filtering stages: explicit targets, transitive deps, script
   * preFilters, user --filter, --changed, script targetFilter, --with-dependants,
   * with-dependencies. Called by run() before script execution. Scripts read the result from
   * getResolvedTargets().
   */
  resolveExecutionPlan(ScriptClass: typeof BaseScript): string[] {
    const entries = this.config.project.services.entries;
    const allTargets = this.config.targets;

    // Get ScriptArgs for filter/changed/since values
    let scriptArgs: ScriptArgs | undefined;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing static 'args' property not declared on base class
    if ((ScriptClass as unknown as { args: unknown }).args) {
      scriptArgs = this.prepareScriptArgs(ScriptClass, ScriptClass, false);
    }

    // Step 1: Start from resolved DAG targets (explicit + transitive deps)
    // depSource controls which dep edges to follow for this script
    const depSource = ScriptClass.depSource ?? ["build", "runtime"];
    const dagTargets = this.resolveTargetDAG(depSource);
    let targets = dagTargets.length > 0 ? [...dagTargets] : [...allTargets];

    // Step 2: Apply script preFilters (e.g., "buildable") when no explicit targets
    const scriptPreFilters = ScriptClass.preFilters ?? [];
    if (scriptPreFilters.length > 0 && dagTargets.length === 0) {
      const preFilterExprs = scriptPreFilters.map(parseFilterExpression);
      const ctx: FilterContext = { projectRoot: this.config.root };
      targets = applyFiltersToNames(targets, entries, preFilterExprs, ctx);
    }

    // Step 3: Apply user --filter expressions
    if (scriptArgs) {
      const filterValue = scriptArgs.get<string[] | undefined>("filter");
      if (filterValue) {
        const filterExprs = filterValue
          .flatMap((v: string) => v.split(","))
          .filter(Boolean)
          .map(parseFilterExpression);
        const sinceRaw = scriptArgs.get<string | undefined>("since");
        const ctx: FilterContext = {
          projectRoot: this.config.root,
          ...parseSinceArg(sinceRaw),
        };
        targets = applyFiltersToNames(targets, entries, filterExprs, ctx);
      }
    }

    // Step 4: Apply --changed + --since
    if (scriptArgs) {
      const changed = scriptArgs.get<boolean>("changed") ?? false;
      if (changed) {
        const sinceRaw = scriptArgs.get<string | undefined>("since");
        const changedFilter = parseFilterExpression("changed");
        const ctx: FilterContext = {
          projectRoot: this.config.root,
          ...parseSinceArg(sinceRaw),
        };
        targets = applyFiltersToNames(targets, entries, [changedFilter], ctx);
      }
    }

    // Step 5: Apply script targetFilter (e.g., "has this command")
    const targetFilter = ScriptClass.targetFilter;
    if (typeof targetFilter === "function") {
      targets = targets.filter((t) => {
        const service = entries[t];
        return service ? targetFilter(service, this) : false;
      });
    }

    // Snapshot before graph expansion (for reporting in --print)
    this.preExpansionTargets = [...targets];

    // Step 6: Apply --with-dependencies (expand to include deps of current targets)
    if (scriptArgs) {
      if (scriptArgs.get<boolean>("with-dependencies")) {
        targets = withDependencies(targets, entries, allTargets);
      }
    }

    // Step 7: Apply --with-dependants (expand to include consumers of current targets)
    if (scriptArgs) {
      if (scriptArgs.get<boolean>("with-dependants")) {
        targets = withDependants(targets, entries, allTargets);
      }
    }

    this.resolvedTargets = targets;
    this.applySelectionToGraph(targets);
    return targets;
  }

  /** Mutate `selection` on every graph node to reflect the resolved plan. Explicit targets
   * (named on the CLI) get `"explicit"`, anything else in the resolved set gets
   * `"transitive"`, everything else stays `"excluded"`. Re-applies cleanly across calls:
   * every node is reset before writing.
   */
  private applySelectionToGraph(resolved: string[]): void {
    const explicit = new Set(this.parseExplicitTargets());
    const included = new Set(resolved);
    for (const node of this.graph.targets.values()) {
      if (explicit.has(node.id)) {
        node.selection = "explicit";
      } else if (included.has(node.id)) {
        node.selection = "transitive";
      } else {
        node.selection = "excluded";
      }
    }
  }

  /**
   * Get the resolved targets from the execution plan.
   * Scripts call this instead of parsing targets from args.
   * Returns null when the plan has not been resolved yet (direct fn() calls).
   */
  getResolvedTargets(): string[] | null {
    return this.resolvedTargets;
  }

  getService(id: string): NormalizedService {
    const service = this.config.project.services.entries[id];
    if (!service) {
      throw new Error(
        `Unknown service "${id}". Define it in nopo.yml before running this command.`,
      );
    }
    return service;
  }

  /**
   * Get the resolved package managers for a service.
   * Returns the service's package_managers array (already merged with project defaults).
   */
  getPackageManagers(serviceId: string): PackageManagerConfig[] {
    return this.getService(serviceId).packageManagers;
  }

  /**
   * Get a specific package manager config by name from the project-level definitions.
   */
  getPackageManagerConfig(name: string): PackageManagerConfig | undefined {
    return this.config.project.packageManagers[name];
  }

  /**
   * Get all unique package managers needed by the resolved target set.
   * Deduplicates by lockfile path (same lockfile = same install).
   */
  getAllPackageManagers(targets?: string[]): PackageManagerConfig[] {
    const serviceIds = targets ?? this.resolvedTargets ?? this.config.targets;
    const seen = new Map<string, PackageManagerConfig>();

    for (const id of serviceIds) {
      const service = this.config.project.services.entries[id];
      if (!service) continue;
      for (const pm of service.packageManagers) {
        const key = pm.lockfile;
        if (!seen.has(key)) {
          seen.set(key, pm);
        }
      }
    }

    return Array.from(seen.values());
  }

  async isDependencyEnabled(dependency: ScriptDependency): Promise<boolean> {
    return typeof dependency.enabled === "function"
      ? await dependency.enabled(this)
      : dependency.enabled;
  }

  async resolveDependencies(
    ScriptClass: typeof BaseScript,
    dependenciesMap: Map<typeof BaseScript, boolean[]> = new Map(),
  ): Promise<Map<typeof BaseScript, boolean[]>> {
    for await (const dependency of ScriptClass.dependencies) {
      const enabled = await this.isDependencyEnabled(dependency);

      const enabledArr = dependenciesMap.get(dependency.class) || [];
      enabledArr.push(enabled);
      dependenciesMap.set(dependency.class, enabledArr);

      if (enabled) {
        await this.resolveDependencies(dependency.class, dependenciesMap);
      }
    }
    return dependenciesMap;
  }

  async run(ScriptClass: typeof BaseScript): Promise<void> {
    // Centralized execution plan: resolve targets through all filtering stages
    this.resolveExecutionPlan(ScriptClass);

    // Intercept --print: output the resolved plan and return without executing. resolution
    // form is opt-in via `--print --json` (added in M3, CI migrated in M4).
    if (this.hasPrintFlag()) {
      const dryOutput = await this.collectDryRunOutput(ScriptClass);
      if (this.hasJsonFlag()) {
        this.io.stdout.write(JSON.stringify(dryOutput) + "\n");
        return;
      }
      this.writeRenderedPlan(dryOutput);
      return;
    }

    const scripts = await this.resolveDependencies(ScriptClass);
    scripts.set(ScriptClass, [true]);
    const line = (length: number) =>
      `${Array(Math.round(length * 1.618))
        .fill("=")
        .join("")}`;
    for (const [ScriptToRun, enabledArr] of scripts.entries()) {
      const enabled = enabledArr.some(Boolean);
      const skipped = enabled ? "" : chalk.bold("(skipped)");
      const color = enabled ? chalk.magenta : chalk.gray;
      const message = `${chalk.bold(ScriptToRun.name)}: ${ScriptToRun.description} ${skipped}`;
      const length = message.length + 2;
      // Section banner is diagnostic, not data — route through logger.error (stderr) so that
      // pipelines like `nopo secret get ... | head` see only the script's actual output.
      this.logger.error(
        color([line(length), message, line(length)].join("\n")),
      );
      if (!enabled) continue;

      // Determine if this script is running as a dependency
      const isDependency = ScriptToRun !== ScriptClass;

      // Create a runner with potentially modified argv (targets stripped for dependencies)
      const runnerForScript = this.prepareRunnerForScript(
        ScriptToRun,
        isDependency,
      );

      try {
        // Every script exposes `static plan(args, scope)` and routes through the plan runner. The
        // dispatch table built from `runnerForScript` knows how to execute every builtin handler
        const planFn = getStaticPlan(ScriptToRun);
        if (planFn === null) {
          throw new Error(
            `Script "${ScriptToRun.name}" must implement static plan() — fn() is no longer supported on built-in scripts`,
          );
        }
        await this.runViaPlan(
          ScriptToRun,
          ScriptClass,
          runnerForScript,
          isDependency,
          planFn,
        );
      } catch (error) {
        if (error instanceof ProcessOutput) {
          this.logger.log(chalk.red(error.stdout));
          this.logger.log(chalk.red(error.stderr));
          this.logger.log(error.stack);
          this.io.exit(error.exitCode);
        }
        throw error;
      }
    }
  }

  /** The plan runner is now the only dispatcher — every script (built-in or {@link
   * LegacyScript}-derived) routes here. Failure handling: the plan runner records `{message,
   * stack}` on each failed `NodeResult`, but the original {@link ProcessOutput} (with its
   * `exitCode`/`stdout`/`stderr`) is only available on the raw `node-failure` event. We
   */
  private async runViaPlan(
    ScriptToRun: typeof BaseScript,
    ParentScript: typeof BaseScript,
    runnerForScript: Runner,
    isDependency: boolean,
    planFn: (args: ScriptArgs, scope: unknown) => Plan,
  ): Promise<void> {
    /* eslint-disable @typescript-eslint/consistent-type-assertions -- accessing static 'args' property not declared on base class */
    const usesScriptArgs = !!(ScriptToRun as unknown as { args?: unknown })
      .args;
    /* eslint-enable @typescript-eslint/consistent-type-assertions */
    const args = usesScriptArgs
      ? this.prepareScriptArgs(ScriptToRun, ParentScript, isDependency)
      : new ScriptArgs({}, runnerForScript);

    const scope = buildScopeForScript(runnerForScript, ScriptToRun, args);
    if (scope === null) {
      // Only CommandScript with no argv[0] reaches here — a degenerate state where there's no
      // command to fan out across. Surface a clear error rather than silently exiting 0.
      throw new Error(
        `Cannot build plan scope for script "${ScriptToRun.name}"`,
      );
    }

    // CommandScript-specific validation: refuse to dispatch NOTHING. This guard used to ask
    // "is the command defined on ANY service?", which let `nopo makemigrations af-api` exit 0
    if (ScriptToRun.name === "") {
      const commandName = runnerForScript.argv[0];
      if (commandName) {
        const filterValue = args.get<string[] | undefined>("filter");
        assertCommandDispatches({
          project: runnerForScript.config.project,
          commandName,
          explicitTargets: runnerForScript.parseExplicitTargets(),
          stageCount: countNonEmptyStages(scope),
          skipMissing: args.get<boolean>("skip-missing") ?? false,
          narrowed:
            (filterValue?.length ?? 0) > 0 ||
            (args.get<boolean>("changed") ?? false),
        });
      }
    }

    const rawPlan = planFn(args, scope);

    // Plugins can declaratively fold N nodes of the emitted plan into a single batch node (see
    // `plan-compact.ts`). When no plugin declares batches this is a deep-equal no-op. Cycles
    const compactionCtx = this.buildCompactionContext(runnerForScript, args);
    const plan = compactPlan(rawPlan, compactionCtx);

    // M10 — wire the streaming renderer (M7) into the live execution path. The renderer
    // consumes every PlanEvent and produces aligned prefixes, stage headers, the failure
    const isTrivialPlan = plan.nodes.size <= 1;

    let streamingRenderer: ReturnType<typeof createStreamingRenderer> | null =
      null;
    if (!isTrivialPlan) {
      const failedTailArg = args.get<number>("failed-tail");
      const failedTailOpt =
        typeof failedTailArg === "number" ? { failedTail: failedTailArg } : {};
      streamingRenderer = createStreamingRenderer(
        runnerForScript.io,
        failedTailOpt,
      );

      const width = runnerForScript.detectTerminalWidth();
      runnerForScript.io.stdout.write(renderPlanDag(plan, { width }));
    }

    // Capture the raw Error from the FIRST node-failure event so the original `ProcessOutput`
    // (with exitCode / stdout / stderr) flows through the surrounding try/catch unchanged.
    let firstFailure: Error | null = null;
    const onEvent = (event: PlanEvent): void => {
      streamingRenderer?.onEvent(event);
      if (event.type === "node-failure" && firstFailure === null) {
        firstFailure = event.error;
      }
    };

    // Lazy import: dispatch.ts eagerly imports every built-in script module, and those scripts
    // import Script/TargetScript from this file — eager import here would create a load-order
    const { buildDispatch } = await import("./dispatch.ts");

    // Plan-wide knobs that come from CLI flags rather than from the plan itself.
    // CommandScript's `--concurrency` and `--no-fail-fast` map directly
    const noFailFast = args.get<boolean>("no-fail-fast") ?? false;
    const failureMode: "fail-fast" | "keep-going" = noFailFast
      ? "keep-going"
      : "fail-fast";
    const concurrencyArg = args.get<number>("concurrency");
    const maxConcurrency =
      typeof concurrencyArg === "number" && concurrencyArg > 0
        ? concurrencyArg
        : undefined;

    const result = await executePlan(plan, {
      io: runnerForScript.io,
      dispatch: buildDispatch(runnerForScript),
      failureMode,
      ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
      onEvent,
    });

    if (!result.ok) {
      // Keep-going mode (`--no-fail-fast`): independent branches all run to completion before we
      // surface an error, so multiple failures can stack up. Aggregate them into a single
      const failed = [...result.results.values()].filter(
        (r) => r.status === "failure",
      );
      if (failureMode === "keep-going" && failed.length > 1) {
        const summary = failed
          .map((r) => `  - ${r.id}: ${r.error?.message ?? "unknown error"}`)
          .join("\n");
        throw new Error(`${failed.length} task(s) failed:\n${summary}`);
      }
      if (firstFailure !== null) throw firstFailure;
      // Surface a generic error so the caller still sees a non-zero exit.
      throw new Error(
        failed[0]?.error?.message ?? `plan failed: ${ScriptToRun.name}`,
      );
    }
  }

  /** Recognized forms: print → default (compacted) plan print=compacted → same as bare
   * `--print` (explicit) print=raw → pre-compaction plan (MT3) We probe argv directly rather
   * than going through the script arg parser because (a) `--print` is a global flag, not
   * script-scoped, and (b) `collectDryRunOutput` runs before per-script arg parsing has
   */
  private hasPrintFlag(): boolean {
    return this.argv.some((a) => a === "--print" || a.startsWith("--print="));
  }

  /** Resolve the `--print` mode from argv. Bare `--print` and `--print=compacted` both yield
   * `"compacted"` (the default — the plan that actually runs). `--print=raw` yields `"raw"`
   * — the pre-compaction plan, useful for debugging. Unknown values fall back to
   * `"compacted"` (forgiving rather than error-prone for shell pipelines).
   */
  private getPrintMode(): PrintMode {
    for (const arg of this.argv) {
      if (arg === "--print") return "compacted";
      if (arg.startsWith("--print=")) {
        const value = arg.slice("--print=".length);
        if (value === "raw") return "raw";
        return "compacted";
      }
    }
    return "compacted";
  }

  /** M5 makes JSON the opt-in form behind `--print --json`; the bare `--print` now renders
   * the DAG. We probe argv directly rather than going through the script arg parser because
   * `collectDryRunOutput` runs before per-script arg parsing has flushed all cli flags into
   * the typed surface.
   */
  private hasJsonFlag(): boolean {
    return this.argv.includes("--json");
  }

  /** Render the dry-run plan as an ASCII DAG and write it to stdout. Trivial plans (≤1 node)
   * — including dry-runs of scripts that don't implement `static plan()` (where
   * `dryOutput.plan` is `null`) — collapse to a one-line summary so the user sees something
   * useful.
   */
  private writeRenderedPlan(dryOutput: DryRunOutput): void {
    const serialized = dryOutput.plan;
    if (serialized === null || serialized.nodes.length === 0) {
      const finalCount = dryOutput.finalTargets.length;
      const targetSummary =
        finalCount === 0
          ? "no targets"
          : finalCount === 1
            ? `1 target (${dryOutput.finalTargets[0]})`
            : `${finalCount} targets`;
      this.io.stdout.write(
        `Plan: ${dryOutput.command} — ${targetSummary} — no execution graph\n`,
      );
      return;
    }
    const plan = deserializePlan(serialized);
    const width = this.detectTerminalWidth();
    this.io.stdout.write(
      plan.nodes.size <= 1
        ? renderTrivialSummary(plan) + "\n"
        : renderPlanDag(plan, { width }),
    );
  }

  /** Read terminal width from `io.stdout.columns`, falling back to a sensible default for
   * non-TTY consumers (CI, pipes). The renderer uses this to cap column widths so long
   * labels truncate rather than wrap.
   */
  private detectTerminalWidth(): number {
    const stdout = this.io.stdout;
    if ("columns" in stdout) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- duck-typed access on optional `columns` field
      const cols = (stdout as { columns?: unknown }).columns;
      if (typeof cols === "number" && cols > 0) return cols;
    }
    return 120;
  }

  /**
   * Collect dry-run output for --print mode.
   * Resolves targets, filters, dependency graph, plugins, and script dependencies
   * without executing the script.
   */
  private async collectDryRunOutput(
    ScriptClass: typeof BaseScript,
  ): Promise<DryRunOutput> {
    // Resolve script dependencies
    const depMap = await this.resolveDependencies(ScriptClass);

    // Prepare args for the main script to resolve targets
    let scriptArgs: ScriptArgs | undefined;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing static 'args' property not declared on base class
    if ((ScriptClass as unknown as { args: unknown }).args) {
      scriptArgs = this.prepareScriptArgs(ScriptClass, ScriptClass, false);
    }

    // MT3 — build the same compaction context used by `runViaPlan`, so the `--print` snapshot
    // reflects the plan that actually runs. When no per-script args were prepared
    const ctxArgs = scriptArgs ?? new ScriptArgs({}, this);
    const compactionCtx = this.buildCompactionContext(this, ctxArgs);
    const printMode = this.getPrintMode();

    return collectDryRunInfo({
      runner: this,
      ScriptClass,
      scriptArgs,
      depMap,
      withDependants,
      withDependencies,
      printMode,
      compactionCtx,
    });
  }

  /** Build the {@link CompactionContext} consumed by `compactPlan`. Used both by the live
   * execution path (`runViaPlan`) and the `--print` dry-run path (`collectDryRunOutput`) so
   * plugin batch specs see identical state in both — preventing the "the plan I printed
   * isn't the plan that ran" failure mode that motivated MT3.
   */
  private buildCompactionContext(
    runnerForScript: Runner,
    args: ScriptArgs,
  ): CompactionContext {
    return {
      services: runnerForScript.config.project.services.entries,
      project: runnerForScript.config.project,
      env: {
        ...runnerForScript.environment.processEnv,
        ...runnerForScript.environment.env,
        ...runnerForScript.environment.extraEnv,
      },
      args,
    };
  }

  private isTargetScript(ScriptClass: typeof BaseScript): boolean {
    return ScriptClass.prototype instanceof TargetScript;
  }

  /**
   * Get extra targets defined by a script (e.g., build script adds rootName)
   */
  private getExtraTargets(ScriptClass: typeof BaseScript): string[] {
    /* eslint-disable @typescript-eslint/consistent-type-assertions -- accessing optional static method not declared on base class */
    const getExtraTargets = (
      ScriptClass as unknown as {
        getExtraTargets?: (runner: Runner) => string[];
      }
    ).getExtraTargets;
    /* eslint-enable @typescript-eslint/consistent-type-assertions */

    if (typeof getExtraTargets === "function") {
      return getExtraTargets(this);
    }

    return [];
  }

  private createScriptInstance(
    ScriptClass: typeof BaseScript,
    runner: Runner,
    isDependency: boolean,
  ): BaseScript {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- constructing script from abstract class reference
    return new (ScriptClass as unknown as new (
      runner: Runner,
      isDependency?: boolean,
    ) => BaseScript)(runner, isDependency);
  }

  private prepareRunnerForScript(
    ScriptClass: typeof BaseScript,
    isDependency: boolean,
  ): Runner {
    // If script is not a TargetScript or not running as dependency, return runner as-is
    if (!this.isTargetScript(ScriptClass) || !isDependency) {
      return this;
    }

    // For TargetScript dependencies: replace user targets with the resolved DAG targets.
    // This ensures build, env, etc. receive the same resolved set as the parent command.
    const resolved = this.resolvedTargets;
    if (!resolved || resolved.length === 0) {
      // No resolved targets — strip targets from argv so the dependency defaults
      const commandName = ScriptClass.name;
      const argv = this.argv.slice(1);
      const leadingPositionals = commandName === "run" ? 1 : 0;

      try {
        const parsed = parseTargetArgs(commandName, argv, this.config.targets, {
          leadingPositionals,
        });
        const newArgv: string[] = [this.argv[0]!];
        newArgv.push(...parsed.leadingArgs);
        for (const [key, value] of Object.entries(parsed.options)) {
          if (typeof value === "boolean" && value) {
            newArgv.push(`--${key}`);
          } else if (typeof value === "string") {
            newArgv.push(`--${key}`, value);
          }
        }
        const runner = new Runner(
          this.config,
          this.environment,
          newArgv,
          this.logger,
          this.io,
        );
        runner.resolvedTargets = this.resolvedTargets;
        return runner;
      } catch {
        return this;
      }
    }

    // Build new argv with resolved targets injected
    const commandName = ScriptClass.name;
    const argv = this.argv.slice(1);
    const leadingPositionals = commandName === "run" ? 1 : 0;

    try {
      const parsed = parseTargetArgs(commandName, argv, this.config.targets, {
        leadingPositionals,
      });

      const newArgv: string[] = [this.argv[0]!];
      newArgv.push(...parsed.leadingArgs);
      // Inject resolved targets instead of original user targets
      newArgv.push(...resolved);
      // Add options back
      for (const [key, value] of Object.entries(parsed.options)) {
        if (typeof value === "boolean" && value) {
          newArgv.push(`--${key}`);
        } else if (typeof value === "string") {
          newArgv.push(`--${key}`, value);
        }
      }

      const runner = new Runner(
        this.config,
        this.environment,
        newArgv,
        this.logger,
        this.io,
      );
      runner.resolvedTargets = this.resolvedTargets;
      return runner;
    } catch {
      return this;
    }
  }

  /**
   * Prepare ScriptArgs for a script (new args system)
   * Handles both main scripts and dependencies, with arg overrides
   */
  private prepareScriptArgs(
    ScriptToRun: typeof BaseScript,
    ParentScript: typeof BaseScript,
    isDependency: boolean,
  ): ScriptArgs {
    // Get script's arg schema
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing static 'args' property not declared on base class
    const argsTemplate = (ScriptToRun as unknown as { args?: ScriptArgs }).args;

    if (!argsTemplate) {
      // Script doesn't use args system (shouldn't happen, but handle gracefully)
      return new ScriptArgs({}, this);
    }

    // Clone args with runner context
    const scriptArgs = new ScriptArgs(argsTemplate.getSchema(), this);

    if (isDependency) {
      // Find dependency definition in parent
      type DependencyDef = {
        class: typeof BaseScript;
        args?: (
          parentArgs: ScriptArgs,
          runner: Runner,
        ) => Record<string, unknown>;
      };
      /* eslint-disable @typescript-eslint/consistent-type-assertions -- accessing typed dependencies not on base class */
      const parentDeps =
        (ParentScript as unknown as { dependencies?: DependencyDef[] })
          .dependencies || [];
      /* eslint-enable @typescript-eslint/consistent-type-assertions */
      const depDef = parentDeps.find((d) => d.class === ScriptToRun);

      if (depDef?.args) {
        // Parent overrides dependency args
        let parentArgs: ScriptArgs;

        // Check if parent uses new ScriptArgs system
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing static 'args' property not on base class
        if ((ParentScript as unknown as { args?: unknown }).args) {
          parentArgs = this.prepareScriptArgs(
            ParentScript,
            ParentScript,
            false,
          );
        } else {
          // Parent uses old parseArgs system - create a bridge ScriptArgs
          parentArgs = new ScriptArgs({}, this);

          // If parent is TargetScript with old parseArgs, get its targets
          if (this.isTargetScript(ParentScript)) {
            /* eslint-disable @typescript-eslint/consistent-type-assertions -- narrowing to TargetScript after runtime check */
            const parentParsedArgs = (
              ParentScript as typeof TargetScript
            ).parseArgs(this, false);
            /* eslint-enable @typescript-eslint/consistent-type-assertions */
            // Inject targets from old system
            if (
              parentParsedArgs !== null &&
              typeof parentParsedArgs === "object" &&
              "targets" in parentParsedArgs &&
              Array.isArray(parentParsedArgs.targets)
            ) {
              parentArgs.set("targets", parentParsedArgs.targets);
            }
          }
        }

        const overrides = depDef.args(parentArgs, this);

        // Apply overrides (including targets!)
        for (const [key, value] of Object.entries(overrides)) {
          scriptArgs.set(key, value);
        }
      } else {
        // Use defaults for all args
        // (values stay empty, get() returns defaults)
      }
    } else {
      // For TargetScript: parse targets FIRST, strip from argv
      let argvForParsing = this.argv.slice(1); // Skip command name

      if (this.isTargetScript(ScriptToRun)) {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing to TargetScript after isTargetScript() check
        const TargetScriptClass = ScriptToRun as typeof TargetScript;

        // Check for extra targets (e.g., build script adds rootName)
        const extraTargets = this.getExtraTargets(TargetScriptClass);
        const availableTargets = [...extraTargets, ...this.config.targets];

        // 1. Parse targets from positionals
        const parsed = parseTargetArgs(
          TargetScriptClass.name,
          this.argv.slice(1),
          availableTargets,
          {
            supportsFilter: true,
            services: this.config.project.services.entries,
            projectRoot: this.config.root,
          },
        );

        const targets = parsed.targets;

        // 2. Strip targets from argv - rebuild with just flags
        argvForParsing = [];

        // Add back leading args if any
        if (parsed.leadingArgs.length > 0) {
          argvForParsing.push(...parsed.leadingArgs);
        }

        // Add back options
        for (const [key, value] of Object.entries(parsed.options)) {
          if (typeof value === "boolean" && value) {
            argvForParsing.push(`--${key}`);
          } else if (value !== undefined && value !== false) {
            argvForParsing.push(`--${key}`, String(value));
          }
        }

        // 3. Set targets on args (injected separately)
        scriptArgs.set("targets", targets);

        // Re-inject since (stripped by parseTargetArgs for filter evaluation
        // but also needed by scripts for their own --changed handling)
        if (parsed.since) {
          argvForParsing.push("--since", parsed.since);
        }
      }

      // 4. Parse remaining flags with ScriptArgs
      scriptArgs.parse(argvForParsing);
    }

    return scriptArgs;
  }

  // Plugin Hook Dispatch

  /** Returns the eagerly-built dependency graph cached on this Runner. Kept as a method
   * (rather than asking callers to read `runner.graph`) for back-compat with the 5+ existing
   * call sites. All callers now share the same instance, so `metadata` mutations from one
   * hook are visible to the next within an invocation.
   */
  buildGraph(): DependencyGraph {
    return this.graph;
  }

  /**
   * Fire all additive hooks for the given hook name.
   * Iterates loaded plugins in declaration order, calling each plugin's hook.
   */
  async fireHooks(
    hookName: AdditiveHookName,
    context: HookContext,
  ): Promise<void> {
    for (const plugin of this.config.project.plugins) {
      const hook = plugin.definition.hooks?.[hookName];
      if (hook) {
        this.logger.log(
          chalk.gray(`[plugin:${plugin.definition.name}] ${hookName}`),
        );
        await hook(context);
      }
    }
  }

  /** Get the override hook and its owning plugin name for the given hook name. Dispatch
   * order: When `pluginName` is given: target only that plugin. If the named plugin doesn't
   * define this override, throw — this is an explicit dispatch (e.g. `nopo up --runtime
   * prod` → root `runtimes.prod`). defines this override
   */
  getOverride(
    hookName: OverrideHookName,
    pluginName?: string,
  ): { fn: HookFn; pluginName: string } | null {
    if (pluginName) {
      const plugin = this.config.project.plugins.find(
        (p) => p.definition.name === pluginName,
      );
      if (!plugin) {
        throw new Error(
          `Plugin "${pluginName}" not registered. Cannot dispatch '${hookName}' to it.`,
        );
      }
      const override = plugin.definition.overrides?.[hookName];
      if (!override) {
        throw new Error(
          `Plugin "${pluginName}" does not define an override for '${hookName}'.`,
        );
      }
      return { fn: override, pluginName: plugin.definition.name };
    }

    for (const plugin of this.config.project.plugins) {
      const override = plugin.definition.overrides?.[hookName];
      if (override) {
        return { fn: override, pluginName: plugin.definition.name };
      }
    }
    return null;
  }

  /** Logs the plugin name and hook. Returns true if an override was fired, false if no
   * override exists. When `pluginName` is set, dispatch is explicit — only that plugin's
   * override runs; missing override is a hard error. This is how the runtime map (`nopo up
   * --runtime <name>`) routes to the right plugin.
   */
  async fireOverride(
    hookName: OverrideHookName,
    context: HookContext,
    pluginName?: string,
  ): Promise<boolean> {
    const override = this.getOverride(hookName, pluginName);
    if (!override) return false;

    this.logger.log(chalk.cyan(`[plugin:${override.pluginName}] ${hookName}`));
    await override.fn(context);
    return true;
  }
}
