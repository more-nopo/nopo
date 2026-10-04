import {
  hasPluginCommand,
  type HookContext,
  type NopoPluginFactory,
} from "@more-nopo/nopo/plugin";
import { expandEnvValues } from "@more-nopo/nopo/expand-env";
import { ScriptArgs } from "@more-nopo/nopo/script-args";
import { z } from "zod";

const optionsSchema = z
  .object({ env: z.record(z.string()).default({}) })
  .strict();
const projectSchema = optionsSchema.default({});
const targetSchema = z.union([z.boolean(), optionsSchema]);

/** Bun's project configuration and preloads belong to a target's working directory.
 * Do not combine independent targets in a process with a shared environment. */
async function executeBun(
  context: HookContext,
  args: ScriptArgs,
  command: "test" | "run" | "build",
  project: z.infer<typeof projectSchema>,
): Promise<void> {
  const owner = context.commandContext;
  const services = context.runner.config.project.services.entries;
  const requested = owner ? [owner.target] : (context.positionals ?? []);
  const ids = requested.length
    ? [...new Set(requested)]
    : Object.keys(services)
        .sort()
        .filter((id) => {
          const service = services[id]!;
          return (
            service.pluginData?.bun !== undefined ||
            hasPluginCommand(service.commands, "bun")
          );
        });
  const invocation = context.argv ?? [];
  const separator = invocation.indexOf("--");
  if (!owner) {
    for (const arg of separator < 0
      ? invocation
      : invocation.slice(0, separator)) {
      if (arg.startsWith("-") && arg.split("=")[0] !== "--print") {
        throw new Error(
          `Unknown nopo Bun option '${arg}'. Put Bun options after --.`,
        );
      }
    }
  }
  const argv = owner ? invocation : (context.passthrough ?? []);
  // Resolve every target before starting any child process.
  const targets = ids.flatMap((id) => {
    const service = services[id];
    if (!service) throw new Error(`Unknown nopo target '${id}'.`);
    const raw = service.pluginData?.bun;
    const config = raw === undefined ? {} : targetSchema.parse(raw);
    if (config === false) {
      if (requested.length) throw new Error(`Bun is disabled for '${id}'.`);
      return [];
    }
    const options = optionsSchema.parse(
      typeof config === "object" ? config : {},
    );
    const baseEnv = {
      ...context.io.env,
      ...context.runner.environment.env,
      ...context.runner.environment.extraEnv,
      ...owner?.env,
    };
    const env = {
      ...baseEnv,
      ...expandEnvValues(
        {
          ...(owner ? {} : service.env),
          ...(command === "test" ? { NODE_ENV: "test" } : {}),
          ...project.env,
          ...options.env,
        },
        baseEnv,
      ),
    };
    return [{ id, cwd: owner?.cwd ?? service.paths.root, env }];
  });
  if (!targets.length)
    throw new Error(
      "No Bun targets found. Delegate a command to bun or set plugins.bun: {}.",
    );
  if (!owner && args.get<boolean>("print")) {
    context.io.stdout.write(
      JSON.stringify({
        command,
        targets: targets.map(({ id, cwd }) => ({ id, cwd })),
        args: argv,
      }) + "\n",
    );
    return;
  }
  for (const target of targets) {
    context.io.stderr.write(`[bun] ${target.id}: ${command}\n`);
    await context.exec("bun", [command, ...argv], {
      cwd: target.cwd,
      env: target.env,
      stdio: "inherit",
    });
  }
}

const bunPlugin: NopoPluginFactory = (raw) => {
  const project = projectSchema.parse(raw);
  return {
    name: "bun",
    defaultCommand: "test",
    description: "Run Bun tests, scripts, and builds in nopo targets",
    configSchema: { project: projectSchema, service: targetSchema },
    commands: (["test", "run", "build"] as const).map((command) => ({
      name: command,
      description: `nopo bun ${command} [targets...] [--print] -- [Bun arguments]`,
      args: new ScriptArgs({
        print: {
          type: "boolean",
          default: false,
          description: "Print selected targets without executing Bun",
        },
      }),
      fn: (context, args) => executeBun(context, args, command, project),
    })),
  };
};

export default bunPlugin;
