/** Cross-session worker-slot broker — the transport + lifecycle around {@link SlotPool}. A
 * single ephemeral process owns the shared budget for the whole machine. Clients (each
 * `nopo` invocation running a heavy command) connect over a unix domain socket and request
 * slots; the broker grants them from the pool and queues the rest. The crucial property
 */

import { unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";

import { type Grant, SlotPool } from "./queue-core.ts";
import type { ClientMeta, QueueStatus } from "./queue-protocol.ts";

/** Default idle window before an unused broker shuts itself down. */
export const DEFAULT_IDLE_MS = 30_000;

export interface BrokerOptions {
  socketPath: string;
  budget: number;
  /** Idle window before self-shutdown. Defaults to {@link DEFAULT_IDLE_MS}. */
  idleMs?: number;
  /** Called once the broker decides to shut down (idle). Standalone uses this
   * to `process.exit(0)`; tests can observe it. */
  onIdleShutdown?: () => void;
  /** Diagnostic sink (defaults to a no-op; standalone wires it to stderr). */
  log?: (msg: string) => void;
}

export interface BrokerHandle {
  /** Stop listening, drop all connections, and unlink the socket. */
  close(): Promise<void>;
  /** The budget this broker was started with. */
  budget: number;
}

/** Error thrown when another live broker already owns the socket. */
export class BrokerAlreadyRunningError extends Error {
  constructor(socketPath: string) {
    super(`a broker is already listening on ${socketPath}`);
    this.name = "BrokerAlreadyRunningError";
  }
}

/** Start a broker listening on `socketPath`. Resolves once it is accepting connections.
 * Rejects with {@link BrokerAlreadyRunningError} if a live broker already holds the socket
 * (the spawn race is expected and benign — the loser just exits). A stale socket file left
 * by a dead broker is detected and removed automatically.
 */
export async function runBroker(opts: BrokerOptions): Promise<BrokerHandle> {
  const { socketPath, budget } = opts;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const log = opts.log ?? (() => {});

  const pool = new SlotPool(budget);
  /** clientId -> socket, so a grant decided by one client's release can be
   * delivered to the right waiting client. */
  const clients = new Map<number, Socket>();
  /** Per-client display metadata + timestamps, for the `status` verb. */
  const meta = new Map<number, ClientMeta>();
  const requestedAt = new Map<number, number>();
  const grantedAt = new Map<number, number>();
  let nextClientId = 1;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const server = createServer();

  const send = (clientId: number, line: object): void => {
    const sock = clients.get(clientId);
    if (sock && !sock.destroyed) sock.write(JSON.stringify(line) + "\n");
  };

  const deliver = (grants: Grant[]): void => {
    const now = Date.now();
    for (const g of grants) {
      grantedAt.set(g.clientId, now);
      send(g.clientId, { t: "grant", n: g.n });
    }
  };

  const buildStatus = (): { t: "status" } & QueueStatus => {
    const snap = pool.snapshot();
    const now = Date.now();
    const fallback: ClientMeta = { cmd: "?", cwd: "?", pid: 0 };
    return {
      t: "status",
      budget,
      used: pool.used,
      running: snap.granted.map((g) => ({
        ...(meta.get(g.clientId) ?? fallback),
        slots: g.n,
        runningMs: now - (grantedAt.get(g.clientId) ?? now),
      })),
      pending: snap.waiting.map((w, i) => ({
        ...(meta.get(w.clientId) ?? fallback),
        want: w.want,
        waitingMs: now - (requestedAt.get(w.clientId) ?? now),
        position: i + 1,
      })),
    };
  };

  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (!pool.idle || closed) return;
    idleTimer = setTimeout(() => {
      if (pool.idle && !closed) {
        log(`idle ${idleMs}ms — shutting down`);
        void shutdown().then(() => opts.onIdleShutdown?.());
      }
    }, idleMs);
    // Don't let the idle timer keep the process alive on its own.
    idleTimer.unref?.();
  };

  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const sock of clients.values()) sock.destroy();
    clients.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(socketPath);
    } catch {
      // Already gone / never created — nothing to clean up.
    }
  };

  server.on("connection", (sock) => {
    const clientId = nextClientId++;
    clients.set(clientId, sock);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    log(`client ${clientId} connected`);

    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        handleMessage(clientId, line);
      }
    });

    const onGone = (): void => {
      if (!clients.has(clientId)) return;
      clients.delete(clientId);
      log(`client ${clientId} gone — releasing`);
      const grants = pool.release(clientId);
      meta.delete(clientId);
      requestedAt.delete(clientId);
      grantedAt.delete(clientId);
      deliver(grants);
      armIdleTimer();
    };
    sock.on("close", onGone);
    sock.on("error", onGone);
  });

  const handleMessage = (clientId: number, line: string): void => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`client ${clientId} sent malformed line: ${line}`);
      return;
    }
    if (!isRecord(msg)) return;
    // Read-only introspection for `nopo queue` — never touches the pool.
    if (msg.t === "status") {
      send(clientId, buildStatus());
      return;
    }
    if (msg.t !== "acq") return;
    const n = typeof msg.want === "number" ? msg.want : 1;
    if (isRecord(msg.meta)) meta.set(clientId, normalizeMeta(msg.meta));
    requestedAt.set(clientId, Date.now());
    log(`client ${clientId} acq want=${n}`);
    deliver(pool.request(clientId, n));
  };

  await listen(server, socketPath);
  log(`listening on ${socketPath} budget=${budget}`);
  armIdleTimer();

  return { close: shutdown, budget };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function normalizeMeta(raw: Record<string, unknown>): ClientMeta {
  return {
    cmd: typeof raw.cmd === "string" ? raw.cmd : "?",
    cwd: typeof raw.cwd === "string" ? raw.cwd : "?",
    pid: typeof raw.pid === "number" ? raw.pid : 0,
  };
}

