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

// `nopo env` contract test matrix (M4.6). Locks down every observable behaviour of `nopo
// env` reachable through the four surfaces of `MockIO`

const cases: ContractCase[] = [
  // GROUP A: service selection / target shaping env declares no positional schema of its
  // own, but the runner still applies target validation upstream. These rows lock down what
  {
    name: "A1 minimal: bare `nopo env` exits cleanly with no captured stdout/stderr/spawns (.env writes go via fs, not io)",
    fixture: "minimal",
    argv: ["env"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.stdout.text()).toBe("");
      // Diff banner goes through `runner.logger.log` → console.log, NOT io.
      expect(io.stderr.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "A2 minimal: `nopo env --print` emits the resolved plan to io.stdout (single-service fixture)",
    fixture: "minimal",
    argv: ["env", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("env");
      expect(plan.finalTargets).toEqual(["app"]);
      expect(plan.services).toEqual(plan.finalTargets);
      expectNoSpawns(io);
    },
  },
  {
    name: "A3 deps-chain: bare `nopo env` is a project-level operation (one .env at the root) — exits null even with multiple services",
    // env doesn't iterate per-service; one env file at the project root. The runner's resolved
    // plan can list every service, but the script itself doesn't care.
    fixture: "deps-chain",
    argv: ["env"],
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
    },
  },
  {
    name: "A4 deps-chain: `nopo env --print` reports every service in finalTargets (no positional → resolveExecutionPlan picks all)",
    fixture: "deps-chain",
    argv: ["env", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["core", "lib", "web", "worker"]);
      expect(plan.dependencies).toEqual({
        core: [],
        lib: ["core"],
        web: ["lib"],
        worker: ["web"],
      });
    },
  },
  {
    name: "A5 packages-and-services: positional `shared` filters finalTargets to just the named service (services[] also narrows)",
    // `finalTargets` and `services` both narrow to ["shared"]; `targets`/`filteredTargets`
    // keep the full project closure.
    fixture: "packages-and-services",
    argv: ["env", "shared", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["shared"]);
      expect(plan.services).toEqual(["shared"]);
      expect(plan.targets).toEqual(["api", "shared", "utils", "web"]);
    },
  },
  {
    name: "A6 minimal: positional `app` (valid target) → exits cleanly, no spawns (env ignores positional in fn())",
    fixture: "minimal",
    argv: ["env", "app"],
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
    },
  },
  {
    name: "A7 minimal: unknown positional `no-such-service` does NOT error (env's empty ScriptArgs skips target validation)",
    // validateTargets), `nopo env no-such-service` exits null. EnvScript declares an empty
    // ScriptArgs schema (`new ScriptArgs({})`) which does NOT include the target-args schema
    fixture: "minimal",
    argv: ["env", "no-such-service"],
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
    },
  },

  // GROUP B: --print plan shape (deterministic JSON contract) Lock down the structural shape
  // of the plan doc. Other groups assert values; these rows are the schema contract for env
  {
    name: "B1 minimal: --print emits the documented JSON keys (matches build/up plan shape)",
    fixture: "minimal",
    argv: ["env", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
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
    name: "B2 minimal: --print sets command='env' AND scriptDependencies=[] (env has no upstream scripts)",
    // EnvScript.dependencies = [] (default). Unlike BuildScript / UpScript
    // which depend on env, env itself has no script-deps.
    fixture: "minimal",
    argv: ["env", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("env");
      expect(plan.scriptDependencies).toEqual([]);
    },
  },
  {
    name: "B3 minimal: --print emits exactly one JSON document terminated with `\\n` (CI consumers rely on `jq` over a single line)",
    fixture: "minimal",
    argv: ["env", "--print"],
    expect: (io) => {
      const text = io.stdout.text();
      expect(text.endsWith("\n")).toBe(true);
      const trimmed = text.trim();
      expect(trimmed.startsWith("{")).toBe(true);
      expect(trimmed.endsWith("}")).toBe(true);
      // Round-trip parse — guarantees it's a single JSON object.
      JSON.parse(trimmed);
      // Exactly one newline at the end (no double newlines, no multi-doc).
      expect(text.split("\n").length).toBe(2);
    },
  },
  {
    name: "B4 multi-runtime: --print reports loaded stub plugin names in `plugins` field",
    fixture: "multi-runtime",
    argv: ["env", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.plugins).toEqual(["dev-plugin", "prod-plugin"]);
      expectNoSpawns(io);
    },
  },
  {
    name: "B5 packages-and-services: --print reports dependency edges in `dependencies` map",
    // env's depSource is the default ["build", "runtime"], so it sees the same dep graph build
    // does. The `dependencies` map matches the build contract's B3 row exactly.
    fixture: "packages-and-services",
    argv: ["env", "--print"],
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
    name: "B6 minimal: --print short-circuits before save() — combining with an unknown flag still produces the plan, no .env spawn or write",
    // print intercepts upstream of script execution; bogus extra flags are ignored (minimist's
    // permissive parsing) and don't change the plan output.
    fixture: "minimal",
    argv: ["env", "--print", "--unknown-flag"],
    expect: (io) => {
      expectStdoutContains(io, '"command":"env"');
      expectNoSpawns(io);
    },
  },

  // GROUP C: env-var precedence / docker-tag resolution env's primary purpose is
  // materializing DOCKER_TAG (and its components) into the .env file. We can't observe
  {
    name: "C1 minimal: explicit DOCKER_TAG override via env → exits cleanly, no stdout pollution from secrets/tag values",
    fixture: "minimal",
    argv: ["env"],
    env: { DOCKER_TAG: "myrepo/custom:test" },
    expect: (io) => {
      expectExitCode(io, null);
      // io.stdout / io.stderr remain empty (logger goes to console.log).
      expect(io.stdout.text()).toBe("");
      // The override value MUST NOT appear in either captured surface
      // (defense against accidental routing-through-io regressions).
      expect(io.stdout.text()).not.toContain("myrepo/custom:test");
      expect(io.stderr.text()).not.toContain("myrepo/custom:test");
      expectNoSpawns(io);
    },
  },
  {
    name: "C2 minimal: explicit DOCKER_PORT override → exits cleanly (port goes into .env, not stdout)",
    fixture: "minimal",
    argv: ["env"],
    env: { DOCKER_PORT: "9999" },
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.stdout.text()).not.toContain("9999");
      expectNoSpawns(io);
    },
  },
  {
    name: "C3 minimal: NODE_ENV=production + DOCKER_VERSION=v1.0.0 → exits cleanly (Environment corrects target/env to production for non-local versions)",
    // Verifies that the Environment's NODE_ENV correction logic doesn't throw at the
    // env-script integration layer. Underlying behaviour is covered
    fixture: "minimal",
    argv: ["env"],
    env: { NODE_ENV: "production", DOCKER_VERSION: "v1.0.0" },
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
    },
  },
  {
    name: "C4 packages-and-services: --print is unaffected by env overrides (DOCKER_TAG consumed by save(), not by --print plan resolution)",
    fixture: "packages-and-services",
    argv: ["env", "--print"],
    env: { DOCKER_TAG: "registry/img:v1" },
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("env");
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
      // DOCKER_TAG is consumed at save() time; --print exits upstream so
      // the override never touches stdout.
      expect(io.stdout.text()).not.toContain("registry/img:v1");
    },
  },

  // GROUP D: secret handling env materializes secrets into the .env file. The `with-secrets`
  // fixture exercises this. With-secrets specific cases are intentionally absent from this

  // GROUP E: flag handling EnvScript declares no own args, but inherits --print, --runtime,
  // and the rest of baseArgs through the runner. These rows lock down that the inherited
  {
    name: "E1 multi-runtime: --runtime prod has no observable effect on env (env is not runtime-dispatched, plan identical to default)",
    fixture: "multi-runtime",
    argv: ["env", "--runtime", "prod", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "web", "worker"]),
      );
      expect(plan.command).toBe("env");
    },
  },
  {
    name: "E2 packages-and-services: --filter=buildable is a no-op for env (every service is buildable AND env has no preFilters of its own)",
    // env's preFilters = [] so --filter=buildable doesn't subtract.
    fixture: "packages-and-services",
    argv: ["env", "--filter=buildable", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
    },
  },
  {
    name: "E3 packages-and-services: --changed with no git changes → plan KEEPS all services (env doesn't auto-empty like build does)",
    // `nopo env changed` emits ALL services because env has no preFilter. The `--changed`
    // filter IS recorded in `filters[]` but doesn't subtract services that have no recorded
    fixture: "packages-and-services",
    argv: ["env", "--changed", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      // No preFilter on env → --changed alone doesn't subtract anything.
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
    },
  },
  {
    name: "E4 minimal: --help on `env` → exit 0, help printed via console (not io.stdout, see Note 2)",
    fixture: "minimal",
    argv: ["env", "--help"],
    expect: (io) => {
      expectExitCode(io, 0);
      // Help routing currently uses console.log; io.stdout stays empty.
      expect(io.stdout.text()).toBe("");
    },
  },

  // GROUP F: error paths env has limited error surface — its fn() is mostly pure computation
  // and a single fs.writeFileSync. Most failure modes live upstream (plugin loading)
  {
    name: "F1 all-plugins: docker plugin can't resolve from tmpdir → loadPlugins throws BEFORE env runs, exit 1, no spawns",
    // Same plugin-load failure as build's D2. The error is logged via
    // `console.error` (not io.stderr) so we lock down exit code only.
    fixture: "all-plugins",
    argv: ["env"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      expect(io.stdout.text()).toBe("");
      expect(io.stderr.text()).toBe("");
    },
  },
  {
    name: "F2 all-plugins: --print also fails — plugin load runs BEFORE --print interception",
    // So --print does NOT bypass plugin failures. Locks down the order-of-operations contract.
    fixture: "all-plugins",
    argv: ["env", "--print"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      expect(io.stdout.text()).toBe("");
    },
  },
  {
    name: "F3 runCli rejects when fixture name doesn't exist (test-harness contract)",
    fixture: "minimal", // unused — overridden below
    argv: ["env"],
    expect: async () => {
      // Test-harness contract — same shape as build G1.
      await expect(
        runCli({ fixture: "no-such-fixture-xyz", argv: ["env"] }),
      ).rejects.toThrow(/fixture 'no-such-fixture-xyz' not found/);
    },
  },
];

describe("nopo env (contract)", () => {
  runContractTable(cases);
});

// Helpers

/** Shape of the `--print` JSON output. Mirrors `DryRunOutput` from
 * `packages/nopo/src/print.ts`. Kept narrow on purpose — same convention as
 * `build.contract.test.ts`. A schema change in `print.ts` SHOULD trip these tests; that's
 * the whole point of a contract suite.
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
