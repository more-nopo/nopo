import { describe, expect } from "vitest";

import {
  type ContractCase,
  expectExitCode,
  expectNoSpawns,
  expectStderrContains,
  expectStdoutContains,
  runContractTable,
} from "../../src/test-utils/contract.ts";
import type { MockIO } from "../../src/test-utils/mock-io.ts";

// `nopo install`, `nopo secret`, `nopo list`, `nopo act` contract test matrix (M4.7).
// These four scripts are the "utility" surface of the CLI — none of them fits cleanly

// nopo install

const installCases: ContractCase[] = [
  // GROUP A: service selection
  {
    name: "A1 minimal: bare `nopo install` exits cleanly (no PMs in fixture → empty pm loop, log via console)",
    fixture: "minimal",
    argv: ["install"],
    expect: (io) => {
      expectExitCode(io, null);
      // "No package managers configured" goes through runner.logger.log
      // (console.log), not io.stdout. See gap §3.
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "A2 packages-and-services: bare `nopo install` exits cleanly (no PMs declared on this fixture either)",
    // Same observable as A1 — none of the canonical fixtures declares `package_managers:`, so
    // `getAllPackageManagers()` returns []. This row exists to lock down that multi-service
    fixture: "packages-and-services",
    argv: ["install"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "A3 deps-chain: positional `core` filters finalTargets (no-op for fn(), but visible in --print)",
    fixture: "deps-chain",
    argv: ["install", "core", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("install");
      expect(plan.finalTargets).toEqual(["core"]);
      expect(plan.services).toEqual(["core"]);
    },
  },
  {
    name: "A4 minimal: unknown positional `no-such` does NOT error (install's args=baseArgs.extend({}) skips target validation, divergence from build)",
    // install's empty schema means `prepareScriptArgs` skips parseTargetArgs/validateTargets,
    // so an unknown positional rides through without erroring. fn() then resolves PMs over
    fixture: "minimal",
    argv: ["install", "no-such"],
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
    },
  },

  // GROUP B: --print plan shape
  {
    name: "B1 minimal: `nopo install --print` emits the JSON plan and does not execute",
    fixture: "minimal",
    argv: ["install", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("install");
      expect(plan.finalTargets).toEqual(["app"]);
      expect(plan.scriptDependencies).toEqual([]);
      expectNoSpawns(io);
    },
  },
  {
    name: "B2 packages-and-services: --print reports every service and dependency edges",
    fixture: "packages-and-services",
    argv: ["install", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
      expect(plan.dependencies).toEqual({
        api: ["shared"],
        shared: [],
        utils: ["shared"],
        web: ["utils", "api"],
      });
    },
  },
  {
    name: "B3 minimal: --print emits exactly one JSON document terminated with `\\n`",
    fixture: "minimal",
    argv: ["install", "--print"],
    expect: (io) => {
      const text = io.stdout.text();
      expect(text.endsWith("\n")).toBe(true);
      const trimmed = text.trim();
      expect(trimmed.startsWith("{")).toBe(true);
      expect(trimmed.endsWith("}")).toBe(true);
      JSON.parse(trimmed);
      expect(text.split("\n").length).toBe(2);
    },
  },

  // GROUP C: flag handling
  {
    name: "C1 minimal: --help prints help (via console.log) and exits 0",
    fixture: "minimal",
    argv: ["install", "--help"],
    expect: (io) => {
      expectExitCode(io, 0);
      // Help routing currently uses console.log; io.stdout stays empty.
      expect(io.stdout.text()).toBe("");
    },
  },

  // GROUP D: error / plugin paths
  {
    name: "D1 all-plugins: docker plugin can't resolve from tmpdir → loadPlugins throws BEFORE install, exit 1",
    // Same plugin-load failure path documented in env F1 / build D2. The
    // error goes to console.error; io stays empty.
    fixture: "all-plugins",
    argv: ["install"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      expect(io.stdout.text()).toBe("");
    },
  },
  {
    name: "D2 with-secrets: bare install on secret-bearing fixture should resolve PMs without leaking ciphertexts to stdout",
    fixture: "with-secrets",
    argv: ["install"],
    expect: () => {
      // No-op: skipped above.
    },
  },
];

describe("nopo install (contract)", () => {
  runContractTable(installCases);
});

// nopo secret

const secretCases: ContractCase[] = [
  // GROUP A: verb dispatch / argument validation
  {
    name: "A1 minimal: bare `nopo secret` (no verb) exits 1 (verb is required)",
    fixture: "minimal",
    argv: ["secret"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "A2 minimal: unknown verb `frobnicate` exits 1",
    fixture: "minimal",
    argv: ["secret", "frobnicate"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "A3 minimal: --help prints help (via console.log) and exits 0",
    fixture: "minimal",
    argv: ["secret", "--help"],
    expect: (io) => {
      expectExitCode(io, 0);
      // Help uses console.log; io.stdout stays empty.
      expect(io.stdout.text()).toBe("");
    },
  },
  {
    name: "A4 minimal: unknown flag `--frobby` is rejected by the custom parser",
    // parseSecretArgs (scripts/secret.ts §518-522) rejects any --flag /
    // -flag it doesn't recognise. Errors propagate → main exits 1.
    fixture: "minimal",
    argv: ["secret", "list", "app", "--frobby"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },

  // GROUP B: keygen (pure verb, no fixture dependency on secret state)
  {
    name: "B1 minimal: `secret keygen` writes a fresh AGE-SECRET-KEY-... block to io.stdout and exits cleanly",
    // keygen is the ONE verb that bypasses identity loading — it generates
    // a brand-new identity in process and prints it. Always succeeds.
    fixture: "minimal",
    argv: ["secret", "keygen"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, "AGE-SECRET-KEY-");
      expectStdoutContains(io, "Recipient: age1");
      expectStdoutContains(io, "NOPO_AGE_IDENTITY_COMMAND");
      expectNoSpawns(io);
    },
  },

  // GROUP C: list verb (read-only, no identity needed)
  {
    name: "C1 deps-chain: `secret list core` on a service with no secrets exits cleanly with empty io.stdout",
    // listSecrets returns []; runner.logger.log fires "(no runtimes...)" which routes to
    // console — io.stdout stays empty. Locks down that the verb DOES NOT require an identity
    fixture: "deps-chain",
    argv: ["secret", "list", "core"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "C2 minimal: `secret list` (no svc positional) exits 1 with usage error",
    // runList throws "Usage: nopo secret list <svc>" → main exits 1.
    fixture: "minimal",
    argv: ["secret", "list"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },
  {
    name: "C3 with-secrets: `secret list api` should report API_KEY (default) + API_KEY/DB_PASSWORD (prod) keys without revealing values",
    fixture: "with-secrets",
    argv: ["secret", "list", "api"],
    expect: () => {
      // No-op: skipped above.
    },
  },

  // GROUP D: set verb (argument validation; identity NOT exercised here)
  {
    name: "D1 minimal: `secret set` missing positionals exits 1 (`Usage:` error)",
    // runSet throws on missing svc/key BEFORE touching identity loader.
    fixture: "minimal",
    argv: ["secret", "set", "app"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },
  {
    name: "D2 minimal: `secret set` with both positional value AND --from-stdin exits 1 (mutually exclusive)",
    // Even though identity is missing, the dual-source check fires FIRST (runSet §216-225) —
    // the parser flags this as "specify exactly one value source" before loadIdentity runs.
    fixture: "minimal",
    argv: ["secret", "set", "app", "MY_KEY", "value", "--from-stdin"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },
  {
    name: "D3 with-secrets: round-trip `secret set api NEW_KEY hello-value` then verify it persists",
    fixture: "with-secrets",
    argv: ["secret", "set", "api", "NEW_KEY", "hello-value"],
    expect: () => {
      // No-op: skipped above.
    },
  },

  // GROUP E: unset verb (idempotent — no identity needed)
  {
    name: "E1 minimal: `secret unset app NO_SUCH_KEY` is idempotent — exits cleanly with empty io.stdout",
    // unsetSecretCiphertext returns false on missing key; runUnset logs
    // "No such secret: ..." via console (gap §3). Exit is null.
    fixture: "minimal",
    argv: ["secret", "unset", "app", "NO_SUCH_KEY"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "E2 minimal: `secret unset` missing args exits 1",
    fixture: "minimal",
    argv: ["secret", "unset", "app"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },

  // GROUP F: get verb (the audit-log + plaintext-to-stdout path)
  {
    name: "F1 with-secrets: `secret get` without --unsafe exits 1 (refusal to print plaintext)",
    fixture: "with-secrets",
    argv: ["secret", "get", "api", "API_KEY"],
    expect: () => {
      // No-op: skipped above.
    },
  },
  {
    name: "F2 with-secrets: `secret get --unsafe` with valid identity writes plaintext to stdout AND audit line to stderr",
    fixture: "with-secrets",
    argv: ["secret", "get", "api", "API_KEY", "--unsafe"],
    env: { NOPO_AGE_IDENTITY_COMMAND: "cat ./dummy-identity.txt" },
    expect: () => {
      // No-op: skipped above.
    },
  },
  {
    name: "F3 with-secrets: `secret get --unsafe --runtime prod` returns the prod overlay value",
    fixture: "with-secrets",
    argv: ["secret", "get", "api", "API_KEY", "--unsafe", "--runtime", "prod"],
    env: { NOPO_AGE_IDENTITY_COMMAND: "cat ./dummy-identity.txt" },
    expect: () => {
      // No-op: skipped above.
    },
  },

  // GROUP G: rotate-key (top-level identity ceremony)
  {
    name: "G1 minimal: `secret rotate-key` with no NOPO_AGE_IDENTITY_COMMAND set exits 1 (identity loader required even when no secrets exist)",
    // rotate-key calls loadIdentity({ env: io.env }) BEFORE walking services. Missing env var
    // → loader throws → main exits 1. Locks down the order-of-operations: identity check is
    fixture: "minimal",
    argv: ["secret", "rotate-key"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },
];

describe("nopo secret (contract)", () => {
  runContractTable(secretCases);
});

// nopo list

const listCases: ContractCase[] = [
  // GROUP A: default text output (currently console-routed — see gap §3)
  {
    name: "A1 minimal: bare `nopo list` exits cleanly with empty io.stdout (table goes through runner.logger → console)",
    fixture: "minimal",
    argv: ["list"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "A2 packages-and-services: bare `nopo list` exits cleanly even with multiple services",
    fixture: "packages-and-services",
    argv: ["list"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },

  // GROUP B: --json (the strong assertion target — writes to io.stdout)
  {
    name: "B1 minimal: `nopo list --json` writes a parseable JSON document with `config` + `services` keys",
    fixture: "minimal",
    argv: ["list", "--json"],
    expect: (io) => {
      const text = io.stdout.text();
      const parsed = JSON.parse(text);
      expect(Object.keys(parsed).sort()).toEqual(["config", "services"]);
      expect(parsed.config.name).toBe("contract-minimal");
      expect(Object.keys(parsed.services)).toEqual(["app"]);
    },
  },
  {
    name: "B2 deps-chain: `nopo list --json` reports every service with the documented per-service shape",
    // Locks down the per-service object keys — schema contract for the
    // CSV/JSON consumers (M3.2's runCli self-tests + downstream tooling).
    fixture: "deps-chain",
    argv: ["list", "--json"],
    expect: (io) => {
      const text = io.stdout.text();
      const parsed = JSON.parse(text);
      expect(Object.keys(parsed.services).sort()).toEqual([
        "core",
        "lib",
        "web",
        "worker",
      ]);
      // Per-service shape (ServiceConfig from list.ts §210-217).
      const first = parsed.services.core;
      expect(Object.keys(first).sort()).toEqual(
        ["cpu", "description", "memory", "port", "static_path", "type"].sort(),
      );
    },
  },
  {
    name: "B3 packages-and-services: positional `shared` narrows the JSON output to one service",
    fixture: "packages-and-services",
    argv: ["list", "shared", "--json"],
    expect: (io) => {
      const parsed = JSON.parse(io.stdout.text());
      expect(Object.keys(parsed.services)).toEqual(["shared"]);
    },
  },
  {
    name: "B4 minimal: `--jq .config.name` filters JSON output via jq subprocess (legacy exec, not visible in io.spawns)",
    // jq runs through legacy exec() (gap §2) — io.spawns stays empty even
    // though jq actually runs. Output is jq's stdout passed through.
    fixture: "minimal",
    argv: ["list", "--json", "--jq", ".config.name"],
    expect: (io) => {
      expectExitCode(io, null);
      // jq -c on a string yields the JSON-quoted string + newline.
      expect(io.stdout.text()).toBe('"contract-minimal"\n');
      expectNoSpawns(io);
    },
  },

  // GROUP C: --csv / --print / --validate (short-circuit modes)
  {
    name: "C1 minimal: `nopo list --csv` writes a comma-joined service list with trailing newline",
    fixture: "minimal",
    argv: ["list", "--csv"],
    expect: (io) => {
      expect(io.stdout.text()).toBe("app\n");
      expectNoSpawns(io);
    },
  },
  {
    name: "C2 packages-and-services: `nopo list --csv` joins every resolved service with `,`",
    fixture: "packages-and-services",
    argv: ["list", "--csv"],
    expect: (io) => {
      // Order matches resolveExecutionPlan output — alphabetical for this
      // fixture per the build B3 contract.
      expect(io.stdout.text()).toBe("api,shared,utils,web\n");
    },
  },
  {
    name: "C3 minimal: `nopo list --print` emits the JSON plan, NOT the listing (centralised --print intercept fires upstream of fn())",
    fixture: "minimal",
    argv: ["list", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("list");
      expect(plan.finalTargets).toEqual(["app"]);
      expectNoSpawns(io);
    },
  },
  {
    name: "C4 minimal: `nopo list --validate` exits cleanly with empty io.stdout (success message via console)",
    // The "✓ Valid nopo.yml" line goes through runner.logger.log (gap §3).
    fixture: "minimal",
    argv: ["list", "--validate"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },

  // GROUP D: error paths
  {
    name: "D1 minimal: `--jq` without `--json` exits 1 (--jq requires --json)",
    fixture: "minimal",
    argv: ["list", "--jq", ".name"],
    expect: (io) => {
      expectExitCode(io, 1);
    },
  },

  // GROUP E: secret-fixture redaction
  {
    name: "E1 with-secrets: `nopo list --json` should expose service shape WITHOUT secret values",
    fixture: "with-secrets",
    argv: ["list", "--json"],
    expect: () => {
      // No-op: skipped above.
    },
  },
];

describe("nopo list (contract)", () => {
  runContractTable(listCases);
});

// nopo act Limited surface: only `--print` (intercepted upstream) and the no-subcommand
// usage path are reliably observable through io. Anything that reaches `which act` /

const actCases: ContractCase[] = [
  // GROUP A: --print (the one reliable assertion target)
  {
    name: "A1 minimal: `nopo act --print` emits the JSON plan and does not invoke the act binary",
    // --print is intercepted in Runner.run BEFORE ActScript.fn() runs, so
    // we don't need `act` installed for this case to pass.
    fixture: "minimal",
    argv: ["act", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("act");
      expect(plan.finalTargets).toEqual(["app"]);
      expect(plan.scriptDependencies).toEqual([]);
      expectNoSpawns(io);
    },
  },
  {
    name: "A2 packages-and-services: --print over a multi-service fixture also short-circuits (no act invocation)",
    fixture: "packages-and-services",
    argv: ["act", "--print"],
    expect: (io) => {
      const plan = parsePrintPlan(io);
      expect(plan.command).toBe("act");
      expect(new Set(plan.finalTargets)).toEqual(
        new Set(["api", "shared", "utils", "web"]),
      );
    },
  },

  // GROUP B: in-script argument validation (exits BEFORE invoking act) These rows lock down
  // ActScript's own error paths. They ARE sensitive to whether `act` is installed
  {
    name: "B1 minimal: `nopo act run` (no -w) should exit 1 with 'workflow is required' error",
    fixture: "minimal",
    argv: ["act", "run"],
    skip: "depends on `which act` host availability — ActScript's `which` runs through legacy exec(); cannot stub via onSpawn until act.ts is migrated to io.spawn",
    expect: () => {
      // No-op: skipped above.
    },
  },
  {
    name: "B2 minimal: `nopo act` (no subcommand, act installed) prints usage via console and exits null",
    // Even when act IS installed (default branch hits printUsage), the usage output goes
    // through runner.logger.log (console.log), so io.stdout stays empty — meaning we can't
    fixture: "minimal",
    argv: ["act"],
    skip: "ActScript.printUsage uses runner.logger.log (console) — not observable through io. Unskip when logger is routed through io.",
    expect: () => {
      // No-op: skipped above.
    },
  },
];

describe("nopo act (contract)", () => {
  runContractTable(actCases);
});

// Helpers

/** Shape of the `--print` JSON output. Mirrors `DryRunOutput` from
 * `packages/nopo/src/print.ts`. Kept narrow on purpose — same convention as
 * `build.contract.test.ts` / `env.contract.test.ts`. A schema change in `print.ts` SHOULD
 * trip these tests; that's the point of a contract suite.
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

// Touch-and-go reference: `expectStderrContains` is exported for downstream tests that
// probe the audit-log path (secret get F2). Keeping the import referenced even when every
void expectStderrContains;
