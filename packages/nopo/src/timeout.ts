/** Every queued `nopo` command gets a wall-clock timeout so a hung command can't hold its
 * worker-slot lease (see {@link ./queue-client.ts}) forever and wedge the cross-session
 * queue. The default is 5 minutes; a command can ask for more (or disable it) via the CLI,
 * an env var, or a per-command default declared on its `Script` class. Precedence
 */

/** Default command timeout: 5 minutes. */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Sentinel for "explicitly disabled — run with no wall-clock limit". */
export const TIMEOUT_DISABLED = null;

const MS = 1;
const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

function unitToMs(unit: string): number {
  switch (unit) {
    case "ms":
      return MS;
    case "m":
      return MINUTE;
    case "h":
      return HOUR;
    default:
      return SECOND; // "s" or unsuffixed
  }
}

const DISABLE_WORDS = new Set(["0", "off", "none", "never", "false", "no"]);

/** @returns a positive number of milliseconds, or `null` when the value explicitly disables
 * the timeout, or `undefined` when the value is absent or unparseable (caller falls
 * through to the next precedence level).
 */
export function parseDuration(
  value: string | number | boolean | undefined,
): number | null | undefined {
  if (value === undefined || typeof value === "boolean") return undefined;

  // Bare number → seconds (matches `--timeout 300`). 0 disables.
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return value === 0 ? TIMEOUT_DISABLED : Math.round(value * 1000);
  }

  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return undefined;
  if (DISABLE_WORDS.has(trimmed)) return TIMEOUT_DISABLED;

  // Suffixed form: <number><unit>. Bare numeric string → seconds.
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const ms = Math.round(amount * unitToMs(match[2] ?? "s"));
  return ms === 0 ? TIMEOUT_DISABLED : ms;
}

export interface TimeoutSources {
  /** `--timeout` CLI value (raw, as minimist parsed it). */
  cli?: string | number | boolean | undefined;
  /** `NOPO_TIMEOUT` env value. */
  env?: string | undefined;
  /** `Script.timeoutMs` — a per-command default already expressed in ms. */
  scriptMs?: number | undefined;
}

export interface ResolveTimeoutOptions {
  /** Defaults to {@link DEFAULT_TIMEOUT_MS}. Callers pass `null` to mean "no implicit
   * timeout" — e.g. under CI, where jobs have their own `timeout-minutes` and legitimately
   * run long full-monorepo commands, so only an explicit `--timeout`/`NOPO_TIMEOUT` should
   * impose a limit.
   */
  fallbackMs?: number | null;
}

/**
 * Resolve the effective timeout in milliseconds, or `null` to run unbounded.
 * Walks the precedence chain and returns the first source that yields a
 * definite answer (a duration or an explicit disable), else the fallback.
 */
export function resolveTimeoutMs(
  sources: TimeoutSources,
  opts: ResolveTimeoutOptions = {},
): number | null {
  const fromCli = parseDuration(sources.cli);
  if (fromCli !== undefined) return fromCli;

  const fromEnv = parseDuration(sources.env);
  if (fromEnv !== undefined) return fromEnv;

  if (sources.scriptMs !== undefined) {
    if (!Number.isFinite(sources.scriptMs) || sources.scriptMs <= 0) {
      return TIMEOUT_DISABLED;
    }
    return sources.scriptMs;
  }

  return opts.fallbackMs === undefined ? DEFAULT_TIMEOUT_MS : opts.fallbackMs;
}

/** Human-friendly rendering of a timeout for log messages (`5m`, `90s`). */
export function formatTimeout(ms: number): string {
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  if (ms % MINUTE === 0) return `${ms / MINUTE}m`;
  if (ms % SECOND === 0) return `${ms / SECOND}s`;
  return `${ms}ms`;
}
