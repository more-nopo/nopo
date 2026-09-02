import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import { type Plan, planFromNodes, type PlanNode } from "./plan.ts";
import {
  executePlan,
  type HandlerDispatch,
  type NodeResult,
  type PlanContext,
  type PlanEvent,
} from "./plan-runner.ts";
import { mockIO } from "./test-utils/mock-io.ts";

// helpers

function ctx(overrides: Partial<PlanContext> = {}): PlanContext {
  const dispatch: HandlerDispatch = overrides.dispatch ?? {
    pluginHook: async () => {},
    builtin: async () => {},
  };
  return {
    io: mockIO({ argv: ["nopo"], cwd: "/" }),
    dispatch,
    ...overrides,
  };
}

function pluginNode(id: string, needs: readonly string[] = []): PlanNode {
  return {
    id,
    handler: { kind: "plugin-hook", plugin: "p", hook: "h" },
    needs,
  };
}

function builtinNode(id: string, needs: readonly string[] = []): PlanNode {
  return {
    id,
    handler: { kind: "builtin", name: "host-exec" },
    needs,
  };
}

function recordEvents(): {
  events: PlanEvent[];
  onEvent: (e: PlanEvent) => void;
} {
  const events: PlanEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

// validation

describe("executePlan validation", () => {
  it("rejects a plan with a cycle", async () => {
    const a: PlanNode = { ...pluginNode("a"), needs: ["b"] };
    const b: PlanNode = { ...pluginNode("b"), needs: ["a"] };
    const plan = planFromNodes([a, b]);
    await expect(executePlan(plan, ctx())).rejects.toThrow(/cycle/i);
  });

  it("rejects a plan with an unknown `needs` reference", async () => {
    const plan = planFromNodes([pluginNode("a", ["ghost"])]);
    await expect(executePlan(plan, ctx())).rejects.toThrow(/unknown node/i);
  });
});

// topology + concurrency

describe("topology", () => {
  it("runs a linear chain in dependency order", async () => {
    const plan = planFromNodes([
      pluginNode("a"),
      pluginNode("b", ["a"]),
      pluginNode("c", ["b"]),
    ]);
    const { events, onEvent } = recordEvents();
    const result = await executePlan(plan, ctx({ onEvent }));

    expect(result.ok).toBe(true);
    const order = events
      .filter((e) => e.type === "node-start")
      .map((e) => (e.type === "node-start" ? e.nodeId : ""));
    expect(order).toEqual(["a", "b", "c"]);

    // Each prerequisite's success must precede the next start.
    const idxStartB = events.findIndex(
      (e) => e.type === "node-start" && e.nodeId === "b",
    );
    const idxSuccessA = events.findIndex(
      (e) => e.type === "node-success" && e.nodeId === "a",
    );
    expect(idxSuccessA).toBeLessThan(idxStartB);
  });

  it("runs diamond fan-out concurrently after the root", async () => {
    // a → b, a → c, (b,c) → d
    const plan = planFromNodes([
      pluginNode("a"),
      pluginNode("b", ["a"]),
      pluginNode("c", ["a"]),
      pluginNode("d", ["b", "c"]),
    ]);

    const startedAt = new Map<string, number>();
    const finishedAt = new Map<string, number>();
    const dispatch: HandlerDispatch = {
      pluginHook: async (node) => {
        startedAt.set(node.id, Date.now());
        await new Promise((r) => setTimeout(r, 25));
        finishedAt.set(node.id, Date.now());
      },
      builtin: async () => {},
    };

    // Without this the cap falls back to autoConcurrency(), which reads the runner's cgroup
    // CPU quota and can resolve to 1 on a constrained CI pod — running b then c serially
    const result = await executePlan(
      plan,
      ctx({ dispatch, maxConcurrency: 4 }),
    );
    expect(result.ok).toBe(true);

    // b and c should both start before either finishes — i.e. their
    // start windows overlap.
    const bStart = startedAt.get("b")!;
    const cStart = startedAt.get("c")!;
    const bEnd = finishedAt.get("b")!;
    const cEnd = finishedAt.get("c")!;
    expect(bStart).toBeLessThanOrEqual(cEnd);
    expect(cStart).toBeLessThanOrEqual(bEnd);
    // d must start after both b and c finish.
    expect(startedAt.get("d")!).toBeGreaterThanOrEqual(bEnd);
    expect(startedAt.get("d")!).toBeGreaterThanOrEqual(cEnd);
  });

  it("serializes everything when maxConcurrency is 1", async () => {
    // Four roots — would all run in parallel without the cap.
    const plan = planFromNodes(
      [pluginNode("a"), pluginNode("b"), pluginNode("c"), pluginNode("d")],
      { maxConcurrency: 1 },
    );

    let inFlight = 0;
    let peak = 0;
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      builtin: async () => {},
    };

    await executePlan(plan, ctx({ dispatch }));
    expect(peak).toBe(1);
  });

  it("caps in-flight at maxConcurrency=2 on a 4-wide fan-out", async () => {
    const plan = planFromNodes(
      [
        pluginNode("root"),
        pluginNode("w1", ["root"]),
        pluginNode("w2", ["root"]),
        pluginNode("w3", ["root"]),
        pluginNode("w4", ["root"]),
      ],
      { maxConcurrency: 2 },
    );

    let inFlight = 0;
    let peak = 0;
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
      },
      builtin: async () => {},
    };

    // Pin ctx.maxConcurrency above the plan cap so the plan's cap of 2 is the
    // binding constraint regardless of the host's auto-detected concurrency.
    await executePlan(plan, ctx({ dispatch, maxConcurrency: 8 }));
    expect(peak).toBe(2);
  });

  it("uses ctx.maxConcurrency when smaller than plan.maxConcurrency", async () => {
    const plan = planFromNodes(
      [pluginNode("a"), pluginNode("b"), pluginNode("c")],
      { maxConcurrency: 8 },
    );

    let inFlight = 0;
    let peak = 0;
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      builtin: async () => {},
    };

    await executePlan(plan, ctx({ dispatch, maxConcurrency: 1 }));
    expect(peak).toBe(1);
  });

  it("returns ok with an empty plan and emits start+finish only", async () => {
    const plan: Plan = { nodes: new Map() };
    const { events, onEvent } = recordEvents();
    const result = await executePlan(plan, ctx({ onEvent }));

    expect(result.ok).toBe(true);
    expect(result.results.size).toBe(0);
    expect(events.map((e) => e.type)).toEqual(["plan-start", "plan-finish"]);
  });
});

