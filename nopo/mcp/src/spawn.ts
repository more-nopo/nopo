import { spawn } from "node:child_process";
import path from "node:path";

const ROOT_DIR = path.resolve(
  import.meta.dirname ?? __dirname,
  "..",
  "..",
  "..",
);
const BIN_PATH = path.join(ROOT_DIR, "packages", "nopo", "bin.ts");

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function spawnNopo(
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SpawnResult> {
  const timeout = Math.min(Math.max(timeoutMs, 1000), MAX_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    const child = spawn("bun", [BIN_PATH, ...args], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ROOT_DIR,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `nopo command timed out after ${timeout}ms: nopo ${args.join(" ")}`,
        ),
      );
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}
