/** Multiple `nopo` invocations (different shells, different worktrees) each want to fan out
 * CPU/memory-heavy work (parallel `tsc`/`eslint`/`vitest`, builds). Run unchecked they sum
 * to far more workers than the host has cores, and the laptop thrashes. {@link SlotPool}
 * is the shared budget that coordinates them: one global pool of worker slots, handed out
 */

/** A decision to hand `n` slots to a waiting client. */
export interface Grant {
  clientId: number;
  n: number;
}

/** A client waiting in the FIFO queue for capacity. */
interface Waiter {
  clientId: number;
  want: number;
}

/** The sum of granted slots never exceeds `budget` (hard cap). Requests are served strictly
 * FIFO — no waiter starves. Every served waiter gets at least 1 slot. (`floor(budget /
 * interested)`, where *interested* = currently-holding + still-waiting clients), clamped
 * to what it asked for and what's actually free. A lone client therefore gets the whole
 */
export class SlotPool {
  private readonly budget: number;
  /** clientId -> slots currently held. */
  private readonly granted = new Map<number, number>();
  /** FIFO queue of clients awaiting capacity. */
  private waiters: Waiter[] = [];

  constructor(budget: number) {
    // A pool must be able to run at least one worker, else nothing proceeds.
    this.budget = Math.max(1, Math.floor(budget));
  }

  /** Slots handed out right now. */
  get used(): number {
    let total = 0;
    for (const n of this.granted.values()) total += n;
    return total;
  }

  /** Free slots available to grant. */
  get available(): number {
    return this.budget - this.used;
  }

  /** Clients currently holding slots. */
  get activeCount(): number {
    return this.granted.size;
  }

  /** Clients currently queued for capacity. */
  get waitingCount(): number {
    return this.waiters.length;
  }

  /** True when no client holds or awaits slots — the broker may shut down. */
  get idle(): boolean {
    return this.granted.size === 0 && this.waiters.length === 0;
  }

  /** Request `want` slots for `clientId`. The client is appended to the FIFO queue and the
   * pool is drained: the returned grants are everything that can be served right now (which
   * may or may not include this client). An empty array means the client is queued and will
   * be granted later, by a future {@link release}.
   */
  request(clientId: number, want: number): Grant[] {
    const n = Number.isFinite(want) && want >= 1 ? Math.floor(want) : 1;
    this.waiters.push({ clientId, want: n });
    return this.drain();
  }

  /**
   * Release everything `clientId` holds (or remove it from the queue if it
   * was still waiting — e.g. it disconnected before being granted). Returns
   * the grants that the freed capacity now unblocks, in FIFO order.
   */
  release(clientId: number): Grant[] {
    this.granted.delete(clientId);
    this.waiters = this.waiters.filter((w) => w.clientId !== clientId);
    return this.drain();
  }

  /**
   * A read-only view of who holds slots and who's waiting, preserving order
   * (grant order for `granted`, FIFO for `waiting`). The broker joins this
   * with per-client metadata to render `nopo queue`.
   */
  snapshot(): {
    granted: Array<{ clientId: number; n: number }>;
    waiting: Array<{ clientId: number; want: number }>;
  } {
    return {
      granted: [...this.granted].map(([clientId, n]) => ({ clientId, n })),
      waiting: this.waiters.map((w) => ({
        clientId: w.clientId,
        want: w.want,
      })),
    };
  }

  /** Each waiter is offered a fair share of the budget, clamped to its ask and to free
   * capacity. Stops at the first waiter that can't be given ≥1 slot so the strict FIFO
   * ordering is preserved (no skipping ahead to a smaller ask).
   */
  private drain(): Grant[] {
    const grants: Grant[] = [];
    while (this.waiters.length > 0 && this.available > 0) {
      const waiter = this.waiters[0]!;
      const interested = this.granted.size + this.waiters.length;
      const fairShare = Math.max(1, Math.floor(this.budget / interested));
      const n = Math.min(waiter.want, fairShare, this.available);
      if (n < 1) break;
      this.waiters.shift();
      this.granted.set(waiter.clientId, n);
      grants.push({ clientId: waiter.clientId, n });
    }
    return grants;
  }
}
