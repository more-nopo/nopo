import { describe, expect } from "vitest";

import {
  type ContractCase,
  expectExitCode,
  expectNoSpawns,
  expectSpawn,
  expectStdoutContains,
  runContractTable,
} from "../../src/test-utils/contract.ts";

// M4.8 contract test matrix for plugin-introduced top-level commands (`nopo <plugin>
// <cmd>`). Lives alongside the M4.1/M4.2 PoC contracts and follows the same

const cases: ContractCase[] = [
  // GROUP A: plugin discovery surface `nopo` (no args) and `nopo --help` print the
  // discovered command set through `console.log` — NOT `io.stdout`. We can't assert
  {
    name: "A1 plugin-commands: bare `nopo` exits 0 (lists discovered commands; help goes via console.log so io.stdout is empty)",
    fixture: "plugin-commands",
    argv: [],
    expect: (io) => {
      expectExitCode(io, 0);
      // Help is printed via console.log, not io.stdout. Locked down here
      // so a future migration to io.stdout doesn't silently regress.
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "A2 plugin-commands: `nopo --help` exits 0 (general help via console.log)",
    fixture: "plugin-commands",
    argv: ["--help"],
    expect: (io) => {
      expectExitCode(io, 0);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "A3 minimal: bare `nopo` (no plugins loaded) exits 0 — no Plugin Commands section but no error",
    fixture: "minimal",
    argv: [],
    expect: (io) => {
      expectExitCode(io, 0);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "A4 plugin-commands: `nopo unknown-plugin foo` falls through to Command script — Command throws 'Unknown target' → exit 1",
    // script falls through to `Command` (index.ts §353). Command parses `foo` as a target
    // name; `app` is the only target → throws "Unknown target 'foo'. Available targets: app".
    fixture: "plugin-commands",
    argv: ["unknown-plugin", "foo"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },

  // GROUP B: per-plugin command invocation (cli-plugin from fixture) The four `cli-plugin`
  // commands probe each surface of the plugin-command
  {
    name: "B1 plugin-commands: `cli-plugin hello` writes to io.stdout, exits cleanly, no spawns",
    fixture: "plugin-commands",
    argv: ["cli-plugin", "hello"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.stdout.text()).toBe("cli-plugin:hello\n");
      expectNoSpawns(io);
    },
  },
  {
    name: "B2 plugin-commands: `cli-plugin print-args alpha beta` exposes positionals via ctx.positionals",
    fixture: "plugin-commands",
    argv: ["cli-plugin", "print-args", "alpha", "beta"],
    expect: (io) => {
      expectExitCode(io, null);
      // Plugin echoes the parsed positionals as JSON. Locks down the
      // positional-extraction loop in runPluginCommand (index.ts §445-458).
      expect(io.stdout.text()).toBe('{"positionals":["alpha","beta"]}\n');
      expectNoSpawns(io);
    },
  },
  {
    name: "B3 plugin-commands: `cli-plugin print-args --who kevin alpha` strips --flag pair, leaves positionals",
    // a flag AND its value if the next token doesn't start with `-`. So `--who kevin alpha`
    // yields positionals ["alpha"].
    fixture: "plugin-commands",
    argv: ["cli-plugin", "print-args", "--who", "kevin", "alpha"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.stdout.text()).toBe('{"positionals":["alpha"]}\n');
    },
  },
  {
    name: "B4 plugin-commands: `cli-plugin shell` spawns a subprocess via ctx.shell (captured by MockIO)",
    fixture: "plugin-commands",
    argv: ["cli-plugin", "shell"],
    expect: (io) => {
      expectExitCode(io, null);
      // ctx.shell()`echo plugin-cmd-shelled` → spawn("echo", ["plugin-cmd-shelled"])
      expectSpawn(
        io,
        (s) => s.cmd === "echo" && s.args.includes("plugin-cmd-shelled"),
      );
      expect(io.spawns.length).toBe(1);
    },
  },
  {
    name: "B5 plugin-commands: `cli-plugin shell` with onSpawn returning exit 7 → ProcessOutput throws → exit 1, spawn was attempted",
    fixture: "plugin-commands",
    argv: ["cli-plugin", "shell"],
    onSpawn: () => ({ exitCode: 7, stdout: "", stderr: "spawn failed" }),
    expect: (io) => {
      expectExitCode(io, 1);
      // Spawn was made — the failure is propagated through
      // IOBackedProcessPromise → ProcessOutput → caught by main's try/catch.
      expect(io.spawns.length).toBe(1);
      // onSpawn's stderr text is replayed through onChunk into io.stderr.
      expect(io.stderr.text()).toContain("spawn failed");
    },
  },
  {
    name: "B6 plugin-commands: `cli-plugin boom` (plugin throws) → main catches, exit 1, no spawns",
    fixture: "plugin-commands",
    argv: ["cli-plugin", "boom"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      // Error message is logged through runner.logger (console), not io.
      expect(io.stdout.text()).toBe("");
      expect(io.stderr.text()).toBe("");
    },
  },
  {
    name: "B7 plugin-commands: `shadow-plugin noop` (second plugin) dispatches and exits cleanly",
    // Confirms multi-plugin loading: shadow-plugin's command is reachable even though
    // cli-plugin loads first. Locks the dispatch lookup in findPluginByName (index.ts §381)
    fixture: "plugin-commands",
    argv: ["shadow-plugin", "noop"],
    expect: (io) => {
      expectExitCode(io, null);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },

  // GROUP C: plugin help variants `nopo <plugin>` (no subcommand), `nopo <plugin> --help`,
  // and `nopo <plugin> help` all funnel through `printPluginHelp` and exit 0.
  {
    name: "C1 plugin-commands: `nopo cli-plugin` (no subcommand) → printPluginHelp, exit 0",
    fixture: "plugin-commands",
    argv: ["cli-plugin"],
    expect: (io) => {
      expectExitCode(io, 0);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "C2 plugin-commands: `nopo cli-plugin --help` → printPluginHelp, exit 0",
    fixture: "plugin-commands",
    argv: ["cli-plugin", "--help"],
    expect: (io) => {
      expectExitCode(io, 0);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "C3 plugin-commands: `nopo cli-plugin help` (special-cased subcommand name 'help') → printPluginHelp, exit 0",
    fixture: "plugin-commands",
    argv: ["cli-plugin", "help"],
    expect: (io) => {
      expectExitCode(io, 0);
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },
  {
    name: "C4 plugin-commands: `nopo cli-plugin no-such-subcmd` → printHelp(unknown plugin command), exit 1",
    fixture: "plugin-commands",
    argv: ["cli-plugin", "no-such-subcmd"],
    expect: (io) => {
      expectExitCode(io, 1);
      // Error message via console.log; io.stdout stays empty.
      expect(io.stdout.text()).toBe("");
      expectNoSpawns(io);
    },
  },

  // GROUP D: workspace plugin commands (skipped — not pre-built) The `nopo/plugins/<name>`
  // workspace packages
  {
    name: "D1 docker (workspace plugin): commands surface untestable",
    fixture: "all-plugins",
    argv: ["docker"],
    skip: "docker plugin package not pre-built (nopo/plugins/docker/dist missing); need vitest setup to build workspace plugins or fixture-local node_modules",
    expect: () => {
      // No-op: skipped above.
    },
  },
  {
    name: "D2 docker-compose (workspace plugin): commands surface untestable",
    fixture: "all-plugins",
    argv: ["docker-compose"],
    skip: "docker-compose plugin package not pre-built; same gap as D1",
    expect: () => {
      // No-op: skipped above.
    },
  },
  {
    name: "D3 terraform deployed-sha (workspace plugin): untestable",
    fixture: "all-plugins",
    argv: ["terraform", "deployed-sha"],
    skip: "terraform plugin package not pre-built; same gap as D1",
    expect: () => {
      // No-op: skipped above.
    },
  },
  {
    name: "D4 playwright e2e (workspace plugin): untestable",
    fixture: "all-plugins",
    argv: ["playwright", "e2e"],
    skip: "playwright plugin package not pre-built; same gap as D1",
    expect: () => {
      // No-op: skipped above.
    },
  },
  {
    name: "D5 diff check (workspace plugin): untestable",
    fixture: "all-plugins",
    argv: ["diff", "check", "--since", "HEAD~1"],
    skip: "diff plugin package not pre-built; same gap as D1",
    expect: () => {
      // No-op: skipped above.
    },
  },
  {
    name: "D6 docs build/dev/serve (workspace plugin): untestable",
    fixture: "all-plugins",
    argv: ["docs", "build"],
    skip: "docs plugin package not pre-built; same gap as D1",
    expect: () => {
      // No-op: skipped above.
    },
  },
  {
    name: "D7 all-plugins fixture: any invocation triggers loadPlugins failure → exit 1, console.error (NOT io.stderr)",
    // The OBSERVED end-to-end behaviour for the all-plugins fixture today: `await
    // import("@more-nopo/nopo-plugin-docker")` throws ERR_MODULE_NOT_FOUND, resolvePluginFactory
    fixture: "all-plugins",
    argv: [],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
      expect(io.stdout.text()).toBe("");
      expect(io.stderr.text()).toBe("");
    },
  },

  // GROUP E: command precedence + plugin hook ordering E1-E2 lock down precedence between
  // top-level token sources (plugins vs built-in scripts vs user-defined commands). E3 locks
  {
    name: "E1 plugin-commands: top-level `noop` (a plugin SUBcommand name) is NOT shadowed — falls through to Command",
    // shadow-plugin has a subcommand called `noop`. At top level (`nopo noop`),
    // `findPluginByName("noop")` returns undefined (only top-level plugin NAMES match),
    fixture: "plugin-commands",
    argv: ["noop"],
    expect: (io) => {
      expectExitCode(io, 1);
      expectNoSpawns(io);
    },
  },
  {
    name: "E2 plugin-commands: top-level plugin name `cli-plugin` always dispatches to plugin help (precedence over Command fallback)",
    // `cli-plugin` is not a built-in script. Without the plugin-name check, it'd fall through
    // to Command
    fixture: "plugin-commands",
    argv: ["cli-plugin"],
    expect: (io) => {
      expectExitCode(io, 0);
      expectNoSpawns(io);
    },
  },
  {
    name: "E3 plugin-commands: `nopo build` fires pre_build hooks in plugin declaration order (cli-plugin → shadow-plugin)",
    // Both fixture plugins declare `pre_build`. nopo.yml lists cli-plugin first, then
    // shadow-plugin. The hook contract says additive hooks fire in plugin-declaration order.
    fixture: "plugin-commands",
    argv: ["build"],
    expect: (io) => {
      expectExitCode(io, null);
      const text = io.stdout.text();
      const cliIdx = text.indexOf("cli-plugin:pre_build");
      const shadowIdx = text.indexOf("shadow-plugin:pre_build");
      expect(cliIdx).toBeGreaterThanOrEqual(0);
      expect(shadowIdx).toBeGreaterThanOrEqual(0);
      // cli-plugin fires before shadow-plugin (declaration order in nopo.yml).
      expect(cliIdx).toBeLessThan(shadowIdx);
    },
  },
  {
    name: "E4 plugin-commands: `cli-plugin hello --print` does NOT short-circuit (plugin-command path bypasses central --print interception)",
    // runPluginCommand bypasses that — the flag is just a normal arg the plugin can choose to
    // honour. The fixture plugin ignores --print, so `hello` runs normally and writes
    fixture: "plugin-commands",
    argv: ["cli-plugin", "hello", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectStdoutContains(io, "cli-plugin:hello");
    },
  },
  {
    name: "E5 plugin-commands: `cli-plugin shell --print` still spawns (no --print short-circuit on the plugin-command path)",
    // Same observation as E4: --print does NOT prevent the spawn.
    fixture: "plugin-commands",
    argv: ["cli-plugin", "shell", "--print"],
    expect: (io) => {
      expectExitCode(io, null);
      expectSpawn(io, (s) => s.cmd === "echo");
    },
  },
];

describe("nopo plugin commands (contract)", () => {
  runContractTable(cases);
});
