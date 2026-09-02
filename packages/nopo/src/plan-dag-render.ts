/** Lays the plan out with `@dagrejs/dagre` (left-to-right; X axis = time, Y axis =
 * concurrency) and projects dagre's continuous coordinates onto a discrete character grid.
 * Every `needs` link is drawn as a real edge line, not an inline annotation. This is the
 * default output of `nopo <cmd> --print` (M5). The JSON resolution form lives behind
 */

import dagre from "@dagrejs/dagre";

import type { Plan, PlanNode, SerializedPlan } from "./plan.ts";
import { deserializePlan, validatePlan } from "./plan.ts";
import { computeStages } from "./plan-layout.ts";
import type { NodeStatus } from "./plan-runner.ts";

/** Default terminal width when the caller has none to report. */
const DEFAULT_WIDTH = 120;

/** Hard floor on per-column width so labels remain legible. */
const MIN_LABEL_WIDTH = 10;

/** Maximum per-label width before truncation kicks in. */
const MAX_LABEL_WIDTH = 28;

/** Inter-column horizontal gutter (in characters). Houses edge lines. */
const COLUMN_GUTTER = 4;

/** Vertical gap between boxes within a column (blank rows). */
const ROW_GUTTER = 1;

/** Options for {@link renderPlanDag}. */
interface RenderPlanDagOptions {
  /**
   * Target terminal width in characters. Used to cap column widths so
   * very long labels truncate rather than blow out the line length.
   * Defaults to {@link DEFAULT_WIDTH}.
   */
  width?: number;
  /** When supplied, each node's label is prefixed with a status symbol (`✓` success, `✘`
   * failure, `⊘` skipped) and — if {@link useColor} is true — the box is wrapped in the
   * matching ANSI color. Nodes missing from the map render with no symbol and no color
   * (falls back to the M5 layout). Pre-`pending` `running` statuses are treated like missing
   */
  statuses?: ReadonlyMap<string, NodeStatus>;
  /** Callers pipe through their own TTY detection (the streaming renderer in `plan-render.ts`
   * reuses its `io.stdout.isTTY` check). When false (default) only the status symbols are
   * emitted, matching the spec's "non-TTY → symbols only" contract. Has no effect unless
   * {@link statuses} is also supplied.
   */
  useColor?: boolean;
}

/**
 * Render `plan` as an ASCII DAG. Returns a multi-line string (each line
 * already terminated with `\n`). Trivial plans (≤1 node) return a
 * one-line summary instead — the renderer is a no-op for those.
 */
export function renderPlanDag(
  plan: Plan,
  options: RenderPlanDagOptions = {},
): string {
  validatePlan(plan);

  if (plan.nodes.size <= 1) {
    return renderTrivialSummary(plan) + "\n";
  }

  const width = options.width ?? DEFAULT_WIDTH;
  const decoration: NodeDecoration = {
    statuses: options.statuses,
    useColor: options.useColor === true,
  };

  const layout = layoutWithDagre(plan, decoration);
  return renderGrid(plan, layout, width, decoration) + renderBatchLegend(plan);
}

/** Render a trailing "Batches:" legend listing every batch node's `meta.batchOf` members in
 * full. Empty string when the plan has no batch nodes (the common case — plans without
 * compaction folds). <batch-node-id> [contains: m1, m2, m3] <batch-node-id> [contains: m4,
 * m5] Members are listed in their `batchOf` order
 */
function renderBatchLegend(plan: Plan): string {
  const lines: string[] = [];
  for (const node of plan.nodes.values()) {
    const members = batchMembers(node);
    if (members === null) continue;
    lines.push(`  ${node.id} [contains: ${members.join(", ")}]`);
  }
  if (lines.length === 0) return "";
  return "Batches:\n" + lines.join("\n") + "\n";
}

/**
 * Convenience wrapper that accepts a {@link SerializedPlan}. Useful for
 * callers (e.g. fixture-driven tests) that hold the JSON shape.
 */
export function renderSerializedPlanDag(
  serialized: SerializedPlan,
  options: RenderPlanDagOptions = {},
): string {
  return renderPlanDag(deserializePlan(serialized), options);
}

