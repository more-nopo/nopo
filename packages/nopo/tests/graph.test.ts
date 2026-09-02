import { describe, expect, it } from "vitest";

import type { NormalizedProjectConfig } from "../src/config/index.ts";
import { DependencyGraph, TargetNode } from "../src/graph.ts";

function makeProject(
  services: Record<
    string,
    {
      type?: "service" | "package";
      dependencies?: string[];
      buildDeps?: string[];
      runtimeDeps?: string[];
    }
  >,
): NormalizedProjectConfig {
  const entries: Record<string, unknown> = {};
  for (const [id, opts] of Object.entries(services)) {
    // Support legacy `dependencies` shorthand in tests: treat as runtimeDeps
    const buildDeps = opts.buildDeps ?? [];
    const runtimeDeps = opts.runtimeDeps ?? opts.dependencies ?? [];
    entries[id] = {
      id,
      name: id,
      description: "",
      staticPath: "",
      tags: [],
      type: opts.type ?? "service",
      build: undefined,
      runtime: opts.type === "package" ? undefined : { port: 3000 },
      configPath: `apps/${id}/nopo.yml`,
      image: undefined,
      buildDeps,
      runtimeDeps,
      commands: {},
      paths: { root: `apps/${id}`, context: "." },
    };
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test helper
  return {
    name: "test",
    configPath: "nopo.yml",
    os: {
      base: { from: "node:22" },
      dependencies: {},
      user: { uid: 1001, gid: 1001, home: "/home/test" },
    },
    services: {
      dirs: ["./apps"],
      entries,
      targets: Object.keys(entries).sort(),
    },
    rootName: "root",
    pluginRefs: [],
    plugins: [],
  } as unknown as NormalizedProjectConfig;
}

describe("DependencyGraph", () => {
  it("builds targets from project services", () => {
    const project = makeProject({ a: {}, b: {} });
    const graph = new DependencyGraph(project);

    expect(graph.targets.size).toBe(2);
    expect(graph.get("a")).toBeInstanceOf(TargetNode);
    expect(graph.get("b")).toBeInstanceOf(TargetNode);
    expect(graph.get("nonexistent")).toBeUndefined();
  });

  it("returns empty order for empty graph", () => {
    const project = makeProject({});
    const graph = new DependencyGraph(project);
    expect(graph.order()).toEqual([]);
  });

  it("returns single node", () => {
    const project = makeProject({ a: {} });
    const graph = new DependencyGraph(project);
    expect(graph.order()).toEqual(["a"]);
  });

  it("sorts by dependencies (dep first)", () => {
    const project = makeProject({
      web: { dependencies: ["backend"] },
      backend: { dependencies: ["db"] },
      db: {},
    });
    const graph = new DependencyGraph(project);
    const order = graph.order();

    expect(order.indexOf("db")).toBeLessThan(order.indexOf("backend"));
    expect(order.indexOf("backend")).toBeLessThan(order.indexOf("web"));
  });

  it("detects circular dependencies", () => {
    const project = makeProject({
      a: { dependencies: ["b"] },
      b: { dependencies: ["a"] },
    });
    const graph = new DependencyGraph(project);
    expect(() => graph.order()).toThrow("Circular dependency");
  });

  it("silently ignores dependencies on unknown targets", () => {
    const project = makeProject({
      a: { dependencies: ["nonexistent"] },
    });
    const graph = new DependencyGraph(project);
    expect(graph.order()).toEqual(["a"]);
  });

  it("returns deterministic order for independent nodes", () => {
    const project = makeProject({ c: {}, a: {}, b: {} });
    const graph = new DependencyGraph(project);
    expect(graph.order()).toEqual(["a", "b", "c"]);
  });

  it("filters services vs packages", () => {
    const project = makeProject({
      api: { type: "service" },
      ui: { type: "package" },
      lib: { type: "package" },
    });
    const graph = new DependencyGraph(project);

    expect(graph.services().map((n) => n.id)).toEqual(["api"]);
    expect(
      graph
        .packages()
        .map((n) => n.id)
        .sort(),
    ).toEqual(["lib", "ui"]);
  });

  it("handles diamond dependencies correctly", () => {
    // A → B, A → C, B → D, C → D (D is shared dependency)
    const project = makeProject({
      a: { dependencies: ["b", "c"] },
      b: { dependencies: ["d"] },
      c: { dependencies: ["d"] },
      d: {},
    });
    const graph = new DependencyGraph(project);
    const order = graph.order();

    // D must come before both B and C, which must come before A
    expect(order.indexOf("d")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("d")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("a"));
    // All four targets present exactly once
    expect(order).toHaveLength(4);
  });

  it("supports mutable metadata on target nodes", () => {
    const project = makeProject({ a: {} });
    const graph = new DependencyGraph(project);
    const node = graph.get("a")!;

    expect(node.metadata.size).toBe(0);
    node.metadata.set("dockerfile", "FROM node:22");
    expect(node.metadata.get("dockerfile")).toBe("FROM node:22");
  });
});
