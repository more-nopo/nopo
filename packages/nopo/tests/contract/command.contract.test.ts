import { describe, expect } from "vitest";

import {
  type ContractCase,
  expectExitCode,
  expectNoSpawns,
  expectStdoutContains,
  runContractTable,
} from "../../src/test-utils/contract.ts";
import type { MockIO } from "../../src/test-utils/mock-io.ts";

// M4.5 contract test matrix for `nopo <command>` (the user-defined commands declared in
// `nopo.yml`'s `commands:` section — e.g. `lint`, `format`, `test`, `test:integration`).

const cases: ContractCase[] = [
  // Command discovery `index.ts` short-circuits for `nopo` (no args) and `nopo --help` —
  // they print headers + a commands table via console.log (NOT io.stdout) and exit 0.
  {
    name: "A1 commands-grid: `nopo` (no args) → exit 0, prints help via console (not io.stdout)",
    fixture: "commands-grid",
    argv: [],
    expect: (io) => {
      expectExitCode(io, 0);
      // Help text is printed via console.log in index.ts (printNopoHeader + printCommandsTable +
      // printServiceCommandsTable). It does NOT go through io.stdout. M4.x can tighten once help
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "A2 commands-grid: `nopo --help` → exit 0, help via console",
    fixture: "commands-grid",
    argv: ["--help"],
    expect: (io) => {
      expectExitCode(io, 0);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "A3 minimal: `nopo no-such-command --print` does NOT error; plan is emitted with command=<typed>, services=[]",
    // CommandScript.targetFilter filters `app` out (it has no `no-such-command:` declared),
    // leaving the post-filter set empty. `services`/`finalTargets`=[]. Pinned so a future
    fixture: "minimal",
    argv: ["no-such-command", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("no-such-command");
      expect(plan.services).toEqual([]);
      expect(plan.finalTargets).toEqual([]);
      expect(plan.targets).toEqual(["app"]);
      expectNoSpawns(io);
    },
  },
  {
    name: "A4 commands-grid: `nopo no-such-command` → zero-stage dispatch is LOUD, exit 1, no spawns",
    // targetFilter drops every service (none declares `no-such-command:`), leaving a
    // zero-stage plan. This used to return cleanly (exit `null`) — a wrapper that silently
    fixture: "commands-grid",
    argv: ["no-such-command"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "A4b commands-grid: `nopo no-such-command --skip-missing` keeps the silent no-op, exit `null`",
    // `--skip-missing` is the documented opt-in for "drop targets that don't implement this
    // command" — it must still short-circuit cleanly so scripted callers can fan a command
    fixture: "commands-grid",
    argv: ["no-such-command", "--skip-missing"],
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
    },
  },
  {
    name: "A5 deps-chain: `nopo lint --print` (no service declares `lint:`) → services=[], finalTargets=[]",
    fixture: "deps-chain",
    argv: ["lint", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("lint");
      expect(plan.services).toEqual([]);
      expect(plan.finalTargets).toEqual([]);
      // `targets` reflects the pre-filter set (every service in the fixture); the targetFilter
      // drops them all because none declares `lint:`.
      expect(new Set(plan.targets)).toEqual(
        new Set(["core", "lib", "web", "worker"]),
      );
    },
  },

  // Per-command invocation commands-grid is the rich fixture. `lint` (declared on all 3),
  // `format` (api + core only), `test` (all 3), `test:integration` (api + web only).
  {
    name: "B1 commands-grid: `nopo lint --print` lists all 3 services",
    fixture: "commands-grid",
    argv: ["lint", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("lint");
      expect(new Set(plan.services)).toEqual(new Set(["api", "core", "web"]));
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "core", "web"]),
      );
    },
  },
  {
    name: "B2 commands-grid: `nopo format --print` lists only api+core (web has no format)",
    // Web doesn't declare `format:`, so the targetFilter drops it.
    fixture: "commands-grid",
    argv: ["format", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.services)).toEqual(new Set(["api", "core"]));
      expect(new Set(plan.finalTargets)).toEqual(new Set(["api", "core"]));
    },
  },
  {
    name: "B3 commands-grid: `nopo test --print` lists all 3 services",
    fixture: "commands-grid",
    argv: ["test", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.services)).toEqual(new Set(["api", "core", "web"]));
    },
  },
  {
    name: "B4 commands-grid: `nopo lint api --print` narrows to api + its build dep core (build script-dep follows DAG)",
    // (the script-level dep) uses depSource ["build","runtime"] and api declares `build.deps:
    // [core]`. Even though `core` declares `lint:`, it's pulled in here as a build-dep, not
    fixture: "commands-grid",
    argv: ["lint", "api", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      // services is the lint-applicable subset (per CommandScript.fn,
      // which filters resolvedTargets by serviceHasCommand)
      expect(plan.services).toEqual(["api", "core"]);
      // finalTargets is the dep-resolved set
      expect(new Set(plan.finalTargets)).toEqual(new Set(["api", "core"]));
    },
  },
  {
    name: "B5 commands-grid: `nopo lint core web --print` two explicit targets, both retained",
    fixture: "commands-grid",
    argv: ["lint", "core", "web", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.services)).toEqual(new Set(["core", "web"]));
      expect(new Set(plan.finalTargets)).toEqual(new Set(["core", "web"]));
    },
  },
  {
    name: "B6 commands-grid: `nopo format web` (web has no format) → exit 1, names the target",
    // `targetFilter` still drops `web` from the resolved set, but `assertCommandDispatches`
    // re-checks every EXPLICITLY-NAMED target against its own service config, so naming
    fixture: "commands-grid",
    argv: ["format", "web"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "B6b commands-grid: `nopo format web --skip-missing` → still a silent no-op, exit `null`",
    fixture: "commands-grid",
    argv: ["format", "web", "--skip-missing"],
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
    },
  },

  // Default-targets behavior (no positional) No-positional invocations rely on
  // CommandScript.targetFilter to produce the default set. These rows lock down
  {
    name: "C1 commands-grid: `nopo lint --print` (no positional) defaults to all 3 services",
    fixture: "commands-grid",
    argv: ["lint", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      // Same as B1 but explicitly asserts the default-target contract.
      expect(new Set(plan.services)).toEqual(new Set(["api", "core", "web"]));
    },
  },
  {
    name: "C2 commands-grid: `nopo format --print` (no positional) defaults to api+core only",
    fixture: "commands-grid",
    argv: ["format", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.services)).toEqual(new Set(["api", "core"]));
    },
  },

  // Nested commands (subcommands declared as `parent:child` keys, OR declared as actual
  // nested `commands:` blocks) commands-grid declares `test:integration:` on api + web
  {
    name: "D1 commands-grid: `nopo test:integration --print` lists api+web (core has no test:integration)",
    fixture: "commands-grid",
    argv: ["test:integration", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("test:integration");
      // `services` is still the ROOT-command pre-filter set — core declares `test:` so it
      // survives targetFilter. What changed is the PLAN: an include selector is a whitelist,
      expect(new Set(plan.services)).toEqual(new Set(["api", "core", "web"]));
    },
  },
  {
    name: "D2 commands-grid: `nopo test:integration web --print` narrows to web (+ its build chain)",
    // Because web declares `test:integration` with context: container, and the build dep
    // covers container readiness, the build script-dep gets enabled
    fixture: "commands-grid",
    argv: ["test:integration", "web", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.services).toEqual(["web"]);
      expect(plan.finalTargets).toEqual(["web"]);
      // The container-context command flips on the build script-dep.
      expect(plan.scriptDependencies).toContainEqual({
        name: "build",
        enabled: true,
      });
    },
  },
  {
    name: "D3 commands-grid: `nopo test integration --print` (whitespace, NOT colon) → exit 1, 'Unknown target' error",
    // in this fixture (the fixture uses `test:integration:` colon-key form, not nested
    // `commands:`), so `#isSubcommandName` returns false and `integration` falls through
    fixture: "commands-grid",
    argv: ["test", "integration", "--print"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "D4 commands-grid: `nopo test:integration core` (core has no test:integration, no --skip-missing) → exit 1",
    // 'test:integration' not found in service 'core'." Logged via runner.logger (console.log),
    // not io.stderr.
    fixture: "commands-grid",
    argv: ["test:integration", "core"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      expect(io.stderr.text()).toBe("");
    },
  },

  // `--print` mode contract surface Lock down the structural shape of the print plan and
  // short-circuit semantics. Mirrors the M4.1/M4.2/M4.4 print-mode rows.
  {
    name: "E1 commands-grid: `nopo lint --print` emits the documented JSON keys",
    fixture: "commands-grid",
    argv: ["lint", "--print"],
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
    name: "E2 commands-grid: `nopo lint --print` emits a single line of JSON",
    fixture: "commands-grid",
    argv: ["lint", "--print"],
    expect: (io) => {
      const text = io.stdout.text();
      const trimmed = text.trim();
      expect(trimmed.startsWith("{")).toBe(true);
      expect(trimmed.endsWith("}")).toBe(true);
      JSON.parse(trimmed); // round-trips
    },
  },
  {
    name: "E3 commands-grid: `nopo lint --print --concurrency=1` short-circuits before any spawn (other flags ignored in print mode)",
    fixture: "commands-grid",
    argv: ["lint", "--concurrency=1", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
      expectStdoutContains(io, '"command":"lint"');
    },
  },
  {
    name: "E4 commands-grid: `nopo test:integration --print` emits command name with colon syntax preserved",
    fixture: "commands-grid",
    argv: ["test:integration", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("test:integration");
      expectNoSpawns(io);
    },
  },
  {
    name: "E5 commands-grid: `nopo lint --print` lists `env` + `build` script-dependencies (build enabled false when no container-ctx in plan)",
    // dep's enabled flag is computed from willExecuteInContainer + hasDownContainer. Without
    // explicit container-context targets, build ends up disabled.
    fixture: "commands-grid",
    argv: ["lint", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      const names = plan.scriptDependencies.map((d) => d.name);
      expect(names).toEqual(["env", "build"]);
      const env = plan.scriptDependencies.find((d) => d.name === "env");
      expect(env?.enabled).toBe(true);
    },
  },

  // Error paths and flag handling Lock down the reachable error contract: invalid context,
  // unknown explicit target, `--` pass-through. Real subprocess failure can't be observed
  {
    name: "F1 commands-grid: `nopo format core -- --extra` → `--` IS honored, `--extra` reaches the command",
    // The predecessor of this row asserted the opposite: `--extra` landed in `parsed._`,
    // failed the unknown-target check, and exited 1. parseCommandArgs now splits argv
    fixture: "commands-grid",
    argv: ["format", "core", "--", "--extra", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("format");
      // `--extra` is NOT a target and NOT a nopo flag.
      expect(plan.targets).not.toContain("--extra");
    },
  },
  {
    name: "F2 commands-grid: `nopo lint no-such-service` → exit 1 'Unknown target'",
    fixture: "commands-grid",
    argv: ["lint", "no-such-service"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      expect(io.stderr.text()).toBe("");
    },
  },
  {
    name: "F3 commands-grid: `nopo lint --context=invalid --print` → exit 1 (context value validated even with --print)",
    // An invalid value throws before --print can intercept
    fixture: "commands-grid",
    argv: ["lint", "--context=invalid", "--print"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "F4 commands-grid: `nopo lint --context=container --print` parses cleanly; plan emitted",
    fixture: "commands-grid",
    argv: ["lint", "--context=container", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("lint");
      expectNoSpawns(io);
    },
  },
  {
    name: "F5 commands-grid: `nopo lint --skip-missing --print` parses cleanly; plan emitted (no observable difference vs bare --print here)",
    // --skip-missing is consumed inside fn() to drop services without the
    // command. With --print upstream, it's a parse-only check.
    fixture: "commands-grid",
    argv: ["lint", "--skip-missing", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("lint");
      expect(new Set(plan.services)).toEqual(new Set(["api", "core", "web"]));
    },
  },
  {
    name: "F6 commands-grid: `nopo lint --no-fail-fast --print` parses cleanly; plan emitted",
    fixture: "commands-grid",
    argv: ["lint", "--no-fail-fast", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("lint");
      expectNoSpawns(io);
    },
  },
  {
    // `exec()` in lib.ts writes to process.stdout directly). onSpawn never fires for command
    // execution, so we can't induce a non-zero exit cleanly via the mock. Once command
    name: "F7 commands-grid: failing host command propagates non-zero exit",
    fixture: "commands-grid",
    argv: ["format", "core"],
    onSpawn: () => ({ exitCode: 7, stdout: "", stderr: "boom" }),
    skip: "command execution uses legacy exec() — io.spawn is bypassed, onSpawn never fires; tighten when execution moves to ctx.shell",
    expect: (io) => {
      expectExitCode(io, 7);
    },
  },

  // Cross-service dependencies (command-on-command DAG) commands-grid declares
  // command-on-command edges: api.test:integration → api.build (intra-service)
  {
    name: "G1 commands-grid: `nopo test:integration web --print` resolves to web only (single explicit target)",
    // into the visible `services` set — the cross-service command DAG is built downstream via
    // buildExecutionPlan inside fn(), not via the BuildScript script-dep pipeline. The print
    fixture: "commands-grid",
    argv: ["test:integration", "web", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.services).toEqual(["web"]);
      // dependencies in the print plan reflect SERVICE-level deps from build/runtime (web has no
      // build/runtime dep on api), NOT the command-on-command edge. So api isn't listed here.
      expect(plan.dependencies).toEqual({ web: [] });
    },
  },
  {
    name: "G2 commands-grid: `nopo test:integration api --print` retains api + its build dep core",
    // api.test:integration has command-on-command dep on api.build, but api also has
    // SERVICE-level build dep on core (api.build.deps: [core]). The print plan reflects
    fixture: "commands-grid",
    argv: ["test:integration", "api", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.services)).toEqual(new Set(["api", "core"]));
      expect(plan.dependencies.api).toEqual(["core"]);
    },
  },
  {
    name: "G3 packages-and-services: `nopo lint web --print` (no service declares `lint:`) → empty services AND empty finalTargets",
    // positional `web` is also dropped — the runner intersects the explicit-target set with
    // the targetFilter-reduced set, leaving nothing. So both `services` AND `finalTargets` are
    fixture: "packages-and-services",
    argv: ["lint", "web", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.services).toEqual([]);
      expect(plan.finalTargets).toEqual([]);
    },
  },

  // Skips: blocked by fixture / infra issues — documented for future unskipping when the
  // underlying gap closes.
  {
    name: "X1 with-secrets: `nopo lint --print` runs against secrets fixture without leaking ciphertext",
    fixture: "with-secrets",
    argv: ["lint", "--print"],
    skip: "with-secrets/services/worker/nopo.yml has YAML parse bug — fixed in user's local union; unskip after copy",
    expect: () => {
      /* would assert plan emitted + no plaintext in stdout */
    },
  },
  {
    name: "X2 all-plugins: `nopo lint` invokes plugin run-override for container-context commands",
    fixture: "all-plugins",
    argv: ["lint"],
    skip: "all-plugins fixture requires plugin pre-build",
    expect: () => {
      /* would assert spawn pattern via plugin run-override */
    },
  },
];

describe("nopo <command> (contract)", () => {
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
