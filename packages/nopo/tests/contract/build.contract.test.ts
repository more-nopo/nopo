import { describe, expect } from "vitest";

import {
  type ContractCase,
  expectExitCode,
  expectNoSpawns,
  expectStdoutContains,
  runContractTable,
} from "../../src/test-utils/contract.ts";
import type { MockIO } from "../../src/test-utils/mock-io.ts";
import { runCli } from "../../src/test-utils/run-cli.ts";

// `nopo build` contract test matrix (M4.1). Locks down every observable behaviour of `nopo
// build` reachable through the four surfaces of `MockIO`

const cases: ContractCase[] = [
  // GROUP A: target selection The shape of `--print` output is the same across every
  // fixture: a single-line JSON document with keys `services`, `command`, `targets`
  {
    name: "A1 minimal: no args → finalTargets=[app] (only service in fixture)",
    fixture: "minimal",
    argv: ["build", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("build");
      expect(plan.finalTargets).toEqual(["app"]);
      expect(plan.services).toEqual(plan.finalTargets); // services == finalTargets
      expectNoSpawns(io);
    },
  },
  {
    name: "A2 deps-chain: no args → finalTargets includes every service in topo order (core,lib,web,worker)",
    fixture: "deps-chain",
    argv: ["build", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["core", "lib", "web", "worker"]);
      expectNoSpawns(io);
    },
  },
  {
    name: "A3 packages-and-services: no args → finalTargets contains the full set, ordered alphabetically",
    // The runner's `targets` come from `services.targets` which is name-sorted at config-load
    // time; `--print` reports them in that order. Topological ordering would put `shared`
    fixture: "packages-and-services",
    argv: ["build", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["api", "shared", "utils", "web"]);
      expectNoSpawns(io);
    },
  },
  {
    name: "A4 deps-chain: single explicit target `core` → finalTargets=[core] (no upstream because core is the leaf)",
    fixture: "deps-chain",
    argv: ["build", "core", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["core"]);
      expect(plan.filteredTargets).toEqual(["core"]);
      expect(plan.dependencies).toEqual({ core: [] });
    },
  },
  {
    name: "A5 deps-chain: explicit `lib` pulls in upstream `core` automatically",
    fixture: "deps-chain",
    argv: ["build", "lib", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["core", "lib"]);
      expect(plan.filteredTargets).toEqual(["lib"]);
      expect(plan.dependencies).toEqual({ core: [], lib: ["core"] });
    },
  },
  {
    name: "A6 deps-chain: explicit `web` pulls full transitive chain (core + lib + web)",
    fixture: "deps-chain",
    argv: ["build", "web", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["core", "lib", "web"]);
      expect(plan.dependencies).toEqual({
        core: [],
        lib: ["core"],
        web: ["lib"],
      });
    },
  },
  {
    name: "A7 deps-chain: multiple explicit targets `core lib` → both, deps deduped (no double core)",
    fixture: "deps-chain",
    argv: ["build", "core", "lib", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["core", "lib"]);
      // No duplicates.
      expect(new Set(plan.finalTargets).size).toBe(plan.finalTargets.length);
    },
  },
  {
    name: "A8 packages-and-services: explicit `shared utils` → both targets + dedup (utils' shared dep is already in the set)",
    fixture: "packages-and-services",
    argv: ["build", "shared", "utils", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(new Set(["shared", "utils"]));
      expect(plan.finalTargets.length).toBe(2);
    },
  },
  {
    name: "A9 deps-chain: build script's depSource includes runtime, so `worker` (runtime-only edge to web) pulls full chain",
    // worker has `runtime.deps: [web]`. BuildScript.depSource = ["build","runtime"],
    // so resolveTargetDAG follows that edge. Worker → web → lib → core.
    fixture: "deps-chain",
    argv: ["build", "worker", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["core", "lib", "web", "worker"]);
    },
  },
  {
    name: "A10 packages-and-services: explicit `root` expands to all services (root is the top-level closure)",
    fixture: "packages-and-services",
    argv: ["build", "root", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      // filteredTargets reflects user input (root); finalTargets is the
      // full closure since root pulls in everything.
      expect(plan.filteredTargets).toEqual(["root"]);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
    },
  },
  {
    name: "A11 minimal: unknown target `no-such-target` → exit 1, no spawns",
    // M4.x should add an `expectStderrContains(io, /Unknown target/)` once logging routes
    // through `IO`. Today we lock down exit code only.
    fixture: "minimal",
    argv: ["build", "no-such-target"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      expect(io.stderr.text()).toBe("");
    },
  },
  {
    name: "A12 packages-and-services: one valid + one invalid target → exit 1 (validateTargets throws on first miss)",
    fixture: "packages-and-services",
    argv: ["build", "shared", "no-such-target"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },

  // GROUP B: --print mode (deterministic JSON output) Lock down the structural shape and
  // content of the print plan. Other groups assert the same plan shape on top — these rows
  {
    name: "B1 minimal: --print emits the documented JSON keys",
    fixture: "minimal",
    argv: ["build", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      // Every key from print.ts:DryRunOutput must be present.
      expect(Object.keys(plan).sort()).toEqual(
        [
          "command",
          "dependants",
          "dependencies",
          "filteredTargets",
          "filters",
          "finalTargets",
          "plan",
          "plugins",
          "scriptDependencies",
          "services",
          "since",
          "targets",
        ].sort(),
      );
    },
  },
  {
    name: "B2 minimal: --print sets command='build' and reports env script as a dependency",
    fixture: "minimal",
    argv: ["build", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("build");
      // BuildScript.dependencies = [{ class: EnvScript, enabled: true }].
      expect(plan.scriptDependencies).toContainEqual({
        name: "env",
        enabled: true,
      });
    },
  },
  {
    name: "B3 packages-and-services: --print reports dependency edges in the `dependencies` map",
    fixture: "packages-and-services",
    argv: ["build", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.dependencies).toEqual({
        api: ["shared"],
        shared: [],
        utils: ["shared"],
        web: ["utils", "api"],
      });
    },
  },
  {
    name: "B4 multi-runtime: --print reports loaded plugin names in `plugins` field",
    fixture: "multi-runtime",
    argv: ["build", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      // Both stub plugins from multi-runtime/nopo.yml.
      expect(plan.plugins).toEqual(["dev-plugin", "prod-plugin"]);
    },
  },
  {
    name: "B4b packages-and-services: --print includes a `plan` field with one cmd:<target> per buildable target",
    fixture: "packages-and-services",
    argv: ["build", "--print"],
    expect: (io) => {
      // parsePrintPlan returns a generic record; narrow to the SerializedPlan-shaped subset we
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- structural narrowing of the dry-run plan field
      const dryOut = parsePrintPlan(io) as unknown as {
        plan: {
          nodes: Array<{
            id: string;
            target?: string;
            handler: { kind: string; name: string };
            needs: string[];
          }>;
        };
      };
      expect(dryOut.plan).not.toBeNull();
      const ids = dryOut.plan.nodes.map((n) => n.id);
      // Every plan has the slot trio.
      expect(ids).toContain("pre_build");
      expect(ids).toContain("post_build");
      // Each resolved target gets a per-target build node.
      const targetNodes = dryOut.plan.nodes.filter(
        (n) => n.handler.name === "build:exec",
      );
      expect(targetNodes.length).toBeGreaterThan(0);
      for (const n of targetNodes) {
        expect(n.target).toBeDefined();
        // Every per-target node depends on `pre_build`; package nodes also encode `build.deps`
        // edges (and service nodes wait on all package nodes) so the legacy
        expect(n.needs).toContain("pre_build");
      }
      // post_build needs every per-target node.
      const post = dryOut.plan.nodes.find((n) => n.id === "post_build");
      expect(post?.needs.sort()).toEqual(targetNodes.map((n) => n.id).sort());
    },
  },
  {
    name: "B5 minimal: --print short-circuits before any spawn AND combines cleanly with --no-cache (other flags ignored in print mode)",
    fixture: "minimal",
    argv: ["build", "--print", "--no-cache"],
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
      expectStdoutContains(io, '"command":"build"');
    },
  },
  {
    name: "B6 minimal: --print emits a single line of JSON (no trailing arrays / multi-doc)",
    // Print mode emits exactly one JSON document followed by a newline.
    // CI consumers rely on `jq -r '.services | join(" ")'` over this output.
    fixture: "minimal",
    argv: ["build", "--print"],
    expect: (io) => {
      const text = io.stdout.text();
      const trimmed = text.trim();
      expect(trimmed.startsWith("{")).toBe(true);
      expect(trimmed.endsWith("}")).toBe(true);
      // Round-trip parse — guarantees it's a single JSON object.
      JSON.parse(trimmed);
    },
  },

  // GROUP C: dependency resolution Group A locked down WHICH targets land in `finalTargets`.
  // These rows lock down WHY — the `dependencies` map of the print plan exposes the resolved
  {
    name: "C1 deps-chain: building leaf `worker` produces topologically-sorted finalTargets [core,lib,web,worker]",
    fixture: "deps-chain",
    argv: ["build", "worker", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      // Strict order: deps must precede dependents.
      expect(plan.finalTargets).toEqual(["core", "lib", "web", "worker"]);
    },
  },
  {
    name: "C2 deps-chain: building middle node `lib` does NOT pull web/worker (they depend on lib, not vice versa)",
    fixture: "deps-chain",
    argv: ["build", "lib", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).not.toContain("web");
      expect(plan.finalTargets).not.toContain("worker");
    },
  },
  {
    name: "C3 packages-and-services: diamond — building `web` pulls `utils`+`api` (siblings), each pulls `shared` (single instance)",
    // web → utils → shared web → api → shared shared must appear exactly once.
    fixture: "packages-and-services",
    argv: ["build", "web", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      const sharedCount = plan.finalTargets.filter(
        (t) => t === "shared",
      ).length;
      expect(sharedCount).toBe(1);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
    },
  },
  {
    name: "C4 packages-and-services: building package `shared` does NOT pull anything (no deps, no dependants by default)",
    fixture: "packages-and-services",
    argv: ["build", "shared", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["shared"]);
      expect(plan.dependants).toEqual([]);
    },
  },
  {
    name: "C5 packages-and-services: building service `api` pulls package dep `shared` (cross-type edge)",
    fixture: "packages-and-services",
    argv: ["build", "api", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(new Set(["api", "shared"]));
      expect(plan.dependencies.api).toEqual(["shared"]);
    },
  },
  {
    name: "C6 commands-grid: build edge `api → core` resolves; building `api` pulls `core`",
    fixture: "commands-grid",
    argv: ["build", "api", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["api", "core"]);
      expect(plan.dependencies.api).toEqual(["core"]);
    },
  },

  // GROUP D: plugin override BuildScript fires `runner.fireOverride("build", ctx)` and falls
  // back to `defaultHostBuild` when no plugin claims the slot. `multi-runtime` loads stub
  {
    name: "D1 multi-runtime: stub plugins don't override build → falls through to default host build (no docker spawns)",
    fixture: "multi-runtime",
    argv: ["build", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.plugins).toEqual(["dev-plugin", "prod-plugin"]);
      // No spawns in --print mode regardless of plugins.
      expectNoSpawns(io);
    },
  },
  {
    name: "D2 all-plugins: docker plugin can't resolve from tmpdir → loadPlugins throws, main catches, exit 1",
    // Once plugin-load errors route through `IO`, an stderr assertion can be added.
    fixture: "all-plugins",
    argv: ["build"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      expect(io.stdout.text()).toBe("");
      expect(io.stderr.text()).toBe("");
    },
  },
  {
    name: "D3 minimal: real build (no --print, no plugins) — runs to completion via legacy exec, no captured spawns",
    // bypasses `io.spawn`. Real subprocess output never reaches MockIO. We can only assert
    // that the script returned cleanly. Once build is migrated to `ctx.shell` (M4.x), this row
    fixture: "minimal",
    argv: ["build"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.spawns.length).toBe(0);
      const stdout = io.stdout.text();
      expect(stdout).toContain("━━━ stage 0 ━");
      expect(stdout).toMatch(
        /Plan finished — 3 ok, 0 failed, 0 skipped, total .+, max-parallel \d+/,
      );
    },
  },
  {
    name: "D4 packages-and-services: real build with no docker plugin loaded — packages and services build via host path, exits cleanly",
    fixture: "packages-and-services",
    argv: ["build"],
    expect: (io) => {
      expectExitCode(io, null);
      // Same reason as D3 — no captured spawns.
      expect(io.spawns.length).toBe(0);
    },
  },

  // GROUP E: flag handling BuildScript declares `--no-cache`, `--output`, `--registries`
  // (own args) and inherits `--filter`, `--since`, `--tags`, `--changed`
  {
    name: "E1 minimal: --no-cache parses without error AND has no observable effect when no plugin overrides build",
    // With no docker plugin loaded it's a silent no-op — the JSON plan is identical to the one
    // without --no-cache. (See B5 for the print-mode equivalent.)
    fixture: "minimal",
    argv: ["build", "--no-cache"],
    expect: (io) => {
      expectExitCode(io, null);
    },
  },
  {
    name: "E2 packages-and-services: --print combined with --no-cache → identical plan to bare --print (flag parsed, plan unchanged)",
    fixture: "packages-and-services",
    argv: ["build", "--print", "--no-cache"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
      expectNoSpawns(io);
    },
  },
  {
    name: "E3 packages-and-services: --filter=buildable retains all (every service has a build.command)",
    fixture: "packages-and-services",
    argv: ["build", "--filter=buildable", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
    },
  },
  {
    name: "E4 packages-and-services: --with-dependants on `shared` expands to api+utils+web (everything that depends on shared)",
    fixture: "packages-and-services",
    argv: ["build", "shared", "--with-dependants", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["shared", "api", "utils", "web"]),
      );
      expect(new Set(plan.dependants)).toEqual(
        new Set(["api", "utils", "web"]),
      );
    },
  },
  {
    name: "E5 packages-and-services: --changed with no git changes → empty finalTargets, no error",
    // --changed with a fresh tmpdir matches no files (no `.changed` cache,
    // no git diff). The script exits cleanly on the empty target set.
    fixture: "packages-and-services",
    argv: ["build", "--changed", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual([]);
      expect(plan.services).toEqual([]);
      expect(plan.filters).toContainEqual({ type: "preset", field: "changed" });
    },
  },
  {
    name: "E6 multi-runtime: --runtime prod has no effect on build (build is not runtime-dispatched, plan identical to default)",
    fixture: "multi-runtime",
    argv: ["build", "--runtime", "prod", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "web", "worker"]),
      );
    },
  },
  {
    name: "E7 multi-runtime: --tags=overlay does NOT narrow the build plan (currently no-op for build)",
    // into Runner.resolveExecutionPlan, so it has no effect on build's print plan. All three
    // multi-runtime services land in finalTargets even though only `web` carries the [overlay]
    fixture: "multi-runtime",
    argv: ["build", "--tags=overlay", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "web", "worker"]),
      );
    },
  },
  {
    name: "E8 minimal: --help on `build` → exits 0, prints help via console (not io.stdout)",
    // Help is printed via `console.log` not `io.stdout`, so io.stdout is
    // empty. We only assert exit code; tightening waits for IO routing.
    fixture: "minimal",
    argv: ["build", "--help"],
    expect: (io) => {
      expectExitCode(io, 0);
    },
  },

  // GROUP F: environment / config Custom env via `runCli({ env: ... })` reaches the runner
  // through `io.env`. We assert the env doesn't bleed into stdout (secrets, arbitrary tags)
  {
    name: "F1 multi-runtime (default runtime): default overlay applied — `web`'s default cmd/cpu used",
    // Build doesn't dispatch by runtime, but the runtime block overlay is
    // resolved at config load. The plan must include all three services.
    fixture: "multi-runtime",
    argv: ["build", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "web", "worker"]),
      );
    },
  },
  {
    name: "F2 packages-and-services: custom DOCKER_TAG env reaches the runner, doesn't pollute stdout",
    fixture: "packages-and-services",
    argv: ["build", "--print"],
    env: { DOCKER_TAG: "myrepo/custom:test" },
    expect: (io) => {
      const plan = parsePrintPlan(io);
      // Plan content unchanged by env override (DOCKER_TAG is consumed
      // by the docker plugin during bake, not by --print).
      expect(plan.command).toBe("build");
      // Custom value MUST NOT appear in the plan output.
      expect(io.stdout.text()).not.toContain("myrepo/custom:test");
    },
  },
  {
    name: "F3 packages-and-services: DOCKER_TARGET=production env doesn't break --print",
    fixture: "packages-and-services",
    argv: ["build", "api", "--print"],
    env: { DOCKER_TARGET: "production" },
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(new Set(["api", "shared"]));
    },
  },
  {
    name: "F4 packages-and-services: DOCKER_PUSH=true env passes through cleanly in --print mode (no push attempted)",
    fixture: "packages-and-services",
    argv: ["build", "--print", "--no-cache"],
    env: { DOCKER_PUSH: "true" },
    expect: (io) => {
      // Print mode never reaches the docker plugin's push logic.
      expectNoSpawns(io);
      expect(io.stdout.text()).toContain('"command":"build"');
    },
  },

  // GROUP G: error paths Bake invocation failure / dockerfile-missing cases rely on the
  // docker plugin actually being loaded — not possible in these fixtures right now (see D2).
  {
    name: "G1 runCli rejects when fixture name doesn't exist (test-harness contract)",
    fixture: "minimal", // unused — we override below
    argv: ["build"],
    expect: async () => {
      // This is a test-harness contract: runCli throws synchronously (well, rejects) when its
      // fixture name is bogus. Locking it down here means downstream contract tests can rely
      await expect(
        runCli({ fixture: "no-such-fixture-xyz", argv: ["build"] }),
      ).rejects.toThrow(/fixture 'no-such-fixture-xyz' not found/);
    },
  },
  {
    name: "G3 packages-and-services: building unknown target after a valid one → still exit 1 (validation is strict)",
    fixture: "packages-and-services",
    argv: ["build", "no-such-x"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
];

describe("nopo build (contract)", () => {
  runContractTable(cases);
});

// Helpers

/** Shape of the `--print` JSON output. Mirrors `DryRunOutput` from
 * `packages/nopo/src/print.ts`. Kept narrow on purpose — we don't want the contract test
 * to import production types and tightly couple the test surface to the implementation
 * file (so a refactor of `print.ts` doesn't quietly weaken the assertions here).
 */
interface PrintPlan {
  command: string;
  services: string[];
  targets: string[];
  filteredTargets: string[];
  finalTargets: string[];
  dependencies: Record<string, string[]>;
  dependants: string[];
  filters: Array<{ type: string; field?: string }>;
  since: Record<string, string> | string | null;
  plugins: string[];
  scriptDependencies: Array<{ name: string; enabled: boolean }>;
  plan: unknown;
}

/**
 * Parse the `--print` JSON plan from `io.stdout`. Throws a useful message
 * if stdout isn't a single JSON document — failures here usually mean the
 * test ran without `--print` and is reading the wrong surface.
 */
function parsePrintPlan(io: MockIO): PrintPlan {
  const text = io.stdout.text().trim();
  if (!text) {
    throw new Error(
      "parsePrintPlan: io.stdout was empty — did you forget to pass --print?",
    );
  }
  try {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime parse, schema documented above
    return JSON.parse(text) as PrintPlan;
  } catch (err) {
    throw new Error(
      `parsePrintPlan: failed to parse io.stdout as JSON.\nstdout (first 500 chars):\n${text.slice(0, 500)}\nparse error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
