// We import `it` from "vitest" explicitly even though the project's `vitest.config.ts`
// sets `globals: true`. The convention across `packages/nopo/tests/*.test.ts`
import { basename, dirname, extname, join } from "node:path";
import { expect, it } from "vitest";

import type { MockIO, MockIOInput, SpawnRecord } from "./mock-io.ts";
import { runCli } from "./run-cli.ts";

/** Each `ContractCase` describes one row of the contract test matrix from the
 * plan-then-execute RFC (`decisions/0010_plan_then_execute_rfc.md` § "Test matrix").
 * `runContractTable(cases)` produces one vitest test per row inside the surrounding
 * `describe()` block. The pattern is the deliverable; M4.1–M4.9 will populate the matrix
 */

/** One row of the contract test matrix. */
export interface ContractCase {
  /** Human-readable name shown in the test runner. */
  name: string;
  /** Fixture name to load (e.g. "minimal", "with-secrets"). */
  fixture: string;
  /** CLI argv (without binary name); passed to `runCli`. */
  argv: string[];
  /** Optional env overrides; passed to `runCli`. Defaults to `{}` (clean). */
  env?: Record<string, string>;
  /** Optional stdin — for tests that pipe input (e.g. `--from-stdin`). */
  stdin?: MockIOInput["stdin"];
  /**
   * Optional `onSpawn` handler — let the test stub external spawns.
   * Forwarded to `mockIO`. See `mock-io.ts` for the contract.
   */
  onSpawn?: MockIOInput["onSpawn"];
  /**
   * Assertions on the populated `MockIO`. Receives the full mock so
   * tests can inspect any of the four observable surfaces (stdout,
   * stderr, exit code, spawns).
   */
  expect: (io: MockIO) => void | Promise<void>;
  /**
   * Optional: skip this case. Pass a string to record the reason in
   * the test name. Use sparingly — prefer fixing the underlying gap.
   */
  skip?: boolean | string;
  /**
   * Optional: mark this case `only` for focused debugging. Standard
   * vitest `.only` semantics — skip everything else in the suite.
   */
  only?: boolean;
  /**
   * Opt out of the auto `--print` snapshot. Defaults to on for any case
   * whose argv includes `--print` and whose stdout parses as JSON.
   */
  snapshotPrint?: false;
  /** Opt OUT of auto-injecting `--json` after `--print`. M5 flipped `--print`'s default from
   * JSON to a rendered ASCII DAG; the contract suite predates that flip and asserts the JSON
   * shape via `parsePrintPlan`, so the runner appends `--json` whenever it sees `--print`
   * without `--json`. Tests that want to lock down the NEW rendered-DAG output set
   */
  printRendered?: true;
}

/** Generate one vitest `it()` per case. Call from inside a `describe()` block in the test
 * file — `runContractTable` does NOT wrap its output in a `describe`, so the caller
 * controls grouping. ```ts describe("nopo build (contract)", () => { runContractTable([ {
 * name: "minimal: exits cleanly", fixture: "minimal", argv: ["build"], ]); }); ```
 */
export function runContractTable(cases: ContractCase[]): void {
  for (const c of cases) {
    const skipReason = typeof c.skip === "string" ? ` [skip: ${c.skip}]` : "";
    const name = `${c.name}${skipReason}`;
    const t = c.skip ? it.skip : c.only ? it.only : it;
    t(name, async (ctx) => {
      const io = await runCli({
        fixture: c.fixture,
        argv: maybeInjectJsonFlag(c),
        env: c.env,
        stdin: c.stdin,
        onSpawn: c.onSpawn,
      });
      await c.expect(io);
      await maybeSnapshotPrint(ctx, c, io);
    });
  }
}

/** The contract test suite predates that flip and asserts on JSON shape via
 * `parsePrintPlan`. To keep every existing case green without per-case argv churn, we
 * auto-append `--json` whenever the test argv includes `--print` but not `--json`. Cases
 * that want to lock in the new rendered output set `printRendered: true` to skip
 */
function maybeInjectJsonFlag(c: ContractCase): string[] {
  if (c.printRendered === true) return c.argv;
  if (!c.argv.includes("--print")) return c.argv;
  if (c.argv.includes("--json")) return c.argv;
  return [...c.argv, "--json"];
}

