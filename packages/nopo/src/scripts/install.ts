import { baseArgs } from "../args.ts";
import type { PackageManagerConfig } from "../config/index.ts";
import { resolveInstallCommand } from "../config/index.ts";
import { Script } from "../lib.ts";
import { type Plan, planFromNodes } from "../plan.ts";
import type { ScriptArgs } from "../script-args.ts";

/**
 * Minimal logger surface — matches `Runner#logger` (lib.ts:Logger). Defined
 * locally so {@link installRun} can be tested with a lightweight stub.
 */
export interface InstallLogger {
  log(...args: unknown[]): void;
}

/** Outcome of an exec call as the handler sees it — only the fields the install loop reads
 * (`exitCode` for branching, `stderr` for error text). The real `exec` from lib.ts returns
 * a `ProcessPromise` that extends `Promise<ProcessOutput>`; this narrower structural alias
 * lets tests supply a plain async function without `as unknown as` casts and keeps
 */
export interface InstallExecResult {
  exitCode: number;
  stderr: string;
}

/** Structural shape of the `exec` dependency {@link installRun} consumes. */
export type InstallExec = (
  cmd: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => Promise<InstallExecResult>;

/** Inputs to {@link installRun} — the pure builtin behind the `"install:run"` plan node.
 * `packageManagers` is pre-resolved by the dispatch table (or test caller). `env` and
 * `exec` are likewise threaded in so the handler stays free of `Runner` dependencies.
 */
interface InstallRunContext {
  packageManagers: readonly PackageManagerConfig[];
  env: Record<string, string | undefined>;
  logger: InstallLogger;
  exec: InstallExec;
}

/** Run `package_manager.install` for every resolved package manager. Mirrors the legacy
 * `InstallScript.fn()` body — sequential install loop, non-zero exit terminates with a
 * thrown error containing the failed PM and its stderr. When no PMs are configured, logs a
 * single line and returns; the contract test suite locks this no-op path down.
 */
export async function installRun(ctx: InstallRunContext): Promise<void> {
  const { packageManagers, env, logger } = ctx;

  if (packageManagers.length === 0) {
    logger.log("No package managers configured for targets");
    return;
  }

  for (const pm of packageManagers) {
    logger.log(`Installing ${pm.name} dependencies...`);
    // `dev` — everything, and deliberately not frozen. Installing something new and updating
    // the lockfile is what this command is for. CI does not come through here;
    const command = resolveInstallCommand(pm.install, "dev");
    const result = await ctx.exec("sh", ["-c", command], {
      cwd: pm.cwd,
      env,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `${pm.name} install failed (exit ${result.exitCode})\n${result.stderr}`,
      );
    }
    logger.log(`${pm.name} install complete`);
  }
}

export default class InstallScript extends Script {
  static override name = "install";
  static override description = "Install dependencies";
  static override args = baseArgs.extend({});

  /** Single-node plan dispatching to {@link installRun} via `"install:run"`. */
  static plan(_args: ScriptArgs, _scope: { targets: readonly string[] }): Plan {
    return planFromNodes([
      {
        id: "install",
        handler: { kind: "builtin", name: "install:run" },
        needs: [],
        meta: { script: "install" },
      },
    ]);
  }
}
