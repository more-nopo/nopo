/** THE BUG: `nopo makemigrations af-api` exited 0 having run nothing. af-api declares the
 * command nested under a `db:` parent (`db:makemigrations`), but
 * `CommandScript.targetFilter` only matched TOP-LEVEL command keys, so af-api was dropped
 * from the resolved target set. The only guard was
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertCommandDispatches,
  buildExecutionPlan,
  type CommandDispatchCheck,
  listCommandPaths,
  resolveServiceCommandPath,
} from "../../src/commands/index.ts";
import {
  loadProjectConfig,
  type NormalizedProjectConfig,
} from "../../src/config/index.ts";
import main from "../../src/index.ts";
import { MockExitError, mockIO } from "../../src/test-utils/mock-io.ts";

// Throwaway project mirroring the real shape that triggered the bug: `afapi` nests
// makemigrations under `db:` (af-api) `backend` declares it top-level (Django backend)
const ROOT_CONFIG = `
name: empty-dispatch-fixture

services:
  dirs:
    - ./services
`;

const SERVICES: Record<string, string> = {
  afapi: `
name: afapi
build:
  command: echo "build afapi"
commands:
  db:
    commands:
      migrate: echo "AFAPI_MIGRATE"
      makemigrations: echo "AFAPI_MAKEMIGRATIONS"
  check:
    commands:
      lint: echo "AFAPI_CHECK_LINT"
  fix:
    commands:
      lint: echo "AFAPI_FIX_LINT"
`,
  backend: `
name: backend
build:
  command: echo "build backend"
commands:
  makemigrations: echo "BACKEND_MAKEMIGRATIONS"
`,
  web: `
name: web
build:
  command: echo "build web"
commands:
  test: echo "WEB_TEST"
`,
};

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
  tmpDirs.length = 0;
});

/** Materialize the fixture above into a fresh tmpdir; returns its root. */
function createProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-empty-dispatch-"));
  tmpDirs.push(root);

  fs.writeFileSync(path.join(root, "nopo.yml"), ROOT_CONFIG, "utf-8");
  for (const [service, config] of Object.entries(SERVICES)) {
    const dir = path.join(root, "services", service);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "nopo.yml"), config, "utf-8");
  }
  return root;
}

function loadFixtureProject(): NormalizedProjectConfig {
  return loadProjectConfig(createProjectRoot());
}

/** The service entry or a loud failure — keeps the tests free of `?.`. */
function serviceOf(project: NormalizedProjectConfig, id: string) {
  const service = project.services.entries[id];
  if (!service) throw new Error(`fixture is missing service '${id}'`);
  return service;
}

// LAYER A — resolution + guard, driven directly.
describe("resolveServiceCommandPath", () => {
  it("resolves a top-level command to itself", () => {
    const project = loadFixtureProject();
    expect(
      resolveServiceCommandPath(serviceOf(project, "backend"), "makemigrations")
        .path,
    ).toBe("makemigrations");
  });

  it("NEVER leaf-matches a bare name — colon addressing is the only way", () => {
    const project = loadFixtureProject();
    // `makemigrations` is reachable only at `db:makemigrations` on this service. It used to
    // resolve via a bare-name fallback; that fallback is gone, so the bare form no longer
    const { path: resolved, candidates } = resolveServiceCommandPath(
      serviceOf(project, "afapi"),
      "makemigrations",
    );
    expect(resolved).toBeNull();
    expect(candidates).toEqual([]);
  });

  it("passes an explicit colon path straight through", () => {
    const project = loadFixtureProject();
    expect(
      resolveServiceCommandPath(
        serviceOf(project, "afapi"),
        "db:makemigrations",
      ).path,
    ).toBe("db:makemigrations");
  });

  it("does not resolve a bare name that is nested more than once either", () => {
    // `lint` exists at check:lint AND fix:lint. There is no ambiguity to
    // arbitrate any more — a bare name simply never reaches a subcommand.
    const project = loadFixtureProject();
    const { path: resolved, candidates } = resolveServiceCommandPath(
      serviceOf(project, "afapi"),
      "lint",
    );
    expect(resolved).toBeNull();
    expect(candidates).toEqual([]);
  });

  it("returns null for a command the service genuinely lacks", () => {
    const project = loadFixtureProject();
    const { path: resolved, candidates } = resolveServiceCommandPath(
      serviceOf(project, "web"),
      "makemigrations",
    );
    expect(resolved).toBeNull();
    expect(candidates).toEqual([]);
  });

  it("never leaf-matches an explicit path that doesn't exist", () => {
    const project = loadFixtureProject();
    // The user said exactly where to look; `db:makemigrations` existing
    // must NOT make `nope:makemigrations` resolve.
    expect(
      resolveServiceCommandPath(
        serviceOf(project, "afapi"),
        "nope:makemigrations",
      ).path,
    ).toBeNull();
  });
});

describe("listCommandPaths", () => {
  it("emits parents alongside every nested path", () => {
    const project = loadFixtureProject();
    expect(listCommandPaths(serviceOf(project, "afapi"))).toEqual([
      "db",
      "db:migrate",
      "db:makemigrations",
      "check",
      "check:lint",
      "fix",
      "fix:lint",
    ]);
  });
});

