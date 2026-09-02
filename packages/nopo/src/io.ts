import { spawn as childSpawn, type SpawnOptions } from "node:child_process";
import process from "node:process";
import type { Readable } from "node:stream";

import { trackChild } from "./child-registry.ts";

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
  stdio?: "pipe" | "inherit" | "ignore";
  /** Optional UTF-8 string to write to the child's stdin, then close the stream. The pattern
   * that motivates this on the buffered `IO.spawn` primitive is `kubectl apply -f -` —
   * kubectl waits for stdin EOF before parsing, so silently dropping `input` deadlocks the
   * call. Mirrors `node:child_process` `options.input`.
   */
  input?: string;
  /** Optional per-chunk callback invoked as the child writes to stdout or stderr. The
   * buffered `SpawnResult` is still returned at the end — the callback is purely additive,
   * used by callers that need streaming output (the default for `ctx.exec` / `ctx.shell`)
   * without sacrificing the captured-output buffer. `mockIO` invokes this synchronously
   */
  onChunk?: (chunk: Buffer, source: "stdout" | "stderr") => void;
  /** Optional AbortSignal that, when triggered, sends SIGTERM to the child. The Promise still
   * resolves with the child's exit code (which will typically be non-zero / null for a
   * terminated process) — abort is NOT a rejection. Motivating use case: long-running
   * streaming watchers like `kubectl get events --watch` or `kubectl logs -f` that
   */
  signal?: AbortSignal;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface IO {
  argv: string[];
  /** Typed as `NodeJS.ProcessEnv` so realIO can pass `process.env` through directly — index
   * access returns `string | undefined` because Node treats unknown keys as undefined, not
   * because the live env literally stores undefined values. This keeps `realIO.env` a LIVE
   * reference to `process.env` (mutations made by tests / setup are visible) rather than
   */
  env: NodeJS.ProcessEnv;
  cwd(): string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  stdin: Readable;
  exit(code: number): never;
  spawn(cmd: string, args: string[], opts?: SpawnOpts): Promise<SpawnResult>;
  platform: NodeJS.Platform;
}

/** Spawns real child processes, reads/writes the real process std streams, and exits the
 * real process. Used by `bin.ts` to boot the CLI; tests construct their own `IO` with
 * in-memory buffers. `env` / `stdin` / `stdout` / `stderr` are exposed as live getters —
 * NOT captured at instantiation. Tests that swap `process.stdin`
 */
class RealIO implements IO {
  readonly argv = process.argv;
  readonly platform = process.platform;

  get env(): NodeJS.ProcessEnv {
    return process.env;
  }
  get stdout(): { write(s: string): void } {
    return process.stdout;
  }
  get stderr(): { write(s: string): void } {
    return process.stderr;
  }
  get stdin(): Readable {
    return process.stdin;
  }

  cwd(): string {
    return process.cwd();
  }

  exit(code: number): never {
    return process.exit(code);
  }

  spawn(
    cmd: string,
    args: string[],
    opts: SpawnOpts = {},
  ): Promise<SpawnResult> {
    return new Promise<SpawnResult>((resolve, reject) => {
      const spawnOptions: SpawnOptions = {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: opts.stdio ?? "pipe",
        shell: false,
      };

      const proc = childSpawn(cmd, args, spawnOptions);
      // Register so a command timeout can terminate in-flight subprocesses.
      trackChild(proc);

      // We don't reject on abort — the child is still expected to exit (via SIGTERM handling or
      // as a forced kill) and `close` resolves the promise normally with whatever exit code it
      if (opts.signal) {
        if (opts.signal.aborted) {
          proc.kill("SIGTERM");
        } else {
          opts.signal.addEventListener(
            "abort",
            () => {
              proc.kill("SIGTERM");
            },
            { once: true },
          );
        }
      }

      // Write `opts.input` to stdin and close it so the child sees EOF. Without this, commands
      // like `kubectl apply -f -` block forever waiting on stdin. EPIPE is benign — the child
      if (opts.input !== undefined && proc.stdin) {
        const isEpipe = (err: unknown): boolean =>
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          err.code === "EPIPE";
        proc.stdin.on("error", (err) => {
          if (!isEpipe(err)) reject(err);
        });
        try {
          proc.stdin.write(opts.input);
          proc.stdin.end();
        } catch (err) {
          if (!isEpipe(err)) {
            reject(err);
            return;
          }
        }
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      if (proc.stdout) {
        proc.stdout.on("data", (chunk: Buffer) => {
          stdoutChunks.push(chunk);
          opts.onChunk?.(chunk, "stdout");
        });
      }
      if (proc.stderr) {
        proc.stderr.on("data", (chunk: Buffer) => {
          stderrChunks.push(chunk);
          opts.onChunk?.(chunk, "stderr");
        });
      }

      proc.on("error", (err) => {
        reject(err);
      });

      proc.on("close", (code) => {
        resolve({
          exitCode: code ?? 0,
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
        });
      });
    });
  }
}

export const realIO: IO = new RealIO();
