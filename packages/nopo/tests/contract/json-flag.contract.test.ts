import { describe, expect, it } from "vitest";

import { runCli } from "../../src/test-utils/run-cli.ts";

// `--json` flag contract test (M3 → M5 / DAG render). M3 added `--json` as a
// no-behavior-change sibling of `--print`. M4 migrated CI consumers to `--print --json`.

// Single `runCli` per test usually completes in 2-3s on this fixture, but CI / slower
// laptops occasionally bump up against vitest's 5s default. Bump the suite-level timeout
describe("--json flag (M3)", { timeout: 30_000 }, () => {
  it("`build --print --json` emits parseable JSON with the documented DryRunOutput keys", async () => {
    const io = await runCli({
      fixture: "packages-and-services",
      argv: ["build", "--print", "--json"],
    });

    const text = io.stdout.text().trim();
    expect(text).not.toBe("");
    expect(text.startsWith("{")).toBe(true);
    expect(text.endsWith("}")).toBe(true);

    const parsed = JSON.parse(text);
    // Shape contract — must match `DryRunOutput` in `src/print.ts`.
    expect(Object.keys(parsed).sort()).toEqual(
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
    expect(parsed.command).toBe("build");
  });

  it("`build --print` (no --json) emits a rendered DAG, not JSON", async () => {
    // M5 flipped the default: bare --print now renders an ASCII DAG. Lock in that the first
    // non-blank line of stdout is NOT a JSON document — `--print --json` remains the explicit
    const io = await runCli({
      fixture: "packages-and-services",
      argv: ["build", "--print"],
    });

    const text = io.stdout.text();
    expect(text).not.toBe("");
    // A rendered DAG starts with a column-header line of `─` glyphs (or a `Plan:` summary line
    // for trivial plans). Either way it must not parse as JSON.
    expect(text.trimStart().startsWith("{")).toBe(false);
    expect(() => JSON.parse(text)).toThrow();
  });

  it("`build --json` (without --print) does NOT emit JSON — flag is inert without --print", async () => {
    // M3 contract: `--json` is a sibling of `--print`. It only takes effect when paired with
    // `--print`. On its own, it parses cleanly (no error) but does NOT trigger the dry-run
    const io = await runCli({
      fixture: "packages-and-services",
      // Use `list --json` would conflict with the `list` script's own `--json` flag — instead
      // use `build --json` which has no executable observable surface in the test harness
      argv: ["build", "--json"],
    });

    // Without --print, the dry-run interceptor in Runner.run() does NOT fire — so the JSON
    // dry-run document does NOT appear on stdout. M10 then wires the streaming renderer
    expect(io.exitCode).toBe(null);
    const text = io.stdout.text();
    expect(text.trimStart().startsWith("{")).toBe(false);
    expect(() => JSON.parse(text)).toThrow();
  });
});