/** One-line summary used in place of the full DAG render when the plan has 0 or 1 nodes.
 * Form: Plan: 1 node — build:exec af-api Public so {@link renderPlanDag} and `--print`
 * callers share the same trivial output regardless of which entry point they use.
 */
export function renderTrivialSummary(plan: Plan): string {
  if (plan.nodes.size === 0) {
    return "Plan: 0 nodes";
  }
  const [only] = plan.nodes.values();
  const label = nodeLabel(only!);
  return `Plan: 1 node — ${label}`;
}

// M9 — status decoration

/** Status → 1-char symbol prefix embedded in the node label. */
const STATUS_SYMBOLS: Readonly<Record<NodeStatus, string>> = {
  success: "✓",
  failure: "✘",
  skipped: "⊘",
  // pending/running shouldn't reach this renderer (it's invoked at
  // plan-finish), but if they do we emit no symbol — see decorationFor().
  pending: "",
  running: "",
};

/** ANSI escape codes mirrored from the streaming renderer (M7/M8). */
const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_GRAY = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";

/** Status → ANSI color used when `useColor` is true. */
const STATUS_COLORS: Readonly<Record<NodeStatus, string | null>> = {
  success: ANSI_GREEN,
  failure: ANSI_RED,
  skipped: ANSI_GRAY,
  pending: null,
  running: null,
};

/** Per-render decoration plumbing. Empty when M9 mode is off. */
interface NodeDecoration {
  statuses?: ReadonlyMap<string, NodeStatus>;
  useColor: boolean;
}

/**
 * Resolve the decoration for one node. Returns `null` when no symbol
 * should be drawn (no map, missing entry, or non-terminal status).
 */
function decorationFor(
  decoration: NodeDecoration,
  nodeId: string,
): { symbol: string; color: string | null } | null {
  if (decoration.statuses === undefined) return null;
  const status = decoration.statuses.get(nodeId);
  if (status === undefined) return null;
  const symbol = STATUS_SYMBOLS[status];
  if (symbol === "") return null;
  const color = decoration.useColor ? STATUS_COLORS[status] : null;
  return { symbol, color };
}

/**
 * Format a node's label with the M9 status symbol prepended when
 * applicable. The color is applied separately at paint time so we don't
 * inflate the column-width budget with invisible escape sequences.
 */
function decoratedLabel(node: PlanNode, symbol: string | null): string {
  const base = nodeLabel(node);
  if (symbol === null || symbol === "") return base;
  return `${symbol} ${base}`;
}

// Label formatting

/** Format `node` as `<handler> <target>` (omitting the trailing space + target if `target`
 * is missing). Mirrors the streaming renderer's `handlerDisplayName` convention. MT3 —
 * batch nodes carry `meta.batchOf: string[]` listing the original node ids that were
 * folded into this one (see `decisions/0012_plugin_batches.md`). When present, we append
 */
export function nodeLabel(node: PlanNode): string {
  const handler =
    node.handler.kind === "plugin-hook"
      ? `${node.handler.plugin}.${node.handler.hook}`
      : node.handler.name;
  const base =
    node.target === undefined || node.target === ""
      ? handler
      : `${handler} ${node.target}`;
  const members = batchMembers(node);
  if (members === null) return base;
  return `${base} [+${members.length} batched]`;
}

/** If `node` is a batch node (carries `meta.batchOf: string[]` from {@link compactPlan}),
 * return the list of original node ids that were folded into it. Otherwise return `null`.
 * The compaction pass guarantees `batchOf` is a non-empty `string[]` for nodes it emits,
 * but this function is defensive against arbitrary `meta` shapes
 */
export function batchMembers(node: PlanNode): readonly string[] | null {
  const raw = node.meta?.batchOf;
  if (!Array.isArray(raw)) return null;
  // Filter to string members only — defensive against malformed meta.
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") out.push(item);
  }
  if (out.length === 0) return null;
  return out;
}

/**
 * Truncate `s` to `max` columns. If truncation occurs, the last visible
 * character is replaced with `…` so the user can tell. Public for tests.
 */
export function truncateLabel(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max === 1) return "…";
  return s.slice(0, max - 1) + "…";
}

