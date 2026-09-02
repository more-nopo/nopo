/** Walks a {@link Plan} through a worker pool, dispatching each node via a caller-supplied
 * {@link HandlerDispatch}. Does no IO of its own — handlers receive `ctx.io`, observers
 * subscribe to {@link PlanEvent}s. Plugin/builtin lookup lives in the dispatch table, not
 * here.
 */

import { Buffer } from "node:buffer";

import type { IO, SpawnOpts, SpawnResult } from "./io.ts";
import {
  type Plan,
  type PlanHandler,
  type PlanNode,
  validatePlan,
} from "./plan.ts";
import { autoConcurrency } from "./resource-limits.ts";

/** Routes each node to its handler. The runner switches on `handler.kind`. */
export interface HandlerDispatch {
  pluginHook(
    node: PlanNode,
    handler: Extract<PlanHandler, { kind: "plugin-hook" }>,
    ctx: PlanContext,
  ): Promise<void>;
  builtin(
    node: PlanNode,
    handler: Extract<PlanHandler, { kind: "builtin" }>,
    ctx: PlanContext,
  ): Promise<void>;
}

/**
 * Threaded as the same reference into every handler. Runner reads
 * `dispatch`, `maxConcurrency`, `failureMode`, `onEvent`; the rest is
 * opaque pass-through.
 */
export interface PlanContext {
  io: IO;
  /** Explicit concurrency cap (CLI `--concurrency` / `NOPO_CONCURRENCY`). When set it
   * overrides auto-detection and may exceed the detected CPU/memory budget — the caller
   * opted in. When omitted, the runner falls back to {@link autoConcurrency}. Either way
   * it's still clamped by `plan.maxConcurrency`.
   */
  maxConcurrency?: number;
  dispatch: HandlerDispatch;
  onEvent?: (event: PlanEvent) => void;
  /**
   * `"keep-going"` (default): a failure poisons descendants but
   * independent branches continue. `"fail-fast"`: first failure halts
   * new dispatches, in-flight nodes are awaited, pending nodes skip.
   */
  failureMode?: "keep-going" | "fail-fast";
}

export type NodeStatus =
  | "pending"
  | "running"
  | "success"
  | "failure"
  | "skipped";

export interface NodeResult {
  id: string;
  status: NodeStatus;
  /** ms — wall time from start to finish (set for success/failure). */
  durationMs?: number;
  /** Populated when status === "failure". */
  error?: { message: string; stack?: string };
  /**
   * Populated when status === "skipped". For keep-going mode this is
   * the immediate failed parent's id. For fail-fast it is either the
   * first failed node's id (if known) or the sentinel `"fail-fast"`.
   */
  skippedDueTo?: string;
}

export type PlanEvent =
  | { type: "plan-start"; plan: Plan; concurrency: number }
  | { type: "node-start"; nodeId: string }
  | { type: "node-success"; nodeId: string; durationMs: number }
  | { type: "node-failure"; nodeId: string; durationMs: number; error: Error }
  | { type: "node-skip"; nodeId: string; reason: string }
  | {
      /** Emitted at chunk granularity (no line splitting) — line buffering is the renderer's
       * concern (M7), not the event stream's. Preserves byte-perfect output including ANSI
       * escape sequences from spawned processes (e.g. `docker build` progress bars). Sources
       * covered by the per-node IO proxy: `ctx.io.stdout.write(s)` — direct handler writes
       */
      type: "node-output";
      nodeId: string;
      source: "stdout" | "stderr";
      chunk: Buffer;
    }
  | {
      type: "plan-finish";
      results: ReadonlyMap<string, NodeResult>;
      ok: boolean;
    };

export interface PlanRunResult {
  ok: boolean;
  results: ReadonlyMap<string, NodeResult>;
}

/** `needs` reference throws — the runner cannot recover from a malformed plan. Worker loop:
 * maintains a ready queue of nodes whose `needs` are all satisfied. Fills empty worker
 * slots up to the effective concurrency cap. When a node finishes (success or failure),
 * readiness is recomputed only for nodes that depend on the just-finished one — the runner
 */
