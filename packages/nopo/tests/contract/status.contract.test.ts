import { describe, expect } from "vitest";

import {
  type ContractCase,
  expectExitCode,
  expectNoSpawns,
  expectStdoutContains,
  runContractTable,
} from "../../src/test-utils/contract.ts";
import type { MockIO } from "../../src/test-utils/mock-io.ts";

// M4.4 contract test matrix for `nopo status`. Follows the M3.4 PoC pattern in
// `build.contract.test.ts` and the M4.2 matrix in `up.contract.test.ts`. `status` is

const cases: ContractCase[] = [
  // Service selection `status` is NOT a TargetScript, but the centralised
  // `Runner.resolveExecutionPlan` still honours positional targets
  {
    name: "A1 minimal: `nopo status --print` (no positional) → services=all (just `app`)",
    fixture: "minimal",
    argv: ["status", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("status");
      expect(plan.services).toEqual(["app"]);
      expect(plan.finalTargets).toEqual(["app"]);
      expectNoSpawns(io);
    },
  },
  {
    name: "A2 packages-and-services: single positional `web` → services=[web,…deps]; deps follow build+runtime DAG",
    // web → utils, api (runtime); api → shared (build); utils → shared (build). All four land
    // in services. `filteredTargets` reflects all-after-filter
    fixture: "packages-and-services",
    argv: ["status", "web", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.services)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
    },
  },
  {
    name: "A3 multi-runtime: two positionals `api web` → services=[api,web]; deps within set",
    fixture: "multi-runtime",
    argv: ["status", "api", "web", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.services)).toEqual(new Set(["api", "web"]));
      expect(new Set(plan.finalTargets)).toEqual(new Set(["api", "web"]));
    },
  },
  {
    name: "A4 multi-runtime: unknown positional `no-such-service` is silently dropped; --print succeeds with all services",
    // intersection with `allTargets`, so unknown names disappear. The resulting empty explicit
    // set falls through to `allTargets` in `resolveExecutionPlan`. NO error is raised
    fixture: "multi-runtime",
    argv: ["status", "no-such-service", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expectExitCode(io, null);
      expect(new Set(plan.services)).toEqual(new Set(["api", "web", "worker"]));
    },
  },
  {
    name: "A5 minimal: unknown positional `no-such-service` (no --print) → exits 1 via missing-override path, NOT via target validation",
    // With no plugin override, the missing override error fires and exit 1. Documented so a
    // future "validate targets upfront for status too" change shows up here.
    fixture: "minimal",
    argv: ["status", "no-such-service"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      // Error logs through `runner.logger` (console.log), not io.stderr.
      expect(io.stderr.text()).toBe("");
    },
  },

  // Runtime / dispatch routing `StatusScript.fn` mirrors `UpScript.fn`: resolve runtime via
  // `resolveRuntimePlugin`, then `fireOverride("status", ctx, name?)`. With no override
  {
    // No `runtimes:` map declared (legacy fixture) → resolveRuntimePlugin returns null. With
    // no plugin claiming `status`, dispatch fails
    name: "B1 minimal: `nopo status` (no runtimes map, no plugin) → exit 1, no spawns",
    fixture: "minimal",
    argv: ["status"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // `runtimes:` map IS declared but stub plugins lack a `status` override.
    // resolveRuntimePlugin → "dev-plugin" → fireOverride
    name: "B2 multi-runtime: `nopo status` resolves default plugin but stub lacks `status` override → exit 1",
    fixture: "multi-runtime",
    argv: ["status"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // `--runtime prod` resolves the prod plugin via the runtimes map. Same shape as B2 — stub
    // plugin defines no `status` override — so we observe exit 1. The contract here is
    name: "B3 multi-runtime: `nopo status --runtime prod` routes via prod plugin (stub, no override) → exit 1",
    fixture: "multi-runtime",
    argv: ["status", "--runtime", "prod"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // `--runtime <unknown>` is rejected by `resolveRuntimePlugin` BEFORE any plugin runs.
    // Error message is `Unknown runtime "nope". Declared runtimes: default, prod.` but logged
    name: "B4 multi-runtime: `nopo status --runtime nope` exits 1 on unknown runtime",
    fixture: "multi-runtime",
    argv: ["status", "--runtime", "nope"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },

  // `--print` mode Strong contract surface: `--print` writes a deterministic JSON document
  // to `io.stdout` (via `runner.printer.print`) and short-circuits before `fn`. Most rows
  {
    // The shape contract: every documented field of the plan document
    // is asserted as a substring. Any change to the shape trips this.
    name: "C1 packages-and-services: `nopo status --print` emits the full plan-document shape with command='status'",
    fixture: "packages-and-services",
    argv: ["status", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("status");
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
    // `scriptDependencies` for status is just `env` (always enabled).
    // Unlike `up`, status has no build script-dep.
    name: "C2 minimal: `nopo status --print` lists `env` as the sole script-dep (no build dep, unlike `up`)",
    fixture: "minimal",
    argv: ["status", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.scriptDependencies).toEqual([{ name: "env", enabled: true }]);
    },
  },
  {
    // `--print` short-circuits before any spawn even with arg combinations that would
    // otherwise trigger error paths inside fn (missing override, unknown runtime).
    name: "C3 multi-runtime: `nopo status --runtime nope --print` succeeds — `--print` intercepts upstream of runtime resolution",
    // OBSERVED: this is the same contract as M4.2 B5 — `--print` masks the unknown-runtime
    // check because validation happens inside `StatusScript.fn`
    fixture: "multi-runtime",
    argv: ["status", "--runtime", "nope", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("status");
      expectNoSpawns(io);
    },
  },
  {
    // `--print` emits exactly one JSON document followed by a newline.
    // CI consumers can rely on `jq -r '.services | join(" ")'` here too.
    name: "C4 minimal: `nopo status --print` emits a single line of JSON",
    fixture: "minimal",
    argv: ["status", "--print"],
    expect: (io) => {
      const text = io.stdout.text();
      const trimmed = text.trim();
      expect(trimmed.startsWith("{")).toBe(true);
      expect(trimmed.endsWith("}")).toBe(true);
      JSON.parse(trimmed);
    },
  },
  {
    // `plugins` field reflects loaded plugin names. multi-runtime loads `dev-plugin` +
    // `prod-plugin` (path-loaded stubs). Locks down the plugin-load → plan-doc round-trip
    name: "C5 multi-runtime: `nopo status --print` lists path-loaded stub plugins in `plugins`",
    fixture: "multi-runtime",
    argv: ["status", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.plugins).toEqual(["dev-plugin", "prod-plugin"]);
    },
  },

  // Flag-handling drift (`status` doesn't extend baseArgs) `StatusScript.args` is its own
  // minimal `ScriptArgs({ runtime })` — it does NOT extend `baseArgs`. `--filter`
  {
    name: "D1 deps-chain: `nopo status --since HEAD --print` parses but `since:` stays null in plan (status has no `since` arg)",
    fixture: "deps-chain",
    argv: ["status", "--since", "HEAD", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      // `--since HEAD` was on the cmdline. Build / up record it; status doesn't.
      expect(plan.since).toBeNull();
    },
  },
  {
    name: "D2 packages-and-services: `nopo status shared --with-dependants --print` does NOT expand to dependants (silent no-op for status)",
    // Status does not, because its arg set doesn't include `withDependants`. `dependants:[]`
    // and `finalTargets:["shared"]` confirm.
    fixture: "packages-and-services",
    argv: ["status", "shared", "--with-dependants", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.finalTargets).toEqual(["shared"]);
      expect(plan.dependants).toEqual([]);
    },
  },
  {
    name: "D3 packages-and-services: `nopo status --filter=buildable --print` does NOT filter (status has no `filter` arg)",
    // OBSERVED: every service stays in finalTargets. Build's E3
    // counterpart actually filters — status doesn't.
    fixture: "packages-and-services",
    argv: ["status", "--filter=buildable", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
      expect(plan.filters).toEqual([]);
    },
  },

  // Plugin override StatusScript fires `runner.fireOverride("status", ctx)` and throws if no
  // plugin claims the slot. The `multi-runtime` fixture loads stub plugins that don't
  {
    name: "E1 multi-runtime: stub plugin loaded, no `status` override → error from fn → exit 1, no spawns",
    fixture: "multi-runtime",
    argv: ["status"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      expect(io.stderr.text()).toBe("");
    },
  },
  {
    // `@more-nopo/nopo-plugin-docker-compose` workspace package to be built, which it isn't in
    // test/CI runs. Once the plugin is path-loadable from a fixture
    name: "E2 all-plugins: `nopo status` invokes `docker compose ps` via the docker-compose plugin",
    fixture: "all-plugins",
    argv: ["status"],
    onSpawn: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    skip: "all-plugins fixture requires built workspace plugin packages — not available in test runs",
    expect: () => {
      /* would assert: expectSpawn(io, s => /docker/.test(s.cmd) && s.args.includes("compose") && s.args.includes("ps")); */
    },
  },
  {
    // SKIPPED: same plugin-load gap as E2, but for the terraform path
    // — would assert kubectl-side status invocation.
    name: "E3 all-plugins: `nopo status --runtime prod` invokes `kubectl get pods` via terraform plugin",
    fixture: "all-plugins",
    argv: ["status", "--runtime", "prod"],
    onSpawn: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    skip: "all-plugins fixture requires built workspace plugin packages — not available in test runs",
    expect: () => {
      /* would assert: expectSpawn(io, s => s.cmd === "kubectl" && s.args[0] === "get"); */
    },
  },

  // Misc surface (help, --runtime default, error propagation)
  {
    name: "F1 minimal: `nopo status --help` exits 0 (help printed via console, not io.stdout)",
    // Help routes through `console.log` not `io.stdout`, so io.stdout stays empty. We only
    // assert exit code; tightening waits for IO routing to capture help output.
    fixture: "minimal",
    argv: ["status", "--help"],
    expect: (io) => {
      expectExitCode(io, 0);
      expect(io.stdout.text()).toBe("");
    },
  },
  {
    name: "F2 multi-runtime: `nopo status --runtime default --print` resolves to dev-plugin (default = dev-plugin in fixture)",
    fixture: "multi-runtime",
    argv: ["status", "--runtime", "default", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      // The plan plugins field lists ALL loaded plugins, regardless of which one would dispatch.
      // Use it as a "plugins loaded" signal, not a "selected plugin" signal. The selection
      expect(plan.plugins).toEqual(["dev-plugin", "prod-plugin"]);
      expectNoSpawns(io);
    },
  },
  {
    // plugin that overrides `status` exists, this row should `onSpawn` return a non-zero exit
    // code and assert the script's exit code propagates.
    name: "F3 all-plugins: a failing `status`-side spawn propagates a non-zero exit code",
    fixture: "all-plugins",
    argv: ["status"],
    onSpawn: () => ({ exitCode: 2, stdout: "", stderr: "boom" }),
    skip: "all-plugins fixture requires built workspace plugin packages — not available in test runs",
    expect: (io) => {
      expectExitCode(io, 2);
    },
  },
  {
    // (worker/nopo.yml description contains an unquoted `<flat>` token). Once fixed, this row
    // should assert no plaintext from the ENC[...] envelopes appears in `io.stdout.text()`
    name: "F4 with-secrets: `nopo status --print` redacts secret values in the plan output",
    fixture: "with-secrets",
    argv: ["status", "--print"],
    expect: (io) => {
      const text = io.stdout.text();
      if (text.includes("test-api-key-default")) {
        throw new Error("plaintext secret leaked into --print stdout");
      }
    },
  },
  {
    // env doesn't drive runtime selection for status — only the `runtimes:` map and
    // `--runtime` flag do. CI=true is observed to have no effect, mirroring M4.2 B7 for `up`.
    name: "F5 minimal: `CI=true nopo status --print` does not affect dispatch — env is not the routing source",
    fixture: "minimal",
    argv: ["status", "--print"],
    env: { CI: "true" },
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expectExitCode(io, null);
      expect(plan.plugins).toEqual([]);
    },
  },
  {
    // commands-grid fixture: another no-runtimes-map shape, exits 1. Locks down that any
    // fixture without a status override hits the same dispatch-error path.
    name: "F6 commands-grid: `nopo status` (no plugin claims status) → exit 1, no spawns",
    fixture: "commands-grid",
    argv: ["status"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // `services` matches `finalTargets` (no positional, no filters), full chain in topo order.
    name: "F7 deps-chain: `nopo status --print` plans full project in topo order, no spawns",
    fixture: "deps-chain",
    argv: ["status", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expectStdoutContains(io, '"command":"status"');
      expect(plan.finalTargets).toEqual(["core", "lib", "web", "worker"]);
      expectNoSpawns(io);
    },
  },
];

describe("nopo status (contract)", () => {
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
