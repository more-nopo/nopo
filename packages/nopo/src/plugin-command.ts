import type { Runner } from "./lib.ts";
import type {
  HookContext,
  PluginCommand,
  PluginCommandContext,
} from "./plugin.ts";
import { ScriptArgs } from "./script-args.ts";

export async function runPluginCommand(
  cmd: PluginCommand,
  runner: Runner,
  argv: string[],
  commandContext?: PluginCommandContext,
): Promise<void> {
  // Always create a fresh ScriptArgs to avoid shared state between invocations
  const args = new ScriptArgs(cmd.args?.getSchema() ?? {}, runner);
  const separator = argv.indexOf("--");
  const pluginArgv = separator < 0 ? argv : argv.slice(0, separator);
  const passthrough = separator < 0 ? [] : argv.slice(separator + 1);
  args.parse(pluginArgv);

  // Extract positional args (anything that isn't a flag or option value). Plugin commands
  // legitimately want these (e.g. an optional service id like `nopo playwright e2e root`);
  const positionals: string[] = [];
  const schema = args.getSchema();
  const booleanFlags = new Set(
    Object.entries(schema).flatMap(([name, config]) =>
      config.type === "boolean" ? [name, ...(config.alias ?? [])] : [],
    ),
  );
  for (let i = 0; i < pluginArgv.length; i++) {
    const tok = pluginArgv[i];
    if (tok === undefined) continue;
    if (tok.startsWith("--") || tok.startsWith("-")) {
      // Boolean and --flag=value options do not consume a positional target.
      const key = tok.replace(/^-+/, "");
      const next = pluginArgv[i + 1];
      if (
        !tok.includes("=") &&
        !booleanFlags.has(key) &&
        next !== undefined &&
        !next.startsWith("-")
      ) {
        i += 1;
      }
      continue;
    }
    positionals.push(tok);
  }

  const graph = runner.buildGraph();

  // Plugin commands aren't runtime-dispatched; they always see the default overlay so
  // resolveRuntime(svc.runtimes, ctx.runtime) returns the same view they got
  const runtimeName = args.get<string | undefined>("runtime");
  const context: HookContext = {
    runner,
    args,
    graph,
    runtime: runtimeName ?? "default",
    positionals,
    argv,
    commandContext,
    passthrough,
    ...runner.contextIO(),
  };

  if (commandContext) {
    const io = runner.contextIO();
    context.exec = (command, values, options = {}) =>
      io.exec(command, values, {
        ...options,
        cwd: options.cwd ?? commandContext.cwd,
        env: { ...commandContext.env, ...options.env },
      });
    context.shell = (options = {}) =>
      io.shell({
        ...options,
        cwd: options.cwd ?? commandContext.cwd,
        env: { ...commandContext.env, ...options.env },
      });
  }
  await cmd.fn(context, args);
}
