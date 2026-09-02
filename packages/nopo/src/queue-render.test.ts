import { describe, expect, it } from "vitest";

import type { QueueStatus } from "./queue-protocol.ts";
import QueueScript, {
  type QueueChalk,
  queueRun,
  type QueueRunContext,
} from "./scripts/queue.ts";

/** Identity chalk so assertions match on plain text. */
const plainChalk: QueueChalk = {
  cyan: (...a) => a.join(""),
  bold: (...a) => a.join(""),
  gray: (...a) => a.join(""),
  yellow: (...a) => a.join(""),
  green: (...a) => a.join(""),
};

function harness(
  status: QueueStatus | null,
  json = false,
): { run: () => Promise<void>; output: () => string } {
  let out = "";
  const ctx: QueueRunContext = {
    io: { stdout: { write: (s) => (out += s) } },
    chalk: plainChalk,
    json,
    query: () => Promise.resolve(status),
  };
  return { run: () => queueRun(ctx), output: () => out };
}

describe("queueRun", () => {
  it("renders running and pending commands", async () => {
    const status: QueueStatus = {
      budget: 8,
      used: 6,
      running: [
        {
          cmd: "check lint",
          cwd: "/repo/wt-a",
          pid: 111,
          slots: 4,
          runningMs: 80_000,
        },
        {
          cmd: "build",
          cwd: "/repo/wt-b",
          pid: 222,
          slots: 2,
          runningMs: 15_000,
        },
      ],
      pending: [
        {
          cmd: "test backend",
          cwd: "/repo/wt-c",
          pid: 333,
          want: 8,
          waitingMs: 8_000,
          position: 1,
        },
      ],
    };
    const h = harness(status);
    await h.run();
    const out = h.output();

    expect(out).toContain("budget 8, 6/8 in use");
    expect(out).toContain("RUNNING (2)");
    expect(out).toContain("check lint");
    expect(out).toContain("4 slots");
    expect(out).toContain("wt-a"); // basename of cwd
    expect(out).toContain("1m20s"); // 80s formatted
    expect(out).toContain("PENDING (1)");
    expect(out).toContain("#1 ");
    expect(out).toContain("test backend");
    expect(out).toContain("waiting 8s");
  });

  it("says the queue is empty when no broker is running", async () => {
    const h = harness(null);
    await h.run();
    expect(h.output()).toContain("empty (no broker running)");
  });

  it("shows empty RUNNING/PENDING sections when the broker is idle", async () => {
    const h = harness({ budget: 8, used: 0, running: [], pending: [] });
    await h.run();
    const out = h.output();
    expect(out).toContain("RUNNING (0)");
    expect(out).toContain("PENDING (0)");
    expect(out).toContain("none");
  });

  it("emits JSON when --json is set", async () => {
    const status: QueueStatus = {
      budget: 4,
      used: 0,
      running: [],
      pending: [],
    };
    const h = harness(status, true);
    await h.run();
    expect(JSON.parse(h.output())).toEqual(status);
  });

  it("emits an empty snapshot as JSON when no broker is running", async () => {
    const h = harness(null, true);
    await h.run();
    expect(JSON.parse(h.output())).toEqual({
      budget: 0,
      used: 0,
      running: [],
      pending: [],
    });
  });
});

describe("QueueScript", () => {
  it("is exempt from the queue and dispatches to queue:run", () => {
    expect(QueueScript.skipQueue).toBe(true);
    const plan = QueueScript.plan(
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal stub; plan() ignores both args
      undefined as unknown as Parameters<typeof QueueScript.plan>[0],
      { targets: [] },
    );
    const node = [...plan.nodes.values()][0];
    expect(node?.handler).toEqual({ kind: "builtin", name: "queue:run" });
  });
});