// Dagre layout

interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  rank: number;
}

interface LaidOutEdge {
  from: string;
  to: string;
}

interface DagreLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

/** Run dagre with LR (left-to-right) rankdir so the rank axis lines up with
 * stages-as-columns. Dagre is left free to choose ranks — M1's prototype showed that
 * constraining dagre to fixed ASAP ranks degrades legibility for cross-stage edges, so we
 * don't.
 */
function layoutWithDagre(plan: Plan, decoration: NodeDecoration): DagreLayout {
  const g = new dagre.graphlib.Graph({ directed: true });
  g.setGraph({
    rankdir: "LR",
    nodesep: 30,
    ranksep: 50,
    marginx: 10,
    marginy: 10,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of plan.nodes.values()) {
    const dec = decorationFor(decoration, node.id);
    const label = decoratedLabel(node, dec?.symbol ?? null);
    g.setNode(node.id, {
      label,
      // The renderer doesn't use these values directly — it derives column width from truncated
      // label length — but dagre needs them for layout.
      width: Math.max(label.length * 7 + 10, 60),
      height: 24,
    });
  }
  for (const node of plan.nodes.values()) {
    for (const dep of node.needs) {
      g.setEdge(dep, node.id);
    }
  }

  dagre.layout(g);

  // Remap to a dense 0..N rank index. We sort by x — with rankdir=LR, dagre maps ranks onto
  // the x axis, so column = ordinal position by x bucket.
  type Raw = { id: string; x: number; y: number; rawRank: number };
  const rawNodes: Raw[] = [];
  for (const id of g.nodes()) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- dagre's typings expose `any`-ish nodes; we set width/height/label above
    const n = g.node(id) as { x: number; y: number; rank?: number };
    rawNodes.push({
      id,
      x: n.x,
      y: n.y,
      rawRank: n.rank ?? n.x,
    });
  }

  const uniqueRanks = [...new Set(rawNodes.map((n) => n.rawRank))].sort(
    (a, b) => a - b,
  );
  const rankMap = new Map(uniqueRanks.map((r, i) => [r, i] as const));

  const nodes: LaidOutNode[] = rawNodes.map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    rank: rankMap.get(n.rawRank) ?? 0,
  }));

  const edges: LaidOutEdge[] = g.edges().map((e) => ({ from: e.v, to: e.w }));

  return { nodes, edges };
}

// Grid renderer

/** A placed box in the rendered grid. */
interface PlacedBox {
  id: string;
  col: number;
  /** Top row of the box (inclusive). */
  row: number;
  /** Inner width (number of label chars between `│ … │`). */
  innerWidth: number;
  /** Left x in grid (column of the leading `│`). */
  x: number;
  /** Right x in grid (column of the trailing `│`). */
  xRight: number;
  /** Mid y (the label row, where edges connect). */
  yMid: number;
}

interface GridLayout {
  /** Boxes keyed by node id. */
  boxes: Map<string, PlacedBox>;
  /** Ordered list of columns; columnIndex -> {x, innerWidth, nodeIds}. */
  columns: Array<{
    col: number;
    x: number;
    innerWidth: number;
    nodeIds: string[];
  }>;
  /** Total grid height (rows). */
  height: number;
  /** Total grid width (chars per row). */
  width: number;
}

/** Project dagre's continuous coordinates onto the character grid, then paint boxes + edges
 * into a 2D char array and join into the final string. Box shape (height=3):
 * ┌──────────────┐ │ build:exec api │ └──────────────┘ Edges are drawn out of the right
 * edge of the source box (yMid), into the left edge of the target box (yMid). The route
 */
