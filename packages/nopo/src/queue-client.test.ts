import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { runBroker } from "./queue-broker.ts";
import { acquireSlot, queueSocketPath } from "./queue-client.ts";
import { mockIO } from "./test-utils/mock-io.ts";

function fakeIO(env: Record<string, string>): ReturnType<typeof mockIO> {
  return mockIO({ argv: ["nopo"], cwd: "/", env });
}

describe("acquireSlot", () => {
  const savedConcurrency = process.env.NOPO_CONCURRENCY;
  afterEach(() => {
    if (savedConcurrency === undefined) delete process.env.NOPO_CONCURRENCY;
    else process.env.NOPO_CONCURRENCY = savedConcurrency;
  });

  it("bypasses the queue (no broker contact) when NOPO_NO_QUEUE is set", async () => {
    const lease = await acquireSlot(fakeIO({ NOPO_NO_QUEUE: "1" }));
    expect(lease.grant).toBeUndefined();
    lease.release(); // must not throw
  });

  it("acquires a grant from a live broker and publishes NOPO_CONCURRENCY", async () => {
    const path = queueSocketPath();
    rmSync(path, { force: true });
    const broker = await runBroker({
      socketPath: path,
      budget: 3,
      idleMs: 60_000,
    });
    try {
      // acquireSlot bypasses under vitest by default; forceQueue opts back in to drive the real
      // broker. Pin `want` high so the grant is deterministically the budget cap
      process.env.NOPO_CONCURRENCY = "32";
      const lease = await acquireSlot(fakeIO({}), undefined, {
        forceQueue: true,
      });
      expect(lease.grant).toBe(3);
      expect(process.env.NOPO_CONCURRENCY).toBe("3");
      lease.release();
    } finally {
      await broker.close();
    }
  });
});