export async function executePlan(
  plan: Plan,
  ctx: PlanContext,
): Promise<PlanRunResult> {
  validatePlan(plan);

  const failureMode: "keep-going" | "fail-fast" =
    ctx.failureMode ?? "keep-going";
  const concurrency = computeConcurrency(plan, ctx);

  const results = new Map<string, NodeResult>();
  for (const node of plan.nodes.values()) {
    results.set(node.id, { id: node.id, status: "pending" });
  }

  const emit = (event: PlanEvent): void => {
    ctx.onEvent?.(event);
  };

  emit({ type: "plan-start", plan, concurrency });

  // Empty plan — nothing to do.
  if (plan.nodes.size === 0) {
    emit({ type: "plan-finish", results, ok: true });
    return { ok: true, results };
  }

  // Lets us recompute readiness for only the nodes that depend on the just-finished one
  // instead of re-walking the whole graph each tick.
  const dependents = new Map<string, string[]>();
  // Remaining unsatisfied prerequisites per node.
  const remaining = new Map<string, number>();
  for (const node of plan.nodes.values()) {
    dependents.set(node.id, []);
    remaining.set(node.id, node.needs.length);
  }
  for (const node of plan.nodes.values()) {
    for (const dep of node.needs) {
      dependents.get(dep)!.push(node.id);
    }
  }

  // Initial ready queue: nodes with no needs, in plan insertion order.
  const ready: string[] = [];
  for (const node of plan.nodes.values()) {
    if (node.needs.length === 0) ready.push(node.id);
  }

  let inFlight = 0;
  let aborted = false;
  let firstFailureId: string | null = null;

  return await new Promise<PlanRunResult>((resolve) => {
    const finish = (): void => {
      const ok = !Array.from(results.values()).some(
        (r) => r.status === "failure",
      );
      // Anything still pending after the loop drained without being dispatched (fail-fast
      // aborted before they started) is recorded as skipped here. In keep-going mode poisoning
      for (const r of results.values()) {
        if (r.status === "pending") {
          r.status = "skipped";
          r.skippedDueTo = firstFailureId ?? "fail-fast";
          emit({
            type: "node-skip",
            nodeId: r.id,
            reason: `fail-fast: aborted by ${r.skippedDueTo}`,
          });
        }
      }
      emit({ type: "plan-finish", results, ok });
      resolve({ ok, results });
    };

    const tryStartMore = (): void => {
      // In fail-fast mode after a failure, do not start any new nodes.
      // Drain only the in-flight ones.
      if (aborted) {
        if (inFlight === 0) finish();
        return;
      }
      while (inFlight < concurrency && ready.length > 0) {
        const id = ready.shift()!;
        const node = plan.nodes.get(id)!;
        const result = results.get(id)!;
        // If poisoning marked it skipped between enqueue and dispatch, skip it for real. (In
        // practice we never enqueue skipped nodes — but defensive anyway.)
        if (result.status !== "pending") continue;
        startNode(node);
      }
      if (inFlight === 0 && ready.length === 0) {
        finish();
      }
    };

    const startNode = (node: PlanNode): void => {
      const result = results.get(node.id)!;
      result.status = "running";
      inFlight++;
      const startedAt = Date.now();
      emit({ type: "node-start", nodeId: node.id });

      // Per-node IO proxy: every byte the handler writes through `ctx.io.stdout`,
      // `ctx.io.stderr`, or a spawned child's `onChunk` is also re-emitted as a `node-output`
      const nodeCtx: PlanContext = {
        ...ctx,
        io: wrapIOForNode(ctx.io, node.id, emit),
      };

      dispatch(node, nodeCtx).then(
        () => {
          const durationMs = Date.now() - startedAt;
          result.status = "success";
          result.durationMs = durationMs;
          inFlight--;
          emit({ type: "node-success", nodeId: node.id, durationMs });
          // Decrement remaining-needs for every dependent; enqueue any
          // that just became ready.
          for (const depId of dependents.get(node.id) ?? []) {
            const next = (remaining.get(depId) ?? 0) - 1;
            remaining.set(depId, next);
            if (next === 0 && results.get(depId)!.status === "pending") {
              ready.push(depId);
            }
          }
          tryStartMore();
        },
        (rawError: unknown) => {
          const durationMs = Date.now() - startedAt;
          const error = normalizeError(rawError);
          result.status = "failure";
          result.durationMs = durationMs;
          result.error = { message: error.message };
          if (error.stack !== undefined) result.error.stack = error.stack;
          inFlight--;
          emit({ type: "node-failure", nodeId: node.id, durationMs, error });

          if (firstFailureId === null) firstFailureId = node.id;

          if (failureMode === "fail-fast") {
            aborted = true;
          } else {
            // keep-going: poison every transitive descendant.
            poisonDescendants(node.id);
          }
          tryStartMore();
        },
      );
    };

    const poisonDescendants = (failedId: string): void => {
      // BFS over forward edges, marking each pending descendant as
      // skipped with `skippedDueTo` set to its IMMEDIATE failed parent.
      const queue: Array<{ id: string; reason: string }> = [];
      for (const child of dependents.get(failedId) ?? []) {
        queue.push({ id: child, reason: failedId });
      }
      while (queue.length > 0) {
        const { id, reason } = queue.shift()!;
        const r = results.get(id)!;
        if (r.status !== "pending") continue;
        r.status = "skipped";
        r.skippedDueTo = reason;
        emit({
          type: "node-skip",
          nodeId: id,
          reason: `dependency "${reason}" failed`,
        });
        // Descendants of a skipped node use the SKIPPED node as their immediate-failed-ancestor —
        // they are blocked because their direct prerequisite was skipped, which transitively means
        for (const grand of dependents.get(id) ?? []) {
          queue.push({ id: grand, reason: id });
        }
      }
    };

    const dispatch = (node: PlanNode, c: PlanContext): Promise<void> => {
      try {
        if (node.handler.kind === "plugin-hook") {
          return c.dispatch.pluginHook(node, node.handler, c);
        }
        return c.dispatch.builtin(node, node.handler, c);
      } catch (err) {
        // Synchronous throw inside dispatch — treat as a rejection.
        return Promise.reject(err);
      }
    };

    // Kick off the first wave.
    tryStartMore();
  });
}

