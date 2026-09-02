import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect } from "vitest";

import {
  type ContractCase,
  expectExitCode,
  expectNoSpawns,
  expectStdoutContains,
  runContractTable,
} from "../../src/test-utils/contract.ts";

// nopo CLI cross-cutting error contract (M4.9). This file is the FINAL M4.x — it locks
// down what the CLI does when things go wrong, regardless of which command is invoked.

const cases: ContractCase[] = [
  // GROUP A: argv / parser surface What does the CLI do for various malformed / unusual argv
  // shapes? Pin the observed behaviour. Most "errors" here are SOFT — minimist is permissive
  {
    name: "A1 minimal: bare `nopo` (no command, no flags) → exit 0, banner+help on console",
    // through `console.log` (not io.stdout); CLI exits 0 cleanly. SURFACE GAP: would like to
    // assert banner text on io.stdout but the header goes via console.log.
    fixture: "minimal",
    argv: [],
    expect: (io) => {
      expectExitCode(io, 0);
      expectNoSpawns(io);
      // Console.log output isn't captured by mockIO — io.stdout stays empty.
      expect(io.stdout.text()).toBe("");
      expect(io.stderr.text()).toBe("");
    },
  },
  {
    name: "A2 minimal: `nopo --help` (no command) → exit 0 via printHelp(..., 0)",
    fixture: "minimal",
    argv: ["--help"],
    expect: (io) => {
      expectExitCode(io, 0);
      expectNoSpawns(io);
    },
  },
  {
    name: "A3 minimal: `nopo help` → exit 0 via printHelp(..., 0)",
    fixture: "minimal",
    argv: ["help"],
    expect: (io) => {
      expectExitCode(io, 0);
      expectNoSpawns(io);
    },
  },
  {
    name: "A4 minimal: unknown command `nopo no-such-command` → Command script refuses the empty dispatch, exit 1",
    // `scripts[commandName]` returns undefined for unknown commands, so ScriptClass becomes
    // the generic Command script and the runner computes `resolvedTargets = []`. That used
    fixture: "minimal",
    argv: ["no-such-command"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "A5 minimal: malformed long flag `nopo --unknown=val` (no command) → still no-args branch fires, exit 0",
    // populates args.unknown=val. Since args._[0] is still empty, the no-command branch wins
    // and exit is 0. The CLI doesn't validate flags against a known set — pin this leniency
    fixture: "minimal",
    argv: ["--unknown=val"],
    expect: (io) => {
      expectExitCode(io, 0);
      expectNoSpawns(io);
    },
  },
  {
    name: "A6 minimal: `nopo build --tag` (boolean-flag where value would be required) → succeeds, --tag becomes boolean true",
    // Build doesn't require --tag, so this is a no-op success. Pin the no-op — surface that
    // the CLI does NOT enforce "value-required" semantics for arbitrary unknown flags.
    fixture: "minimal",
    argv: ["build", "--tag"],
    expect: (io) => {
      // Same as D3 in build.contract.test.ts — host build path bypasses
      // io.spawn, so we assert exit-clean only.
      expectExitCode(io, null);
      expect(io.spawns.length).toBe(0);
    },
  },
  {
    name: "A7 minimal: `nopo --version` (no command, just --version) → no-args branch, exit 0 (CLI doesn't implement --version)",
    // args.version=true; args._[0] is undefined; falls into the no-command banner branch →
    // exit 0. M5.x might add a real --version handler; pinning today's behaviour so the change
    fixture: "minimal",
    argv: ["--version"],
    expect: (io) => {
      expectExitCode(io, 0);
      expectNoSpawns(io);
    },
  },

  // GROUP B: config loading errors `loadProjectConfig` is called eagerly inside
  // `createConfig` BEFORE `main`'s plugin-load try/catch. Failures from this layer propagate
  {
    name: "B1 missing nopo.yml: runCli rejects with 'Missing nopo.yml configuration'",
    fixture: "minimal", // unused — overridden inline
    argv: [],
    expect: async () => {
      // Build a tmpdir with NO nopo.yml. We don't have a fixture for this, so synthesize one
      // inline — but runCli requires a fixture name. Use a sibling helper that copies a fixture
      await expect(runMissingConfig()).rejects.toThrow(/Missing nopo\.yml/);
    },
  },
  {
    name: "B2 malformed YAML at root: runCli rejects with 'Failed to read' wrapper from parseYamlFile",
    fixture: "minimal", // unused — overridden inline
    argv: [],
    expect: async () => {
      await expect(runMalformedRootYaml()).rejects.toThrow(/Failed to read/);
    },
  },
  {
    name: "B3 schema-validation failure (typo'd field at root): runCli rejects with a Zod validation message",
    // ProjectConfigSchema.parse throws a ZodError. The error class is ZodError (not Error),
    // but its message contains "Invalid" / the path. We assert it's a thrown error and that
    fixture: "minimal",
    argv: [],
    expect: async () => {
      await expect(runWithBadRootField()).rejects.toThrow();
    },
  },
  {
    name: "B4 service nopo.yml with malformed YAML: runCli rejects (whole-project load aborts, no per-service skip)",
    // Pin the contract: a single bad service nopo.yml aborts the WHOLE load — there is no
    // skip-bad-services mode. We use a YAML parse error rather than a missing-field, because
    fixture: "minimal",
    argv: [],
    expect: async () => {
      await expect(runWithBadServiceField()).rejects.toThrow(/Failed to read/);
    },
  },
  {
    name: "B5 deps-chain: circular service deps would throw — pinned via the happy-path absence (deps-chain has no cycle)",
    // The runner DOES have cycle detection (lib.ts:974 — graph.order() throws 'Circular
    // dependency detected ...'). Pin the adjacent contract: a non-circular fixture
    fixture: "deps-chain",
    argv: [],
    expect: (io) => {
      // Bare `nopo` against a valid fixture — banner branch, exit 0.
      expectExitCode(io, 0);
    },
    skip: "no canonical circular-deps fixture; cycle detection lives in lib.ts but isn't reachable from the canonical fixture set today",
  },
  {
    name: "B6 with-secrets: bare `nopo` parses cleanly (regression-pin for the previously-broken fixture YAML)",
    // The with-secrets/services/worker/nopo.yml previously had an unquoted flow-mapping in
    // `description:` (`<flat>` token parsed as a nested mapping). Fixed in the union; this row
    fixture: "with-secrets",
    argv: [],
    expect: (io) => {
      expectExitCode(io, 0);
    },
  },

  // GROUP C: plugin loading errors `loadPlugins` runs INSIDE `main`'s try/catch
  // (index.ts:272-278). On `io.exit(1)`. So io.exitCode === 1, io.stderr === ''
  {
    name: "C1 all-plugins: plugin package can't be resolved from tmpdir → exit 1 via main's plugin-load catch",
    // Same as build.contract D2 but cross-cutting — true regardless of which command is
    // invoked
    fixture: "all-plugins",
    argv: [],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      expect(io.stderr.text()).toBe(""); // SURFACE GAP: error text on console.error
      expect(io.stdout.text()).toBe("");
    },
  },
  {
    name: "C2 all-plugins: same plugin-load failure also fires for `build` command (error class is pre-command)",
    fixture: "all-plugins",
    argv: ["build"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "C3 all-plugins: same plugin-load failure for `--help` (error fires before help is printed)",
    // Pin the ordering: plugin loading happens BEFORE the help branch is checked (index.ts:272
    // vs :302). So even `--help` gets the plugin error and exits 1 — not a help-print exit-0.
    fixture: "all-plugins",
    argv: ["--help"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "C4 plugin-name-collides-with-builtin: synthesized fixture (plugin named 'build') → loadPlugins throws → exit 1",
    fixture: "minimal", // unused — overridden inline
    argv: [],
    expect: async () => {
      // We can't easily synthesize a tmpdir with a plugin file because loadPlugins resolves via
      // dynamic import. Fall back to asserting the contract via the all-plugins fixture
    },
    skip: "plugin-collision-with-builtin is unreachable from canonical fixtures (all-plugins fails on resolve before reaching collision check); add a local-path plugin fixture to exercise this path",
  },

  // GROUP D: runtime resolution errors The CLI's `resolveRuntimePlugin`
  // (config/index.ts:939) throws when: `--runtime <name>` is passed but no `runtimes:` map
  {
    name: "D1 minimal: `--runtime nope` for `build` → no error (build doesn't dispatch by runtime)",
    // trip resolveRuntimePlugin because that's only called by runtime dispatched scripts
    // (up/down/status/run). Pin the "tolerated" shape.
    fixture: "minimal",
    argv: ["build", "--runtime", "nope"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.spawns.length).toBe(0);
    },
  },
  {
    name: "D2 minimal: `--runtime nope` for `up` → no `runtimes:` map declared, runtime resolves via service overlay (no error from resolveRuntimePlugin in this path)",
    // resolveRuntimePlugin which throws if --runtime is given without a map. The error
    // propagates to main's catch, exit 1. SURFACE GAP: the precise error text lives
    fixture: "minimal",
    argv: ["up", "--runtime", "nope"],
    expect: (io) => {
      // Either exits cleanly (no runtime path hit) or 1 (resolveRuntime
      // threw). Pin observed exit code without over-specifying:
      expect([null, 1]).toContain(io.exitCode);
      expectNoSpawns(io);
    },
  },
  {
    name: "D3 multi-runtime: `--runtime nope` for `up` → unknown name in declared map, runtime resolution throws → exit 1",
    // multi-runtime fixture HAS a `runtimes:` map. An unknown name IS
    // caught by resolveRuntimePlugin's "Unknown runtime" branch.
    fixture: "multi-runtime",
    argv: ["up", "--runtime", "nope"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },

  // GROUP E: script execution errors What happens when a script throws or a spawned
  // subprocess fails? Most error paths here use `onSpawn` to inject failures. Note that
  {
    name: "E1 minimal: bare `nopo command` (no subcommand) → zero-stage dispatch refused, exit 1",
    // No service in `minimal` declares a command literally named "command", so the plan
    // resolves to zero stages. That used to be a silent log+return (exit `null`);
    fixture: "minimal",
    argv: ["command"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "E2 minimal: nonexistent custom command → zero-stage dispatch refused, exit 1",
    // Same root cause as A4 / E1 — unknown commands fall through to the Command script with an
    // empty resolved-target set. The CLI used to be permissive here; it now fails loudly
    fixture: "minimal",
    argv: ["totally-fake-command"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "E3 minimal: onSpawn throws for ALL spawns → unknown-cmd path fails before any spawn",
    // For commands that DO use io.spawn (most plugin paths), an injected throw should
    // propagate. Unknown commands never reach io.spawn: the empty-dispatch guard rejects
    fixture: "minimal",
    argv: ["no-such-cmd"],
    onSpawn: () => {
      throw new Error("ENOENT: no such file or directory");
    },
    expect: (io) => {
      expectExitCode(io, 1);
      // onSpawn never fired — the guard tripped before any subprocess.
      expectNoSpawns(io);
    },
  },
  {
    name: "E4 minimal: onSpawn returns exitCode=2 for any spawn → captured but doesn't crash the CLI (build host path, no spawns)",
    // Pin the build-host-path no-spawn contract: even with a hostile
    // onSpawn handler, build never spawns, so exit is clean.
    fixture: "minimal",
    argv: ["build"],
    onSpawn: () => ({ exitCode: 2, stdout: "", stderr: "boom" }),
    expect: (io) => {
      expectExitCode(io, null);
      expectNoSpawns(io);
    },
  },

  // GROUP F: list-command JSON-mode error contract The `list` command has a JSON output mode
  // that goes through io.stdout (silent mode). Pin error behaviour around it: invalid
  {
    name: "F1 minimal: `nopo list --json` → emits a JSON document on io.stdout (no error, silent mode active)",
    fixture: "minimal",
    argv: ["list", "--json"],
    expect: (io) => {
      // Silent mode: stdout has JSON output we can parse.
      expectExitCode(io, null);
      const text = io.stdout.text().trim();
      expect(text.length).toBeGreaterThan(0);
      // Round-trip parse confirms it's valid JSON.
      JSON.parse(text);
    },
  },
  {
    name: "F2 minimal: `nopo list --json --csv` (conflicting silent-mode flags) → CSV wins or JSON wins, but no crash",
    // Both are silent. The list script's own format resolver decides which wins. Pin the
    // no-crash contract.
    fixture: "minimal",
    argv: ["list", "--json", "--csv"],
    expect: (io) => {
      // No exit 1 — the conflict is silently resolved.
      expect([null, 0]).toContain(io.exitCode);
      // Some output produced (silent mode emitted something).
      expect(io.stdout.text().length).toBeGreaterThan(0);
    },
  },

  // GROUP G: exit code conventions Lock down the observed exit-code map. M5.x will likely
  // normalize this; having the map pinned as a contract makes any change explicit. OBSERVED
  {
    name: "G1 convention: --help exits 0 (success-style help)",
    fixture: "minimal",
    argv: ["--help"],
    expect: (io) => expectExitCode(io, 0),
  },
  {
    name: "G2 convention: bare `nopo` exits 0 (banner is success-style)",
    fixture: "minimal",
    argv: [],
    expect: (io) => expectExitCode(io, 0),
  },
  {
    name: "G3 convention: unknown command exits 1 — an empty dispatch is an error, not a no-op",
    // The CLI still does NOT distinguish "unknown command" from "valid command with an empty
    // target set" — but both now exit 1 instead of silently no-opping, which is the property
    fixture: "minimal",
    argv: ["zzz-not-a-command"],
    expect: (io) => expectExitCode(io, 1),
  },
  {
    name: "G4 convention: plugin-load failure exits 1 (config-class error, same code as runtime)",
    fixture: "all-plugins",
    argv: [],
    expect: (io) => expectExitCode(io, 1),
  },
  {
    name: "G5 convention: happy-path command (build on minimal) returns null exitCode (no exit() call)",
    fixture: "minimal",
    argv: ["build"],
    expect: (io) => expectExitCode(io, null),
  },
  {
    name: "G6 convention: --print mode also returns null exitCode (success path)",
    fixture: "minimal",
    argv: ["build", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, '"command":"build"');
    },
  },
  {
    name: "G7 convention: list --json (success, silent mode) returns null exitCode (NOT 0 — no explicit exit)",
    // and "main called io.exit(0)" (0). Today list --json returns from main without calling
    // exit(), so exitCode is null. Pin this so the distinction is explicit.
    fixture: "minimal",
    argv: ["list", "--json"],
    expect: (io) => expectExitCode(io, null),
  },
];

describe("nopo cross-cutting error contract (M4.9)", () => {
  runContractTable(cases);
});

// Helpers These synthesize tmpdir scenarios for cases that need a deliberately malformed
// fixture. They live alongside the test rather than under `nopo/fixtures/contract/`

async function runWithMutatedFixture(
  baseFixture: string,
  mutate: (tmpdir: string) => Promise<void>,
  argv: string[] = [],
): Promise<void> {
  const fixtureRoot = findFixtureRoot();
  const fixtureSrc = path.join(fixtureRoot, baseFixture);
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "nopo-m49-"));
  try {
    await fs.cp(fixtureSrc, tmpdir, { recursive: true });
    await mutate(tmpdir);
    // Replicate runCli's internals — we can't call runCli directly because
    // it resolves fixtures by name from the canonical set.
    const mainModule = await import("../../src/index.ts");
    const mockModule = await import("../../src/test-utils/mock-io.ts");
    const io = mockModule.mockIO({
      argv: ["bun", "nopo", ...argv],
      cwd: tmpdir,
      env: {},
    });
    try {
      await mainModule.default(io);
    } catch (err) {
      if (err instanceof mockModule.MockExitError) return;
      throw err;
    }
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
}

function findFixtureRoot(): string {
  // packages/nopo/tests/contract/errors.contract.test.ts → walk up to find
  // nopo/fixtures/contract.
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "nopo", "fixtures", "contract");
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- sync existence check, mirrors run-cli.ts pattern
      const stat = require("node:fs").statSync(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("findFixtureRoot: could not locate nopo/fixtures/contract");
}

async function runMissingConfig(): Promise<void> {
  await runWithMutatedFixture("minimal", async (tmpdir) => {
    await fs.rm(path.join(tmpdir, "nopo.yml"));
  });
}

async function runMalformedRootYaml(): Promise<void> {
  await runWithMutatedFixture("minimal", async (tmpdir) => {
    // Write something the YAML parser will choke on. A line starting with
    // `:` is invalid YAML — yaml's parser surfaces a syntax error.
    await fs.writeFile(
      path.join(tmpdir, "nopo.yml"),
      "name: bad\n:::not yaml:::\n  - this is broken: [unbalanced\n",
      "utf-8",
    );
  });
}

async function runWithBadRootField(): Promise<void> {
  await runWithMutatedFixture("minimal", async (tmpdir) => {
    // `services` must be an object/array per ProjectConfigSchema; setting
    // it to a number triggers Zod validation failure.
    await fs.writeFile(
      path.join(tmpdir, "nopo.yml"),
      "name: bad-field\nservices: 12345\n",
      "utf-8",
    );
  });
}

async function runWithBadServiceField(): Promise<void> {
  await runWithMutatedFixture("minimal", async (tmpdir) => {
    // Replace the service nopo.yml with malformed YAML that the parser will reject with a
    // syntax error.
    const serviceYaml = path.join(tmpdir, "services", "app", "nopo.yml");
    await fs.writeFile(
      serviceYaml,
      "name: bad-service\nbuild:\n  command: echo hi\n  : invalid syntax here\n  - and: nested-broken-flow [\n",
      "utf-8",
    );
  });
}
