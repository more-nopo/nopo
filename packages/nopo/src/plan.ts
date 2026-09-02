/**
 * Pure data model for the plan-then-execute DAG. No execution, no IO,
 * no plugin imports — Plans are trivial to merge, snapshot, and JSON
 * round-trip.
 */

/** Where to dispatch a {@link PlanNode}. */
export type PlanHandler =
  | { kind: "plugin-hook"; plugin: string; hook: string; payload?: unknown }
  | { kind: "builtin"; name: string; payload?: unknown };

/** A unit of work in a {@link Plan}. */
export interface PlanNode {
  id: string;
  handler: PlanHandler;
  /** IDs that must succeed before this node runs. */
  needs: readonly string[];
  /** Service id, for renderers/events. Ignored at dispatch. */
  target?: string;
  /** Merged with handler.payload at dispatch. */
  payload?: unknown;
  /** Renderer/debugging hints. Ignored at dispatch. */
  meta?: Readonly<Record<string, unknown>>;
}

/** Insertion order is preserved across {@link mergePlans} + serialization. */
export interface Plan {
  nodes: ReadonlyMap<string, PlanNode>;
  /** Runner takes `min(this, cli flag, availableParallelism())`. */
  maxConcurrency?: number;
}

/** Thrown by {@link mergePlans} on incompatible duplicate node ids. */
export class PlanMergeError extends Error {
  public readonly conflictingId: string;

  constructor(message: string, conflictingId: string) {
    super(message);
    this.name = "PlanMergeError";
    this.conflictingId = conflictingId;
  }
}

/** JSON-serializable form of a {@link Plan}. */
export interface SerializedPlan {
  nodes: Array<{
    id: string;
    handler: PlanHandler;
    needs: string[];
    target?: string;
    payload?: unknown;
    meta?: Record<string, unknown>;
  }>;
  maxConcurrency?: number;
}

/**
 * Round-trip safe via JSON.stringify/parse. Strips `undefined` fields so
 * snapshots stay minimal.
 */
export function serializePlan(plan: Plan): SerializedPlan {
  const nodes: SerializedPlan["nodes"] = [];
  for (const node of plan.nodes.values()) {
    const out: SerializedPlan["nodes"][number] = {
      id: node.id,
      handler: cloneHandler(node.handler),
      needs: [...node.needs],
    };
    if (node.target !== undefined) out.target = node.target;
    if (node.payload !== undefined) out.payload = clonePlain(node.payload);
    if (node.meta !== undefined) out.meta = { ...node.meta };
    nodes.push(out);
  }
  const result: SerializedPlan = { nodes };
  if (plan.maxConcurrency !== undefined) {
    result.maxConcurrency = plan.maxConcurrency;
  }
  return result;
}

/** Inverse of {@link serializePlan}. Preserves insertion order. */
export function deserializePlan(serialized: SerializedPlan): Plan {
  const nodes = new Map<string, PlanNode>();
  for (const raw of serialized.nodes) {
    const node: PlanNode = {
      id: raw.id,
      handler: cloneHandler(raw.handler),
      needs: [...raw.needs],
    };
    if (raw.target !== undefined) node.target = raw.target;
    if (raw.payload !== undefined) node.payload = clonePlain(raw.payload);
    if (raw.meta !== undefined) node.meta = { ...raw.meta };
    nodes.set(node.id, node);
  }
  const plan: Plan = { nodes };
  if (serialized.maxConcurrency !== undefined) {
    plan.maxConcurrency = serialized.maxConcurrency;
  }
  return plan;
}

/** Structurally-identical duplicates dedup silently; conflicting duplicates throw {@link
 * PlanMergeError}. `maxConcurrency` is the `min` of all defined values. Single-plan input
 * is cloned so the result can be safely mutated.
 */
export function mergePlans(plans: readonly Plan[]): Plan {
  if (plans.length === 0) {
    return { nodes: new Map() };
  }

  const merged = new Map<string, PlanNode>();
  let maxConcurrency: number | undefined;

  for (const plan of plans) {
    for (const node of plan.nodes.values()) {
      const existing = merged.get(node.id);
      if (existing === undefined) {
        merged.set(node.id, cloneNode(node));
        continue;
      }
      const diff = diffNodes(existing, node);
      if (diff.length > 0) {
        throw new PlanMergeError(
          `Cannot merge plans: node "${node.id}" conflicts on ${diff.join(", ")}`,
          node.id,
        );
      }
      // structurally identical — silent de-dup, keep first occurrence
    }
    if (plan.maxConcurrency !== undefined) {
      maxConcurrency =
        maxConcurrency === undefined
          ? plan.maxConcurrency
          : Math.min(maxConcurrency, plan.maxConcurrency);
    }
  }

  const result: Plan = { nodes: merged };
  if (maxConcurrency !== undefined) result.maxConcurrency = maxConcurrency;
  return result;
}