// internal helpers

/** Wrap `io` so that every byte produced by the node's handler is forwarded to the
 * underlying IO AND emitted as a `node-output` PlanEvent. Surface intercepted:
 * `stdout.write(s)` / `stderr.write(s)` — direct handler writes. We coerce the string to a
 * `Buffer` so the event carries raw bytes
 */
function wrapIOForNode(
  io: IO,
  nodeId: string,
  emit: (event: PlanEvent) => void,
): IO {
  const emitChunk = (source: "stdout" | "stderr", chunk: Buffer): void => {
    emit({ type: "node-output", nodeId, source, chunk });
  };
  const wrappedStdout: IO["stdout"] = {
    write(s: string): void {
      emitChunk("stdout", Buffer.from(s));
      io.stdout.write(s);
    },
  };
  const wrappedStderr: IO["stderr"] = {
    write(s: string): void {
      emitChunk("stderr", Buffer.from(s));
      io.stderr.write(s);
    },
  };

  // Build a proxy object that pins stdout/stderr/spawn but forwards everything else to `io`
  // via getters so live bindings (env, stdin, mutable platform in tests) keep working.
  const wrapped: IO = {
    get argv() {
      return io.argv;
    },
    get env() {
      return io.env;
    },
    get platform() {
      return io.platform;
    },
    get stdin() {
      return io.stdin;
    },
    cwd: () => io.cwd(),
    exit: (code: number) => io.exit(code),
    stdout: wrappedStdout,
    stderr: wrappedStderr,
    spawn(
      cmd: string,
      args: string[],
      opts: SpawnOpts = {},
    ): Promise<SpawnResult> {
      const callerOnChunk = opts.onChunk;
      const onChunk = (chunk: Buffer, source: "stdout" | "stderr"): void => {
        emitChunk(source, chunk);
        callerOnChunk?.(chunk, source);
      };
      return io.spawn(cmd, args, { ...opts, onChunk });
    },
  };

  return wrapped;
}

function computeConcurrency(plan: Plan, ctx: PlanContext): number {
  // An explicit cap (CLI / NOPO_CONCURRENCY, surfaced via ctx.maxConcurrency) wins over
  // auto-detection and may exceed the detected budget. With no explicit cap, fall back
  const base = ctx.maxConcurrency ?? autoConcurrency();
  const candidates: number[] = [base];
  if (plan.maxConcurrency !== undefined) candidates.push(plan.maxConcurrency);
  const min = Math.min(...candidates);
  // Floor at 1 — a 0 or negative cap would deadlock the worker loop.
  return Math.max(1, min);
}

function normalizeError(raw: unknown): Error {
  if (raw instanceof Error) return raw;
  if (typeof raw === "string") return new Error(raw);
  if (typeof raw === "number" || typeof raw === "boolean") {
    return new Error(String(raw));
  }
  if (raw === null || raw === undefined) {
    return new Error(`Handler threw non-Error value: ${String(raw)}`);
  }
  try {
    return new Error(`Handler threw non-Error value: ${JSON.stringify(raw)}`);
  } catch {
    return new Error("Handler threw non-Error value (unserializable)");
  }
}
