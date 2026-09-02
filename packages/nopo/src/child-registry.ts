/** The command timeout (see {@link ./timeout.ts}) needs to actually stop the work when it
 * fires, not merely abandon a promise — otherwise the spawned `tsc`/`eslint`/`docker`
 * processes keep running orphaned, defeating the point (and still burning the CPU/memory
 * the queue exists to protect). Every real subprocess nopo spawns registers here
 */

/** The slice of `ChildProcess` we depend on — keeps tests trivial to fake. */
export interface KillableChild {
  kill(signal?: NodeJS.Signals): boolean | void;
  once(event: "close" | "error", listener: () => void): unknown;
}

const live = new Set<KillableChild>();

/**
 * Register a freshly-spawned child so the timeout can reach it. The child is
 * removed automatically when it closes or errors, so the set only ever holds
 * processes that are genuinely still running.
 */
export function trackChild(child: KillableChild): void {
  live.add(child);
  const drop = (): void => {
    live.delete(child);
  };
  child.once("close", drop);
  child.once("error", drop);
}

/**
 * Signal every tracked child. Returns how many were signalled. Errors from
 * `kill` (e.g. the process already exited) are swallowed — a best-effort
 * teardown should never throw.
 */
export function killTrackedChildren(
  signal: NodeJS.Signals = "SIGTERM",
): number {
  let count = 0;
  for (const child of live) {
    try {
      child.kill(signal);
      count++;
    } catch {
      // Already gone — nothing to do.
    }
  }
  return count;
}

/** Number of children currently tracked (for tests / diagnostics). */
export function trackedChildCount(): number {
  return live.size;
}