/** For any case that ran `--print` and produced a parseable JSON document on stdout,
 * snapshot the full payload to `<test-file-dir>/__snapshots__/<file-stem>/<slug>.json`.
 * Lets every scenario contribute DAG-shape coverage without per-case wiring. Skipped
 * silently when: argv didn't include `--print` stdout is empty (validation error path)
 */
async function maybeSnapshotPrint(
  ctx: { task: { file?: { filepath: string } | undefined; name: string } },
  c: ContractCase,
  io: MockIO,
): Promise<void> {
  if (c.snapshotPrint === false) return;
  if (!c.argv.includes("--print")) return;

  const text = io.stdout.text().trim();
  if (!text || !text.startsWith("{")) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }

  const filepath = ctx.task.file?.filepath;
  if (!filepath) return;
  const dir = dirname(filepath);
  // Keep the full file stem (e.g. `build.contract`, `command.contract`) so the snapshot
  // subdir doesn't collide with project-wide gitignores like `**/build/`. Drop only
  const stem = basename(filepath, extname(filepath)).replace(/\.test$/, "");
  const snapshotPath = join(
    dir,
    "__snapshots__",
    stem,
    `${slugify(c.name)}.json`,
  );

  const actual = JSON.stringify(parsed, null, 2) + "\n";
  await expect(actual).toMatchFileSnapshot(snapshotPath);
}

/** Filename-safe slug derived from a test name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Assertion helpers These compose the patterns most contract tests will reach for. They
// are NOT required for `runContractTable` to work — they're sugar so the `expect` callback

/** Assert the CLI exited with the given code (or `null` for clean return). */
export function expectExitCode(io: MockIO, code: number | null): void {
  expect(
    io.exitCode,
    `expected exitCode ${String(code)} but got ${String(io.exitCode)}`,
  ).toBe(code);
}

/** Assert captured stdout contains the substring or matches the regex. */
export function expectStdoutContains(
  io: MockIO,
  needle: string | RegExp,
): void {
  const text = io.stdout.text();
  if (needle instanceof RegExp) {
    expect(text, `stdout did not match ${needle.source}`).toMatch(needle);
  } else {
    expect(text, `stdout did not contain ${JSON.stringify(needle)}`).toContain(
      needle,
    );
  }
}

/** Assert captured stderr contains the substring or matches the regex. */
export function expectStderrContains(
  io: MockIO,
  needle: string | RegExp,
): void {
  const text = io.stderr.text();
  if (needle instanceof RegExp) {
    expect(text, `stderr did not match ${needle.source}`).toMatch(needle);
  } else {
    expect(text, `stderr did not contain ${JSON.stringify(needle)}`).toContain(
      needle,
    );
  }
}

/** Find the first `SpawnRecord` matching `predicate` and return it. Throws a useful error
 * including every observed spawn when no match is found, so the failure message answers
 * "what DID the CLI spawn?" without requiring a re-run with a console.log.
 */
export function expectSpawn(
  io: MockIO,
  predicate: (record: SpawnRecord) => boolean,
  message?: string,
): SpawnRecord {
  const match = io.spawns.find(predicate);
  if (match) return match;
  const observed = io.spawns
    .map((s, i) => `  [${i}] ${s.cmd} ${s.args.join(" ")}`)
    .join("\n");
  const header = message ?? "no spawn matched the predicate";
  const body = io.spawns.length === 0 ? "(no spawns recorded)" : observed;
  expect.fail(`${header}\nobserved spawns:\n${body}`);
}

/**
 * Assert no spawns were recorded. Useful for plan-only / dry-run /
 * parse-only commands (`--print`, `--json`, `list`, `info`) that should
 * never reach for a subprocess.
 */
export function expectNoSpawns(io: MockIO): void {
  if (io.spawns.length === 0) return;
  const observed = io.spawns
    .map((s, i) => `  [${i}] ${s.cmd} ${s.args.join(" ")}`)
    .join("\n");
  expect.fail(
    `expected no spawns but ${io.spawns.length} were recorded:\n${observed}`,
  );
}
