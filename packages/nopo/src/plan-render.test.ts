import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { type Plan, planFromNodes, type PlanNode } from "./plan.ts";
import { createStreamingRenderer } from "./plan-render.ts";
import type { NodeResult, PlanEvent } from "./plan-runner.ts";
import { type MockIO, mockIO } from "./test-utils/mock-io.ts";

// ---------------------------------------------------------------------------
// helpers

function pluginNode(
  id: string,
  needs: readonly string[] = [],
  target?: string,
): PlanNode {
  const node: PlanNode = {
    id,
    handler: { kind: "plugin-hook", plugin: "docker", hook: "build" },
    needs,
  };
  if (target !== undefined) node.target = target;
  return node;
}

function builtinNode(
  id: string,
  needs: readonly string[] = [],
  target?: string,
): PlanNode {
  const node: PlanNode = {
    id,
    handler: { kind: "builtin", name: "host-exec" },
    needs,
  };
  if (target !== undefined) node.target = target;
  return node;
}

/** Build a non-TTY MockIO so renderer output is plain text. */
function nonTtyIO(): MockIO {
  return mockIO({ argv: ["nopo"], cwd: "/" });
}

/**
 * Stdout shape that includes an `isTTY` flag. The renderer probes for
 * the flag at runtime via an `in` check, so attaching it to the mock's
 * stdout flips the color path on without touching production types.
 */
interface TTYStream {
  write(s: string): void;
  text(): string;
  isTTY: true;
}

interface TTYIO extends Omit<MockIO, "stdout"> {
  stdout: TTYStream;
}

/**
 * Build a MockIO whose stdout reports `isTTY === true`. Tests that
 * exercise the color path use this; everything else uses `nonTtyIO()`
 * so snapshots stay readable.
 */
function ttyIO(): TTYIO {
  const base = nonTtyIO();
  const captured = base.stdout;
  const tty: TTYStream = {
    isTTY: true,
    write(s: string): void {
      captured.write(s);
    },
    text(): string {
      return captured.text();
    },
  };
  // Spread + override stdout. Excess-property checks block an inline
  // replace of MockIO['stdout'] = MockStream.
  return { ...base, stdout: tty };
}

function output(io: { stdout: { text(): string } }): string {
  return io.stdout.text();
}

/**
 * Build a `results` map for `plan-finish` from prior node events.
 * Mirrors the runner so footer counts and failure order match what
 * the renderer saw.
 */
function resultsFromEvents(
  events: readonly PlanEvent[],
): Map<string, NodeResult> {
  const out = new Map<string, NodeResult>();
  for (const e of events) {
    if (e.type === "node-success") {
      out.set(e.nodeId, {
        id: e.nodeId,
        status: "success",
        durationMs: e.durationMs,
      });
    } else if (e.type === "node-failure") {
      out.set(e.nodeId, {
        id: e.nodeId,
        status: "failure",
        durationMs: e.durationMs,
        error: { message: e.error.message },
      });
    } else if (e.type === "node-skip") {
      out.set(e.nodeId, {
        id: e.nodeId,
        status: "skipped",
        skippedDueTo: e.reason,
      });
    }
  }
  return out;
}

/**
 * Strip the `total <wallclock>` token so snapshots stay stable.
 * `Date.now()` between `plan-start` and `plan-finish` is irrelevant.
 */
function normalizeWallclock(s: string): string {
  return s.replace(/total \d+(?:\.\d+)?(?:ms|s|m\d+s)/g, "total <wallclock>");
}

// ---------------------------------------------------------------------------
// prefix alignment

