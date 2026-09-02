/** Cross-session worker-slot client — the bit that runs inside every `nopo` invocation.
 * Before a heavy command fans out, it calls {@link acquireSlot}: connect to the shared
 * broker (auto-spawning it if this is the first heavy command on the machine), ask for as
 * many worker slots as the command would ideally use, and block until the broker grants
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { IO } from "./io.ts";
import { DEFAULT_IDLE_MS } from "./queue-broker.ts";
import type { ClientMeta, QueueStatus } from "./queue-protocol.ts";
import { autoConcurrency, memoryConcurrencyCap } from "./resource-limits.ts";

/** How long to keep trying to reach (or spawn) the broker before giving up
 * and running unthrottled. The broker boots in well under a second. */
const CONNECT_TIMEOUT_MS = 4_000;
/** Poll interval while waiting for the freshly-spawned broker to bind. */
const CONNECT_RETRY_MS = 50;
/** Delay before telling the user we're queued, so quick grants stay silent. */
const WAIT_NOTICE_MS = 750;

/** The handle returned by {@link acquireSlot}; `release` returns the slots. */
export interface SlotLease {
  release: () => void;
  /** Slots granted, or `undefined` when the queue was skipped/bypassed. */
  grant?: number;
}

/** A no-op lease — the queue was skipped/bypassed, nothing to release. */
export const NOOP_LEASE: SlotLease = { release: () => {} };

/** Defaults to a per-user, machine-global path so every worktree and every repo for that
 * user shares one budget — the host's CPU/memory is the shared resource, regardless of
 * which checkout the command runs in. Override with `NOPO_QUEUE_SOCKET` to scope the
 * budget differently (e.g. a per-repo path for isolated pools). Kept short by default
 */
export function queueSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.NOPO_QUEUE_SOCKET;
  if (override) return override;
  const uid =
    typeof process.getuid === "function" ? process.getuid() : "shared";
  return join(tmpdir(), `nopo-queue-${uid}.sock`);
}

/** Host-capacity based (NOT the per-command `NOPO_CONCURRENCY`): the lesser of a CPU budget
 * (cores − 2, reserving headroom so the laptop stays responsive) and the memory budget
 * (how many per-worker heaps fit in RAM). Memory matters because a slot can back a fat
 * `tsc`/`eslint`/`vitest` heap, and N concurrent sessions summing to the budget would
 */
function queueBudget(env: NodeJS.ProcessEnv): number {
  const override = env.NOPO_QUEUE_BUDGET;
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  const cpuBudget = availableParallelism() - 2;
  return Math.max(1, Math.min(cpuBudget, memoryConcurrencyCap()));
}

/** Blocks until the broker grants (this is the queue — waiting is the point). The caller
 * decides *whether* to queue (core scripts opt out via `Script.skipQueue`); this just does
 * it. `meta` is descriptive only — it lets `nopo queue` display what's running/waiting.
 * Returns a no-op lease when bypassed via `NOPO_NO_QUEUE` or on any failure to reach
 */
export async function acquireSlot(
  io: IO,
  meta?: Partial<ClientMeta>,
  opts?: { forceQueue?: boolean },
): Promise<SlotLease> {
  // Bypass the queue when running under test (vitest sets VITEST in every worker — covers
  // runCli, direct main() calls, and any future test) or when the user opts out
  const bypass =
    process.env.VITEST || io.env.NOPO_NO_QUEUE || process.env.NOPO_NO_QUEUE;
  if (bypass && !opts?.forceQueue) return NOOP_LEASE;

  try {
    const socketPath = queueSocketPath(io.env);
    const budget = queueBudget(io.env);
    const sock = await connectOrSpawn(io, socketPath, budget);
    if (!sock) {
      io.stderr.write("nopo: worker queue unavailable — running unthrottled\n");
      return NOOP_LEASE;
    }

    const fullMeta: ClientMeta = {
      cmd: meta?.cmd ?? "?",
      cwd: meta?.cwd ?? io.cwd(),
      pid: meta?.pid ?? process.pid,
    };
    const want = autoConcurrency();
    const grant = await requestGrant(io, sock, want, fullMeta);
    if (grant === null) {
      sock.destroy();
      return NOOP_LEASE; // broker vanished mid-handshake — fail open.
    }

    process.env.NOPO_CONCURRENCY = String(grant);

    let released = false;
    return {
      grant,
      release: () => {
        if (released) return;
        released = true;
        sock.end();
      },
    };
  } catch {
    return NOOP_LEASE;
  }
}