function renderGrid(
  plan: Plan,
  layout: DagreLayout,
  termWidth: number,
  decoration: NodeDecoration,
): string {
  // Group nodes by column (dagre rank).
  const nodesByCol = new Map<number, LaidOutNode[]>();
  for (const n of layout.nodes) {
    let bucket = nodesByCol.get(n.rank);
    if (bucket === undefined) {
      bucket = [];
      nodesByCol.set(n.rank, bucket);
    }
    bucket.push(n);
  }

  // Sort each column by dagre's y so vertical order matches dagre's
  // crossing-minimization choice.
  for (const list of nodesByCol.values()) {
    list.sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
  }

  const columnIndices = [...nodesByCol.keys()].sort((a, b) => a - b);

  // Compute the max allowed label width given termWidth and column count. We need: cols *
  // (innerWidth + 2 borders) + (cols - 1) * gutter ≤ termWidth. Solve for innerWidth
  const cols = columnIndices.length;
  const budget = Math.max(
    MIN_LABEL_WIDTH,
    Math.floor((termWidth - (cols - 1) * COLUMN_GUTTER) / cols) - 2,
  );
  const maxLabelWidth = Math.min(MAX_LABEL_WIDTH, budget);

  // Per-column inner width = max truncated label width in that column.
  const columnInnerWidths: number[] = columnIndices.map((c) => {
    const ids = nodesByCol.get(c) ?? [];
    let max = MIN_LABEL_WIDTH;
    for (const n of ids) {
      const node = plan.nodes.get(n.id);
      if (!node) continue;
      const dec = decorationFor(decoration, n.id);
      const raw = decoratedLabel(node, dec?.symbol ?? null);
      const truncated = truncateLabel(raw, maxLabelWidth);
      // +2 = one space of padding on each side inside the borders.
      const w = truncated.length + 2;
      if (w > max) max = w;
    }
    return Math.min(max, maxLabelWidth + 2);
  });

  // Compute column x positions.
  const columnXs: number[] = [];
  let xCursor = 0;
  for (let i = 0; i < cols; i++) {
    columnXs.push(xCursor);
    const innerWidth = columnInnerWidths[i] ?? MIN_LABEL_WIDTH;
    xCursor += innerWidth + 2 + COLUMN_GUTTER;
  }
  const totalWidth = xCursor - COLUMN_GUTTER;

  // Box height = 3. Reserve row 0 for the stage-header line, row 1 blank, then boxes start
  // at row 2.
  const FIRST_BOX_ROW = 2;
  const BOX_HEIGHT = 3;
  const ROW_STRIDE = BOX_HEIGHT + ROW_GUTTER;

  const boxes = new Map<string, PlacedBox>();
  const columns: GridLayout["columns"] = [];
  let maxRow = FIRST_BOX_ROW;

  for (let i = 0; i < cols; i++) {
    const col = columnIndices[i]!;
    const x = columnXs[i]!;
    const innerWidth = columnInnerWidths[i]!;
    const nodes = nodesByCol.get(col) ?? [];
    const nodeIds = nodes.map((n) => n.id);

    nodes.forEach((n, idx) => {
      const top = FIRST_BOX_ROW + idx * ROW_STRIDE;
      const box: PlacedBox = {
        id: n.id,
        col,
        row: top,
        innerWidth,
        x,
        xRight: x + innerWidth + 1,
        yMid: top + 1,
      };
      boxes.set(n.id, box);
      if (top + BOX_HEIGHT > maxRow) maxRow = top + BOX_HEIGHT;
    });

    columns.push({ col, x, innerWidth, nodeIds });
  }

  const grid: GridLayout = {
    boxes,
    columns,
    height: maxRow,
    width: totalWidth,
  };

  return paint(plan, layout, grid, maxLabelWidth, decoration);
}

/** Paint a {@link GridLayout} into a 2D char array and join the rows into the final string.
 * Boxes are drawn first; edges are routed through the inter-column gutter and overlay onto
 * the grid (taking care not to clobber box borders).
 */
