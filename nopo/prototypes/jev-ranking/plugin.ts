import path from "node:path";
import { makeCtxExec } from "@more-nopo/nopo/lib";
import type { HookContext, NopoPluginFactory } from "@more-nopo/nopo/plugin";
import { bunCandidates, vitestCandidates } from "./discovery.ts";
import { observe, writeReport } from "./observe.ts";

/** Prototype wiring only, not a public plugin-of-plugins protocol.
 * Observe the resolved native invocation so profiles, quarantine and sharding
 * remain owned by the released runner plugin. A shipping implementation should
 * call the shared engine directly where those plugins already resolve inventory. */
export function rankInside(
  factory: NopoPluginFactory,
  runner: "vitest" | "bun",
): NopoPluginFactory {
  return (config) => {
    const plugin = factory(config);
    return {
      ...plugin,
      commands: plugin.commands?.map((command) => ({
        ...command,
        async fn(ctx, args) {
          const directory = ctx.io.env.NOPO_JEV_REPORT_DIR;
          if (
            !directory ||
            command.name !== (runner === "vitest" ? "run" : "test")
          )
            return command.fn(ctx, args);
          const spawn: HookContext["io"]["spawn"] = async (
            cmd,
            argv,
            options,
          ) => {
            const eligible =
              runner === "bun"
                ? cmd === "bun" && argv[0] === "test"
                : cmd === "node" && argv[1] === "run";
            if (!eligible) return ctx.io.spawn(cmd, argv, options);
            const cwd = options?.cwd ?? ctx.io.cwd();
            const report = await observe(ctx, async () =>
              runner === "vitest"
                ? vitestCandidates(ctx, cmd, argv, options)
                : bunCandidates(cwd, argv.slice(1)),
            );
            const executionStart = performance.now();
            let exitCode: number | null = null;
            try {
              const result = await ctx.io.spawn(cmd, argv, options);
              exitCode = result.exitCode;
              return result;
            } finally {
              writeReport(ctx, directory, {
                ...report,
                runner,
                target:
                  ctx.commandContext?.target ??
                  path.relative(ctx.runner.config.root, cwd),
                command: ctx.commandContext?.command ?? command.name,
                exitCode,
                timings: {
                  ...report.timings,
                  executionMs: performance.now() - executionStart,
                },
              });
            }
          };
          // Preserve IO getters/prototype methods and the existing ProcessPromise
          // contract, including nothrow needed by quarantine and shutdown policies.
          const io = new Proxy(ctx.io, {
            get(target, key) {
              if (key === "spawn") return spawn;
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          await command.fn({ ...ctx, io, exec: makeCtxExec(io) }, args);
        },
      })),
    };
  };
}