// dispatch routing

describe("dispatch routing", () => {
  it("routes plugin-hook handlers to dispatch.pluginHook", async () => {
    const plan = planFromNodes([pluginNode("a")]);
    const pluginHook = vi.fn<HandlerDispatch["pluginHook"]>(async () => {});
    const builtin = vi.fn<HandlerDispatch["builtin"]>(async () => {});

    await executePlan(plan, ctx({ dispatch: { pluginHook, builtin } }));

    expect(pluginHook).toHaveBeenCalledTimes(1);
    expect(builtin).not.toHaveBeenCalled();
    const call = pluginHook.mock.calls[0];
    expect(call?.[0]?.id).toBe("a");
    expect(call?.[1]?.kind).toBe("plugin-hook");
  });

  it("routes builtin handlers to dispatch.builtin", async () => {
    const plan = planFromNodes([builtinNode("a")]);
    const pluginHook = vi.fn<HandlerDispatch["pluginHook"]>(async () => {});
    const builtin = vi.fn<HandlerDispatch["builtin"]>(async () => {});

    await executePlan(plan, ctx({ dispatch: { pluginHook, builtin } }));

    expect(builtin).toHaveBeenCalledTimes(1);
    expect(pluginHook).not.toHaveBeenCalled();
    const call = builtin.mock.calls[0];
    expect(call?.[0]?.id).toBe("a");
    expect(call?.[1]?.kind).toBe("builtin");
  });

  it("passes a per-node ctx to handlers that shares dispatch + onEvent with the caller's ctx", async () => {
    // node-attributing IO proxy) — the underlying dispatch / onEvent failureMode /
    // maxConcurrency are the same references, but `ctx` itself is a fresh object so a renderer
    const plan = planFromNodes([pluginNode("a")]);
    let seen: PlanContext | undefined;
    const dispatch: HandlerDispatch = {
      pluginHook: async (_n, _h, c) => {
        seen = c;
      },
      builtin: async () => {},
    };
    const c = ctx({ dispatch });
    await executePlan(plan, c);
    expect(seen).toBeDefined();
    expect(seen?.dispatch).toBe(c.dispatch);
  });
});

