/** Consumes the runner's event stream and writes aligned, prefixed lines to `io.stdout` so
 * the user can attribute every byte of output to the node that produced it. The renderer
 * is a pure consumer — it does NOT call `executePlan`. The Runner (M10) wires this into
 * `PlanContext.onEvent`. Output format per line: [<stage> <handler> <target>] <line>
 */

import type { IO } from "./io.ts";
import type { Plan, PlanNode } from "./plan.ts";
import { renderPlanDag } from "./plan-dag-render.ts";
import { computeStages } from "./plan-layout.ts";
import type { NodeResult, NodeStatus, PlanEvent } from "./plan-runner.ts";

/** Options for {@link createStreamingRenderer}. */
export interface StreamingRendererOptions {
  /** Number of trailing prefixed lines retained per node for the failure post-mortem.
   * Defaults to 30. Must be >= 0; 0 disables the per-node buffered tail (the footer still
   * emits the summary line and section header, just with no lines underneath).
   */
  failedTail?: number;
}

const DEFAULT_FAILED_TAIL = 30;

/** Per-line state tracked while the plan is running. */
interface RendererState {
  /**
   * The plan as observed at `plan-start`. Held so the M9 footer DAG
   * render can re-layout it with each node's terminal status overlaid.
   */
  plan: Plan;
  /** Map nodeId -> rendered prefix (already padded to the max width). */
  prefixes: Map<string, string>;
  /** Map nodeId -> stage index (for color cycling + header lookup). */
  stages: Map<string, number>;
  /** Map stage index -> node count in that stage (for header text). */
  stageSizes: Map<number, number>;
  /** Map nodeId -> the original PlanNode (for footer display name). */
  nodes: Map<string, PlanNode>;
  /** Stages whose header has already been emitted. */
  emittedStages: Set<number>;
  /** Per-node partial-line buffer. Lines flush on `\n`. */
  lineBuffers: Map<string, string>;
  /**
   * Per-node ring buffer of completed prefixed lines (most recent
   * last, capped at {@link failedTail}). Used at `node-failure` /
   * `plan-finish` to dump the last-N lines into the post-mortem.
   */
  tailBuffers: Map<string, string[]>;
  /** Cap on each tail buffer's length. Set from options. */
  failedTail: number;
  /** Insertion order of nodes that have failed (for footer ordering). */
  failedOrder: string[];
  /** Wall-clock ms when `plan-start` arrived. */
  planStartMs: number;
  /** Currently running node count — peak is captured in `maxParallel`. */
  inFlight: number;
  /** High-water mark of concurrent in-flight nodes during the run. */
  maxParallel: number;
}

/** Build a streaming renderer wired against `io`. The returned `onEvent` is the callback
 * the Runner installs as `PlanContext.onEvent`. Optional {@link
 * StreamingRendererOptions.failedTail} configures the per-node ring buffer size used for
 * the failure post-mortem footer (defaults to 30).
 */