function paint(
  plan: Plan,
  layout: DagreLayout,
  grid: GridLayout,
  maxLabelWidth: number,
  decoration: NodeDecoration,
): string {
  // Build an empty char grid. We use ' ' as the background.
  const buf: string[][] = [];
  // Parallel mask: cells flagged here are "off-limits" to edge overlays (box interiors,
  // headers, label spans). Box borders are detected via the EDGE_GLYPHS check directly, but
  const mask: boolean[][] = [];
  for (let r = 0; r < grid.height; r++) {
    buf.push(new Array<string>(grid.width).fill(" "));
    mask.push(new Array<boolean>(grid.width).fill(false));
  }

  // Column headers on row 0: "─── stage N ───" centered above each column. M2's
  // computeStages gives us the per-node stage; we read any node's stage to label the column.
  const stages = computeStages(plan);
  for (const col of grid.columns) {
    let stage: number | null = null;
    for (const id of col.nodeIds) {
      const s = stages.get(id);
      if (s !== undefined && (stage === null || s < stage)) stage = s;
    }
    const text = stage === null ? `col ${col.col}` : `stage ${stage}`;
    const innerSpan = col.innerWidth + 2;
    drawHeader(buf, 0, col.x, innerSpan, text);
  }
  // Header row is off-limits to edge overlays.
  if (mask[0]) {
    mask[0].fill(true);
  }

  // M9 — per-row spans `(rowIdx, [startCol, endColExclusive, color])` to be wrapped in ANSI
  // escapes after the buffer is joined. Empty when no decoration is requested
  const colorSpans = new Map<number, Array<[number, number, string]>>();

  // Boxes first.
  for (const box of grid.boxes.values()) {
    const planNode = plan.nodes.get(box.id);
    if (!planNode) continue;
    const dec = decorationFor(decoration, box.id);
    const label = truncateLabel(
      decoratedLabel(planNode, dec?.symbol ?? null),
      maxLabelWidth,
    );
    drawBox(buf, box, label);
    // Mask the box footprint (borders + interior label row) so edges
    // can't overlay through them.
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < box.innerWidth + 2; dx++) {
        mask[box.row + dy]![box.x + dx] = true;
      }
    }
    // Record the box's character range (3 rows) for post-paint ANSI wrapping. The mask above
    // guarantees no edges crossed into these cells, so the slice is contiguous
    if (dec?.color != null && dec.color !== "") {
      for (let dy = 0; dy < 3; dy++) {
        const r = box.row + dy;
        let bucket = colorSpans.get(r);
        if (bucket === undefined) {
          bucket = [];
          colorSpans.set(r, bucket);
        }
        bucket.push([box.x, box.x + box.innerWidth + 2, dec.color]);
      }
    }
  }

  // We draw each `needs` edge as a real line connecting the source box's right edge to the
  // target box's left edge. Routing uses a single vertical leg in the first gutter right
  for (const edge of layout.edges) {
    const src = grid.boxes.get(edge.from);
    const tgt = grid.boxes.get(edge.to);
    if (!src || !tgt) continue;
    drawEdge(buf, mask, src, tgt);
  }

  return (
    buf
      .map((row, idx) => {
        const spans = colorSpans.get(idx);
        if (spans === undefined || spans.length === 0) {
          return row.join("").replace(/\s+$/u, "");
        }
        // Splice from right-to-left so column indices stay valid as we
        // insert the (variable-length) ANSI escapes.
        const cells = row.slice();
        const sorted = spans.slice().sort((a, b) => b[0] - a[0]);
        for (const [start, end, color] of sorted) {
          // Insert RESET at `end` first so the splice at `start` doesn't
          // shift the end position.
          cells.splice(end, 0, ANSI_RESET);
          cells.splice(start, 0, color);
        }
        return cells.join("").replace(/\s+$/u, "");
      })
      .join("\n") + "\n"
  );
}

// Primitives

function drawHeader(
  buf: string[][],
  row: number,
  x: number,
  span: number,
  text: string,
): void {
  // "─── text ───" form, with text centered. If text is wider than span,
  // truncate; the caller already constrained labels so this is rare.
  const safe = text.length > span - 2 ? text.slice(0, span - 2) : text;
  const padLeft = Math.max(0, Math.floor((span - safe.length - 2) / 2));
  const padRight = Math.max(0, span - safe.length - 2 - padLeft);
  const line = "─".repeat(padLeft) + " " + safe + " " + "─".repeat(padRight);
  for (let i = 0; i < span && i < line.length; i++) {
    setChar(buf, x + i, row, line[i] ?? " ");
  }
}