/**
 * Convenience constructor for a {@link Plan} from a node array. Throws
 * if two nodes share the same id (use {@link mergePlans} if you want
 * dedup semantics).
 */
export function planFromNodes(
  nodes: readonly PlanNode[],
  opts: { maxConcurrency?: number } = {},
): Plan {
  const map = new Map<string, PlanNode>();
  for (const node of nodes) {
    if (map.has(node.id)) {
      throw new PlanMergeError(
        `Duplicate node id "${node.id}" in planFromNodes input`,
        node.id,
      );
    }
    map.set(node.id, cloneNode(node));
  }
  const plan: Plan = { nodes: map };
  if (opts.maxConcurrency !== undefined)
    plan.maxConcurrency = opts.maxConcurrency;
  return plan;
}

/**
 * Asserts every `needs` id resolves and the graph is acyclic. Throws
 * on first failure with a descriptive message.
 */
export function validatePlan(plan: Plan): void {
  for (const node of plan.nodes.values()) {
    for (const dep of node.needs) {
      if (!plan.nodes.has(dep)) {
        throw new Error(`Plan node "${node.id}" needs unknown node "${dep}"`);
      }
    }
  }
  // Kahn's algorithm for cycle detection. Build forward adjacency
  // (dep -> dependent) so we can decrement indegree in O(1) per edge.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of plan.nodes.keys()) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const node of plan.nodes.values()) {
    for (const dep of node.needs) {
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      dependents.get(dep)!.push(node.id);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (visited !== plan.nodes.size) {
    throw new Error("Plan contains a cycle in `needs`");
  }
}

/**
 * Return the nodes with no prerequisites (`needs.length === 0`),
 * preserving plan insertion order. These are the entry points the
 * runner can dispatch first.
 */
export function getRoots(plan: Plan): readonly PlanNode[] {
  const roots: PlanNode[] = [];
  for (const node of plan.nodes.values()) {
    if (node.needs.length === 0) roots.push(node);
  }
  return roots;
}

// internal helpers

function cloneHandler(handler: PlanHandler): PlanHandler {
  if (handler.kind === "plugin-hook") {
    const out: PlanHandler = {
      kind: "plugin-hook",
      plugin: handler.plugin,
      hook: handler.hook,
    };
    if (handler.payload !== undefined)
      out.payload = clonePlain(handler.payload);
    return out;
  }
  const out: PlanHandler = { kind: "builtin", name: handler.name };
  if (handler.payload !== undefined) out.payload = clonePlain(handler.payload);
  return out;
}

function cloneNode(node: PlanNode): PlanNode {
  const out: PlanNode = {
    id: node.id,
    handler: cloneHandler(node.handler),
    needs: [...node.needs],
  };
  if (node.target !== undefined) out.target = node.target;
  if (node.payload !== undefined) out.payload = clonePlain(node.payload);
  if (node.meta !== undefined) out.meta = { ...node.meta };
  return out;
}

/** Plan payloads / meta are required to be JSON-safe (the whole module exists to be
 * serializable), so this is sufficient and avoids pulling in a structuredClone dep that
 * has surprising behavior with class instances.
 */
function clonePlain<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  // JSON-safe round-trip; payloads / meta are required to be JSON-safe.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- generic clone preserves runtime shape
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Compare two nodes by all structurally-significant fields and return a
 * list of field names that differ. Empty list means the nodes are
 * compatible duplicates.
 */
function diffNodes(a: PlanNode, b: PlanNode): string[] {
  const diff: string[] = [];
  if (!handlersEqual(a.handler, b.handler)) diff.push("handler");
  if (!sameNeedsSet(a.needs, b.needs)) diff.push("needs");
  if (a.target !== b.target) diff.push("target");
  if (!deepEqual(a.payload, b.payload)) diff.push("payload");
  if (!deepEqual(a.meta, b.meta)) diff.push("meta");
  return diff;
}

function handlersEqual(a: PlanHandler, b: PlanHandler): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "plugin-hook" && b.kind === "plugin-hook") {
    return (
      a.plugin === b.plugin &&
      a.hook === b.hook &&
      deepEqual(a.payload, b.payload)
    );
  }
  if (a.kind === "builtin" && b.kind === "builtin") {
    return a.name === b.name && deepEqual(a.payload, b.payload);
  }
  return false;
}

function sameNeedsSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  for (const id of b) if (!seen.has(id)) return false;
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  // arrays
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  // Both are non-null objects and not arrays — treat as plain records.
  if (!isRecord(a) || !isRecord(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
