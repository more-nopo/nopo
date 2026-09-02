import { baseArgs } from "../args.ts";
import type { PackageManagerConfig } from "../config/index.ts";
import { Script } from "../lib.ts";
import { type Plan, planFromNodes } from "../plan.ts";
import type { ScriptArgs } from "../script-args.ts";
import type { InstallExec } from "./install.ts";

/**
 * Minimal logger surface — matches `Runner#logger` (lib.ts:Logger). Defined
 * locally so {@link syncRun} can be tested with a lightweight stub.
 */
export interface SyncLogger {
  log(...args: unknown[]): void;
}

/**
 * Inputs to {@link syncRun} — the pure builtin behind the `"sync:run"` plan
 * node. Same shape as {@link import("./install.ts").InstallRunContext} — the
 * only difference is which command runs (`pm.sync` vs `pm.install`).
 */
interface SyncRunContext {
  packageManagers: readonly PackageManagerConfig[];
  env: Record<string, string | undefined>;
  logger: SyncLogger;
  /** Reuses {@link InstallExec} — same structural shape, same call sites. */
  exec: InstallExec;
}

/** Run `package_manager.sync` for every resolved package manager. Mirrors the legacy
 * `SyncScript.fn()` body — sequential sync loop, non-zero exit terminates with a thrown
 * error containing the failed PM and its stderr. When no PMs are configured, logs a single
 * line and returns.
 */
export async function syncRun(ctx: SyncRunContext): Promise<void> {
  const { packageManagers, env, logger } = ctx;

  if (packageManagers.length === 0) {
    logger.log("No package managers configured for targets");
    return;
  }

  for (const pm of packageManagers) {
    logger.log(`Syncing ${pm.name} dependencies...`);
    const result = await ctx.exec("sh", ["-c", pm.sync], {
      cwd: pm.cwd,
      env,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `${pm.name} sync failed (exit ${result.exitCode})\n${result.stderr}`,
      );
    }
    logger.log(`${pm.name} sync complete`);
  }
}

export default class SyncScript extends Script {
  static override name = "sync";
  static override description = "Sync dependencies";
  static override args = baseArgs.extend({});

  /** Single-node plan dispatching to {@link syncRun} via `"sync:run"`. */
  static plan(_args: ScriptArgs, _scope: { targets: readonly string[] }): Plan {
    return planFromNodes([
      {
        id: "sync",
        handler: { kind: "builtin", name: "sync:run" },
        needs: [],
        meta: { script: "sync" },
      },
    ]);
  }
}