/**
 * Listen on the unix socket, transparently clearing a stale socket file left
 * behind by a dead broker. If the socket is held by a *live* broker, reject
 * with {@link BrokerAlreadyRunningError}.
 */
function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code !== "EADDRINUSE") {
        reject(err);
        return;
      }
      // Probe: can we connect? If yes, a live broker owns it — stand down. If the connection is
      // refused, the file is stale; remove it and try once more.
      const probe = connect(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        reject(new BrokerAlreadyRunningError(socketPath));
      });
      probe.once("error", () => {
        probe.destroy();
        try {
          unlinkSync(socketPath);
        } catch {
          // Raced with another cleanup — fall through and let listen decide.
        }
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    };

    server.once("error", onError);
    server.listen(socketPath, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

// Standalone entrypoint: `bun queue-broker.ts <socketPath> <budget> [idleMs]`.
// The first client that can't reach a broker spawns this, detached.
if (import.meta.main) {
  const [socketPath, budgetRaw, idleRaw] = process.argv.slice(2);
  if (!socketPath || !budgetRaw) {
    console.error("usage: queue-broker <socketPath> <budget> [idleMs]");
    process.exit(2);
  }
  const budget = Number.parseInt(budgetRaw, 10);
  const idleMs = idleRaw ? Number.parseInt(idleRaw, 10) : DEFAULT_IDLE_MS;
  runBroker({
    socketPath,
    budget,
    idleMs,
    log: (msg) => process.stderr.write(`[nopo-queue] ${msg}\n`),
    onIdleShutdown: () => process.exit(0),
  })
    .then(() => {
      process.stderr.write(`[nopo-queue] broker up (budget=${budget})\n`);
    })
    .catch((err) => {
      if (err instanceof BrokerAlreadyRunningError) {
        // Lost the spawn race — the winner is serving. Exit quietly.
        process.exit(0);
      }
      process.stderr.write(`[nopo-queue] broker failed: ${String(err)}\n`);
      process.exit(1);
    });
}
