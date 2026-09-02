import type { NormalizedProjectConfig } from "../config/index.ts";
import { resolveRuntimePlugin } from "../config/index.ts";
import type { DependencyGraph } from "../graph.ts";
import type { IO } from "../io.ts";
import { Script, type ScriptDependency } from "../lib.ts";
import { type Plan, planFromNodes } from "../plan.ts";
import type { HookContext } from "../plugin.ts";
import { ScriptArgs } from "../script-args.ts";
import EnvScript from "./env.ts";

/** The narrow surface of `Runner` that the extracted status phase handlers ({@link
 * statusPre}, {@link statusMain}, {@link statusPost}) touch. Defined locally rather than
 * depending on the full `Runner` class so the status builtins can be tested with a
 * lightweight stub and so this module doesn't widen `lib.ts`. The shape mirrors what
 */
export interface StatusRunnerLike {
  config: { project: NormalizedProjectConfig };
  buildGraph(): DependencyGraph;
  contextIO(): {
    io: IO;
    exec: HookContext["exec"];
    shell: HookContext["shell"];
  };
  fireHooks(
    name: "pre_status" | "post_status",
    ctx: HookContext,
  ): Promise<void>;
  fireOverride(
    name: "status",
    ctx: HookContext,
    pluginName?: string,
  ): Promise<boolean>;
}

/** Inputs to {@link statusPre} / {@link statusMain} / {@link statusPost}. */
export interface StatusPhaseContext {
  io: IO;
  args: ScriptArgs;
  /** Resolved runtime name; `"default"` for non-`--runtime` calls. */
  runtime: string;
  runner: StatusRunnerLike;
}

/** Build the {@link HookContext} that the three status phases share. Internal — exported
 * via the phase functions, not directly. Each invocation rebuilds the context so tests can
 * observe what each phase passed to its respective hook / override.
 */
function buildHookContext(ctx: StatusPhaseContext): HookContext {
  const { runner, args, runtime, io } = ctx;
  const wired = runner.contextIO();
  return {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- StatusRunnerLike is a structural narrowing of Runner; HookContext.runner expects the concrete class for plugins, but every site that builds a HookContext (legacy fn() / future CLI driver) passes the real Runner — only tests pass a stub
    runner: runner as unknown as HookContext["runner"],
    args,
    graph: runner.buildGraph(),
    runtime,
    io: wired.io ?? io,
    exec: wired.exec,
    shell: wired.shell,
  };
}

/** The pure builtin behind the `"status:pre"` plan node. Fires the `pre_status` additive
 * hook on every registered plugin, in declaration order. Extracted from {@link
 * StatusScript.fn} so it can be exercised directly without standing up a `Runner`.
 */
export async function statusPre(ctx: StatusPhaseContext): Promise<void> {
  await ctx.runner.fireHooks("pre_status", buildHookContext(ctx));
}

/** The pure builtin behind the `"status:main"` plan node. Resolves the runtime plugin (from
 * `--runtime <name>` or the project default) and fires the `status` override on it. Throws
 * verbatim the legacy {@link StatusScript.fn} message when no plugin owns the override.
 */
export async function statusMain(ctx: StatusPhaseContext): Promise<void> {
  const runtimeName = ctx.args.get<string | undefined>("runtime");
  const pluginName = resolveRuntimePlugin(
    ctx.runner.config.project,
    runtimeName,
  );

  const overridden = await ctx.runner.fireOverride(
    "status",
    buildHookContext(ctx),
    pluginName ?? undefined,
  );
  if (!overridden) {
    throw new Error(
      "No plugin provides a 'status' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
  }
}

/**
 * The pure builtin behind the `"status:post"` plan node. Fires the
 * `post_status` additive hook on every registered plugin, in
 * declaration order.
 */
export async function statusPost(ctx: StatusPhaseContext): Promise<void> {
  await ctx.runner.fireHooks("post_status", buildHookContext(ctx));
}

export default class StatusScript extends Script {
  static override skipQueue = true; // instant, read-only — never wait
  static override name = "status";
  static override description = "Check the status of the project and services";
  static override dependencies: ScriptDependency[] = [
    {
      class: EnvScript,
      enabled: true,
    },
  ];

  static override args = new ScriptArgs({
    runtime: {
      type: "string",
      description:
        'Runtime name from root `runtimes:` map (e.g., "prod"). Defaults to `default`.',
      default: undefined,
    },
  });

  /** Linear `pre_status → status → post_status` plan. */
  static plan(_args: ScriptArgs, scope: { runtime: string }): Plan {
    const { runtime } = scope;
    return planFromNodes([
      {
        id: "pre_status",
        handler: { kind: "builtin", name: "status:pre" },
        needs: [],
        meta: { script: "status", runtime },
      },
      {
        id: "status",
        handler: { kind: "builtin", name: "status:main" },
        needs: ["pre_status"],
        meta: { script: "status", runtime },
      },
      {
        id: "post_status",
        handler: { kind: "builtin", name: "status:post" },
        needs: ["status"],
        meta: { script: "status", runtime },
      },
    ]);
  }
}
