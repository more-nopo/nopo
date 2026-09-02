import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type BrokerHandle, runBroker } from "./queue-broker.ts";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "nopo-q-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "q.sock");
}

async function startBroker(
  socketPath: string,
  budget: number,
  idleMs = 60_000,
): Promise<BrokerHandle> {
  const handle = await runBroker({ socketPath, budget, idleMs });
  cleanups.push(() => handle.close());
  return handle;
}

/** A raw client: connects, can `acq`, and resolves the next grant. */
function client(socketPath: string): {
  sock: Socket;
  acquire: (want: number, meta?: Record<string, unknown>) => Promise<number>;
  close: () => void;
} {
  const sock = connect(socketPath);
  sock.setEncoding("utf8");
  let buf = "";
  let pending: ((n: number) => void) | null = null;
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.t === "grant" && pending) {
        const resolve = pending;
        pending = null;
        resolve(msg.n);
      }
    }
  });
  cleanups.push(() => {
    sock.destroy();
  });
  return {
    sock,
    acquire: (want: number, meta?: Record<string, unknown>) =>
      new Promise<number>((resolve) => {
        pending = resolve;
        sock.write(JSON.stringify({ t: "acq", want, meta }) + "\n");
      }),
    close: () => sock.end(),
  };
}

/** One-shot read-only status query over a fresh connection. */
function queryStatus(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      resolve(JSON.parse(buf.slice(0, nl).trim()));
      sock.end();
    });
    sock.write(JSON.stringify({ t: "status" }) + "\n");
  });
}

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("queue broker", () => {
  it("grants the budget to a single client", async () => {
    const path = tempSocket();
    await startBroker(path, 6);
    const c = client(path);
    expect(await c.acquire(6)).toBe(6);
  });

  it("queues a second client until the first releases", async () => {
    const path = tempSocket();
    await startBroker(path, 4);

    const a = client(path);
    expect(await a.acquire(4)).toBe(4); // takes everything

    const b = client(path);
    let bGrant: number | null = null;
    void b.acquire(4).then((n) => (bGrant = n));

    await tick(); // give the broker time to (not) grant
    expect(bGrant).toBeNull(); // still queued

    a.close(); // release all 4
    await tick();
    expect(bGrant).toBe(4); // now served
  });

  it("frees slots when a client's socket dies (no explicit release)", async () => {
    const path = tempSocket();
    await startBroker(path, 4);

    const a = client(path);
    await a.acquire(4);

    const b = client(path);
    let bGrant: number | null = null;
    void b.acquire(4).then((n) => (bGrant = n));
    await tick();
    expect(bGrant).toBeNull();

    a.sock.destroy(); // hard kill — kernel closes the socket
    await tick();
    expect(bGrant).toBe(4);
  });

  it("never hands out more than the budget across clients", async () => {
    const path = tempSocket();
    await startBroker(path, 4);
    const a = client(path);
    const b = client(path);
    const ga = await a.acquire(2);
    const gb = await b.acquire(2);
    expect(ga + gb).toBeLessThanOrEqual(4);
  });

  it("reports running + pending with metadata via the status verb", async () => {
    const path = tempSocket();
    await startBroker(path, 4);

    const a = client(path);
    await a.acquire(4, { cmd: "check lint", cwd: "/repo/wt-a", pid: 111 });

    const b = client(path);
    void b.acquire(4, { cmd: "build", cwd: "/repo/wt-b", pid: 222 }); // queued

    await tick();
    const status = await queryStatus(path);

    expect(status.budget).toBe(4);
    expect(status.used).toBe(4);
    expect(status.running).toMatchObject([
      { cmd: "check lint", cwd: "/repo/wt-a", pid: 111, slots: 4 },
    ]);
    expect(status.pending).toMatchObject([
      { cmd: "build", cwd: "/repo/wt-b", pid: 222, want: 4, position: 1 },
    ]);
  });

  it("status is read-only — querying never consumes a slot", async () => {
    const path = tempSocket();
    await startBroker(path, 2);
    await queryStatus(path);
    await queryStatus(path);
    const c = client(path);
    expect(await c.acquire(2)).toBe(2); // full budget still available
  });

  it("self-shuts down after the idle window once all clients leave", async () => {
    const path = tempSocket();
    let shutdown = false;
    const handle = await runBroker({
      socketPath: path,
      budget: 4,
      idleMs: 80,
      onIdleShutdown: () => {
        shutdown = true;
      },
    });
    cleanups.push(() => handle.close());

    const c = client(path);
    await c.acquire(4);
    await tick(150);
    expect(shutdown).toBe(false); // busy → stays up

    c.close();
    await tick(200); // idle past the window
    expect(shutdown).toBe(true);
  });
});
