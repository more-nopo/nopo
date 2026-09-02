/** Load the age private identity by spawning an operator-supplied command. Threat model:
 * The age private key MUST NOT live on disk in any path nopo controls. We don't read it
 * from `.nopo/sops-age.key`, we don't read it from a plaintext env var, and there is no
 * `--key-file` flag. Both of those patterns expose the key to: any npm postinstall script
 */
import { spawn } from "node:child_process";

const ENV_VAR = "NOPO_AGE_IDENTITY_COMMAND";
const DEFAULT_TIMEOUT_MS = 60_000;
const IDENTITY_PREFIX = "AGE-SECRET-KEY-";

interface LoadIdentityOptions {
  /**
   * Override `process.env`. Tests inject a clean env; nopo scripts inject
   * their threaded `io.env` so all OS access flows through the IO layer.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the 60-second wall-clock timeout. Tests use a shorter budget
   * to exercise the timeout path without waiting a real minute.
   */
  timeoutMs?: number;
}

/** Run the operator's `NOPO_AGE_IDENTITY_COMMAND` and return the trimmed age identity
 * string from its stdout. 1. Reads `NOPO_AGE_IDENTITY_COMMAND` from env. Throws an
 * actionable error if missing. 2. Spawns the command via `shell: true`. stdin and stderr
 * inherit so interactive auth prompts (1Password biometrics, GPG passphrase) and any error
 */
export async function loadIdentity(
  opts: LoadIdentityOptions = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const command = env[ENV_VAR];
  if (!command || command.trim() === "") {
    throw new Error(
      `${ENV_VAR} is not set. Set it to a shell command that emits your age identity on stdout. Examples:
  # 1Password
  export ${ENV_VAR}="op read 'op://Vault/nopo/age-identity'"
  # macOS Keychain
  export ${ENV_VAR}="security find-generic-password -w -s nopo-age-identity"
  # pass
  export ${ENV_VAR}="pass nopo/age-identity"
  # k8s mount / CI
  export ${ENV_VAR}="cat /run/secrets/nopo-age-identity"
See nopo/docs/cli/commands/secret.md for the full setup.`,
    );
  }

  const stdoutChunks: Buffer[] = [];
  // `detached: true` puts the shell in its own process group so we can SIGKILL the entire
  // subtree on timeout. With `shell: true` alone, some shells fork the actual command
  const child = spawn(command, {
    shell: true,
    stdio: ["inherit", "pipe", "inherit"],
    detached: true,
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });

  // If the timer wins, we SIGKILL the whole process group — single-PID kill misses
  // subprocesses on shells that don't exec — and resolve with a timeout marker.
  const result = await new Promise<{ exitCode: number } | "timeout">(
    (resolve, reject) => {
      let resolved = false;

      child.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        reject(err);
      });
      child.on("close", (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? 0 });
      });

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try {
          // Negative PID targets the process group. The shell is the
          // group leader (`detached: true` did this).
          process.kill(-(child.pid ?? 0), "SIGKILL");
        } catch {
          // Fall back to single-PID. Worst case, the grandchild lingers but the event loop frees
          // regardless because we resolve here.
          try {
            child.kill("SIGKILL");
          } catch {
            // Already dead.
          }
        }
        resolve("timeout");
      }, timeoutMs);
    },
  );

  if (result === "timeout") {
    throw new Error(
      `${ENV_VAR} took longer than ${timeoutMs}ms to produce output. If the command needs interactive auth, set up your auth session (e.g. \`op signin\`, GPG agent, kubelogin) before running nopo.`,
    );
  }
  const { exitCode } = result;

  if (exitCode !== 0) {
    throw new Error(
      `${ENV_VAR} exited with code ${exitCode}. Its error output was streamed to your terminal — fix the underlying secret-manager command and retry.`,
    );
  }

  const identity = Buffer.concat(stdoutChunks).toString("utf-8").trim();
  if (!identity.startsWith(IDENTITY_PREFIX)) {
    throw new Error(
      `${ENV_VAR} did not produce a value that looks like an age identity. Expected output starting with \`${IDENTITY_PREFIX}\`; got ${identity.length} bytes starting with "${identity.slice(0, 20)}...". Check that the command is fetching the right secret.`,
    );
  }
  return identity;
}