describe("buildExecutionPlan via a resolved nested path", () => {
  it("produces a non-empty stage for a colon-addressed target (regression: was 0 stages)", () => {
    const project = loadFixtureProject();
    const resolved = resolveServiceCommandPath(
      serviceOf(project, "afapi"),
      "db:makemigrations",
    ).path;
    expect(resolved).not.toBeNull();

    const { stages } = buildExecutionPlan(project, resolved!, ["afapi"]);
    const tasks = stages.flat();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      service: "afapi",
      command: "db:makemigrations",
      executable: 'echo "AFAPI_MAKEMIGRATIONS"',
    });
  });

  it("fans one bare name across targets that resolve it differently", () => {
    // The mixed case: `makemigrations` is nested on afapi and top-level on backend. Both must
    // land in ONE plan, each with its own resolved path — this is why buildExecutionPlan takes
    const project = loadFixtureProject();
    const commandPaths = new Map([
      ["afapi", "db:makemigrations"],
      ["backend", "makemigrations"],
    ]);

    const { stages } = buildExecutionPlan(
      project,
      "makemigrations",
      ["afapi", "backend"],
      commandPaths,
    );
    const tasks = stages.flat();
    expect(
      tasks
        .map((t) => `${t.service}:${t.command}`)
        .sort((a, b) => (a < b ? -1 : 1)),
    ).toEqual(["afapi:db:makemigrations", "backend:makemigrations"]);
  });

  it("emits a dependency shared by differently-resolved targets exactly once", () => {
    // Regression guard for the merge strategy this refactor replaced: building one plan per
    // resolved path and concatenating them emitted the shared dep TWICE, and `planFromNodes`
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-shared-dep-"));
    tmpDirs.push(root);
    fs.writeFileSync(path.join(root, "nopo.yml"), ROOT_CONFIG, "utf-8");

    const write = (name: string, body: string) => {
      const dir = path.join(root, "services", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "nopo.yml"), body, "utf-8");
    };

    write(
      "core",
      `
name: core
build:
  command: echo "build core"
commands:
  prep: echo "CORE_PREP"
`,
    );
    // Both depend on the SAME core:prep, but resolve `gen` differently. Cross-service
    // `dependencies:` are only legal on a TOP-LEVEL command (sub-commands schema-forbid them)
    write(
      "nested",
      `
name: nested
build:
  command: echo "build nested"
commands:
  db:
    dependencies:
      core:
        - prep
    commands:
      gen: echo "NESTED_GEN"
`,
    );
    write(
      "flat",
      `
name: flat
build:
  command: echo "build flat"
commands:
  gen:
    command: echo "FLAT_GEN"
    dependencies:
      core:
        - prep
`,
    );

    const project = loadProjectConfig(root);
    const { stages } = buildExecutionPlan(
      project,
      "gen",
      ["nested", "flat"],
      new Map([
        ["nested", "db:gen"],
        ["flat", "gen"],
      ]),
    );

    const ids = stages.flat().map((t) => `${t.service}:${t.command}`);
    expect(ids.filter((id) => id === "core:prep")).toHaveLength(1);
    expect(new Set(ids)).toEqual(
      new Set(["core:prep", "nested:db:gen", "flat:gen"]),
    );
  });
});

describe("assertCommandDispatches", () => {
  const base = (project: NormalizedProjectConfig): CommandDispatchCheck => ({
    project,
    commandName: "makemigrations",
    explicitTargets: [],
    stageCount: 1,
    skipMissing: false,
    narrowed: false,
  });

  it("accepts a named target addressed with the colon path", () => {
    const project = loadFixtureProject();
    expect(() =>
      assertCommandDispatches({
        ...base(project),
        commandName: "db:makemigrations",
        explicitTargets: ["afapi"],
      }),
    ).not.toThrow();
  });

  it("points a bare nested name at its colon path instead of just failing", () => {
    // Dropping the fallback is only safe if the error teaches the replacement — otherwise
    // `nopo makemigrations af-api` becomes a dead end and people go back to running
    const project = loadFixtureProject();
    expect(() =>
      assertCommandDispatches({
        ...base(project),
        explicitTargets: ["afapi"],
        stageCount: 0,
      }),
    ).toThrow(
      /nested at db:makemigrations.*colon.*'nopo db:makemigrations afapi'/s,
    );
  });

  it("throws naming the target and the command it lacks", () => {
    const project = loadFixtureProject();
    expect(() =>
      assertCommandDispatches({
        ...base(project),
        explicitTargets: ["web"],
        stageCount: 0,
      }),
    ).toThrow(/Service 'web' does not define command 'makemigrations'/);
  });

  it("lists the available paths so the caller can self-correct", () => {
    const project = loadFixtureProject();
    expect(() =>
      assertCommandDispatches({
        ...base(project),
        commandName: "nope",
        explicitTargets: ["afapi"],
        stageCount: 0,
      }),
    ).toThrow(/Available commands: db, db:migrate, db:makemigrations/);
  });

  it("lists every nested path when a bare name matches more than one", () => {
    const project = loadFixtureProject();
    expect(() =>
      assertCommandDispatches({
        ...base(project),
        commandName: "lint",
        explicitTargets: ["afapi"],
        stageCount: 0,
      }),
    ).toThrow(/nested at check:lint, fix:lint/s);
  });

  it("throws on a zero-stage plan even with no explicit target", () => {
    const project = loadFixtureProject();
    expect(() =>
      assertCommandDispatches({
        ...base(project),
        commandName: "nope",
        stageCount: 0,
      }),
    ).toThrow(/resolved to 0 stages for any service/);
  });

  it("stands down for --skip-missing", () => {
    const project = loadFixtureProject();
    expect(() =>
      assertCommandDispatches({
        ...base(project),
        explicitTargets: ["web"],
        stageCount: 0,
        skipMissing: true,
      }),
    ).not.toThrow();
  });

  it("stands down when --filter/--changed narrowed the set to nothing", () => {
    // A narrowing predicate matching nothing is a legitimate no-op —
    // `nopo lint --changed` on a clean tree must not fail the build.
    const project = loadFixtureProject();
    expect(() =>
      assertCommandDispatches({
        ...base(project),
        stageCount: 0,
        narrowed: true,
      }),
    ).not.toThrow();
  });
});

