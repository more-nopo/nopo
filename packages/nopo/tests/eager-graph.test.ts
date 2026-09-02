import path from "node:path";
import { describe, expect, it } from "vitest";

import { createConfig, Logger, Runner } from "../src/lib.ts";
import { Environment } from "../src/parse-env.ts";
import { createTmpEnv, FIXTURES_ROOT } from "./utils.ts";

const DAG_FIXTURES_ROOT = path.resolve(FIXTURES_ROOT, "test-dag");

function createDagConfig(
  options: Omit<Parameters<typeof createConfig>[0], "rootDir"> = {},
) {
  return createConfig({
    rootDir: DAG_FIXTURES_ROOT,
    processEnv: {},
    ...options,
  });
}

function makeRunner(argv: string[] = []) {
  const config = createDagConfig({ envFile: createTmpEnv(), silent: true });
  const logger = new Logger(config);
  const environment = new Environment(config);
  return new Runner(config, environment, argv, logger);
}

describe("Runner constructs the dependency graph eagerly", () => {
  it("exposes runner.graph populated with every project target", () => {
    const runner = makeRunner();
    // test-dag has 5 services + 3 packages = 8 targets
    expect(runner.graph).toBeDefined();
    expect(runner.graph.targets.size).toBe(8);
    // All nodes start excluded — selection only flips after
    // resolveExecutionPlan runs.
    for (const node of runner.graph.targets.values()) {
      expect(node.selection).toBe("excluded");
    }
  });

  it("returns the same instance from buildGraph() across calls", () => {
    const runner = makeRunner();
    const a = runner.buildGraph();
    const b = runner.buildGraph();
    expect(a).toBe(b);
    expect(a).toBe(runner.graph);
  });

  it("preserves metadata mutations across buildGraph() calls", () => {
    const runner = makeRunner();
    runner.buildGraph().get("api")!.metadata.set("dockerfile", "FROM node");
    expect(runner.buildGraph().get("api")!.metadata.get("dockerfile")).toBe(
      "FROM node",
    );
  });
});

describe("Runner constructor fails fast on cycles", () => {
  it("throws a 'Circular dependency' error when project graph cycles", () => {
    // Hand-build a project with a 2-node cycle a → b → a. The constructor
    // calls graph.order(), which throws via Kahn's algorithm.
    const services = {
      a: {
        id: "a",
        name: "a",
        description: "",
        staticPath: "",
        tags: [],
        type: "service",
        build: undefined,
        runtime: { port: 1 },
        configPath: "apps/a/nopo.yml",
        image: undefined,
        buildDeps: [],
        runtimeDeps: ["b"],
        commands: {},
        paths: { root: "apps/a", context: "." },
      },
      b: {
        id: "b",
        name: "b",
        description: "",
        staticPath: "",
        tags: [],
        type: "service",
        build: undefined,
        runtime: { port: 1 },
        configPath: "apps/b/nopo.yml",
        image: undefined,
        buildDeps: [],
        runtimeDeps: ["a"],
        commands: {},
        paths: { root: "apps/b", context: "." },
      },
    };

    const project = {
      name: "cyclic",
      configPath: "nopo.yml",
      os: {
        base: { from: "node:22" },
        dependencies: {},
        user: { uid: 1001, gid: 1001, home: "/home/test" },
      },
      services: {
        dirs: ["./apps"],
        entries: services,
        targets: ["a", "b"],
      },
      rootName: "root",
      pluginRefs: [],
      plugins: [],
      packageManagers: {},
    };

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal config stub
    const config = {
      root: "/tmp/cyclic",
      envFile: "/tmp/cyclic/.env",
      processEnv: {},
      silent: true,
      targets: ["a", "b"],
      project,
    } as unknown as ReturnType<typeof createConfig>;

    const logger = new Logger(config);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- environment stub not exercised before constructor throws
    const environment = {} as Environment;

    expect(() => new Runner(config, environment, [], logger)).toThrow(
      /Circular dependency/,
    );
  });
});