export function createStreamingRenderer(
  io: IO,
  opts: StreamingRendererOptions = {},
): {
  onEvent: (event: PlanEvent) => void;
} {
  let state: RendererState | null = null;
  const useColor = isTTY(io.stdout);
  const failedTail = Math.max(
    0,
    Math.floor(opts.failedTail ?? DEFAULT_FAILED_TAIL),
  );

  const onEvent = (event: PlanEvent): void => {
    switch (event.type) {
      case "plan-start":
        state = initState(event.plan, failedTail);
        return;

      case "node-start": {
        if (state === null) return;
        const stage = state.stages.get(event.nodeId);
        if (stage === undefined) return;
        if (!state.emittedStages.has(stage)) {
          state.emittedStages.add(stage);
          const count = state.stageSizes.get(stage) ?? 0;
          io.stdout.write(formatStageHeader(stage, count, useColor) + "\n");
        }
        // Track parallelism high-water mark.
        state.inFlight++;
        if (state.inFlight > state.maxParallel) {
          state.maxParallel = state.inFlight;
        }
        return;
      }

      case "node-output": {
        if (state === null) return;
        const prefix = state.prefixes.get(event.nodeId);
        if (prefix === undefined) return;
        const stage = state.stages.get(event.nodeId) ?? 0;
        const buffered = state.lineBuffers.get(event.nodeId) ?? "";
        const text = buffered + event.chunk.toString("utf8");
        const parts = text.split("\n");
        // Last element is the trailing partial line (empty string if the
        // chunk ended exactly at a newline). Buffer it for next time.
        const trailing = parts.pop() ?? "";
        state.lineBuffers.set(event.nodeId, trailing);
        const colorForStage = useColor ? stageColor(stage) : null;
        for (const line of parts) {
          const renderedPrefix =
            colorForStage !== null ? colorize(prefix, colorForStage) : prefix;
          const rendered = renderedPrefix + " " + line;
          io.stdout.write(rendered + "\n");
          pushTail(state, event.nodeId, rendered);
        }
        return;
      }

      case "node-failure": {
        if (state === null) return;
        // Flush any buffered partial line for this node so it isn't lost when the node errors
        // mid-line. The trailing partial enters the tail buffer too so the post-mortem sees what
        flushPartial(state, io, event.nodeId, useColor);
        // Track parallelism — node left the in-flight set.
        if (state.inFlight > 0) state.inFlight--;
        // Record failure order so the footer iterates in the order
        // failures arrived.
        if (!state.failedOrder.includes(event.nodeId)) {
          state.failedOrder.push(event.nodeId);
        }
        // Inline failure marker — emitted at the failure point so the user sees "✘ FAILED"
        // alongside the scrolling output, before any other node's lines arrive.
        io.stdout.write(
          formatFailureMarker(state, event.nodeId, event.durationMs, useColor) +
            "\n",
        );
        return;
      }

      case "node-success": {
        // Flush any buffered partial line for this node so it isn't lost.
        if (state === null) return;
        flushPartial(state, io, event.nodeId, useColor);
        if (state.inFlight > 0) state.inFlight--;
        return;
      }

      case "node-skip": {
        // Skipped nodes never `node-start`, so they don't enter the in-flight set; nothing to
        // decrement here. Footer summary line counts them via the final results map
        return;
      }

      case "plan-finish": {
        // Flush any remaining partial lines so byte-for-byte content the
        // handler emitted survives even without a trailing newline.
        if (state === null) return;
        for (const nodeId of state.lineBuffers.keys()) {
          flushPartial(state, io, nodeId, useColor);
        }
        emitFooter(state, io, event.results, useColor);
        return;
      }
    }
  };

  return { onEvent };
}

// internal helpers