// failure handling — keep-going (default)

describe("keep-going failure mode", () => {
  it("records a leaf failure but everything else succeeds", async () => {
    const plan = planFromNodes([
      pluginNode("a"),
      pluginNode("b"),
      pluginNode("c", ["a"]),
    ]);
    const dispatch: HandlerDispatch = {
      pluginHook: async (node) => {
        if (node.id === "c") throw new Error("boom");
      },
      builtin: async () => {},
    };

    const result = await executePlan(plan, ctx({ dispatch }));

    expect(result.ok).toBe(false);
    expect(result.results.get("a")!.status).toBe("success");
    expect(result.results.get("b")!.status).toBe("success");
    expect(result.results.get("c")!.status).toBe("failure");
    expect(result.results.get("c")!.error?.message).toBe("boom");
  });

  it("skips descendants of a failed middle node, citing its id", async () => {
    // a → b (fails) → c → d, plus independent e
    const plan = planFromNodes([
      pluginNode("a"),
      pluginNode("b", ["a"]),
      pluginNode("c", ["b"]),
      pluginNode("d", ["c"]),
      pluginNode("e"),
    ]);
    const dispatch: HandlerDispatch = {
      pluginHook: async (node) => {
        if (node.id === "b") throw new Error("middle failed");
      },
      builtin: async () => {},
    };

    const result = await executePlan(plan, ctx({ dispatch }));

    expect(result.ok).toBe(false);
    expect(result.results.get("a")!.status).toBe("success");
    expect(result.results.get("b")!.status).toBe("failure");
    // c is the immediate descendant of the failed b
    expect(result.results.get("c")!.status).toBe("skipped");
    expect(result.results.get("c")!.skippedDueTo).toBe("b");
    // d's immediate parent is the now-skipped c
    expect(result.results.get("d")!.status).toBe("skipped");
    expect(result.results.get("d")!.skippedDueTo).toBe("c");
    // independent branch survives
    expect(result.results.get("e")!.status).toBe("success");
  });

  it("handles multiple independent failures with independent skip chains", async () => {
    // a (fail) → a1 → a2; b (fail) → b1; c (ok)
    const plan = planFromNodes([
      pluginNode("a"),
      pluginNode("a1", ["a"]),
      pluginNode("a2", ["a1"]),
      pluginNode("b"),
      pluginNode("b1", ["b"]),
      pluginNode("c"),
    ]);
    const dispatch: HandlerDispatch = {
      pluginHook: async (node) => {
        if (node.id === "a" || node.id === "b") throw new Error(node.id);
      },
      builtin: async () => {},
    };

    const result = await executePlan(plan, ctx({ dispatch }));

    expect(result.ok).toBe(false);
    expect(result.results.get("a")!.status).toBe("failure");
    expect(result.results.get("b")!.status).toBe("failure");
    expect(result.results.get("a1")!.status).toBe("skipped");
    expect(result.results.get("a1")!.skippedDueTo).toBe("a");
    expect(result.results.get("a2")!.status).toBe("skipped");
    expect(result.results.get("b1")!.status).toBe("skipped");
    expect(result.results.get("b1")!.skippedDueTo).toBe("b");
    expect(result.results.get("c")!.status).toBe("success");
  });
});

// failure handling — fail-fast