describe("createStreamingRenderer prefix alignment", () => {
  it("pads every prefix to the same width so closing `]` lines up", () => {
    // Mixed handler-name lengths force padding to take effect.
    const plan = planFromNodes([
      pluginNode("a", [], "svc-a"),
      builtinNode("b", ["a"], "svc-much-longer-target"),
    ]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);

    const events: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 2 },
      { type: "node-start", nodeId: "a" },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("hello\n"),
      },
      { type: "node-success", nodeId: "a", durationMs: 5 },
      { type: "node-start", nodeId: "b" },
      {
        type: "node-output",
        nodeId: "b",
        source: "stdout",
        chunk: Buffer.from("world\n"),
      },
      { type: "node-success", nodeId: "b", durationMs: 5 },
      { type: "plan-finish", results: new Map(), ok: true },
    ];
    for (const e of events) onEvent(e);

    const lines = output(io).split("\n");
    const aLine = lines.find((l) => l.includes("hello"));
    const bLine = lines.find((l) => l.includes("world"));
    expect(aLine).toBeDefined();
    expect(bLine).toBeDefined();
    // The `]` of every prefix lands at the same column index.
    const aBracket = aLine!.indexOf("]");
    const bBracket = bLine!.indexOf("]");
    expect(aBracket).toBe(bBracket);
    // After the `]` there's a single space, then the line content.
    expect(aLine!.slice(aBracket)).toMatch(/^]\s+hello$/);
    expect(bLine!.slice(bBracket)).toMatch(/^]\s+world$/);
  });

  it("includes plugin.hook for plugin-hook handlers", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc-a")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("line\n"),
    });
    expect(output(io)).toContain("[0 docker.build svc-a] line");
  });

  it("includes builtin name for builtin handlers", () => {
    const plan = planFromNodes([builtinNode("a", [], "svc-a")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("line\n"),
    });
    expect(output(io)).toContain("[0 host-exec svc-a] line");
  });

  it("omits target column when node.target is undefined", () => {
    const plan = planFromNodes([pluginNode("a")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("line\n"),
    });
    expect(output(io)).toContain("[0 docker.build] line");
  });
});

// ---------------------------------------------------------------------------
// stage headers

describe("createStreamingRenderer stage headers", () => {
  it("emits header on first node-start per stage and includes node count", () => {
    // Stage 0: 2 nodes (parallel). Stage 1: 1 node (no parallel).
    const plan = planFromNodes([
      pluginNode("a", [], "x"),
      pluginNode("b", [], "y"),
      pluginNode("c", ["a", "b"], "z"),
    ]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);

    onEvent({ type: "plan-start", plan, concurrency: 2 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({ type: "node-start", nodeId: "b" });
    onEvent({ type: "node-success", nodeId: "a", durationMs: 1 });
    onEvent({ type: "node-success", nodeId: "b", durationMs: 1 });
    onEvent({ type: "node-start", nodeId: "c" });

    const out = output(io);
    expect(out).toContain("━━━ stage 0 ━ 2 nodes ━ parallel ━━━");
    // Stage 0 header appears exactly once even though two nodes started.
    expect(out.match(/stage 0/g)?.length).toBe(1);
    expect(out).toContain("━━━ stage 1 ━ 1 nodes ━━━");
    // Stage 1 (single node) omits the `parallel` token.
    expect(out).not.toMatch(/stage 1 ━ 1 nodes ━ parallel/);
  });

  it("single-node plan emits a single header without `parallel`", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    expect(output(io)).toContain("━━━ stage 0 ━ 1 nodes ━━━");
    expect(output(io)).not.toMatch(/parallel/);
  });
});

// ---------------------------------------------------------------------------
// chunk + line buffering

describe("createStreamingRenderer line buffering", () => {
  it("buffers partial lines until a newline arrives", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);

    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    // One full line + a fragment.
    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("first line\nfra"),
    });
    // After the first chunk only the first line should have flushed; the
    // fragment "fra" stays buffered.
    let lines = output(io)
      .split("\n")
      .filter((l) => l.includes("first line"));
    expect(lines.length).toBe(1);
    // No partial-line prefix flushed yet for "fra".
    expect(output(io)).not.toContain("fra");

    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("gment\n"),
    });
    // Now the joined line "fragment" should be flushed.
    lines = output(io)
      .split("\n")
      .filter((l) => l.includes("fragment"));
    expect(lines.length).toBe(1);
  });

  it("flushes a trailing partial line on node-success", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);

    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("no-trailing-newline"),
    });
    // Before success, the partial is NOT yet flushed.
    expect(output(io)).not.toContain("no-trailing-newline");
    onEvent({ type: "node-success", nodeId: "a", durationMs: 1 });
    expect(output(io)).toContain("no-trailing-newline");
  });

  it("flushes a trailing partial line on node-failure", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);

    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("partial-on-fail"),
    });
    onEvent({
      type: "node-failure",
      nodeId: "a",
      durationMs: 1,
      error: new Error("boom"),
    });
    expect(output(io)).toContain("partial-on-fail");
  });

  it("multi-node interleave: each line gets its own node's prefix", () => {
    const plan = planFromNodes([
      pluginNode("a", [], "alpha"),
      pluginNode("b", [], "beta"),
    ]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);

    onEvent({ type: "plan-start", plan, concurrency: 2 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({ type: "node-start", nodeId: "b" });
    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("a-line-1\n"),
    });
    onEvent({
      type: "node-output",
      nodeId: "b",
      source: "stdout",
      chunk: Buffer.from("b-line-1\n"),
    });
    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("a-line-2\n"),
    });

    const out = output(io);
    expect(out).toMatch(/\[0 docker\.build alpha\s*\] a-line-1/);
    expect(out).toMatch(/\[0 docker\.build beta\s*\] b-line-1/);
    expect(out).toMatch(/\[0 docker\.build alpha\s*\] a-line-2/);
  });
});

