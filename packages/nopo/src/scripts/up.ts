import { baseArgs } from "../args.ts";
import type { DependencyGraph } from "../graph.ts";
import { type Runner, type ScriptDependency, TargetScript } from "../lib.ts";
import { type Plan, planFromNodes } from "../plan.ts";
import type { HookContext } from "../plugin.ts";
import type { ScriptArgs } from "../script-args.ts";
import BuildScript from "./build.ts";
import EnvScript from "./env.ts";

export function isBuild({ config, environment }: Runner): boolean {
  const forceBuild = !!config.processEnv.DOCKER_BUILD;
  const localVersion = environment.env.DOCKER_VERSION === "local";
  return forceBuild || localVersion;
}

/** Pre-resolved scope for {@link UpScript.plan}. The CLI driver / {@link UpScript.fn}
 * adapter pre-resolves this so `plan()` itself stays a pure function of its inputs and
 * never has to read `config.project`. Only `runtime` lands in the {@link Plan} (on each
 * node's `meta.runtime`). The resolved override-owning plugin name is a dispatch-time
 */
export interface UpPlanScope {
  /** The user-facing runtime name (e.g. `"prod"` from `--runtime prod`), or `"default"` when
   * none was given. Lands on every node's `meta.runtime` — same value the legacy {@link
   * UpScript.fn} put on `HookContext.runtime` (up.ts:46 pre-extraction).
   */
  runtime: string;
}

/** The narrow surface of `Runner` that {@link upPre}, {@link upMain}, and {@link upPost}
 * touch. Defined locally rather than importing the full `Runner` class so the builtins can
 * be exercised with a lightweight stub and so this module doesn't widen `lib.ts`'s public
 * surface. Mirrors the production methods on `Runner` (lib.ts:932) used by `up`.
 */
export interface UpRunner {
  fireHooks(name: "pre_up" | "post_up", ctx: HookContext): Promise<void>;
  fireOverride(
    name: "up",
    ctx: HookContext,
    pluginName?: string,
  ): Promise<boolean>;
}

/** Inputs to {@link upPre} / {@link upMain} / {@link upPost}. */
export interface UpPhaseContext {
  /** Narrow runner surface — see {@link UpRunner}. */
  runner: UpRunner;
  /** Parsed script args (forwarded into the {@link HookContext}). */
  args: ScriptArgs;
  /** Pre-built dependency graph (forwarded into the {@link HookContext}). */
  graph: DependencyGraph;
  /**
   * User-facing runtime name (or `"default"`). Lands on
   * `HookContext.runtime` exactly like the legacy {@link UpScript.fn}
   * passed it (up.ts:46 pre-extraction).
   */
  runtime: string;
  /** Resolved override-owning plugin name (e.g. `"docker-compose"`), or `undefined` when no
   * runtime plugin is registered. Forwarded to {@link UpRunner.fireOverride} so explicit
   * dispatch picks the right plugin.
   */
  pluginName: string | undefined;
  /**
   * The IO surface (and `exec` / `shell` helpers) attached to every
   * {@link HookContext}. The CLI driver builds this via
   * `runner.contextIO()`; tests pass a minimal stub.
   */
  contextIO: Pick<HookContext, "io" | "exec" | "shell">;
}

/** The CLI driver produces a single `HookContext` per `up` invocation today; the extracted
 * handlers do the same so plugins observe identical state to the legacy `fn()` path. The
 * `runtime` field on the resulting context echoes the scope's user-facing runtime name
 * (defaulted to `"default"` upstream).
 */
function buildHookContext(ctx: UpPhaseContext): HookContext {
  return {
    // The narrow `UpRunner` surface satisfies what `upPre` / `upMain` `upPost` read off
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- HookContext.runner is the full Runner; UpPhaseContext narrows for testability
    runner: ctx.runner as unknown as Runner,
    args: ctx.args,
    graph: ctx.graph,
    runtime: ctx.runtime,
    ...ctx.contextIO,
  };
}

/** The pure builtin behind the `"up:pre"` plan node. Fires every plugin's `pre_up` additive
 * hook in declaration order. Extracted from {@link UpScript.fn} so the phase can be
 * exercised directly without standing up a `Runner`.
 */
export async function upPre(ctx: UpPhaseContext): Promise<void> {
  await ctx.runner.fireHooks("pre_up", buildHookContext(ctx));
}

/** The pure builtin behind the `"up:main"` plan node. Dispatches the `up` override to the
 * resolved runtime plugin (or to whatever plugin owns the slot when no runtime is set).
 * Throws the same "No plugin provides 'up' override..." error the legacy {@link
 * UpScript.fn} did when no plugin provides the slot.
 */
export async function upMain(ctx: UpPhaseContext): Promise<void> {
  const overridden = await ctx.runner.fireOverride(
    "up",
    buildHookContext(ctx),
    ctx.pluginName ?? undefined,
  );
  if (!overridden) {
    throw new Error(
      "No plugin provides an 'up' override. Register a runtime plugin (e.g. docker-compose) in nopo.yml.",
    );
  }
}

/**
 * The pure builtin behind the `"up:post"` plan node. Fires every plugin's
 * `post_up` additive hook in declaration order.
 */
export async function upPost(ctx: UpPhaseContext): Promise<void> {
  await ctx.runner.fireHooks("post_up", buildHookContext(ctx));
}

export default class UpScript extends TargetScript {
  static override skipQueue = true; // long-lived services — would hold a slot for its whole runtime
  static override name = "up";
  static override description = "Start the services";
  static override dependencies: ScriptDependency[] = [
    {
      class: EnvScript,
      enabled: true,
    },
    {
      class: BuildScript,
      enabled: isBuild,
    },
  ];

  static override args = baseArgs.extend({});

  /** Linear `pre_up → up → post_up` plan; no per-service fan-out. */
  static plan(_args: ScriptArgs, scope: UpPlanScope): Plan {
    const meta = { script: "up", runtime: scope.runtime };
    return planFromNodes([
      {
        id: "pre_up",
        handler: { kind: "builtin", name: "up:pre" },
        needs: [],
        meta,
      },
      {
        id: "up",
        handler: { kind: "builtin", name: "up:main" },
        needs: ["pre_up"],
        meta,
      },
      {
        id: "post_up",
        handler: { kind: "builtin", name: "up:post" },
        needs: ["up"],
        meta,
      },
    ]);
  }
}