describe("fail-fast failure mode", () => {
  it("stops new dispatches at first failure but lets in-flight finish", async () => {
    // 3 root nodes, concurrency 2 → survivor + failer dispatched together, pending stays in
    // the queue. Failer awaits a "survivor entered" signal before throwing so the assertion
    const plan = planFromNodes(
      [pluginNode("survivor"), pluginNode("failer"), pluginNode("pending")],
      { maxConcurrency: 2 },
    );

    let resolveSurvivorEntered!: () => void;
    const survivorEntered = new Promise<void>((r) => {
      resolveSurvivorEntered = r;
    });
    let resolveSurvivorFinish!: () => void;
    const survivorCanFinish = new Promise<void>((r) => {
      resolveSurvivorFinish = r;
    });

    const dispatch: HandlerDispatch = {
      pluginHook: async (node) => {
        if (node.id === "survivor") {
          resolveSurvivorEntered();
          await survivorCanFinish;
          return;
        }
        if (node.id === "failer") {
          await survivorEntered;
          // Release survivor on the next microtask so the runner sees the
          // failure first, flips abort, and then drains the in-flight survivor.
          queueMicrotask(resolveSurvivorFinish);
          throw new Error("first failure");
        }
        // "pending" should never start — assert via skip below.
        throw new Error("pending should not have run");
      },
      builtin: async () => {},
    };

    // Pin ctx.maxConcurrency so concurrency is exactly the plan cap of 2
    // (survivor + failer together) independent of host auto-detection.
    const result = await executePlan(
      plan,
      ctx({ dispatch, failureMode: "fail-fast", maxConcurrency: 8 }),
    );

    expect(result.ok).toBe(false);
    expect(result.results.get("failer")!.status).toBe("failure");
    expect(result.results.get("survivor")!.status).toBe("success");
    expect(result.results.get("pending")!.status).toBe("skipped");
  });

  it("with maxConcurrency 1, skips everything after the first failure", async () => {
    const plan = planFromNodes(
      [
        pluginNode("a"),
        pluginNode("b", ["a"]),
        pluginNode("c", ["b"]),
        pluginNode("d", ["c"]),
      ],
      { maxConcurrency: 1 },
    );
    const dispatch: HandlerDispatch = {
      pluginHook: async (node) => {
        if (node.id === "b") throw new Error("nope");
      },
      builtin: async () => {},
    };

    const result = await executePlan(
      plan,
      ctx({ dispatch, failureMode: "fail-fast" }),
    );

    expect(result.ok).toBe(false);
    expect(result.results.get("a")!.status).toBe("success");
    expect(result.results.get("b")!.status).toBe("failure");
    expect(result.results.get("c")!.status).toBe("skipped");
    expect(result.results.get("d")!.status).toBe("skipped");
  });

  it("fail-fast aborts pending independent branches too", async () => {
    // Two independent roots; with concurrency 1 the second never starts
    // after the first fails.
    const plan = planFromNodes([pluginNode("a"), pluginNode("b")], {
      maxConcurrency: 1,
    });
    const dispatch: HandlerDispatch = {
      pluginHook: async (node) => {
        if (node.id === "a") throw new Error("nope");
      },
      builtin: async () => {},
    };
    const result = await executePlan(
      plan,
      ctx({ dispatch, failureMode: "fail-fast" }),
    );
    expect(result.results.get("a")!.status).toBe("failure");
    expect(result.results.get("b")!.status).toBe("skipped");
    expect(result.results.get("b")!.skippedDueTo).toBe("a");
  });
});

// events