// ---------------------------------------------------------------------------
// TTY-vs-non-TTY color toggle

describe("createStreamingRenderer TTY color toggle", () => {
  const ESC = "\x1b[";

  it("emits no escape codes when stdout is not a TTY", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("plain\n"),
    });
    expect(output(io)).not.toContain(ESC);
  });

  it("emits ANSI color when stdout.isTTY is true", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = ttyIO();
    const { onEvent } = createStreamingRenderer(io);
    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("colored\n"),
    });
    const out = output(io);
    expect(out).toContain(ESC);
    // Stage 0 should be cyan (\x1b[36m).
    expect(out).toContain("\x1b[36m");
  });

  it("color cycles cyan/magenta/yellow per stage index", () => {
    // Three stages so we cover all three colors.
    const plan = planFromNodes([
      pluginNode("a", [], "x"),
      pluginNode("b", ["a"], "y"),
      pluginNode("c", ["b"], "z"),
    ]);
    const io = ttyIO();
    const { onEvent } = createStreamingRenderer(io);
    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({ type: "node-start", nodeId: "b" });
    onEvent({ type: "node-start", nodeId: "c" });
    const out = output(io);
    // Stage colors: 0 cyan, 1 magenta, 2 yellow.
    expect(out).toContain("\x1b[36m");
    expect(out).toContain("\x1b[35m");
    expect(out).toContain("\x1b[33m");
  });
});

// ---------------------------------------------------------------------------
// snapshot — canonical event sequence

describe("createStreamingRenderer snapshots", () => {
  it("matches snapshot for a single-node sequence", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    const baseEvents: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 1 },
      { type: "node-start", nodeId: "a" },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("step 1\nstep 2\n"),
      },
      { type: "node-success", nodeId: "a", durationMs: 1 },
    ];
    const events: PlanEvent[] = [
      ...baseEvents,
      { type: "plan-finish", results: resultsFromEvents(baseEvents), ok: true },
    ];
    for (const e of events) onEvent(e);
    expect(normalizeWallclock(output(io))).toMatchSnapshot();
  });

  it("matches snapshot for parallel fan-out across two stages", () => {
    const plan: Plan = planFromNodes([
      pluginNode("a", [], "alpha"),
      pluginNode("b", [], "beta"),
      builtinNode("c", ["a", "b"], "gamma"),
    ]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    const baseEvents: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 2 },
      { type: "node-start", nodeId: "a" },
      { type: "node-start", nodeId: "b" },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("alpha-out\n"),
      },
      {
        type: "node-output",
        nodeId: "b",
        source: "stdout",
        chunk: Buffer.from("beta-out\n"),
      },
      { type: "node-success", nodeId: "a", durationMs: 1 },
      { type: "node-success", nodeId: "b", durationMs: 1 },
      { type: "node-start", nodeId: "c" },
      {
        type: "node-output",
        nodeId: "c",
        source: "stdout",
        chunk: Buffer.from("gamma-out\n"),
      },
      { type: "node-success", nodeId: "c", durationMs: 1 },
    ];
    const events: PlanEvent[] = [
      ...baseEvents,
      { type: "plan-finish", results: resultsFromEvents(baseEvents), ok: true },
    ];
    for (const e of events) onEvent(e);
    expect(normalizeWallclock(output(io))).toMatchSnapshot();
  });

  it("matches snapshot for cross-stage edge (a -> b -> c)", () => {
    const plan = planFromNodes([
      pluginNode("a", [], "first"),
      pluginNode("b", ["a"], "second"),
      pluginNode("c", ["b"], "third"),
    ]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    const baseEvents: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 1 },
      { type: "node-start", nodeId: "a" },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("a out\n"),
      },
      { type: "node-success", nodeId: "a", durationMs: 1 },
      { type: "node-start", nodeId: "b" },
      {
        type: "node-output",
        nodeId: "b",
        source: "stdout",
        chunk: Buffer.from("b out\n"),
      },
      { type: "node-success", nodeId: "b", durationMs: 1 },
      { type: "node-start", nodeId: "c" },
      {
        type: "node-output",
        nodeId: "c",
        source: "stdout",
        chunk: Buffer.from("c out\n"),
      },
      { type: "node-success", nodeId: "c", durationMs: 1 },
    ];
    const events: PlanEvent[] = [
      ...baseEvents,
      { type: "plan-finish", results: resultsFromEvents(baseEvents), ok: true },
    ];
    for (const e of events) onEvent(e);
    expect(normalizeWallclock(output(io))).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// M8 — failure post-mortem footer

