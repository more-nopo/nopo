import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import main from "../index.ts";
import {
  MockExitError,
  type MockIO,
  mockIO,
  type MockIOInput,
} from "./mock-io.ts";

/** Test-only helper that boots the CLI against a canonical fixture and returns the
 * populated `MockIO` so tests can assert on the full observable contract (stdout text,
 * stderr text, exit code, captured spawn invocations). Layered on top of the M3.1
 * `mockIO()` primitive. See the RFC at `decisions/0010_plan_then_execute_rfc.md` §
 */

/** Inputs to `runCli`. */
export interface RunCliInput {
  /**
   * Fixture name under `nopo/fixtures/contract/`. The fixture is copied
   * into a fresh tmpdir, `mockIO.cwd()` returns that tmpdir, and `main()`
   * runs with that tmpdir as the project root.
   */
  fixture: string;
  /** Do NOT include the binary name — `runCli` prepends `["bun", "nopo"]` so
   * `argv[0]/argv[1]` are positioned the way the CLI expects (`io.argv.slice(2)` is what
   * `main()` parses).
   */
  argv: string[];
  /**
   * Optional environment overrides. Defaults to `{}` — a clean env with
   * no leakage from the real `process.env`. Same default as `mockIO`.
   */
  env?: Record<string, string>;
  /** Optional spawn override; same semantics as `mockIO`'s `onSpawn`. */
  onSpawn?: MockIOInput["onSpawn"];
  /** Optional stdin Readable; defaults to a closed stream. */
  stdin?: MockIOInput["stdin"];
  /** Optional platform override; defaults to "linux". */
  platform?: MockIOInput["platform"];
}

/** `runCli` returns the populated `MockIO`. Tests assert on: `result.stdout.text()` —
 * captured stdout `result.stderr.text()` — captured stderr `result.exitCode` — captured
 * exit code (`null` if main returned without calling `io.exit`, equivalent to a clean
 * completion) `result.spawns` — every `io.spawn` invocation the CLI made The tmpdir is
 */
export type RunCliResult = MockIO;

/** Resolve the absolute path to the canonical fixture root by walking up from this file
 * (`packages/nopo/src/test-utils/run-cli.ts`) until we find a directory containing
 * `nopo/fixtures/contract`. Robust to the file's depth changing — don't assume a fixed
 * `..` count.
 */
function resolveFixtureRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  // Cap the walk so a misconfigured tree can't loop forever.
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "nopo", "fixtures", "contract");
    try {
      if (nodeFs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `runCli: could not locate nopo/fixtures/contract starting from ${path.dirname(fileURLToPath(import.meta.url))}`,
  );
}

const FIXTURE_ROOT = resolveFixtureRoot();

/** Boot the CLI against a canonical fixture and return the populated `MockIO`. See
 * `RunCliInput` for input shape. Implementation contract: Creates a fresh tmpdir under
 * `os.tmpdir()/nopo-runcli-*`. Deep-copies `nopo/fixtures/contract/<fixture>` into that
 * tmpdir. Constructs a `MockIO` with `cwd = <tmpdir>`
 */
export async function runCli(input: RunCliInput): Promise<RunCliResult> {
  const fixtureSrc = path.join(FIXTURE_ROOT, input.fixture);
  const fixtureSrcStat = await fs.stat(fixtureSrc).catch(() => null);
  if (!fixtureSrcStat?.isDirectory()) {
    throw new Error(
      `runCli: fixture '${input.fixture}' not found at ${fixtureSrc}`,
    );
  }

  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "nopo-runcli-"));
  try {
    await fs.cp(fixtureSrc, tmpdir, { recursive: true });

    const io = mockIO({
      // Match production bin.ts shape: argv[0] = runtime, argv[1] = bin path, argv[2..] = the
      // user-supplied command + flags. `main()` does `io.argv.slice(2)`, so this gives the CLI
      argv: ["bun", "nopo", ...input.argv],
      cwd: tmpdir,
      env: input.env ?? {},
      onSpawn: input.onSpawn,
      stdin: input.stdin,
      platform: input.platform,
    });

    try {
      await main(io);
    } catch (err) {
      if (err instanceof MockExitError) {
        // Expected — `mockIO.exit()` throws to halt control flow the same way `process.exit()`
        // does. The exit code is already on `io.exitCode`. Swallow and return the populated mock.
      } else {
        throw err;
      }
    }

    return io;
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
}
