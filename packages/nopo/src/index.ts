import { killTrackedChildren } from "./child-registry.ts";
import { loadPlugins, loadProjectConfig } from "./config/index.ts";
import type { IO } from "./io.ts";
import {
  chalk,
  type Config,
  createConfig,
  Logger,
  minimist,
  Runner,
  type Script,
} from "./lib.ts";
import { Environment } from "./parse-env.ts";
import type { HookContext, LoadedPlugin, PluginCommand } from "./plugin.ts";
import { acquireSlot, NOOP_LEASE } from "./queue-client.ts";
import { ScriptArgs } from "./script-args.ts";
import Act from "./scripts/act.ts";
import Build from "./scripts/build.ts";
import Command from "./scripts/command.ts";
import Down from "./scripts/down.ts";
import Env from "./scripts/env.ts";
import Install from "./scripts/install.ts";
import List from "./scripts/list.ts";
import Queue from "./scripts/queue.ts";
import Secret from "./scripts/secret.ts";
import Status from "./scripts/status.ts";
import Sync from "./scripts/sync.ts";
import Up from "./scripts/up.ts";
import { formatTimeout, resolveTimeoutMs } from "./timeout.ts";

const scripts: Record<string, typeof Script> = {
  act: Act,
  build: Build,
  command: Command,
  down: Down,
  env: Env,
  install: Install,
  list: List,
  queue: Queue,
  secret: Secret,
  status: Status,
  sync: Sync,
  up: Up,
};

function printNopoHeader(): void {
  const asciiArt = `
███╗   ██╗ ██████╗ ██████╗  ██████╗ 
████╗  ██║██╔═══██╗██╔══██╗██╔═══██╗
██╔██╗ ██║██║   ██║██████╔╝██║   ██║
██║╚██╗██║██║   ██║██╔═══╝ ██║   ██║
██║ ╚████║╚██████╔╝██║     ╚██████╔╝
╚═╝  ╚═══╝ ╚═════╝ ╚═╝      ╚═════╝ 
`;
  console.log(chalk.cyan(asciiArt));
}

