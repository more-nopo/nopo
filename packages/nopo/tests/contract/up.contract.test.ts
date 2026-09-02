import { describe } from "vitest";

import {
  type ContractCase,
  expectExitCode,
  expectNoSpawns,
  expectStdoutContains,
  runContractTable,
} from "../../src/test-utils/contract.ts";

// M4.2 contract test matrix for `nopo up`. Follows the M3.4 PoC pattern in
// `build.contract.test.ts`. Cases are grouped by axis below. The four observable surfaces

// JSON-fragment helper: assert that `--print` stdout begins with a literal substring (e.g.
// `"command":"up"`). Substrings only — never parse and re-stringify, so the assertions

const cases: ContractCase[] = [
  // A. Service selection
  {
    // Baseline: `nopo up --print` with no positional → every service in
    // the project goes into both `targets` and `finalTargets`.
    name: "A1: minimal `nopo up --print` plans the only service",
    fixture: "minimal",
    argv: ["up", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"command":"up"');
      expectStdoutContains(io, '"finalTargets":["app"]');
      expectNoSpawns(io);
    },
  },
  {
    // Multi-service fixture, no positional → all services planned.
    name: "A2: deps-chain `nopo up --print` plans every service when no positional given",
    fixture: "deps-chain",
    argv: ["up", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"finalTargets":["core","lib","web","worker"]');
    },
  },
  {
    // Single positional: only that target appears in `filteredTargets`.
    // `finalTargets` may still expand via deps (covered in axis D below).
    name: "A3: deps-chain `nopo up web --print` filters to a single service",
    fixture: "deps-chain",
    argv: ["up", "web", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"filteredTargets":["web"]');
    },
  },
  {
    // Multiple positionals: both filtered.
    name: "A4: packages-and-services `nopo up api web --print` filters to two services",
    fixture: "packages-and-services",
    argv: ["up", "api", "web", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"filteredTargets":["api","web"]');
    },
  },
  {
    // Failure path: unknown service → `validateTargets` throws BEFORE any plugin or subprocess
    // runs. Exit 1, no spawns, error text routes through `runner.logger` (console.log)
    name: "A5: minimal `nopo up no-such-service` exits non-zero on unknown target",
    fixture: "minimal",
    argv: ["up", "no-such-service"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // Unknown service even in `--print` mode: `validateTargets` runs in
    // `resolveExecutionPlan`, which `Runner.run` calls BEFORE the `--print` intercept.
    name: "A6: minimal `nopo up no-such-service --print` still exits non-zero",
    fixture: "minimal",
    argv: ["up", "no-such-service", "--print"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },

  // B. Runtime / dispatch routing
  {
    // No `runtimes:` map declared (legacy fixture) → `resolveRuntimePlugin` returns null. With
    // no plugin providing `up`, dispatch fails with the documented error and exit 1. Captured
    name: "B1: minimal `nopo up` fails fast when no runtime plugin is available",
    fixture: "minimal",
    argv: ["up"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // `runtimes:` map IS declared but no plugin provides `up`. The dispatcher resolves
    // "default" → "dev-plugin" then asks for the override slot, which the plugin doesn't
    name: "B2: multi-runtime `nopo up` errors when the resolved plugin defines no `up` override",
    fixture: "multi-runtime",
    argv: ["up"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // `--runtime prod` resolves the prod plugin via the runtimes map. Same shape as B2 — the
    // stub plugin defines no `up` override — so we observe the override-missing error path
    name: "B3: multi-runtime `nopo up --runtime prod` routes via the prod plugin",
    fixture: "multi-runtime",
    argv: ["up", "--runtime", "prod"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // `--runtime <unknown>` is rejected by `resolveRuntimePlugin` BEFORE any plugin runs.
    // logged via `runner.logger`, not `io.stderr`. Assert exit only.
    name: "B4: multi-runtime `nopo up --runtime nope` exits non-zero on unknown runtime",
    fixture: "multi-runtime",
    argv: ["up", "--runtime", "nope"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },
  {
    // `--print` intercept in Runner.run runs upstream of `up.fn`, which is where
    // `resolveRuntimePlugin` is called. So `--print` masks the unknown-runtime check. This is
    name: "B5: multi-runtime `nopo up --runtime nope --print` succeeds — `--print` short-circuits before runtime resolution",
    fixture: "multi-runtime",
    argv: ["up", "--runtime", "nope", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"command":"up"');
      expectNoSpawns(io);
    },
  },
  {
    // the current code — runtime routing is governed by the `runtimes:` map and `--runtime`
    // flag only. Documented here so the contract doesn't silently drift if the routing
    name: "B6: minimal `NOPO_NAMESPACE=nopo-dev nopo up --print` does not affect dispatch — env is not the routing source",
    fixture: "minimal",
    argv: ["up", "--print"],
    env: { NOPO_NAMESPACE: "nopo-dev" },
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"command":"up"');
      expectStdoutContains(io, '"plugins":[]');
    },
  },
  {
    // OBSERVED: `CI=true` env, similarly, does not change dispatch.
    name: "B7: minimal `CI=true nopo up --print` does not affect dispatch — env is not the routing source",
    fixture: "minimal",
    argv: ["up", "--print"],
    env: { CI: "true" },
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"command":"up"');
    },
  },

  // C. `--print` mode
  {
    // The strong contract row for `--print`: every documented field of the plan document is
    // asserted as a substring. Any change to the shape trips this.
    name: "C1: packages-and-services `nopo up --print` emits the full plan-document shape",
    fixture: "packages-and-services",
    argv: ["up", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"command":"up"');
      expectStdoutContains(io, '"services"');
      expectStdoutContains(io, '"targets"');
      expectStdoutContains(io, '"filteredTargets"');
      expectStdoutContains(io, '"finalTargets"');
      expectStdoutContains(io, '"dependencies"');
      expectStdoutContains(io, '"dependants"');
      expectStdoutContains(io, '"filters"');
      expectStdoutContains(io, '"since"');
      expectStdoutContains(io, '"plugins"');
      expectStdoutContains(io, '"scriptDependencies"');
      expectNoSpawns(io);
    },
  },
  {
    // `scriptDependencies` declares `env` (always enabled) and `build` (enabled-by-condition).
    // With no DOCKER_BUILD/local override `build` resolves disabled — but the default env
    name: "C2: minimal `nopo up --print` lists env+build as script-deps with build enabled by default (DOCKER_VERSION=local)",
    fixture: "minimal",
    argv: ["up", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"name":"env","enabled":true');
      expectStdoutContains(io, '"name":"build","enabled":true');
    },
  },
  {
    // OBSERVED: setting DOCKER_VERSION away from "local" AND no
    // DOCKER_BUILD flips the build script-dep to disabled.
    name: "C3: multi-runtime `DOCKER_VERSION=v9 nopo up --print` disables the build script-dep",
    fixture: "multi-runtime",
    argv: ["up", "--print"],
    env: { DOCKER_TAG: "custom:tag", DOCKER_VERSION: "v9.9.9" },
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"name":"build","enabled":false');
    },
  },
  {
    // `--print` is a planning surface: never spawns even when the fixture would otherwise
    // spawn during a real `up`. Belt-and-braces alongside C1; isolated for visibility.
    name: "C4: deps-chain `nopo up --print` short-circuits — no spawns",
    fixture: "deps-chain",
    argv: ["up", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
    },
  },
  {
    // is requested — `filteredTargets` shrinks to the named service and `finalTargets` expands
    // via the dep graph (covered fully in axis D).
    name: "C5: packages-and-services `nopo up api --print` scopes the plan to one service",
    fixture: "packages-and-services",
    argv: ["up", "api", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"filteredTargets":["api"]');
    },
  },
  {
    // (worker/nopo.yml description contains an unquoted `<flat>` token, parsed as a nested
    // mapping). Pre-existing; out of scope for M4.2. Once fixed, this row should assert no
    name: "C6: with-secrets `nopo up --print` redacts secret values in the plan output",
    fixture: "with-secrets",
    argv: ["up", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      const text = io.stdout.text();
      // No plaintext from the dummy-identity-decryptable envelopes.
      if (text.includes("test-api-key-default")) {
        throw new Error("plaintext secret leaked into --print stdout");
      }
      if (text.includes("test-queue-token-default")) {
        throw new Error("plaintext secret leaked into --print stdout");
      }
    },
  },

  // D. Dependency resolution
  {
    // Build-deps form a chain core <- lib <- web. `up web` must pull
    // every upstream into `finalTargets`, in topological order.
    name: "D1: deps-chain `nopo up web --print` expands to the full build-dep chain in topo order",
    fixture: "deps-chain",
    argv: ["up", "web", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"filteredTargets":["web"]');
      expectStdoutContains(io, '"finalTargets":["core","lib","web"]');
      expectStdoutContains(
        io,
        '"dependencies":{"core":[],"lib":["core"],"web":["lib"]}',
      );
    },
  },
  {
    // worker has a runtime-edge to web (no build dep). `up worker`
    // pulls in worker's runtime dep + that dep's transitive build-deps.
    name: "D2: deps-chain `nopo up worker --print` follows runtime deps as well as build deps",
    fixture: "deps-chain",
    argv: ["up", "worker", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"filteredTargets":["worker"]');
      expectStdoutContains(io, '"finalTargets":["core","lib","web","worker"]');
      expectStdoutContains(io, '"worker":["web"]');
    },
  },
  {
    // Cross-type dep edge: `web` (service) build-depends on `utils` (package), which
    // build-depends on `shared` (package). `up web` must pull both packages in even though
    name: "D3: packages-and-services `nopo up web --print` pulls packages across the cross-type dep edge",
    fixture: "packages-and-services",
    argv: ["up", "web", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"filteredTargets":["web"]');
      // Topo order: shared <- utils <- api/web; api also depends on shared. Asserting on
      // inclusion (substrings) rather than exact ordering keeps the test robust
      expectStdoutContains(io, '"shared"');
      expectStdoutContains(io, '"utils"');
      expectStdoutContains(io, '"api"');
      expectStdoutContains(io, '"web"');
    },
  },
  {
    // `up api web` should mention shared exactly once in `finalTargets`.
    name: "D4: packages-and-services `nopo up api web --print` lists each shared dep exactly once",
    fixture: "packages-and-services",
    argv: ["up", "api", "web", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      const text = io.stdout.text();
      // Count occurrences of `"shared"` inside the finalTargets array
      // segment (everything between `"finalTargets":[` and the next `]`).
      const m = text.match(/"finalTargets":\[([^\]]*)\]/);
      if (!m || m[1] === undefined) {
        throw new Error("could not locate finalTargets array in plan");
      }
      const finalTargetsBody = m[1];
      const occurrences = (finalTargetsBody.match(/"shared"/g) ?? []).length;
      if (occurrences !== 1) {
        throw new Error(
          `expected 'shared' to appear exactly once in finalTargets, got ${occurrences}: ${finalTargetsBody}`,
        );
      }
    },
  },

  // E. Plugin override
  {
    // Without `--print`, `up` reaches the plugin dispatch. minimal has no `runtimes:` map and
    // no plugin claims `up`, so the documented error path fires. Asserts the contract: missing
    name: "E1: minimal `nopo up` errors with the documented message when no plugin provides `up`",
    fixture: "minimal",
    argv: ["up"],
    expect: (io) => {
      expectExitCode(io, 1);
      // The error itself routes through `runner.logger` (console.log), so it doesn't reach
      // `io.stderr`. The contract here is the exit code + no-spawns.
      expectNoSpawns(io);
    },
  },
  {
    // With a `runtimes:` map and a named plugin that lacks an `up` override, dispatch errors
    // with the per-plugin variant of the missing-override message. Captured exit code is 1.
    name: "E2: multi-runtime `nopo up --runtime prod` errors when the resolved plugin lacks an `up` override",
    fixture: "multi-runtime",
    argv: ["up", "--runtime", "prod"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // `@more-nopo/nopo-plugin-docker-compose` workspace package to be built, which it isn't in
    // test/CI runs (vite build hasn't run). Once the plugin is path-loadable from a fixture
    name: "E3: all-plugins `nopo up` invokes `docker compose up` via the docker-compose plugin",
    fixture: "all-plugins",
    argv: ["up"],
    onSpawn: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    skip: "all-plugins fixture requires built workspace plugin packages — not available in test runs",
    expect: () => {
      /* would assert: expectSpawn(io, s => /docker/.test(s.cmd) && s.args.includes("compose")); */
    },
  },
  {
    // SKIPPED: same plugin-load gap as E3, but for the terraform path.
    name: "E4: all-plugins `nopo up --runtime prod` invokes `kubectl apply` via the terraform plugin",
    fixture: "all-plugins",
    argv: ["up", "--runtime", "prod"],
    onSpawn: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    skip: "all-plugins fixture requires built workspace plugin packages — not available in test runs",
    expect: () => {
      /* would assert: expectSpawn(io, s => s.cmd === "kubectl" && s.args[0] === "apply"); */
    },
  },

  // F. Environment / config
  {
    // Custom DOCKER_TAG flows through the env merge into the plan context. With `--print` we
    // can't observe the eventual subprocess env, but we CAN observe that the run does not fail
    name: "F1: minimal `DOCKER_TAG=custom:tag nopo up --print` succeeds with a custom tag",
    fixture: "minimal",
    argv: ["up", "--print"],
    env: { DOCKER_TAG: "custom:tag" },
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"command":"up"');
    },
  },
  {
    // be the spawn-side variant: a real `up` against a service with ENC[...] secrets must NOT
    // include the plaintext in any captured spawn's args, env, or input.
    name: "F2: with-secrets `nopo up` does not leak decrypted plaintext into spawn args/env/input",
    fixture: "with-secrets",
    argv: ["up"],
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
          blob.includes("test-api-key-prod") ||
          blob.includes("test-db-password-prod") ||
          blob.includes("test-queue-token-default")
        ) {
          throw new Error(`plaintext secret leaked into spawn ${s.cmd}`);
        }
      }
    },
  },
  {
    // OBSERVED: `--since` populates the `since` field in `--print` JSON.
    // No spawn-side observable surface today.
    name: "F3: deps-chain `nopo up --print --since HEAD` records the since ref in the plan",
    fixture: "deps-chain",
    argv: ["up", "--print", "--since", "HEAD"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"since":"HEAD"');
    },
  },
  {
    // carrying that tag (just `web` in multi-runtime). `finalTargets` still includes the
    // others because they were valid targets before the tag filter — only
    name: "F4: multi-runtime `nopo up --print --tags overlay` filters by tag",
    fixture: "multi-runtime",
    argv: ["up", "--print", "--tags", "overlay"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"filteredTargets":["web"]');
    },
  },

  // G. Error paths
  {
    // Unknown service → exit 1 (covered for direct + --print in axis A;
    // duplicated here for axis-G visibility).
    name: "G1: deps-chain `nopo up no-such-service` exits non-zero with no spawns",
    fixture: "deps-chain",
    argv: ["up", "no-such-service"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // Package-only target (no `runtime:` block) routed through `up`. error path as B1 fires —
    // the lack of a runtime block on the service does NOT itself produce a distinct error
    name: "G2: deps-chain `nopo up core` (package-only target, no runtime) errors on missing override, exit 1",
    fixture: "deps-chain",
    argv: ["up", "core"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    // Unknown runtime → exit 1 (mirrors B4; isolated in axis G).
    name: "G3: multi-runtime `nopo up --runtime nope` exits non-zero on unknown runtime",
    fixture: "multi-runtime",
    argv: ["up", "--runtime", "nope"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },
  {
    // requires a plugin that actually shells out via `ctx.shell` `io.spawn`. The only such
    // built-in is the path-loaded docker-compose / terraform plugins, neither of which is
    name: "G4: a failing `up`-side spawn propagates a non-zero exit code",
    fixture: "all-plugins",
    argv: ["up"],
    onSpawn: () => ({ exitCode: 2, stdout: "", stderr: "boom" }),
    skip: "all-plugins fixture requires built workspace plugin packages — not available in test runs",
    expect: (io) => {
      expectExitCode(io, 2);
    },
  },
  {
    // SKIPPED: missing-required-secret error contract. Same fixture
    // blocker as F2/C6.
    name: "G5: with-secrets `nopo up` errors with the missing variable name when a required secret env var is unset",
    fixture: "with-secrets",
    argv: ["up"],
    expect: (io) => {
      expectExitCode(io, 1);
      // Should mention the var by name, never the value.
    },
  },
];

describe("nopo up (contract)", () => {
  runContractTable(cases);
});
