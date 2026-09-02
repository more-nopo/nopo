/** Colon-only subcommand addressing, against the REAL repo config. Two rules are pinned
 * here: (1) A subcommand is reachable ONLY through colon syntax. The old bare-name
 * fallback (`nopo makemigrations af-api` finding af-api's nested `db:makemigrations`) is
 * GONE — one spelling per subcommand. Whole-repo fan-out already matched top-level keys
 */
import { describe, expect, it } from "vitest";

import {
  CommandSelectorError,
  parseCommandSelector,
} from "../../src/commands/index.ts";
import { Logger, Runner } from "../../src/lib.ts";
import { Environment } from "../../src/parse-env.ts";
import { buildScopeForScript } from "../../src/scope.ts";
import { ScriptArgs } from "../../src/script-args.ts";
import CommandScript, {
  type CommandPlanScope,
} from "../../src/scripts/command.ts";
import { createTestConfig, HAS_PRODUCT_GRAPH } from "../utils.ts";

/** A `Runner` over the REAL repo config (`createTestConfig()` roots at PROJECT_ROOT) with
 * its execution plan resolved — i.e. the production pipeline `Runner.resolveExecutionPlan`
 * → step 5 `CommandScript.targetFilter`.
 */
function resolvedRunner(argv: string[]): Runner {
  const config = createTestConfig();
  const runner = new Runner(
    config,
    new Environment(config),
    argv,
    new Logger(config),
  );
  runner.resolveExecutionPlan(CommandScript);
  return runner;
}

/** Sorted service ids `nopo <argv>` would dispatch to. */
function dispatchTargets(argv: string[]): string[] {
  return [...resolvedRunner(argv).resolveExecutionPlan(CommandScript)].sort();
}

/** The `service:command` tasks `nopo <argv>` would actually EXECUTE, read straight off the
 * production plan scope (`buildScopeForScript`). This is the payload half of the
 * regression — a target set alone wouldn't reveal that `talos` was about to run
 * `longhorn:smoketest` — and going through the real scope builder keeps the test
 */
function dispatchTasks(argv: string[]): string[] {
  const runner = resolvedRunner(argv);
  const raw = buildScopeForScript(
    runner,
    CommandScript,
    new ScriptArgs({}, runner),
  );
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- buildScopeForScript returns `unknown`; CommandScript's scope shape is CommandPlanScope by construction (scope.ts matches on `name === ""`)
  const scope = raw as CommandPlanScope | null;
  if (scope === null) return [];
  return scope.stages
    .flatMap((stage) => stage.tasks)
    .map((task) => `${task.service}:${task.command}`)
    .sort();
}

describe.skipIf(!HAS_PRODUCT_GRAPH)(
  "whole-repo fan-out matches TOP-LEVEL keys only (real config)",
  () => {
  it("`nopo smoketest` does not recruit talos's nested longhorn:smoketest", () => {
    // `infrastructure/talos/nopo.yml` declares `longhorn: { commands: { smoketest: ... } }`
    // with `context: host`; it kubectl-applies a 1Gi Longhorn PVC and an alpine writer pod
    expect(dispatchTargets(["smoketest"])).toEqual(["root"]);
    expect(dispatchTasks(["smoketest"])).toEqual(["root:smoketest"]);
  });

  it("`nopo migrate` does not recruit af-api's nested db:migrate", () => {
    // The highest-consequence of the four: `db:migrate` runs real database migrations.
    // AGENTS.md documents the targeted form (`nopo migrate backend`), so a bare `nopo migrate`
    expect(dispatchTargets(["migrate"])).toEqual(["backend"]);
    expect(dispatchTasks(["migrate"])).toEqual([
      "backend:migrate:check",
      "backend:migrate:run",
    ]);
  });

  it("`nopo run` dispatches nothing rather than backend's migrate:run", () => {
    // `run` is declared top-level by no service. Pre-fix the leaf fallback silently promoted
    // `backend`'s `migrate:run` (`manage.py migrate`), turning a documented no-op
    expect(dispatchTargets(["run"])).toEqual([]);
    expect(dispatchTasks(["run"])).toEqual([]);
  });

  it("`nopo plan` dispatches only the terraform services", () => {
    // stripe-tf / cloudflare-tf declare `plan` top-level — those are
    // intended. talos nests `upgrade: { commands: { plan: ... } }`.
    expect(dispatchTargets(["plan"])).toEqual(["cloudflare-tf", "stripe-tf"]);
    expect(dispatchTasks(["plan"])).toEqual([
      "cloudflare-tf:plan",
      "stripe-tf:plan",
    ]);
  });
});