describe("createStreamingRenderer M8 failure footer", () => {
  it("inline ✘ FAILED marker is emitted at node-failure", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc-a")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({
      type: "node-output",
      nodeId: "a",
      source: "stdout",
      chunk: Buffer.from("about to fail\n"),
    });
    onEvent({
      type: "node-failure",
      nodeId: "a",
      durationMs: 250,
      error: new Error("boom"),
    });
    const out = output(io);
    // Marker is emitted inline (before plan-finish footer).
    expect(out).toMatch(
      /━━━ ✘ FAILED {2}0:docker\.build\(svc-a\) \(250ms\) ━━━/,
    );
    // The output line scrolled past BEFORE the marker.
    const lineIdx = out.indexOf("about to fail");
    const markerIdx = out.indexOf("FAILED");
    expect(lineIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeGreaterThan(lineIdx);
  });

  it("nodes without a target render display name without parens", () => {
    const plan = planFromNodes([pluginNode("a")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    onEvent({ type: "plan-start", plan, concurrency: 1 });
    onEvent({ type: "node-start", nodeId: "a" });
    onEvent({
      type: "node-failure",
      nodeId: "a",
      durationMs: 5,
      error: new Error("boom"),
    });
    // Display name omits `(<target>)` so we don't get an empty `()`.
    expect(output(io)).toContain("━━━ ✘ FAILED  0:docker.build (5ms) ━━━");
  });

  it("captures stdout + stderr interleaved in original order", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    const baseEvents: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 1 },
      { type: "node-start", nodeId: "a" },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("stdout-1\n"),
      },
      {
        type: "node-output",
        nodeId: "a",
        source: "stderr",
        chunk: Buffer.from("stderr-1\n"),
      },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("stdout-2\n"),
      },
      {
        type: "node-failure",
        nodeId: "a",
        durationMs: 1,
        error: new Error("boom"),
      },
    ];
    const events: PlanEvent[] = [
      ...baseEvents,
      {
        type: "plan-finish",
        results: resultsFromEvents(baseEvents),
        ok: false,
      },
    ];
    for (const e of events) onEvent(e);
    const out = output(io);
    // Post-mortem section preserves arrival order, regardless of source.
    const sectionStart = out.indexOf("━━━ Failed:");
    expect(sectionStart).toBeGreaterThan(0);
    const section = out.slice(sectionStart);
    const idxS1 = section.indexOf("stdout-1");
    const idxE1 = section.indexOf("stderr-1");
    const idxS2 = section.indexOf("stdout-2");
    expect(idxS1).toBeGreaterThan(0);
    expect(idxE1).toBeGreaterThan(idxS1);
    expect(idxS2).toBeGreaterThan(idxE1);
  });

  it("ring buffer keeps only the last N lines per node", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io, { failedTail: 3 });
    const lines: PlanEvent[] = [];
    for (let i = 1; i <= 10; i++) {
      lines.push({
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from(`line-${i}\n`),
      });
    }
    const baseEvents: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 1 },
      { type: "node-start", nodeId: "a" },
      ...lines,
      {
        type: "node-failure",
        nodeId: "a",
        durationMs: 1,
        error: new Error("boom"),
      },
    ];
    const events: PlanEvent[] = [
      ...baseEvents,
      {
        type: "plan-finish",
        results: resultsFromEvents(baseEvents),
        ok: false,
      },
    ];
    for (const e of events) onEvent(e);
    const out = output(io);
    const section = out.slice(out.indexOf("━━━ Failed:"));
    // failedTail=3 → only the last 3 (line-8/9/10) appear in the section.
    expect(section).toContain("line-8");
    expect(section).toContain("line-9");
    expect(section).toContain("line-10");
    expect(section).not.toContain("line-7");
    // "line-1" overlaps "line-10", so check via word-boundary regex.
    expect(section).not.toMatch(/line-1\b/);
  });

  it("failedTail=0 suppresses the per-node tail but keeps the header", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io, { failedTail: 0 });
    const baseEvents: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 1 },
      { type: "node-start", nodeId: "a" },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("would-be-tailed\n"),
      },
      {
        type: "node-failure",
        nodeId: "a",
        durationMs: 1,
        error: new Error("boom"),
      },
    ];
    const events: PlanEvent[] = [
      ...baseEvents,
      {
        type: "plan-finish",
        results: resultsFromEvents(baseEvents),
        ok: false,
      },
    ];
    for (const e of events) onEvent(e);
    const out = output(io);
    expect(out).toContain("━━━ Failed: 0:docker.build(svc)");
    // The inline line still scrolled by (above), but the tail is empty
    // — there must be no "would-be-tailed" inside the Failed section.
    const section = out.slice(out.indexOf("━━━ Failed:"));
    expect(section).not.toContain("would-be-tailed");
  });

  it("max-parallel reflects the high-water mark of in-flight nodes", () => {
    const plan = planFromNodes([
      pluginNode("a", [], "alpha"),
      pluginNode("b", [], "beta"),
      pluginNode("c", [], "gamma"),
    ]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    const baseEvents: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 3 },
      { type: "node-start", nodeId: "a" },
      { type: "node-start", nodeId: "b" },
      { type: "node-start", nodeId: "c" },
      { type: "node-success", nodeId: "a", durationMs: 1 },
      { type: "node-success", nodeId: "b", durationMs: 1 },
      { type: "node-success", nodeId: "c", durationMs: 1 },
    ];
    const events: PlanEvent[] = [
      ...baseEvents,
      { type: "plan-finish", results: resultsFromEvents(baseEvents), ok: true },
    ];
    for (const e of events) onEvent(e);
    expect(output(io)).toContain("max-parallel 3");
  });

  // ---------- canonical snapshot scenarios ----------

  /**
   * Build the canonical event sequence for a single-failure scenario.
   * Used by snapshot tests so the exact footer format is locked down.
   */
  function singleFailureEvents(plan: Plan): PlanEvent[] {
    return [
      { type: "plan-start", plan, concurrency: 1 },
      { type: "node-start", nodeId: "a" },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("a-stdout\n"),
      },
      {
        type: "node-output",
        nodeId: "a",
        source: "stderr",
        chunk: Buffer.from("a-stderr-error\n"),
      },
      {
        type: "node-failure",
        nodeId: "a",
        durationMs: 1234,
        error: new Error("boom"),
      },
    ];
  }

  it("snapshot — single failure", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    const base = singleFailureEvents(plan);
    const events: PlanEvent[] = [
      ...base,
      { type: "plan-finish", results: resultsFromEvents(base), ok: false },
    ];
    for (const e of events) onEvent(e);
    expect(normalizeWallclock(output(io))).toMatchSnapshot();
  });

  it("snapshot — multiple independent failures", () => {
    const plan = planFromNodes([
      pluginNode("a", [], "alpha"),
      pluginNode("b", [], "beta"),
    ]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    const base: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 2 },
      { type: "node-start", nodeId: "a" },
      { type: "node-start", nodeId: "b" },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("a-line\n"),
      },
      {
        type: "node-output",
        nodeId: "b",
        source: "stdout",
        chunk: Buffer.from("b-line\n"),
      },
      {
        type: "node-failure",
        nodeId: "a",
        durationMs: 50,
        error: new Error("a-fail"),
      },
      {
        type: "node-failure",
        nodeId: "b",
        durationMs: 80,
        error: new Error("b-fail"),
      },
    ];
    const events: PlanEvent[] = [
      ...base,
      { type: "plan-finish", results: resultsFromEvents(base), ok: false },
    ];
    for (const e of events) onEvent(e);
    expect(normalizeWallclock(output(io))).toMatchSnapshot();
  });

  it("snapshot — mixed failure + skip", () => {
    const plan = planFromNodes([
      pluginNode("a", [], "alpha"),
      pluginNode("b", ["a"], "beta"),
    ]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    const base: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 2 },
      { type: "node-start", nodeId: "a" },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("a-stdout\n"),
      },
      {
        type: "node-failure",
        nodeId: "a",
        durationMs: 100,
        error: new Error("a-fail"),
      },
      // b is poisoned by a — runner emits node-skip and skipped entries
      // appear in the summary line only (no per-node section).
      { type: "node-skip", nodeId: "b", reason: 'dependency "a" failed' },
    ];
    const events: PlanEvent[] = [
      ...base,
      { type: "plan-finish", results: resultsFromEvents(base), ok: false },
    ];
    for (const e of events) onEvent(e);
    expect(normalizeWallclock(output(io))).toMatchSnapshot();
  });

  it("M9 footer — colored DAG appended after post-mortem sections", () => {
    // 2-node plan so M9 is not suppressed. a fails; b skips. The
    // post-mortem section for `a` must appear before the DAG render.
    const plan = planFromNodes([
      pluginNode("a", [], "alpha"),
      pluginNode("b", ["a"], "beta"),
    ]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    const base: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 2 },
      { type: "node-start", nodeId: "a" },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("a-stdout\n"),
      },
      {
        type: "node-failure",
        nodeId: "a",
        durationMs: 100,
        error: new Error("a-fail"),
      },
      { type: "node-skip", nodeId: "b", reason: 'dependency "a" failed' },
    ];
    const events: PlanEvent[] = [
      ...base,
      { type: "plan-finish", results: resultsFromEvents(base), ok: false },
    ];
    for (const e of events) onEvent(e);
    const out = output(io);
    // M9 symbols present in the appended DAG render.
    expect(out).toContain("✘ docker.build alpha");
    expect(out).toContain("⊘ docker.build beta");
    // Non-TTY: no ANSI escapes injected by the M9 render.
    expect(out).not.toContain("\x1b[");
    // Order check: post-mortem section appears before the DAG render.
    const postMortemIdx = out.indexOf("━━━ Failed:");
    const dagIdx = out.indexOf("✘ docker.build alpha");
    expect(postMortemIdx).toBeGreaterThan(0);
    expect(dagIdx).toBeGreaterThan(postMortemIdx);
  });

  it("M9 footer — TTY emits ANSI status colors in the DAG render", () => {
    const plan = planFromNodes([
      pluginNode("a", [], "alpha"),
      pluginNode("b", ["a"], "beta"),
    ]);
    const io = ttyIO();
    const { onEvent } = createStreamingRenderer(io);
    const base: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 2 },
      { type: "node-start", nodeId: "a" },
      { type: "node-success", nodeId: "a", durationMs: 5 },
      { type: "node-start", nodeId: "b" },
      { type: "node-success", nodeId: "b", durationMs: 5 },
    ];
    const events: PlanEvent[] = [
      ...base,
      { type: "plan-finish", results: resultsFromEvents(base), ok: true },
    ];
    for (const e of events) onEvent(e);
    const out = output(io);
    // Both nodes succeeded → the DAG render wraps each box in ANSI green.
    expect(out).toContain("\x1b[32m");
    expect(out).toContain("✓ docker.build alpha");
    expect(out).toContain("✓ docker.build beta");
  });

  it("M9 footer — single-node plan suppresses the DAG render", () => {
    // 1-node plan: M9's auto-suppression mirrors M5's trivial-summary
    // path. The footer summary line still prints; the DAG block doesn't.
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    const base: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 1 },
      { type: "node-start", nodeId: "a" },
      { type: "node-success", nodeId: "a", durationMs: 1 },
    ];
    const events: PlanEvent[] = [
      ...base,
      { type: "plan-finish", results: resultsFromEvents(base), ok: true },
    ];
    for (const e of events) onEvent(e);
    const out = output(io);
    expect(out).toContain("Plan finished —");
    // No M9 box characters appended.
    expect(out).not.toContain("┌");
    expect(out).not.toContain("✓ docker.build svc");
    // And no trivial-summary one-liner in the footer either.
    expect(out).not.toContain("Plan: 1 node");
  });

  it("snapshot — no failure: summary line only, no post-mortem", () => {
    const plan = planFromNodes([pluginNode("a", [], "svc")]);
    const io = nonTtyIO();
    const { onEvent } = createStreamingRenderer(io);
    const base: PlanEvent[] = [
      { type: "plan-start", plan, concurrency: 1 },
      { type: "node-start", nodeId: "a" },
      {
        type: "node-output",
        nodeId: "a",
        source: "stdout",
        chunk: Buffer.from("all good\n"),
      },
      { type: "node-success", nodeId: "a", durationMs: 1 },
    ];
    const events: PlanEvent[] = [
      ...base,
      { type: "plan-finish", results: resultsFromEvents(base), ok: true },
    ];
    for (const e of events) onEvent(e);
    const out = normalizeWallclock(output(io));
    expect(out).toMatchSnapshot();
    // Defensive: no per-node post-mortem header in a no-failure run.
    expect(out).not.toContain("━━━ Failed:");
  });
});
