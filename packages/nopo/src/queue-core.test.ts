import { describe, expect, it } from "vitest";

import { SlotPool } from "./queue-core.ts";

describe("SlotPool", () => {
  it("grants the full budget to a lone client", () => {
    const pool = new SlotPool(8);
    expect(pool.request(1, 8)).toEqual([{ clientId: 1, n: 8 }]);
    expect(pool.used).toBe(8);
    expect(pool.available).toBe(0);
  });

  it("clamps a grant to what the client asked for", () => {
    const pool = new SlotPool(8);
    expect(pool.request(1, 3)).toEqual([{ clientId: 1, n: 3 }]);
    expect(pool.available).toBe(5);
  });

  it("never exceeds the budget — extra demand queues", () => {
    const pool = new SlotPool(8);
    pool.request(1, 8); // takes everything
    const grants = pool.request(2, 8); // no room
    expect(grants).toEqual([]);
    expect(pool.waitingCount).toBe(1);
    expect(pool.used).toBe(8);
  });

  it("serves a queued waiter when the holder releases (FIFO)", () => {
    const pool = new SlotPool(8);
    pool.request(1, 8);
    pool.request(2, 8); // queued
    const grants = pool.release(1);
    expect(grants).toEqual([{ clientId: 2, n: 8 }]);
    expect(pool.activeCount).toBe(1);
    expect(pool.waitingCount).toBe(0);
  });

  it("splits the budget fairly across simultaneous waiters", () => {
    const pool = new SlotPool(8);
    // Both clients queue behind a holder that then releases. Only client 2
    // waits, so it gets the whole budget.
    pool.request(1, 8);
    pool.request(2, 8);
    const grants = pool.release(1);
    expect(grants).toEqual([{ clientId: 2, n: 8 }]);
  });

  it("gives each of three co-waiters a fair share, never over budget", () => {
    const pool = new SlotPool(8);
    pool.request(99, 8); // holder
    pool.request(1, 8);
    pool.request(2, 8);
    pool.request(3, 8);
    const grants = pool.release(99); // free all 8 to 3 waiters
    // floor(8/3) = 2 each; total 6 ≤ 8, every waiter served ≥1.
    expect(grants).toEqual([
      { clientId: 1, n: 2 },
      { clientId: 2, n: 2 },
      { clientId: 3, n: 2 },
    ]);
    expect(pool.used).toBeLessThanOrEqual(8);
  });

  it("preserves strict FIFO — a large ask blocks smaller ones behind it", () => {
    const pool = new SlotPool(4);
    // Client 99 holds. Client 1 wants 4; client 2 wants 1 behind it.
    pool.request(99, 4);
    pool.request(1, 4);
    pool.request(2, 1);
    const grants = pool.release(99);
    // Fair share floor(4/2)=2 → client 1 gets 2; client 2 then gets 1.
    expect(grants).toEqual([
      { clientId: 1, n: 2 },
      { clientId: 2, n: 1 },
    ]);
  });

  it("always grants at least 1 slot even when fair share floors to 0", () => {
    const pool = new SlotPool(1);
    pool.request(1, 4);
    const grants = pool.request(2, 4); // budget 1, two interested
    // Client 1 already holds the only slot; client 2 must wait.
    expect(grants).toEqual([]);
    expect(pool.used).toBe(1);
    const next = pool.release(1);
    expect(next).toEqual([{ clientId: 2, n: 1 }]);
  });

  it("removes a still-queued client on release without granting it", () => {
    const pool = new SlotPool(8);
    pool.request(1, 8);
    pool.request(2, 8); // queued
    const grants = pool.release(2); // client 2 gives up before being served
    expect(grants).toEqual([]);
    expect(pool.waitingCount).toBe(0);
    expect(pool.used).toBe(8); // client 1 untouched
  });

  it("snapshots granted (grant order) and waiting (FIFO) clients", () => {
    const pool = new SlotPool(4);
    // Clients 1 and 2 get 2 each (budget full). Clients 3 and 4 queue.
    pool.request(1, 2);
    pool.request(2, 2);
    pool.request(3, 4);
    pool.request(4, 1);
    const snap = pool.snapshot();
    expect(snap.granted).toEqual([
      { clientId: 1, n: 2 },
      { clientId: 2, n: 2 },
    ]);
    expect(snap.waiting).toEqual([
      { clientId: 3, want: 4 },
      { clientId: 4, want: 1 },
    ]);
  });

  it("reports idle only when nothing is held or queued", () => {
    const pool = new SlotPool(4);
    expect(pool.idle).toBe(true);
    pool.request(1, 4);
    expect(pool.idle).toBe(false);
    pool.release(1);
    expect(pool.idle).toBe(true);
  });

  it("floors a fractional budget and guarantees at least 1", () => {
    expect(new SlotPool(2.9).request(1, 99)).toEqual([{ clientId: 1, n: 2 }]);
    expect(new SlotPool(0).request(1, 99)).toEqual([{ clientId: 1, n: 1 }]);
  });

  it("normalizes a non-positive or garbage want to 1", () => {
    const pool = new SlotPool(8);
    expect(pool.request(1, 0)).toEqual([{ clientId: 1, n: 1 }]);
    expect(pool.request(2, Number.NaN)).toEqual([{ clientId: 2, n: 1 }]);
  });
});