function drawBox(buf: string[][], box: PlacedBox, label: string): void {
  const innerSpan = box.innerWidth;
  const top = "┌" + "─".repeat(innerSpan) + "┐";
  // Pad label to innerSpan with leading/trailing spaces.
  const padded =
    " " + label + " ".repeat(Math.max(0, innerSpan - label.length - 1));
  const mid = "│" + padded.slice(0, innerSpan) + "│";
  const bot = "└" + "─".repeat(innerSpan) + "┘";
  writeLine(buf, box.x, box.row, top);
  writeLine(buf, box.x, box.row + 1, mid);
  writeLine(buf, box.x, box.row + 2, bot);
}

function writeLine(buf: string[][], x: number, y: number, s: string): void {
  for (let i = 0; i < s.length; i++) {
    setChar(buf, x + i, y, s[i] ?? " ");
  }
}

function setChar(buf: string[][], x: number, y: number, ch: string): void {
  if (y < 0 || y >= buf.length) return;
  const row = buf[y];
  if (!row) return;
  if (x < 0 || x >= row.length) return;
  row[x] = ch;
}

/**
 * Get the current char at (x, y), returning ' ' for out-of-bounds.
 */
function getChar(buf: string[][], x: number, y: number): string {
  if (y < 0 || y >= buf.length) return " ";
  const row = buf[y];
  if (!row) return " ";
  if (x < 0 || x >= row.length) return " ";
  return row[x] ?? " ";
}

/** Draw an edge from `src`'s right edge to `tgt`'s left edge. Route uses an L-bend in the
 * inter-column gutter: src.xRight → step right (─) → bend column (┐/┘) → vertical run (│)
 * → bend (└/┌) → step right (─) → tgt.x - 1 If src and tgt are on the same y, the run is a
 * straight horizontal line.
 */
function drawEdge(
  buf: string[][],
  mask: boolean[][],
  src: PlacedBox,
  tgt: PlacedBox,
): void {
  const x0 = src.xRight + 1; // first gutter col right of source box
  const x1 = tgt.x - 1; // last gutter col left of target box
  if (x0 > x1) {
    // Target is to the left of (or overlapping) source — unusual but
    // can happen if a column is empty. Skip.
    return;
  }

  const y0 = src.yMid;
  const y1 = tgt.yMid;
  const bendX = x0;

  if (y0 === y1) {
    for (let x = x0; x <= x1; x++) {
      overlayEdgeChar(buf, mask, x, y0, "─");
    }
    return;
  }

  overlayEdgeChar(buf, mask, bendX, y0, y1 > y0 ? "┐" : "┘");
  const yLow = Math.min(y0, y1) + 1;
  const yHigh = Math.max(y0, y1) - 1;
  for (let y = yLow; y <= yHigh; y++) {
    overlayEdgeChar(buf, mask, bendX, y, "│");
  }
  overlayEdgeChar(buf, mask, bendX, y1, y1 > y0 ? "└" : "┌");
  for (let x = bendX + 1; x <= x1; x++) {
    overlayEdgeChar(buf, mask, x, y1, "─");
  }
}

/** Overlay an edge glyph at (x, y), merging with whatever is already there so two edges
 * crossing produce `┼` instead of clobbering. We only write into cells that are blank or
 * already carry an edge glyph. Box borders, labels, and header chars are preserved — this
 * is the discipline that lets the renderer route edges across the page without smashing
 */
function overlayEdgeChar(
  buf: string[][],
  mask: boolean[][],
  x: number,
  y: number,
  glyph: string,
): void {
  // Masked cells (box footprints, headers) are off-limits — edges that would otherwise punch
  // through a label or border are dropped at the mask, leaving a visible gap in the route.
  if (y < 0 || y >= mask.length) return;
  const maskRow = mask[y];
  if (!maskRow) return;
  if (x < 0 || x >= maskRow.length) return;
  if (maskRow[x] === true) return;

  const existing = getChar(buf, x, y);
  if (existing === " ") {
    setChar(buf, x, y, glyph);
    return;
  }
  if (!EDGE_GLYPHS.has(existing)) return;
  if (
    (existing === "─" && glyph === "│") ||
    (existing === "│" && glyph === "─")
  ) {
    setChar(buf, x, y, "┼");
    return;
  }
  // Same glyph or bend corner already present — no-op.
}

const EDGE_GLYPHS = new Set(["─", "│", "┼", "┌", "┐", "└", "┘"]);