describe.skipIf(!HAS_PRODUCT_GRAPH)(
  "the bare-name nested-leaf fallback is GONE",
  () => {
  it("`nopo makemigrations af-api` no longer reaches db:makemigrations", () => {
    // Was the whole point of #9451. Now colon-or-nothing: af-api does not
    // declare `makemigrations` at the top level, so it is not a target.
    expect(dispatchTargets(["makemigrations", "af-api"])).not.toContain(
      "af-api",
    );
    expect(dispatchTasks(["makemigrations", "af-api"])).toEqual([]);
  });

  it("`nopo db:makemigrations af-api` is the replacement spelling", () => {
    expect(dispatchTasks(["db:makemigrations", "af-api"])).toEqual([
      "af-api:db:makemigrations",
    ]);
  });

  it("`nopo smoketest talos` no longer reaches longhorn:smoketest", () => {
    expect(dispatchTasks(["smoketest", "talos"])).toEqual([]);
  });

  it("`nopo longhorn:smoketest talos` still can, explicitly", () => {
    expect(dispatchTasks(["longhorn:smoketest", "talos"])).toEqual([
      "talos:longhorn:smoketest",
    ]);
  });
});

describe.skipIf(!HAS_PRODUCT_GRAPH)(
  "colon selectors (asymmetric include / exclude)",
  () => {
  // af-api's `test` declares cross-service dependencies, so a bare `test` also runs each
  // dependency's own `test`. Those appear below wherever the selector still reaches them.
  const DEPS = [
    "db:test",
    "jaeger:test",
    "litellm:test",
    "otel-collector:test",
    "victoria-logs:test",
  ];

  it("bare `test` runs every leaf of the group", () => {
    expect(dispatchTasks(["test", "af-api"])).toEqual(
      [
        "af-api:test:admin",
        "af-api:test:integration",
        "af-api:test:unit",
        ...DEPS,
      ].sort(),
    );
  });

  it("an include picks one leaf — and drops the deps that lack it", () => {
    // The dependency services declare a plain `test`, never `test:unit`.
    // An include is a whitelist, so they are skipped rather than erroring.
    expect(dispatchTasks(["test:unit", "af-api"])).toEqual([
      "af-api:test:unit",
    ]);
  });

  it("an exclude subtracts from the group and KEEPS plain-leaf services", () => {
    // The property the CI split rests on: one invocation covers both shapes. The deps have
    // nothing named `integration` to remove, so "everything except integration" is still their
    expect(dispatchTasks(["test:-integration", "af-api"])).toEqual(
      ["af-api:test:admin", "af-api:test:unit", ...DEPS].sort(),
    );
  });

  it("include + exclude compose, excludes winning", () => {
    expect(dispatchTasks(["test:unit,admin,-admin", "af-api"])).toEqual([
      "af-api:test:unit",
    ]);
  });

  it("an INCLUDE skips a named service whose command is a plain leaf", () => {
    expect(dispatchTasks(["test:integration", "db", "af-api"])).toEqual([
      "af-api:test:integration",
    ]);
  });

  it("an EXCLUDE keeps that same plain leaf", () => {
    expect(dispatchTasks(["test:-integration", "db", "af-api"])).toEqual(
      ["af-api:test:admin", "af-api:test:unit", ...DEPS].sort(),
    );
  });
});

describe.skipIf(!HAS_PRODUCT_GRAPH)("selector grammar", () => {
  it("rejects a comma-list outside the final segment", () => {
    expect(() => parseCommandSelector("test:unit,admin:slow")).toThrow(
      CommandSelectorError,
    );
  });

  it("treats a mid-name dash as part of the name, not a negation", () => {
    // `root` declares `test:eslint-plugin`.
    expect(parseCommandSelector("test:eslint-plugin")).toMatchObject({
      root: "test",
      path: ["eslint-plugin"],
      hasList: false,
    });
    expect(dispatchTasks(["test:eslint-plugin", "root"])).toEqual([
      "root:test:eslint-plugin",
    ]);
  });

  it("parses a nested path with a trailing list", () => {
    expect(parseCommandSelector("test:unit:slow,-fast")).toEqual({
      root: "test",
      path: ["unit"],
      include: ["slow"],
      exclude: ["fast"],
      hasList: true,
    });
  });
});

describe.skipIf(!HAS_PRODUCT_GRAPH)(
  "whitespace no longer selects a subcommand",
  () => {
  /** `parseCommandArgs` owns explicit-target validation. */
  function parse(argv: string[]): void {
    const config = createTestConfig();
    const runner = new Runner(
      config,
      new Environment(config),
      argv,
      new Logger(config),
    );
    CommandScript.parseCommandArgs(runner);
  }

  it("`nopo test integration af-api` treats `integration` as a target", () => {
    expect(() => parse(["test", "integration", "af-api"])).toThrow(
      /Unknown target/,
    );
  });

  it("`nopo test mcp root` (the old CI spelling) is likewise a target error", () => {
    expect(() => parse(["test", "mcp", "root"])).toThrow(/Unknown target/);
  });

  it("`nopo test:mcp root` is the replacement", () => {
    expect(dispatchTasks(["test:mcp", "root"])).toEqual(["root:test:mcp"]);
  });
});