const ANSI_CYAN = "\x1b[36m";
const ANSI_MAGENTA = "\x1b[35m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RESET = "\x1b[0m";
const STAGE_COLORS = [ANSI_CYAN, ANSI_MAGENTA, ANSI_YELLOW] as const;

/**
 * Walk the plan, compute each node's stage + raw prefix, then pad every
 * prefix to the max width so the closing `]` aligns vertically. This
 * matches verbose-aligned output the user sees in scripts/build-and-up.
 */
function initState(plan: Plan, failedTail: number): RendererState {
  const stages = computeStages(plan);
  const stageSizes = new Map<number, number>();
  for (const stage of stages.values()) {
    stageSizes.set(stage, (stageSizes.get(stage) ?? 0) + 1);
  }

  const rawPrefixes = new Map<string, string>();
  let maxWidth = 0;
  for (const node of plan.nodes.values()) {
    const stage = stages.get(node.id) ?? 0;
    const raw = formatRawPrefix(stage, node);
    rawPrefixes.set(node.id, raw);
    if (raw.length > maxWidth) maxWidth = raw.length;
  }

  const prefixes = new Map<string, string>();
  for (const [id, raw] of rawPrefixes) {
    prefixes.set(id, padPrefix(raw, maxWidth));
  }

  const nodes = new Map<string, PlanNode>();
  for (const node of plan.nodes.values()) {
    nodes.set(node.id, node);
  }

  return {
    plan,
    prefixes,
    stages,
    stageSizes,
    nodes,
    emittedStages: new Set(),
    lineBuffers: new Map(),
    tailBuffers: new Map(),
    failedTail,
    failedOrder: [],
    planStartMs: Date.now(),
    inFlight: 0,
    maxParallel: 0,
  };
}

function formatRawPrefix(stage: number, node: PlanNode): string {
  const handlerName = handlerDisplayName(node);
  const target = node.target ?? "";
  // Always include all three columns (with a trailing space before `]` when target is empty)
  // so widths line up cleanly even for nodes that omit `target`.
  if (target === "") {
    return `[${stage} ${handlerName}]`;
  }
  return `[${stage} ${handlerName} ${target}]`;
}

function handlerDisplayName(node: PlanNode): string {
  if (node.handler.kind === "plugin-hook") {
    return `${node.handler.plugin}.${node.handler.hook}`;
  }
  return node.handler.name;
}

/** Pad with trailing spaces inside the brackets so the closing `]` aligns. We append spaces
 * BEFORE the closing bracket — appending after would move `]` away from the line content.
 * Strip the trailing `]`, pad, then re-append.
 */
function padPrefix(raw: string, width: number): string {
  if (raw.length >= width) return raw;
  const pad = " ".repeat(width - raw.length);
  // raw ends with "]". Insert padding right before it so the `]` lands
  // at column `width - 1` for every node.
  return raw.slice(0, -1) + pad + "]";
}

function formatStageHeader(
  stage: number,
  nodeCount: number,
  useColor: boolean,
): string {
  const parallelSuffix = nodeCount > 1 ? " ━ parallel" : "";
  const text = `━━━ stage ${stage} ━ ${nodeCount} nodes${parallelSuffix} ━━━`;
  if (!useColor) return text;
  return colorize(text, stageColor(stage));
}

function stageColor(stage: number): string {
  const idx =
    ((stage % STAGE_COLORS.length) + STAGE_COLORS.length) % STAGE_COLORS.length;
  // SAFE: idx is bounded to [0, STAGE_COLORS.length). The fallback is
  // present only to satisfy noUncheckedIndexedAccess.
  return STAGE_COLORS[idx] ?? ANSI_CYAN;
}

function colorize(s: string, color: string): string {
  return color + s + ANSI_RESET;
}

/** The shared `IO['stdout']` type is the minimal `{ write(s): void }` shape so MockIO
 * satisfies it without a stream. RealIO returns `process.stdout`, which carries the
 * standard Node `isTTY` flag. We probe for it at runtime and treat any non-truthy value
 * (undefined / false) as "not a TTY → no color".
 */
function isTTY(stdout: IO["stdout"]): boolean {
  // `in` narrows the union to the branch that has the property; combined
  // with a strict equality check this avoids any type assertions.
  if (!("isTTY" in stdout)) return false;
  return stdout.isTTY === true;
}

/** If a node ended without a trailing newline, emit whatever's left in its buffer as a
 * final line so no bytes are dropped. Clears the buffer afterwards so a stray late
 * `node-output` doesn't double-print the same fragment.
 */
function flushPartial(
  state: RendererState,
  io: IO,
  nodeId: string,
  useColor: boolean,
): void {
  const partial = state.lineBuffers.get(nodeId);
  if (partial === undefined || partial === "") {
    state.lineBuffers.delete(nodeId);
    return;
  }
  const prefix = state.prefixes.get(nodeId);
  if (prefix === undefined) {
    state.lineBuffers.delete(nodeId);
    return;
  }
  const stage = state.stages.get(nodeId) ?? 0;
  const renderedPrefix = useColor
    ? colorize(prefix, stageColor(stage))
    : prefix;
  const rendered = renderedPrefix + " " + partial;
  io.stdout.write(rendered + "\n");
  pushTail(state, nodeId, rendered);
  state.lineBuffers.delete(nodeId);
}

// M8 — failure post-mortem helpers

const ANSI_RED = "\x1b[31m";

/**
 * Push `line` onto the node's ring buffer, trimming from the front when
 * length exceeds {@link RendererState.failedTail}. No-op when
 * `failedTail === 0` so the spec's "0 disables tail" path is honored.
 */
function pushTail(state: RendererState, nodeId: string, line: string): void {
  if (state.failedTail === 0) return;
  let buf = state.tailBuffers.get(nodeId);
  if (buf === undefined) {
    buf = [];
    state.tailBuffers.set(nodeId, buf);
  }
  buf.push(line);
  // Trim from the front (oldest) to keep at most `failedTail` lines.
  // Loop instead of slice() so a single overrun doesn't churn the array.
  while (buf.length > state.failedTail) {
    buf.shift();
  }
}

/** `<stage>:<handler>(<target>)` — the node-identifying string used by both the inline
 * failure marker and the post-mortem section header. `(<target>)` is dropped when the node
 * has no target so we don't emit a dangling empty parenthesis.
 */
function nodeDisplayName(state: RendererState, nodeId: string): string {
  const node = state.nodes.get(nodeId);
  const stage = state.stages.get(nodeId) ?? 0;
  if (node === undefined) {
    // Defensive — should not happen since the runner only emits events
    // for nodes that were in the plan at `plan-start`.
    return `${stage}:${nodeId}`;
  }
  const handlerName = handlerDisplayName(node);
  if (node.target === undefined || node.target === "") {
    return `${stage}:${handlerName}`;
  }
  return `${stage}:${handlerName}(${node.target})`;
}

/** Human-readable wall-clock duration. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) {
    // Trim trailing zeros / dot — `5.0s` -> `5s`, `5.30s` -> `5.3s`.
    return `${secs.toFixed(1).replace(/\.0$/, "")}s`;
  }
  const minutes = Math.floor(secs / 60);
  const remainder = Math.floor(secs - minutes * 60);
  return `${minutes}m${remainder}s`;
}

function formatFailureMarker(
  state: RendererState,
  nodeId: string,
  durationMs: number,
  useColor: boolean,
): string {
  const text =
    `━━━ ✘ FAILED  ${nodeDisplayName(state, nodeId)} ` +
    `(${formatDuration(durationMs)}) ━━━`;
  return useColor ? colorize(text, ANSI_RED) : text;
}

function formatPostMortemHeader(
  state: RendererState,
  nodeId: string,
  durationMs: number | undefined,
  useColor: boolean,
): string {
  const durStr = durationMs === undefined ? "?" : formatDuration(durationMs);
  const text = `━━━ Failed: ${nodeDisplayName(state, nodeId)} (${durStr}) ━━━`;
  return useColor ? colorize(text, ANSI_RED) : text;
}

/**
 * Emit the closing footer at `plan-finish`. Always emits the one-line
 * summary; only emits per-node post-mortem sections when there are
 * failures. Skipped nodes are counted in the summary line only.
 */
function emitFooter(
  state: RendererState,
  io: IO,
  results: ReadonlyMap<string, NodeResult>,
  useColor: boolean,
): void {
  let okCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  for (const r of results.values()) {
    if (r.status === "success") okCount++;
    else if (r.status === "failure") failedCount++;
    else if (r.status === "skipped") skippedCount++;
  }

  const totalMs = Date.now() - state.planStartMs;
  io.stdout.write(
    `Plan finished — ${okCount} ok, ${failedCount} failed, ` +
      `${skippedCount} skipped, total ${formatDuration(totalMs)}, ` +
      `max-parallel ${state.maxParallel}\n`,
  );

  if (failedCount > 0) {
    // Fall back to results-map order for any failed node that somehow didn't pass through the
    // node-failure event
    const order: string[] = [...state.failedOrder];
    for (const [id, r] of results) {
      if (r.status === "failure" && !order.includes(id)) order.push(id);
    }

    for (const nodeId of order) {
      const r = results.get(nodeId);
      if (r === undefined || r.status !== "failure") continue;
      io.stdout.write(
        formatPostMortemHeader(state, nodeId, r.durationMs, useColor) + "\n",
      );
      const tail = state.tailBuffers.get(nodeId);
      if (tail !== undefined) {
        for (const line of tail) {
          io.stdout.write(line + "\n");
        }
      }
    }
  }

  // Auto-suppress for ≤1-node plans (matches M5's start-of-run trivial-summary contract).
  // The render sits AFTER all per-failure post-mortem sections (when present) so the user
  emitColoredDag(state, io, results, useColor);
}

/**
 * M9 — append the post-mortem DAG render (color-coded by final status)
 * to the footer. The renderer is reused from M5; the only behavioral
 * difference is the `statuses` + `useColor` overlay.
 */
function emitColoredDag(
  state: RendererState,
  io: IO,
  results: ReadonlyMap<string, NodeResult>,
  useColor: boolean,
): void {
  // The renderer itself emits a one-line summary in this case — useless to duplicate, so we
  // just bail.
  if (state.plan.nodes.size <= 1) return;

  const statuses = new Map<string, NodeStatus>();
  for (const [id, r] of results) {
    statuses.set(id, r.status);
  }

  const dag = renderPlanDag(state.plan, { statuses, useColor });
  io.stdout.write(dag);
}
