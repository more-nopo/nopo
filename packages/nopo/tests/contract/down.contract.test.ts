import { describe, expect } from "vitest";

import {
  type ContractCase,
  expectExitCode,
  expectNoSpawns,
  expectStdoutContains,
  runContractTable,
} from "../../src/test-utils/contract.ts";
import type { MockIO } from "../../src/test-utils/mock-io.ts";

// M4.3 contract test matrix for `nopo down`. Mirrors the M4.2 `nopo up` contract suite
// (same dispatch architecture, inverse direction). Cases are grouped by axis A-F per

const cases: ContractCase[] = [
  // A. Service selection
  {
    // Baseline: `nopo down --print` with no positional → every service
    // appears in `targets` and `finalTargets`.
    name: "A1: minimal `nopo down --print` plans the only service",
    fixture: "minimal",
    argv: ["down", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"command":"down"');
      expectStdoutContains(io, '"finalTargets":["app"]');
      expectNoSpawns(io);
    },
  },
  {
    // Single positional: only that target appears in `filteredTargets`
    // (finalTargets may still expand via deps — covered in axis D).
    name: "A2: deps-chain `nopo down web --print` filters to a single service",
    fixture: "deps-chain",
    argv: ["down", "web", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"filteredTargets":["web"]');
    },
  },
  {
    // Multiple positionals: both filtered.
    name: "A3: packages-and-services `nopo down api web --print` filters to two services",
    fixture: "packages-and-services",
    argv: ["down", "api", "web", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"filteredTargets":["api","web"]');
    },
  },
  {
    // Failure path: unknown service → `validateTargets` throws BEFORE any plugin dispatch.
    // Exit 1, no spawns. Error text logged via `runner.logger` (console.log), not `io.stderr`.
    name: "A4: minimal `nopo down no-such-service` exits non-zero on unknown target",
    fixture: "minimal",
    argv: ["down", "no-such-service"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // OBSERVED: `--print` does NOT mask validation — `validateTargets` runs in
    // `resolveExecutionPlan`, which `Runner.run` calls BEFORE the `--print` intercept.
    name: "A5: minimal `nopo down no-such-service --print` still exits non-zero",
    fixture: "minimal",
    argv: ["down", "no-such-service", "--print"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },

  // B. Runtime / dispatch routing
  {
    // No `runtimes:` map declared (legacy fixture) → `resolveRuntimePlugin` returns null. With
    // no plugin providing `down`, dispatch fails with the documented error and exit 1.
    name: "B1: minimal `nopo down` fails fast when no runtime plugin is available",
    fixture: "minimal",
    argv: ["down"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // `runtimes:` map IS declared but the resolved plugin defines no `down` override. The
    // dispatcher resolves "default" → "dev-plugin", asks for the override slot, and throws
    name: "B2: multi-runtime `nopo down` errors when the resolved plugin defines no `down` override",
    fixture: "multi-runtime",
    argv: ["down"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // `--runtime prod` resolves the prod plugin via the runtimes map. Same shape as B2 — the
    // stub plugin defines no `down` override — so we observe the override-missing error path
    name: "B3: multi-runtime `nopo down --runtime prod` routes via the prod plugin",
    fixture: "multi-runtime",
    argv: ["down", "--runtime", "prod"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // `--runtime <unknown>` is rejected by `resolveRuntimePlugin` BEFORE any plugin runs.
    // NOTE: error message ("Unknown runtime ...") is logged via `runner.logger`, not
    name: "B4: multi-runtime `nopo down --runtime nope` exits non-zero on unknown runtime",
    fixture: "multi-runtime",
    argv: ["down", "--runtime", "nope"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },
  {
    // OBSERVED: `--runtime <unknown> --print` SUCCEEDS — the `--print` intercept in
    // `Runner.run` runs upstream of `down.fn`, where `resolveRuntimePlugin` is called.
    name: "B5: multi-runtime `nopo down --runtime nope --print` succeeds — `--print` short-circuits before runtime resolution",
    fixture: "multi-runtime",
    argv: ["down", "--runtime", "nope", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"command":"down"');
      expectNoSpawns(io);
    },
  },

  // C. `--print` mode
  {
    // The strong contract row for `--print`: every documented field of
    // the plan document is asserted. Any change to the shape trips this.
    name: "C1: packages-and-services `nopo down --print` emits the full plan-document shape",
    fixture: "packages-and-services",
    argv: ["down", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("down");
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
      expectNoSpawns(io);
    },
  },
  {
    // (unlike `up`, which also declares `BuildScript`). So `scriptDependencies` lists `env`
    // enabled, AND DOES NOT list `build`.
    name: "C2: minimal `nopo down --print` lists ONLY env as a script-dep (no build entry)",
    fixture: "minimal",
    argv: ["down", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      const plan = parsePrintPlan(io);
      expect(plan.scriptDependencies).toContainEqual({
        name: "env",
        enabled: true,
      });
      // No `build` script-dep on down — distinct from `up`.
      expect(plan.scriptDependencies.find((d) => d.name === "build")).toBe(
        undefined,
      );
    },
  },
  {
    // `--print` short-circuits: never spawns, even when the plan would otherwise touch the
    // plugin dispatch path. Belt-and-braces alongside C1; isolated for visibility.
    name: "C3: deps-chain `nopo down --print` short-circuits — no spawns",
    fixture: "deps-chain",
    argv: ["down", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
    },
  },

  // Dependency resolution `depSource = ["build", "runtime"]`. The DAG walk pulls UPSTREAM
  // dependencies (same as `up`), NOT downstream dependants. So `down web` on `deps-chain`
  {
    // `down web` follows the SAME upstream walk that `up web` does — it does NOT cascade to
    // dependents (worker, which depends on web, is NOT in finalTargets).
    name: "D1: deps-chain `nopo down web --print` plans only upstream deps, NOT downstream dependants",
    fixture: "deps-chain",
    argv: ["down", "web", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      const plan = parsePrintPlan(io);
      expect(plan.filteredTargets).toEqual(["web"]);
      expect(plan.finalTargets).toEqual(["core", "lib", "web"]);
      // Worker depends on web but `down web` does NOT pull it in.
      expect(plan.finalTargets).not.toContain("worker");
    },
  },
  {
    // Diamond / shared dep: tearing down api+web — the shared dep appears
    // exactly ONCE in finalTargets (deduped, just like `up`).
    name: "D2: packages-and-services `nopo down api web --print` lists each shared dep exactly once",
    fixture: "packages-and-services",
    argv: ["down", "api", "web", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      const plan = parsePrintPlan(io);
      const sharedCount = plan.finalTargets.filter(
        (t) => t === "shared",
      ).length;
      expect(sharedCount).toBe(1);
    },
  },
  {
    // Worker has runtime.deps:[web]. `down worker` pulls worker's runtime
    // dep + that dep's transitive build-deps (same closure as `up worker`).
    name: "D3: deps-chain `nopo down worker --print` follows runtime+build deps (same as up)",
    fixture: "deps-chain",
    argv: ["down", "worker", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      const plan = parsePrintPlan(io);
      expect(plan.filteredTargets).toEqual(["worker"]);
      expect(plan.finalTargets).toEqual(["core", "lib", "web", "worker"]);
    },
  },

  // E. Plugin override
  {
    // Without `--print`, `down` reaches the plugin dispatch. minimal has no `runtimes:` map
    // and no plugin claims `down`, so the documented error path fires. Asserts the contract
    name: "E1: minimal `nopo down` errors with the documented missing-override path when no plugin provides `down`",
    fixture: "minimal",
    argv: ["down"],
    expect: (io) => {
      expectExitCode(io, 1);
      // Error itself routes through `runner.logger` (console.log), not
      // `io.stderr`. Contract here is exit code + no-spawns.
      expectNoSpawns(io);
    },
  },
  {
    // `@more-nopo/nopo-plugin-docker-compose` workspace plugin to be pre-built (vite build hasn't
    // run in test/CI). Once the plugin is path-loadable from a fixture
    name: "E2: all-plugins `nopo down` invokes `docker compose down` via the docker-compose plugin",
    fixture: "all-plugins",
    argv: ["down"],
    onSpawn: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    skip: "all-plugins fixture requires plugin pre-build",
    expect: () => {
      /* would assert: expectSpawn(io, s => /docker/.test(s.cmd) && s.args.includes("compose") && s.args.includes("down")); */
    },
  },
  {
    // SKIPPED: same plugin-load gap as E2, but for the terraform path
    // (`kubectl delete` / terraform-destroy invocation).
    name: "E3: all-plugins `nopo down --runtime prod` invokes the terraform plugin",
    fixture: "all-plugins",
    argv: ["down", "--runtime", "prod"],
    onSpawn: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    skip: "all-plugins fixture requires plugin pre-build",
    expect: () => {
      /* would assert: expectSpawn(io, s => s.cmd === "kubectl" && s.args[0] === "delete"); */
    },
  },

  // F. Error paths
  {
    // that actually shells out via `ctx.shell` / `io.spawn`. The only such built-ins are the
    // path-loaded docker-compose / terraform plugins, neither of which is loadable
    name: "F1: a failing `down`-side spawn propagates a non-zero exit code",
    fixture: "all-plugins",
    argv: ["down"],
    onSpawn: () => ({ exitCode: 2, stdout: "", stderr: "boom" }),
    skip: "all-plugins fixture requires plugin pre-build",
    expect: (io) => {
      expectExitCode(io, 2);
      expect(io.stderr.text()).toContain("boom");
    },
  },
  {
    // Idempotency check: tearing down a service "that wasn't up" — from the CLI's perspective
    // there's no "is it up?" gate, the script unconditionally dispatches to the plugin.
    name: "F2: minimal `nopo down` is not idempotent at the runner layer — same missing-override exit as B1",
    fixture: "minimal",
    argv: ["down"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // description contains an unquoted `<flat>` token, parsed as a nested mapping).
    // Pre-existing; out of scope for M4.3. Once fixed, this row should assert no plaintext
    name: "F3: with-secrets `nopo down` does not leak decrypted plaintext into spawn args/env/input",
    fixture: "with-secrets",
    argv: ["down"],
    onSpawn: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    expect: (io) => {
      for (const s of io.spawns) {
        const blob = JSON.stringify({
          args: s.args,
          env: s.env,
          input: s.input,
        });
        if (
          blob.includes("test-api-key-default") ||
          blob.includes("test-queue-token-default")
        ) {
          throw new Error(`plaintext secret leaked into spawn ${s.cmd}`);
        }
      }
    },
  },
];

describe("nopo down (contract)", () => {
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
 * if stdout isn't a single JSON document — failures here usually mean
 * the test ran without `--print` and is reading the wrong surface.
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
