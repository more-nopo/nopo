import { baseArgs } from "../args.ts";
import { resolveRuntimePlugin } from "../config/index.ts";
import { type ScriptDependency, TargetScript } from "../lib.ts";
import { type Plan, planFromNodes } from "../plan.ts";
import type { HookContext } from "../plugin.ts";
import type { ScriptArgs } from "../script-args.ts";
import EnvScript from "./env.ts";

/** Narrow surface of `Runner` that the down phase handlers touch. Defined locally rather
 * than importing the full `Runner` so handlers can be driven by lightweight stubs in
 * tests, and so this module doesn't widen `lib.ts`'s public surface. Mirrors {@link
 * EnvScript}'s `EnvSource` / `EnvLogger` pattern: tiny structural slices that match
 */
export interface DownRunner {
  /**
   * The normalized project config — needed only to resolve which plugin
   * owns the `down` override for the active runtime. Read-only; handlers
   * never mutate it.
   */
  config: {
    project: Parameters<typeof resolveRuntimePlugin>[0];
  };
  buildGraph(): HookContext["graph"];
  contextIO(): Pick<HookContext, "io" | "exec" | "shell">;
  fireHooks(
    hookName: "pre_down" | "post_down",
    context: HookContext,
  ): Promise<void>;
  fireOverride(
    hookName: "down",
    context: HookContext,
    pluginName?: string,
  ): Promise<boolean>;
}

/** Inputs to {@link downPre} / {@link downMain} / {@link downPost}. */
export interface DownPhaseContext {
  io: HookContext["io"];
  args: ScriptArgs;
  runtime: string;
  runner: DownRunner;
}

/** Build the {@link HookContext} that gets threaded into every `pre_down` `down` /
 * `post_down` invocation. Identical instance is reused across the three phases so plugins
 * observe a stable graph + metadata bag — same shape as the legacy {@link DownScript.fn}
 * path.
 */
function buildHookContext(ctx: DownPhaseContext): HookContext {
  return {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- HookContext.runner is typed as the full Runner; handlers only ever need the narrow DownRunner slice but the public HookContext shape that plugins consume requires Runner. Real callers pass a real Runner; tests pass a stub that satisfies DownRunner.
    runner: ctx.runner as unknown as HookContext["runner"],
    args: ctx.args,
    graph: ctx.runner.buildGraph(),
    runtime: ctx.runtime,
    ...ctx.runner.contextIO(),
  };
}

/**
 * The pure builtin behind the `"down:pre"` plan node. Fires every plugin's
 * `pre_down` additive hook in declaration order via `runner.fireHooks`.
 */
export async function downPre(ctx: DownPhaseContext): Promise<void> {
  await ctx.runner.fireHooks("pre_down", buildHookContext(ctx));
}

/** The pure builtin behind the `"down:main"` plan node. Resolves the runtime plugin (using
 * the runtime baked into {@link DownPhaseContext}) and dispatches the `down` override to
 * it. Throws verbatim when no plugin owns the override — preserves the legacy {@link
 * DownScript.fn} error message so user-facing output is unchanged.
 */
export async function downMain(ctx: DownPhaseContext): Promise<void> {
  // Plan scope bakes the runtime as a string ("default" when the user passed nothing).
  // Re-derive the original "was a name passed?" signal by checking the args directly
  const runtimeArg = ctx.args.get<string | undefined>("runtime");
  const pluginName = resolveRuntimePlugin(
    ctx.runner.config.project,
    runtimeArg,
  );

  const overridden = await ctx.runner.fireOverride(
    "down",
    buildHookContext(ctx),
    pluginName ?? undefined,
  );
  if (!overridden) {
    throw new Error(
      "No plugin provides a 'down' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
  }
}

/**
 * The pure builtin behind the `"down:post"` plan node. Fires every
 * plugin's `post_down` additive hook in declaration order.
 */
export async function downPost(ctx: DownPhaseContext): Promise<void> {
  await ctx.runner.fireHooks("post_down", buildHookContext(ctx));
}

export default class DownScript extends TargetScript {
  static override skipQueue = true; // service teardown — pairs with `up`, not host fan-out
  static override name = "down";
  static override description = "Bring down the containers";
  static override dependencies: ScriptDependency[] = [
    {
      class: EnvScript,
      enabled: true,
    },
  ];

  static override args = baseArgs.extend({});

  /** Linear `pre_down → down → post_down` plan. */
  static plan(_args: ScriptArgs, scope: { runtime: string }): Plan {
    const meta = { script: "down", runtime: scope.runtime } as const;
    return planFromNodes([
      {
        id: "pre_down",
        handler: { kind: "builtin", name: "down:pre" },
        needs: [],
        meta,
      },
      {
        id: "down",
        handler: { kind: "builtin", name: "down:main" },
        needs: ["pre_down"],
        meta,
      },
      {
        id: "post_down",
        handler: { kind: "builtin", name: "down:post" },
        needs: ["down"],
        meta,
      },
    ]);
  }
}
