/**
 * Test plugin "beta" — records every override invocation onto a global
 * trace. Pair of `alpha` for runtime-dispatch tests. Mirrors alpha's
 * overlay-observation logic so per-plugin assertions are symmetrical.
 */
import { resolveRuntime } from "../../../../packages/nopo/src/config/index.ts";
import type {
  HookContext,
  NopoPluginFactory,
} from "../../../../packages/nopo/src/plugin.ts";

interface OverlayRecord {
  plugin: string;
  hook: string;
  service: string;
  runtime: string;
  cpu: string;
  port: number;
  env: Record<string, string>;
}

interface TraceTarget {
  __nopoTrace?: string[];
  __nopoOverlays?: OverlayRecord[];
}
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- attaching a typed shim onto globalThis for cross-plugin trace recording in fixture tests
const target = globalThis as unknown as TraceTarget;

function recordOverlays(
  pluginName: string,
  hook: string,
  ctx: HookContext,
): void {
  const services = ctx.runner.config.project.services.entries;
  const overlays: OverlayRecord[] = target.__nopoOverlays ?? [];
  for (const [id, svc] of Object.entries(services)) {
    if (!svc.runtimes) continue;
    const resolved = resolveRuntime(svc.runtimes, ctx.runtime);
    overlays.push({
      plugin: pluginName,
      hook,
      service: id,
      runtime: ctx.runtime,
      cpu: resolved.cpu,
      port: resolved.port,
      env: { ...resolved.envs.effective },
    });
  }
  target.__nopoOverlays = overlays;
}

const beta: NopoPluginFactory = () => ({
  name: "beta",
  description: "Runtime dispatch fixture plugin",
  overrides: {
    up: async (ctx: HookContext) => {
      target.__nopoTrace = [...(target.__nopoTrace ?? []), "beta:up"];
      recordOverlays("beta", "up", ctx);
    },
    down: async (ctx: HookContext) => {
      target.__nopoTrace = [...(target.__nopoTrace ?? []), "beta:down"];
      recordOverlays("beta", "down", ctx);
    },
    status: async (ctx: HookContext) => {
      target.__nopoTrace = [...(target.__nopoTrace ?? []), "beta:status"];
      recordOverlays("beta", "status", ctx);
    },
  },
});

export default beta;
