import type {
  NormalizedProjectConfig,
  NormalizedService,
} from "./config/index.ts";

/** Set by Runner.resolveExecutionPlan() after target filtering. Plugins read this off the
 * graph to know what's in scope without going through string arrays on the Runner.
 * `explicit` — named on the CLI by the user (matches parseExplicitTargets) `transitive` —
 * pulled in via deps / preFilter / --with-* expansion `excluded` — present in the project
 */
type TargetSelection = "explicit" | "transitive" | "excluded";

/**
 * A node in the dependency graph representing a single target (service or package).
 * Plugins can attach arbitrary state to `metadata` — like compiler passes
 * annotating AST nodes.
 */
export class TargetNode {
  readonly id: string;
  readonly service: NormalizedService;
  /** All dependencies (union of buildDeps and runtimeDeps) */
  readonly dependencies: string[];
  readonly metadata: Map<string, unknown>;
  /**
   * Execution intent for this run. Defaults to `"excluded"` and is mutated
   * by Runner.resolveExecutionPlan() once targets have been resolved.
   */
  selection: TargetSelection;

  constructor(service: NormalizedService) {
    this.id = service.id;
    this.service = service;
    this.dependencies = [
      ...new Set([...service.buildDeps, ...service.runtimeDeps]),
    ];
    this.metadata = new Map();
    this.selection = "excluded";
  }
}

/** This is the central data structure passed to all plugin hooks. Think of it like a
 * compiler IR — plugins receive the full graph, can read service configs, filter targets,
 * and mutate metadata.
 */
export class DependencyGraph {
  readonly targets: Map<string, TargetNode>;

  constructor(project: NormalizedProjectConfig) {
    this.targets = new Map();

    for (const [id, service] of Object.entries(project.services.entries)) {
      this.targets.set(id, new TargetNode(service));
    }
  }

  /**
   * Returns target IDs in topological order (dependencies first).
   * Uses Kahn's algorithm for deterministic ordering.
   */
  order(): string[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    // Initialize
    for (const [id] of this.targets) {
      inDegree.set(id, 0);
      adjacency.set(id, []);
    }

    // Build edges: if A depends on B, B -> A
    for (const [id, node] of this.targets) {
      for (const dep of node.dependencies) {
        if (this.targets.has(dep)) {
          adjacency.get(dep)!.push(id);
          inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
        }
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }
    // Sort initial queue for deterministic output
    queue.sort();

    const result: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      const neighbors = adjacency.get(current) ?? [];
      const nextBatch: string[] = [];
      for (const neighbor of neighbors) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          nextBatch.push(neighbor);
        }
      }
      // Sort for deterministic output
      nextBatch.sort();
      queue.push(...nextBatch);
    }

    if (result.length !== this.targets.size) {
      const missing = [...this.targets.keys()].filter(
        (id) => !result.includes(id),
      );
      throw new Error(
        `Circular dependency detected involving: ${missing.join(", ")}`,
      );
    }

    return result;
  }

  /** Get all targets with type === "service" (have runtime config) */
  services(): TargetNode[] {
    return [...this.targets.values()].filter(
      (node) => node.service.type === "service",
    );
  }

  /** Get all targets with type === "package" (build-only, no runtime) */
  packages(): TargetNode[] {
    return [...this.targets.values()].filter(
      (node) => node.service.type === "package",
    );
  }

  /** Get a specific target by ID */
  get(id: string): TargetNode | undefined {
    return this.targets.get(id);
  }

  /**
   * Targets the user named explicitly on the CLI (selection === "explicit").
   * Order matches insertion order of the underlying targets map.
   */
  explicit(): TargetNode[] {
    return [...this.targets.values()].filter(
      (node) => node.selection === "explicit",
    );
  }

  /**
   * Targets in scope for this run — explicit + transitive (i.e. anything not
   * excluded). Returned in topological order so plugins can iterate in build
   * order without re-sorting.
   */
  included(): TargetNode[] {
    const order = this.order();
    const result: TargetNode[] = [];
    for (const id of order) {
      const node = this.targets.get(id);
      if (node && node.selection !== "excluded") {
        result.push(node);
      }
    }
    return result;
  }

  /**
   * Targets present in the project but not in scope this run
   * (selection === "excluded"). Insertion order.
   */
  excluded(): TargetNode[] {
    return [...this.targets.values()].filter(
      (node) => node.selection === "excluded",
    );
  }
}