function printCommandsTable(): void {
  const commands = Object.entries(scripts)
    .map(([key, ScriptClass]) => ({
      name: ScriptClass.name || key,
      description: ScriptClass.description || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const nameWidth = Math.max(
    ...commands.map((cmd) => cmd.name.length),
    "COMMAND".length,
  );
  const descriptionWidth = Math.max(
    ...commands.map((cmd) => cmd.description.length),
    "DESCRIPTION".length,
  );

  const commandHeader = "COMMAND".padEnd(nameWidth);
  const descriptionHeader = "DESCRIPTION".padEnd(descriptionWidth);
  const header = chalk.cyan(
    chalk.bold(`  ${commandHeader}  ${descriptionHeader}`),
  );
  const separator = chalk.gray(
    `  ${"-".repeat(nameWidth)}  ${"-".repeat(descriptionWidth)}`,
  );

  console.log(header);
  console.log(separator);

  for (const cmd of commands) {
    const name = chalk.yellow(cmd.name.padEnd(nameWidth));
    const description = chalk.white(cmd.description.padEnd(descriptionWidth));
    console.log(`  ${name}  ${description}`);
  }
}

function printServiceCommandsTable(io: IO): void {
  try {
    const project = loadProjectConfig(io.cwd());
    const services = project.services.targets;

    // Build a tree structure of commands
    interface CommandNode {
      services: Set<string>;
      children: Map<string, CommandNode>;
    }

    const commandTree = new Map<string, CommandNode>();

    // Recursively collect commands into tree structure
    function collectCommands(
      serviceId: string,
      commands: Record<string, unknown>,
      parentNode: Map<string, CommandNode>,
    ): void {
      for (const [commandName, command] of Object.entries(commands)) {
        if (!parentNode.has(commandName)) {
          parentNode.set(commandName, {
            services: new Set(),
            children: new Map(),
          });
        }
        const node = parentNode.get(commandName)!;
        node.services.add(serviceId);

        // Recursively collect sub-commands
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing dynamic config object to check for nested commands
        const cmd = command as { commands?: Record<string, unknown> };
        if (cmd.commands) {
          collectCommands(serviceId, cmd.commands, node.children);
        }
      }
    }

    for (const serviceId of services) {
      const service = project.services.entries[serviceId];
      if (!service) continue;

      collectCommands(serviceId, service.commands, commandTree);
    }

    if (commandTree.size === 0) {
      return; // No commands to display
    }

    console.log(chalk.cyan(chalk.bold("\nService Commands:\n")));

    const commandHeader = "COMMAND";
    const servicesHeader = "SERVICES";
    const header = chalk.cyan(
      chalk.bold(`  ${commandHeader.padEnd(25)}  ${servicesHeader}`),
    );
    const separator = chalk.gray(`  ${"-".repeat(25)}  ${"-".repeat(40)}`);

    console.log(header);
    console.log(separator);

    // Print tree recursively
    function printCommandNode(
      name: string,
      node: CommandNode,
      prefix: string,
      isLast: boolean,
      depth: number,
    ): void {
      // Create the tree branch characters
      const branch = isLast ? "└─ " : "├─ ";
      const indent = depth === 0 ? "" : prefix + branch;

      const displayName = indent + name;
      const servicesList = Array.from(node.services)
        .sort()
        .map((s) => chalk.green(s))
        .join(chalk.gray(", "));

      const nameColor = depth === 0 ? chalk.yellow : chalk.cyan;
      console.log(`  ${nameColor(displayName.padEnd(25))}  ${servicesList}`);

      // Print children
      if (node.children.size > 0) {
        const childEntries = Array.from(node.children.entries()).sort((a, b) =>
          a[0].localeCompare(b[0]),
        );

        const childPrefix =
          depth === 0 ? "" : prefix + (isLast ? "   " : "│  ");

        childEntries.forEach(([childName, childNode], index) => {
          const isLastChild = index === childEntries.length - 1;
          printCommandNode(
            childName,
            childNode,
            childPrefix,
            isLastChild,
            depth + 1,
          );
        });
      }
    }

    // Sort and print top-level commands
    const sortedCommands = Array.from(commandTree.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    sortedCommands.forEach(([name, node], index) => {
      const isLast = index === sortedCommands.length - 1;
      printCommandNode(name, node, "", isLast, 0);
    });
  } catch {
    // Silently skip if we can't load the project config
    // This can happen if nopo.yml doesn't exist or is invalid
  }
}

function printCommandHelp(
  ScriptClass: typeof Script,
  commandName: string,
  io: IO,
): never {
  printNopoHeader();
  const name = ScriptClass.name || commandName;
  const description = ScriptClass.description || "";

  console.log(chalk.cyan(chalk.bold(`\nCommand: ${chalk.yellow(name)}\n`)));
  if (description) {
    console.log(chalk.white(`  ${description}\n`));
  }
  console.log(chalk.gray(`  Usage: nopo ${name} [options]\n`));

  // If the script uses ScriptArgs, generate help from the schema
  /* eslint-disable @typescript-eslint/consistent-type-assertions -- accessing static 'args' property not on base class type */
  const argsTemplate = (
    ScriptClass as unknown as { args: ScriptArgs | undefined }
  ).args;
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
  if (argsTemplate) {
    const help = argsTemplate.generateHelp();
    if (help) {
      console.log(chalk.cyan(chalk.bold("Options:\n")));
      console.log(help);
      console.log();
    }
  }

  return io.exit(0);
}

function printHelp(message: string, io: IO, exitCode = 1): never {
  printNopoHeader();
  const color = exitCode === 0 ? chalk.green : chalk.red;
  console.log(color(message));
  console.log();
  printCommandsTable();
  return io.exit(exitCode);
}

export default async function main(io: IO): Promise<void> {
  const argv = io.argv.slice(2);
  const args = minimist(argv);

  // Check if this is a command that outputs machine-readable format and should be silent
  const commandName = args._[0] || "";
  const isJsonOutput =
    commandName === "list" &&
    !!(args.json || args.j || args.format === "json" || args.f === "json");
  const isCsvOutput =
    commandName === "list" &&
    !!(args.csv || args.format === "csv" || args.f === "csv");
  const isSilentOutput = isJsonOutput || isCsvOutput;

  const config: Config = createConfig({
    envFile: io.env.ENV_FILE || undefined,
    silent: isSilentOutput,
    rootDir: io.env.ROOT_DIR || undefined,
    io,
  });

  // Load plugins asynchronously (ESM dynamic import)
  try {
    await loadPlugins(config.project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`\nPlugin load error: ${message}\n`));
    return io.exit(1);
  }

  const logger = new Logger(config, io);
  const environment = new Environment(config);
  const runner = new Runner(config, environment, argv, logger, io);

  // Routed through logger.error (stderr) so that pipelines like `nopo secret get ... | head`
  // see only the script's actual output, not this diagnostic banner.
  if (!isSilentOutput && config.project.plugins.length > 0) {
    const pluginNames = config.project.plugins
      .map((p) => {
        const overrides = Object.keys(p.definition.overrides ?? {});
        const suffix =
          overrides.length > 0
            ? chalk.gray(` (overrides: ${overrides.join(", ")})`)
            : "";
        return chalk.cyan(p.definition.name) + suffix;
      })
      .join(", ");
    logger.error(chalk.gray(`Plugins: ${pluginNames}`));
  }

  // Show general help only if --help is passed without a command
  if (args.help && !args._[0]) {
    return printHelp("Usage: nopo <command> [options]", io, 0);
  }

  if (!args._[0]) {
    printNopoHeader();
    console.log(chalk.cyan(chalk.bold("Available commands:\n")));
    printCommandsTable();
    printPluginCommandsTable(config);
    printServiceCommandsTable(io);
    return io.exit(0);
  }

  // Handle "help" as a special command (show general help)
  if (commandName === "help") {
    return printHelp("Usage: nopo <command> [options]", io, 0);
  }

  // Check if the command matches a loaded plugin name (plugin subcommands)
  const pluginMatch = findPluginByName(config, commandName);
  if (pluginMatch) {
    const subCommandName = args._[1];

    // nopo <plugin> --help or nopo <plugin> help
    if (!subCommandName || args.help || subCommandName === "help") {
      return printPluginHelp(pluginMatch, io);
    }

    const pluginCmd = pluginMatch.definition.commands?.find(
      (c) => c.name === subCommandName,
    );
    if (!pluginCmd) {
      return printHelp(
        `Unknown plugin command '${subCommandName}' for plugin '${commandName}'`,
        io,
      );
    }

    try {
      // argv is already io.argv.slice(2); slice off plugin name + subcommand
      await runPluginCommand(pluginCmd, runner, argv.slice(2));
    } catch (error) {
      logError(runner, error);
      io.exit(1);
    }
    return;
  }

  // Determine which script to use Only fall back to Command script if no registered script
  // matches
  const ScriptClass = scripts[commandName] ?? Command;

  // Check for recursive help: nopo <command> help or nopo <command> --help
  if (args._[1] === "help" || args.help) {
    return printCommandHelp(ScriptClass, commandName, io);
  }

  // Coordinate commands across all concurrent nopo sessions/worktrees through a machine-wide
  // worker-slot budget. EVERYTHING queues except core scripts that opt out
  const skipQueue = ScriptClass.skipQueue || Boolean(args["skip-queue"]);
  const lease = skipQueue
    ? NOOP_LEASE
    : await acquireSlot(io, { cmd: argv.join(" ") || commandName });

  // Wall-clock timeout so a hung command can't hold its queue slot forever. Same gate as the
  // lease: only queued commands are timed out, so long-lived lifecycle commands
  const inCI = Boolean(io.env.CI);
  const cliTimeout = Array.isArray(args.timeout)
    ? args.timeout.at(-1)
    : args.timeout;
  const timeoutMs = skipQueue
    ? null
    : resolveTimeoutMs(
        {
          cli: cliTimeout,
          env: io.env.NOPO_TIMEOUT,
          scriptMs: inCI ? undefined : ScriptClass.timeoutMs,
        },
        { fallbackMs: inCI ? null : undefined },
      );
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          io.stderr.write(
            `\nnopo: '${commandName}' timed out after ${formatTimeout(timeoutMs)} ` +
              `— terminating (raise with --timeout <dur> or NOPO_TIMEOUT)\n`,
          );
          killTrackedChildren("SIGTERM");
          lease.release();
          io.exit(124);
        }, timeoutMs);
  // Don't let the watchdog keep the process alive on its own.
  timer?.unref?.();

  try {
    await runner.run(ScriptClass);
  } catch (error) {
    logError(runner, error);
    io.exit(1);
  } finally {
    if (timer) clearTimeout(timer);
    lease.release();
  }
}

function logError(runner: Runner, error: unknown): void {
  if (error instanceof Error) {
    runner.logger.log(chalk.red(`\n${error.message}\n`));
    if (error.stack) {
      runner.logger.log(chalk.gray(error.stack));
    }
  } else if (error && typeof error === "object" && "err" in error) {
    runner.logger.log(chalk.red(`\n${error.err}\n`));
  } else {
    runner.logger.log(chalk.red(`\nUnknown error: ${String(error)}\n`));
  }
}

function findPluginByName(
  config: Config,
  name: string,
): LoadedPlugin | undefined {
  return config.project.plugins.find((p) => p.definition.name === name);
}

function printPluginCommandsTable(config: Config): void {
  const plugins = config.project.plugins.filter(
    (p) => p.definition.commands && p.definition.commands.length > 0,
  );
  if (plugins.length === 0) return;

  console.log(chalk.cyan(chalk.bold("\nPlugin Commands:\n")));

  for (const plugin of plugins) {
    const pluginName = plugin.definition.name;
    for (const cmd of plugin.definition.commands ?? []) {
      const fullName = `${pluginName} ${cmd.name}`;
      console.log(
        `  ${chalk.yellow(fullName.padEnd(20))}  ${chalk.white(cmd.description)}`,
      );
    }
  }
}

function printPluginHelp(plugin: LoadedPlugin, io: IO): never {
  printNopoHeader();
  const name = plugin.definition.name;
  const description = plugin.definition.description ?? "";

  console.log(chalk.cyan(chalk.bold(`\nPlugin: ${chalk.yellow(name)}\n`)));
  if (description) {
    console.log(chalk.white(`  ${description}\n`));
  }

  const commands = plugin.definition.commands ?? [];
  if (commands.length > 0) {
    console.log(chalk.cyan(chalk.bold("Commands:\n")));
    for (const cmd of commands) {
      console.log(
        `  ${chalk.yellow(cmd.name.padEnd(20))}  ${chalk.white(cmd.description)}`,
      );
    }
  } else {
    console.log(chalk.gray("  No subcommands defined."));
  }

  return io.exit(0);
}

async function runPluginCommand(
  cmd: PluginCommand,
  runner: Runner,
  argv: string[],
): Promise<void> {
  // Always create a fresh ScriptArgs to avoid shared state between invocations
  const args = new ScriptArgs(cmd.args?.getSchema() ?? {}, runner);
  args.parse(argv);

  // Extract positional args (anything that isn't a flag or option value). Plugin commands
  // legitimately want these (e.g. an optional service id like `nopo playwright e2e root`);
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.startsWith("--") || tok.startsWith("-")) {
      // Skip flag and its value if the next token isn't another flag.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
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
    ...runner.contextIO(),
  };

  await cmd.fn(context, args);
}