// LAYER B — the real CLI, so the asserted exit codes are the user's.

/** Mirrors `src/test-utils/run-cli.ts`, but sources the project from this file's own tmpdir
 * instead of the shared `nopo/fixtures/contract` tree — the nested-command shape this
 * suite needs doesn't exist there.
 */
async function runCliInFixture(argv: string[]) {
  const io = mockIO({
    argv: ["bun", "nopo", ...argv],
    cwd: createProjectRoot(),
    env: {},
  });
  try {
    await main(io);
  } catch (err) {
    // `MockIO.exit()` throws to halt control flow the way `process.exit`
    // does; the code is already captured on `io.exitCode`.
    if (!(err instanceof MockExitError)) throw err;
  }
  return io;
}

describe("nopo <command> <target> (CLI)", () => {
  it("dispatches a named target whose command is nested (exit clean)", async () => {
    // The guard now rejects any zero-stage plan, so a clean exit here PROVES the dispatch was
    // non-empty.
    const io = await runCliInFixture(["db:makemigrations", "afapi"]);
    expect(io.exitCode).toBeNull();
  });

  it("keeps the named target in the resolved plan", async () => {
    const io = await runCliInFixture([
      "db:makemigrations",
      "afapi",
      "--print",
      "--json",
    ]);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime parse of the documented --print --json shape
    const plan = JSON.parse(io.stdout.text().trim()) as {
      services: string[];
      finalTargets: string[];
    };
    // Pre-fix both of these were `[]` — af-api was filtered out before
    // the plan was ever built.
    expect(plan.services).toEqual(["afapi"]);
    expect(plan.finalTargets).toEqual(["afapi"]);
  });

  it("fans a bare name to TOP-LEVEL implementors only", async () => {
    // `backend` declares makemigrations top-level, `afapi` nests it under `db:`. With no
    // positional target this must resolve backend ONLY. The predecessor of this row asserted
    const io = await runCliInFixture(["makemigrations", "--print", "--json"]);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime parse of the documented --print --json shape
    const plan = JSON.parse(io.stdout.text().trim()) as { services: string[] };
    expect(plan.services).toEqual(["backend"]);
  });

  it("exits NON-ZERO when a named target can't run the command", async () => {
    const io = await runCliInFixture(["makemigrations", "web"]);
    expect(io.exitCode).toBe(1);
    expect(io.spawns).toEqual([]);
  });

  it("exits NON-ZERO when a bare name only exists nested", async () => {
    const io = await runCliInFixture(["lint", "afapi"]);
    expect(io.exitCode).toBe(1);
  });

  it("names the nested colon paths rather than 'command not found'", async () => {
    // Asserting the exit code ALONE is what let the real defect through: `buildCommandScope`
    // fed ambiguous targets to `buildExecutionPlan`, which fell back to the raw user-typed
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const io = await runCliInFixture(["lint", "afapi"]);
      expect(io.exitCode).toBe(1);
      const output = spy.mock.calls.flat().join("\n");
      expect(output).toContain("nested at");
      expect(output).toContain("check:lint");
      expect(output).toContain("fix:lint");
      expect(output).toContain("colon");
      expect(output).not.toContain("not found in service");
    } finally {
      spy.mockRestore();
    }
  });

  it("exits NON-ZERO when no service implements the command at all", async () => {
    const io = await runCliInFixture(["totally-made-up"]);
    expect(io.exitCode).toBe(1);
  });

  it("still allows the silent no-op behind --skip-missing", async () => {
    const io = await runCliInFixture([
      "makemigrations",
      "web",
      "--skip-missing",
    ]);
    expect(io.exitCode).toBeNull();
  });
});
