/** Wire types shared by the queue broker (producer) and its clients (consumers): the
 * per-client metadata carried on an acquire, and the read-only status snapshot returned
 * for `nopo queue`. Kept in its own module so neither {@link ./queue-broker.ts} nor {@link
 * ./queue-client.ts} has to import the other just for a type.
 */

/** Descriptive metadata a client attaches so the queue can be displayed.
 * Purely informational — the broker never branches on it. */
export interface ClientMeta {
  /** The command line being run, e.g. `"check lint root"`. */
  cmd: string;
  /** The invocation's working directory (identifies the worktree/repo). */
  cwd: string;
  /** The client process id, so a human can find/kill it. */
  pid: number;
}

/** A command currently holding slots. */
export interface RunningItem extends ClientMeta {
  /** Worker slots granted to this command. */
  slots: number;
  /** Milliseconds since the slots were granted. */
  runningMs: number;
}

/** A command waiting in the FIFO queue for capacity. */
export interface PendingItem extends ClientMeta {
  /** Worker slots requested. */
  want: number;
  /** Milliseconds spent waiting so far. */
  waitingMs: number;
  /** 1-based position in the FIFO queue. */
  position: number;
}

/** The full queue snapshot returned by the broker's `status` verb. */
export interface QueueStatus {
  /** Total machine-wide worker budget. */
  budget: number;
  /** Slots currently handed out. */
  used: number;
  running: RunningItem[];
  pending: PendingItem[];
}
