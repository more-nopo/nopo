import { Readable } from "node:stream";

import type { IO, SpawnOpts, SpawnResult } from "../io.ts";

/** `mockIO()` returns an object satisfying the production `IO` interface, but every
 * interaction (spawn calls, stdout/stderr writes, exit codes) is captured into in-memory
 * buffers so a test can boot the CLI against `MockIO` and then assert on the resulting
 * capture surface. This is the foundation of the Phase 1 test harness
 */

/** Recorded spawn invocation. */
export interface SpawnRecord {
  cmd: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  /** UTF-8 string piped to the child's stdin, if any. */
  input: string | undefined;
  /**
   * The result returned to the caller. Tests assert on this when they
   * want to confirm what the call site received (e.g. "the wrapper
   * propagated stderr from the failing command").
   */
  result: SpawnResult;
}

/** Capture buffer exposed by `MockIO.stdout` / `MockIO.stderr`. */
export interface MockStream {
  write(s: string): void;
  /** Concatenated text of every `write()` so far. */
  text(): string;
}

export interface MockIO extends IO {
  spawns: SpawnRecord[];
  stdout: MockStream;
  stderr: MockStream;
  /**
   * Captured exit code from the most recent `exit()` call.
   * `null` if `exit()` has not been called.
   */
  exitCode: number | null;
}

export interface MockIOInput {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: Readable;
  /** Invoked for every `io.spawn()` call to produce the `SpawnResult` returned to the caller.
   * May return a promise for async resolution. If unset (or returns nothing usable), spawn
   * defaults to a successful `{ exitCode: 0, stdout: "", stderr: "" }` so tests that don't
   * care about subprocess output don't have to wire one up.
   */
  onSpawn?: (
    cmd: string,
    args: string[],
    opts?: SpawnOpts,
  ) => SpawnResult | Promise<SpawnResult>;
  platform?: NodeJS.Platform;
}

/** Thrown by `MockIO.exit()` to halt control flow the same way `process.exit()` does in
 * production. The thrown error carries the captured exit code so callers (notably `runCli`
 * in M3.2) can `instanceof`-check it, swallow it, and resolve with the captured `MockIO`
 * instead of letting the test fail with an unhandled throw.
 */
export class MockExitError extends Error {
  constructor(public readonly exitCode: number) {
    super(`MockIO.exit(${exitCode})`);
    this.name = "MockExitError";
  }
}

function createStream(): MockStream {
  const chunks: string[] = [];
  return {
    write(s: string): void {
      chunks.push(s);
    },
    text(): string {
      return chunks.join("");
    },
  };
}

/** Build a `MockIO`. See `MockIOInput` for input shape. `env` → `{}` (clean — no leakage
 * from the real `process.env`) `platform` → `"linux"` `stdin` → an immediately-closed
 * `Readable` (`Readable.from([])`) `onSpawn` → returns `{ exitCode: 0, stdout: "", stderr:
 * "" }`
 */
export function mockIO(input: MockIOInput): MockIO {
  const stdout = createStream();
  const stderr = createStream();
  const spawns: SpawnRecord[] = [];
  const env = input.env ?? {};
  const platform = input.platform ?? "linux";
  const stdin = input.stdin ?? Readable.from([]);
  const onSpawn = input.onSpawn;

  const io: MockIO = {
    argv: input.argv,
    env,
    platform,
    stdin,
    stdout,
    stderr,
    spawns,
    exitCode: null,

    cwd(): string {
      return input.cwd;
    },

    exit(code: number): never {
      io.exitCode = code;
      throw new MockExitError(code);
    },

    async spawn(
      cmd: string,
      args: string[],
      opts?: SpawnOpts,
    ): Promise<SpawnResult> {
      // Honour `opts.signal` — if the caller aborts before/while the mocked `onSpawn` resolves,
      // return immediately with an exit shape that mirrors a SIGTERMed child (143 = 128 + 15).
      const work: Promise<SpawnResult> = onSpawn
        ? Promise.resolve(onSpawn(cmd, args, opts))
        : Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      let result: SpawnResult;
      if (opts?.signal) {
        const aborted = new Promise<SpawnResult>((resolve) => {
          const onAbort = (): void => {
            resolve({ exitCode: 143, stdout: "", stderr: "" });
          };
          if (opts.signal!.aborted) {
            onAbort();
            return;
          }
          opts.signal!.addEventListener("abort", onAbort, { once: true });
        });
        result = await Promise.race([work, aborted]);
      } else {
        result = await work;
      }
      // Replay buffered output through `onChunk` so callers exercising the streaming surface
      // (default for `stdio: "pipe"`) see the same forwarding behaviour they do against `realIO`
      if (opts?.onChunk) {
        if (result.stdout) opts.onChunk(Buffer.from(result.stdout), "stdout");
        if (result.stderr) opts.onChunk(Buffer.from(result.stderr), "stderr");
      }
      spawns.push({
        cmd,
        args,
        cwd: opts?.cwd,
        env: opts?.env,
        input: opts?.input,
        result,
      });
      return result;
    },
  };

  return io;
}
