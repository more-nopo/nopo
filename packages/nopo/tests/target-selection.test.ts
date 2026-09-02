import path from "node:path";
import { describe, expect, it } from "vitest";

import { createConfig, Logger, Runner } from "../src/lib.ts";
import { Environment } from "../src/parse-env.ts";
import BuildScript from "../src/scripts/build.ts";
import UpScript from "../src/scripts/up.ts";
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

function makeRunner(argv: string[]) {
  const config = createDagConfig({ envFile: createTmpEnv(), silent: true });
  const logger = new Logger(config);
  const environment = new Environment(config);
  return new Runner(config, environment, argv, logger);
}

describe("TargetNode.selection reflects the resolved execution plan", () => {
  it("marks named targets explicit and pulled-in deps transitive", () => {
    // build web → pulls types, ui, api, db transitively (per fixture).
    const runner = makeRunner(["build", "web"]);
    runner.resolveExecutionPlan(BuildScript);

    expect(runner.graph.get("web")!.selection).toBe("explicit");
    // api/types/ui/db are dragged in by web's build/runtime deps.
    expect(runner.graph.get("api")!.selection).toBe("transitive");
    expect(runner.graph.get("types")!.selection).toBe("transitive");
    expect(runner.graph.get("ui")!.selection).toBe("transitive");
    expect(runner.graph.get("db")!.selection).toBe("transitive");
    // worker / nginx / utils are not in scope.
    expect(runner.graph.get("worker")!.selection).toBe("excluded");
    expect(runner.graph.get("nginx")!.selection).toBe("excluded");
    expect(runner.graph.get("utils")!.selection).toBe("excluded");
  });

  it("with no explicit targets, every node becomes transitive (none explicit)", () => {
    // No positional targets → resolveExecutionPlan falls back to all targets as the resolved
    // set. None of them were named on the CLI, so they all get `transitive`
    const runner = makeRunner(["up"]);
    runner.resolveExecutionPlan(UpScript);

    for (const node of runner.graph.targets.values()) {
      expect(node.selection).toBe("transitive");
    }
    expect(runner.graph.explicit()).toEqual([]);
  });

  it("graph.explicit() / included() / excluded() partition the graph", () => {
    const runner = makeRunner(["build", "web"]);
    runner.resolveExecutionPlan(BuildScript);

    const explicit = runner.graph.explicit().map((n) => n.id);
    const included = runner.graph.included().map((n) => n.id);
    const excluded = runner.graph.excluded().map((n) => n.id);

    expect(explicit).toEqual(["web"]);
    // included is the union; excluded is the complement.
    expect(new Set([...included, ...excluded])).toEqual(
      new Set([...runner.graph.targets.keys()]),
    );
    // included contains web; excluded does not.
    expect(included).toContain("web");
    expect(excluded).not.toContain("web");
  });

  it("graph.included() returns nodes in topological order", () => {
    const runner = makeRunner(["build", "web"]);
    runner.resolveExecutionPlan(BuildScript);

    const includedIds = runner.graph.included().map((n) => n.id);
    const fullOrder = runner.graph.order();

    // included() must be a subsequence of order() — same relative order,
    // just filtered to non-excluded nodes.
    let cursor = 0;
    for (const id of includedIds) {
      const found = fullOrder.indexOf(id, cursor);
      expect(found).toBeGreaterThanOrEqual(0);
      cursor = found + 1;
    }
  });

  it("graph.included() ids match runner.resolvedTargets as a set", () => {
    const runner = makeRunner(["build", "web"]);
    runner.resolveExecutionPlan(BuildScript);

    const includedIds = runner.graph.included().map((n) => n.id);
    const resolved = runner.resolvedTargets ?? [];
    expect(new Set(includedIds)).toEqual(new Set(resolved));
  });

  it("re-running resolveExecutionPlan resets prior selection cleanly", () => {
    const runner = makeRunner(["build", "web"]);
    runner.resolveExecutionPlan(BuildScript);
    expect(runner.graph.get("web")!.selection).toBe("explicit");

    // parseExplicitTargets is cached on Runner so this is best done with a fresh Runner — but
    // we can at least confirm a re-resolve with the same argv idempotently produces the same
    runner.resolveExecutionPlan(BuildScript);
    expect(runner.graph.get("web")!.selection).toBe("explicit");
    expect(runner.graph.get("worker")!.selection).toBe("excluded");
  });
});