describe("events", () => {
  it("emits exactly one terminal event per node", async () => {
    const plan = planFromNodes([
      pluginNode("a"),
      pluginNode("b", ["a"]),
      pluginNode("c", ["a"]),
    ]);
    const dispatch: HandlerDispatch = {
      pluginHook: async (node) => {
        if (node.id === "b") throw new Error("x");
      },
      builtin: async () => {},
    };
    const { events, onEvent } = recordEvents();
    await executePlan(plan, ctx({ dispatch, onEvent }));

    const terminals = new Map<string, number>();
    for (const e of events) {
      let id: string | null = null;
      if (e.type === "node-success") id = e.nodeId;
      else if (e.type === "node-failure") id = e.nodeId;
      else if (e.type === "node-skip") id = e.nodeId;
      if (id !== null) terminals.set(id, (terminals.get(id) ?? 0) + 1);
    }
    expect(terminals.get("a")).toBe(1);
    expect(terminals.get("b")).toBe(1);
    expect(terminals.get("c")).toBe(1);
  });

  it("plan-finish.ok matches `every result is not failure`", async () => {
    const plan = planFromNodes([pluginNode("a"), pluginNode("b", ["a"])]);
    const dispatch: HandlerDispatch = {
      pluginHook: async (node) => {
        if (node.id === "b") throw new Error("nope");
      },
      builtin: async () => {},
    };
    const { events, onEvent } = recordEvents();
    await executePlan(plan, ctx({ dispatch, onEvent }));

    const finish = events.find((e) => e.type === "plan-finish");
    expect(finish).toBeDefined();
    if (finish?.type !== "plan-finish") throw new Error("unreachable");
    const ok = !Array.from(finish.results.values()).some(
      (r) => r.status === "failure",
    );
    expect(finish.ok).toBe(ok);
    expect(finish.ok).toBe(false);
  });

  it("plan-finish.results includes every node keyed by id", async () => {
    const plan = planFromNodes([
      pluginNode("a"),
      pluginNode("b"),
      pluginNode("c", ["a", "b"]),
    ]);
    const { events, onEvent } = recordEvents();
    await executePlan(plan, ctx({ onEvent }));

    const finish = events.find((e) => e.type === "plan-finish");
    if (finish?.type !== "plan-finish") throw new Error("unreachable");
    expect([...finish.results.keys()].sort()).toEqual(["a", "b", "c"]);
    for (const [id, r] of finish.results) {
      expect(r.id).toBe(id);
    }
  });

  it("emits plan-start as the first event with computed concurrency", async () => {
    const plan = planFromNodes([pluginNode("a")], { maxConcurrency: 3 });
    const { events, onEvent } = recordEvents();
    await executePlan(plan, ctx({ onEvent, maxConcurrency: 2 }));

    expect(events[0]?.type).toBe("plan-start");
    if (events[0]?.type !== "plan-start") throw new Error("unreachable");
    // ctx.maxConcurrency=2 is the smallest cap (plan was 3, OS is >=1).
    expect(events[0].concurrency).toBeLessThanOrEqual(2);
    expect(events[0].concurrency).toBeGreaterThanOrEqual(1);
  });
});

// error capture

describe("error capture", () => {
  it("captures Error message and stack", async () => {
    const plan = planFromNodes([pluginNode("a")]);
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        throw new Error("specific message");
      },
      builtin: async () => {},
    };
    const result = await executePlan(plan, ctx({ dispatch }));
    const r = result.results.get("a")!;
    expect(r.status).toBe("failure");
    expect(r.error?.message).toBe("specific message");
    expect(r.error?.stack).toContain("specific message");
  });

  it("wraps a thrown string into an Error", async () => {
    const plan = planFromNodes([pluginNode("a")]);
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        throw "stringy failure";
      },
      builtin: async () => {},
    };
    const result = await executePlan(plan, ctx({ dispatch }));
    const r = result.results.get("a")!;
    expect(r.status).toBe("failure");
    expect(r.error?.message).toContain("stringy failure");
  });

  it("wraps a thrown number into an Error without crashing", async () => {
    const plan = planFromNodes([pluginNode("a")]);
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {
        throw 42;
      },
      builtin: async () => {},
    };
    const result = await executePlan(plan, ctx({ dispatch }));
    const r = result.results.get("a")!;
    expect(r.status).toBe("failure");
    expect(r.error?.message).toContain("42");
  });
});

// result shape