/** Try to connect; resolve `null` (not reject) if nobody's listening. */
function tryConnect(socketPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    const onErr = (): void => {
      sock.destroy();
      resolve(null);
    };
    sock.once("error", onErr);
    sock.once("connect", () => {
      sock.removeListener("error", onErr);
      resolve(sock);
    });
  });
}

/** Connect to the broker, spawning it (once) if it isn't up yet. Resolves
 * `null` if it can't be reached within {@link CONNECT_TIMEOUT_MS}. */
async function connectOrSpawn(
  io: IO,
  socketPath: string,
  budget: number,
): Promise<Socket | null> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let spawned = false;
  for (;;) {
    const sock = await tryConnect(socketPath);
    if (sock) return sock;
    if (Date.now() >= deadline) return null;
    if (!spawned) {
      spawnBroker(socketPath, budget);
      spawned = true;
    }
    await delay(CONNECT_RETRY_MS);
  }
}

/** Spawn the broker as a detached background process. The spawn race (two
 * clients spawning at once) is harmless: only one wins the socket bind, the
 * other exits quietly. */
function spawnBroker(socketPath: string, budget: number): void {
  const brokerPath = fileURLToPath(
    new URL("./queue-broker.ts", import.meta.url),
  );
  let out: "ignore" | number = "ignore";
  try {
    const logDir = join(tmpdir(), "nopo-queue-logs");
    mkdirSync(logDir, { recursive: true });
    out = openSync(join(logDir, "broker.log"), "a");
  } catch {
    out = "ignore";
  }
  const child: ChildProcess = spawn(
    process.execPath,
    [brokerPath, socketPath, String(budget), String(DEFAULT_IDLE_MS)],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
}

/** Waits indefinitely on purpose — being queued behind other sessions is the whole feature.
 * Resolves `null` only if the socket dies before a grant arrives (broker crashed → caller
 * falls back to unthrottled). Prints a one-line notice if the wait runs long enough to be
 * worth mentioning.
 */
function requestGrant(
  io: IO,
  sock: Socket,
  want: number,
  meta: ClientMeta,
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    const notice = setTimeout(() => {
      if (!settled) {
        io.stderr.write(
          "nopo: machine busy — waiting for free worker slots…\n",
        );
      }
    }, WAIT_NOTICE_MS);

    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(notice);
      sock.removeListener("data", onData);
      resolve(value);
    };

    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg && msg.t === "grant" && typeof msg.n === "number") {
            finish(msg.n);
            return;
          }
        } catch {
          // Ignore noise; keep waiting for a valid grant line.
        }
      }
    };

    sock.setEncoding("utf8");
    sock.on("data", onData);
    sock.once("close", () => finish(null));
    sock.once("error", () => finish(null));
    sock.write(JSON.stringify({ t: "acq", want, meta }) + "\n");
  });
}

/**
 * Query the broker for a read-only snapshot of what's running and queued.
 * Connects but never spawns — if no broker is up, the queue is empty by
 * definition, so it resolves `null`. Backs `nopo queue`.
 */
export function queryQueue(io: IO): Promise<QueueStatus | null> {
  return new Promise((resolve) => {
    void (async () => {
      const sock = await tryConnect(queueSocketPath(io.env));
      if (!sock) {
        resolve(null);
        return;
      }
      let settled = false;
      let buf = "";
      const finish = (value: QueueStatus | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.end();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), CONNECT_TIMEOUT_MS);

      sock.setEncoding("utf8");
      sock.on("data", (chunk: Buffer | string) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        try {
          const msg = JSON.parse(buf.slice(0, nl).trim());
          if (msg && msg.t === "status") {
            // Drop the wire-envelope discriminant; return a clean QueueStatus.
            const { t: _t, ...status } = msg;
            finish(status);
          } else finish(null);
        } catch {
          finish(null);
        }
      });
      sock.once("error", () => finish(null));
      sock.once("close", () => finish(null));
      sock.write(JSON.stringify({ t: "status" }) + "\n");
    })();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