describe("result shape", () => {
  it("populates durationMs for successes and failures", async () => {
    const plan = planFromNodes([pluginNode("ok"), pluginNode("bad")]);
    const dispatch: HandlerDispatch = {
      pluginHook: async (node) => {
        await new Promise((r) => setTimeout(r, 5));
        if (node.id === "bad") throw new Error("x");
      },
      builtin: async () => {},
    };
    const result = await executePlan(plan, ctx({ dispatch }));
    const ok = result.results.get("ok")!;
    const bad = result.results.get("bad")!;
    expect(ok.durationMs).toBeTypeOf("number");
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);
    expect(bad.durationMs).toBeTypeOf("number");
  });

  it("does not populate durationMs for skipped nodes", async () => {
    const plan = planFromNodes([pluginNode("a"), pluginNode("b", ["a"])]);
    const dispatch: HandlerDispatch = {
      pluginHook: async (node) => {
        if (node.id === "a") throw new Error("x");
      },
      builtin: async () => {},
    };
    const result = await executePlan(plan, ctx({ dispatch }));
    const b: NodeResult = result.results.get("b")!;
    expect(b.status).toBe("skipped");
    expect(b.durationMs).toBeUndefined();
  });
});

// per-node IO proxy + node-output events

/**
 * Pull the node-output events for a specific node, optionally
 * filtered by source. Helpful in assertions below.
 */
function nodeOutputs(
  events: PlanEvent[],
  nodeId: string,
  source?: "stdout" | "stderr",
): Array<{ source: "stdout" | "stderr"; chunk: Buffer }> {
  const out: Array<{ source: "stdout" | "stderr"; chunk: Buffer }> = [];
  for (const e of events) {
    if (e.type !== "node-output") continue;
    if (e.nodeId !== nodeId) continue;
    if (source !== undefined && e.source !== source) continue;
    out.push({ source: e.source, chunk: e.chunk });
  }
  return out;
}

describe("per-node IO proxy + node-output events", () => {
  it("emits node-output when a builtin handler writes to ctx.io.stdout", async () => {
    const plan = planFromNodes([builtinNode("a")]);
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async (_node, _handler, c) => {
        c.io.stdout.write("hello ");
        c.io.stdout.write("world");
      },
    };
    const { events, onEvent } = recordEvents();
    await executePlan(plan, ctx({ dispatch, onEvent }));

    const chunks = nodeOutputs(events, "a", "stdout");
    expect(chunks.map((c) => c.chunk.toString())).toEqual(["hello ", "world"]);
    expect(chunks.every((c) => Buffer.isBuffer(c.chunk))).toBe(true);
    // No stderr chunks for this handler.
    expect(nodeOutputs(events, "a", "stderr")).toEqual([]);
  });

  it("emits node-output when a handler writes to ctx.io.stderr", async () => {
    const plan = planFromNodes([builtinNode("a")]);
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async (_node, _handler, c) => {
        c.io.stderr.write("warn: boom\n");
      },
    };
    const { events, onEvent } = recordEvents();
    await executePlan(plan, ctx({ dispatch, onEvent }));

    const stderr = nodeOutputs(events, "a", "stderr");
    expect(stderr.map((c) => c.chunk.toString())).toEqual(["warn: boom\n"]);
  });

  it("emits node-output for spawn() onChunk and still passes chunks to the caller's onChunk", async () => {
    const plan = planFromNodes([builtinNode("a")]);
    const callerSeen: Array<{ source: "stdout" | "stderr"; text: string }> = [];

    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async (_node, _handler, c) => {
        await c.io.spawn("echo", ["hi"], {
          onChunk: (chunk, source) => {
            callerSeen.push({ source, text: chunk.toString() });
          },
        });
      },
    };

    // mockIO replays the configured stdout/stderr through opts.onChunk synchronously, so we
    // can drive both stdout and stderr from a single onSpawn override.
    const io = mockIO({
      argv: ["nopo"],
      cwd: "/",
      onSpawn: () => ({
        exitCode: 0,
        stdout: "stream-out",
        stderr: "stream-err",
      }),
    });

    const { events, onEvent } = recordEvents();
    await executePlan(plan, ctx({ dispatch, onEvent, io }));

    // The proxy must fan chunks out to the renderer AND the caller —
    // not steal them. Both sides see both streams.
    expect(
      nodeOutputs(events, "a", "stdout").map((c) => c.chunk.toString()),
    ).toEqual(["stream-out"]);
    expect(
      nodeOutputs(events, "a", "stderr").map((c) => c.chunk.toString()),
    ).toEqual(["stream-err"]);
    expect(callerSeen).toEqual([
      { source: "stdout", text: "stream-out" },
      { source: "stderr", text: "stream-err" },
    ]);
  });

  it("emits node-output for spawn() output even when the caller omits onChunk", async () => {
    // Streamed output from `ctx.io.spawn` should reach the renderer whether or not the handler
    // installs its own onChunk. This covers handlers that just await the buffered SpawnResult.
    const plan = planFromNodes([builtinNode("a")]);
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async (_node, _handler, c) => {
        await c.io.spawn("echo", ["hi"]);
      },
    };
    const io = mockIO({
      argv: ["nopo"],
      cwd: "/",
      onSpawn: () => ({
        exitCode: 0,
        stdout: "from-child",
        stderr: "",
      }),
    });

    const { events, onEvent } = recordEvents();
    await executePlan(plan, ctx({ dispatch, onEvent, io }));

    const chunks = nodeOutputs(events, "a", "stdout");
    expect(chunks.map((c) => c.chunk.toString())).toEqual(["from-child"]);
  });

  it("emits node-output for plugin-hook handlers without any plugin opt-in", async () => {
    // Plugins must inherit attribution for free — they receive the same
    // proxied IO that builtin handlers do.
    const plan = planFromNodes([pluginNode("p")]);
    const dispatch: HandlerDispatch = {
      pluginHook: async (_node, _handler, c) => {
        c.io.stdout.write("plugin out");
        c.io.stderr.write("plugin err");
      },
      builtin: async () => {},
    };
    const { events, onEvent } = recordEvents();
    await executePlan(plan, ctx({ dispatch, onEvent }));

    expect(
      nodeOutputs(events, "p", "stdout").map((c) => c.chunk.toString()),
    ).toEqual(["plugin out"]);
    expect(
      nodeOutputs(events, "p", "stderr").map((c) => c.chunk.toString()),
    ).toEqual(["plugin err"]);
  });

  it("attributes interleaved writes from concurrent nodes to the correct node", async () => {
    // Diamond fan-out where b and c both write — every chunk should be
    // tagged with the producing nodeId, even when they run in parallel.
    const plan = planFromNodes([
      pluginNode("a"),
      pluginNode("b", ["a"]),
      pluginNode("c", ["a"]),
    ]);
    const dispatch: HandlerDispatch = {
      pluginHook: async (node, _handler, c) => {
        if (node.id === "a") return;
        // Interleave writes across nodes with microtask yields.
        c.io.stdout.write(`${node.id}-1 `);
        await new Promise((r) => setTimeout(r, 5));
        c.io.stdout.write(`${node.id}-2 `);
      },
      builtin: async () => {},
    };
    const { events, onEvent } = recordEvents();
    await executePlan(plan, ctx({ dispatch, onEvent }));

    const b = nodeOutputs(events, "b", "stdout").map((c) => c.chunk.toString());
    const c = nodeOutputs(events, "c", "stdout").map((c) => c.chunk.toString());
    expect(b).toEqual(["b-1 ", "b-2 "]);
    expect(c).toEqual(["c-1 ", "c-2 "]);
  });

  it("forwards writes to the underlying io so existing capture surfaces still see them", async () => {
    // The proxy is additive: a renderer subscribed via PlanEvents sees attributed chunks, AND
    // the underlying mockIO buffer still receives the raw write — same as before M6. Important
    const io = mockIO({ argv: ["nopo"], cwd: "/" });
    const plan = planFromNodes([builtinNode("a")]);
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async (_node, _handler, c) => {
        c.io.stdout.write("forwarded");
      },
    };
    const { onEvent } = recordEvents();
    await executePlan(plan, ctx({ dispatch, onEvent, io }));

    expect(io.stdout.text()).toBe("forwarded");
  });

  it("does not emit node-output when the handler writes nothing", async () => {
    const plan = planFromNodes([builtinNode("a")]);
    const dispatch: HandlerDispatch = {
      pluginHook: async () => {},
      builtin: async () => {},
    };
    const { events, onEvent } = recordEvents();
    await executePlan(plan, ctx({ dispatch, onEvent }));
    expect(events.filter((e) => e.type === "node-output")).toEqual([]);
  });
});
