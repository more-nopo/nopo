import type {
  CommandContext,
  CommandDependencies,
  NormalizedCommand,
  NormalizedProjectConfig,
  NormalizedService,
  NormalizedSubCommand,
} from "../config/index.ts";

/**
 * Represents a command to execute on a specific service.
 */
interface CommandDependencySpec {
  service: string;
  command: string;
}

/**
 * Represents a resolved command with its executable and execution context.
 */
export interface ResolvedCommand {
  service: string;
  command: string;
  executable: string;
  env?: Record<string, string>;
  dir?: string; // "root", absolute path, or relative to service
  context?: CommandContext; // "host" (default) or "container"
}

/**
 * Represents an execution plan with stages that can be run in parallel.
 * Each stage contains commands that are independent of each other.
 */
interface ExecutionPlan {
  stages: ResolvedCommand[][];
}

/** Validates that all top-level target services have the specified command defined.
 * Dependencies of those services do NOT need to have the command defined. @param project -
 * The normalized project configuration @param commandName - The command to validate (e.g.,
 * "lint", "build") @param targets - The top-level target service IDs @throws Error if any
 */
export function validateCommandTargets(
  project: NormalizedProjectConfig,
  commandName: string,
  targets: string[],
): void {
  for (const target of targets) {
    const service = project.services.entries[target];
    if (!service) {
      throw new Error(
        `Unknown service '${target}'. Available services: ${project.services.targets.join(", ")}`,
      );
    }

    // Get the root command name (before any colons for subcommands)
    const rootCommand = commandName.split(":")[0]!;

    if (!service.commands[rootCommand]) {
      throw new Error(
        `Service '${target}' does not define command '${commandName}'. ` +
          `Available commands: ${Object.keys(service.commands).join(", ") || "none"}`,
      );
    }
  }
}

/** Covers both declaration styles: literal top-level keys, which may themselves contain
 * colons (`test:integration:` in a `commands:` map stays one literal key); paths reachable
 * by walking nested `commands:` blocks (`db:` → `db:migrate`, `db:makemigrations`). Parent
 * nodes are emitted alongside their children because {@link resolveCommand} accepts
 */
export function listCommandPaths(service: NormalizedService): string[] {
  const paths: string[] = [];

  const walk = (
    node: NormalizedCommand | NormalizedSubCommand,
    prefix: string,
  ): void => {
    paths.push(prefix);
    if (!node.commands) return;
    for (const [name, child] of Object.entries(node.commands)) {
      walk(child, `${prefix}:${name}`);
    }
  };

  for (const [name, command] of Object.entries(service.commands)) {
    walk(command, name);
  }
  return paths;
}

/** Last `:`-separated segment of a command path. */
function leafOf(commandPath: string): string {
  return commandPath.slice(commandPath.lastIndexOf(":") + 1);
}

/**
 * Locate the config node a command path points at, or `undefined`.
 * Checks the literal key first (colon-in-key declarations), then walks
 * nested `commands:` maps segment by segment.
 */
export function findCommandNode(
  service: NormalizedService,
  commandPath: string,
): NormalizedCommand | NormalizedSubCommand | undefined {
  const literal = service.commands[commandPath];
  if (literal) return literal;

  const parts = commandPath.split(":");
  let node: NormalizedCommand | NormalizedSubCommand | undefined =
    service.commands[parts[0]!];
  for (const part of parts.slice(1)) {
    if (!node?.commands) return undefined;
    node = node.commands[part];
  }
  return node;
}

/** Outcome of resolving one user-typed command name against one service. */
export interface ServiceCommandResolution {
  /**
   * Full colon path that resolves on this service, or `null` when the
   * service can't run this command (or the name is ambiguous).
   */
  path: string | null;
  /**
   * Nested paths whose leaf segment matched the requested name. Length
   * > 1 means ambiguous — callers surface these as candidates.
   */
  candidates: string[];
}

/** comma-list, and each item in that list may be negated with a leading `-`. Descending out
 * of a list (`test:unit,admin:slow`) is a parse error — it would need a distribution rule
 * nobody can read at a glance. test -> path [] , no list test:unit -> path ["unit"] , no
 * list test:unit:slow -> path ["unit","slow"], no list test:-integration -> path []
 */
export interface CommandSelector {
  /** Top-level command name. */
  root: string;
  /** Plain segments to descend before applying the list. */
  path: string[];
  /** Names to keep. Empty means "everything at this level". */
  include: string[];
  /** Names to drop. */
  exclude: string[];
  /** True when the final segment was a comma-list / negation. */
  hasList: boolean;
}

/** Thrown for a malformed selector so the CLI can exit 1 with the reason. */
export class CommandSelectorError extends Error {}

/**
 * Parse a colon selector. Never throws for an *unknown* name — only for a
 * shape the grammar forbids.
 */
export function parseCommandSelector(commandName: string): CommandSelector {
  const parts = commandName.split(":");
  const root = parts[0]!;
  const rest = parts.slice(1);

  if (root.length === 0) {
    throw new CommandSelectorError(
      `Invalid command '${commandName}': it must start with a command name.`,
    );
  }

  const path: string[] = [];
  const include: string[] = [];
  const exclude: string[] = [];
  let hasList = false;

  for (const [i, segment] of rest.entries()) {
    const isLast = i === rest.length - 1;
    // Only a LEADING dash negates — `eslint-plugin` is a plain name.
    const looksLikeList = segment.includes(",") || segment.startsWith("-");

    if (!looksLikeList) {
      if (segment.length === 0) {
        throw new CommandSelectorError(
          `Invalid command '${commandName}': empty segment.`,
        );
      }
      path.push(segment);
      continue;
    }

    if (!isLast) {
      throw new CommandSelectorError(
        `Invalid command '${commandName}': a comma-list or negation may only ` +
          `appear in the LAST segment. Write '${root}:${segment.split(",")[0]}:...' ` +
          `or move the list to the end.`,
      );
    }

    hasList = true;
    for (const raw of segment.split(",")) {
      const item = raw.trim();
      if (item === "" || item === "-") {
        throw new CommandSelectorError(
          `Invalid command '${commandName}': empty item in the selector list.`,
        );
      }
      if (item.startsWith("-")) exclude.push(item.slice(1));
      else include.push(item);
    }
  }

  return { root, path, include, exclude, hasList };
}

/**
 * Apply a selector's include/exclude lists to the children available at
 * one level. An INCLUDE is a whitelist; an EXCLUDE subtracts from
 * "everything". Order matters only in that excludes always win.
 */
export function selectChildNames(
  available: string[],
  selector: Pick<CommandSelector, "include" | "exclude">,
): string[] {
  const kept =
    selector.include.length > 0
      ? available.filter((name) => selector.include.includes(name))
      : available;
  return kept.filter((name) => !selector.exclude.includes(name));
}

/** Only the ROOT has to exist here — everything after the first colon is navigated by
 * `resolveCommand`, which skips (rather than errors) when a service simply doesn't declare
 * that subcommand. There is deliberately NO bare-name fallback to a nested leaf: colon
 * addressing is the only way to reach a subcommand, so `nopo makemigrations af-api` no
 */
export function resolveServiceCommandPath(
  service: NormalizedService,
  commandName: string,
): ServiceCommandResolution {
  // 1. Literal key — covers colon-in-key declarations (`test:integration:`).
  if (service.commands[commandName]) {
    return { path: commandName, candidates: [commandName] };
  }

  // 2. Root key present — subpath navigation is resolveCommand's job.
  const root = commandName.split(":")[0]!;
  if (service.commands[root]) {
    return { path: commandName, candidates: [commandName] };
  }

  // 3. Root absent: this service does not answer to the command at all.
  return { path: null, candidates: [] };
}

/** Inputs to {@link assertCommandDispatches}. */
export interface CommandDispatchCheck {
  project: NormalizedProjectConfig;
  /** The user-typed command name (may be a colon path). */
  commandName: string;
  /** Services named as positionals on the CLI. */
  explicitTargets: readonly string[];
  /** Number of NON-EMPTY stages the resolved plan produced. */
  stageCount: number;
  /** `--skip-missing` — opts back into the silent no-op. */
  skipMissing: boolean;
  /**
   * True when `--filter` / `--changed` narrowed the target set. A
   * narrowing predicate matching nothing is a legitimate no-op, so the
   * zero-stage guard stands down.
   */
  narrowed: boolean;
}

/** The wrapper used to exit 0 after dispatching an empty target list:
 * `CommandScript.targetFilter` dropped every service that didn't declare the command, and
 * the only guard was "is this command defined on ANY service?". `nopo makemigrations
 * af-api` slipped through that guard — `makemigrations` exists on the Django backend,
 */
export function assertCommandDispatches(check: CommandDispatchCheck): void {
  const {
    project,
    commandName,
    explicitTargets,
    stageCount,
    skipMissing,
    narrowed,
  } = check;

  // `--skip-missing` is the documented opt-in for "silently drop targets
  // that don't implement this command".
  if (skipMissing) return;

  for (const target of explicitTargets) {
    const service = project.services.entries[target];
    // Unknown service ids are validated upstream with a better message.
    if (!service) continue;

    // Every target in this loop was named on the CLI, so the nested-leaf
    // fallback is in scope here by construction.
    const { path } = resolveServiceCommandPath(service, commandName);
    if (path !== null) continue;

    // Subcommands are reachable only through colon syntax, so a bare name that exists ONLY as
    // a nested leaf used to resolve and now doesn't. Name the colon path rather than making
    if (!commandName.includes(":")) {
      const nested = listCommandPaths(service).filter(
        (p) => p.includes(":") && leafOf(p) === commandName,
      );
      if (nested.length > 0) {
        throw new Error(
          `Service '${target}' does not define a top-level command ` +
            `'${commandName}', but it is nested at ${nested.join(", ")}. ` +
            `Subcommands are addressed with a colon: ` +
            `'nopo ${nested[0]} ${target}'.`,
        );
      }
    }

    const available = listCommandPaths(service).join(", ") || "none";
    throw new Error(
      `Service '${target}' does not define command '${commandName}'. ` +
        `Available commands: ${available}. ` +
        `Pass --skip-missing to treat this as a no-op.`,
    );
  }

  if (stageCount > 0) return;
  // `--filter` / `--changed` matching nothing is a real no-op, not a bug.
  if (narrowed) return;

  const scope =
    explicitTargets.length > 0
      ? `target${explicitTargets.length > 1 ? "s" : ""} '${explicitTargets.join("', '")}'`
      : "any service";
  throw new Error(
    `Command '${commandName}' resolved to 0 stages for ${scope} — nothing would run. ` +
      `Check that '${commandName}' is defined in nopo.yml, or pass --skip-missing ` +
      `to allow an empty dispatch.`,
  );
}

/** If the command has subcommands, returns all subcommands flattened. Subcommands are
 * returned with their full path (e.g., "lint:ts"). @param project - The normalized project
 * configuration @param commandName - The command to resolve (can include subcommand path
 * like "lint:ts") @param serviceId - The service ID @returns Array of resolved commands
 */
export function resolveCommand(
  project: NormalizedProjectConfig,
  commandName: string,
  serviceId: string,
): ResolvedCommand[] {
  const service = project.services.entries[serviceId];
  if (!service) {
    throw new Error(`Unknown service '${serviceId}'`);
  }

  // Literal colon-in-key declarations (`test:integration:` as one key) win
  // before the selector grammar gets a look — they are a single name.
  const literal = service.commands[commandName];
  if (literal?.command) {
    return [
      {
        service: serviceId,
        command: commandName,
        executable: literal.command,
        env: literal.env,
        dir: literal.dir,
        context: literal.context,
      },
    ];
  }

  const selector = parseCommandSelector(commandName);
  const rootCommand = selector.root;
  const subPath = selector.path;

  const command = service.commands[rootCommand];
  if (!command) {
    throw new Error(
      `Command '${commandName}' not found in service '${serviceId}'. ` +
        `Available commands: ${Object.keys(service.commands).join(", ") || "none"}`,
    );
  }

  // Navigate the colon path and/or apply a selector list.
  if (subPath.length > 0 || selector.hasList) {
    return resolveSubCommandPath(
      serviceId,
      rootCommand,
      command,
      subPath,
      selector,
    );
  }

  // If the command has subcommands, return all of them
  if (command.commands) {
    return flattenSubCommands(
      serviceId,
      rootCommand,
      command.commands,
      command.env,
      command.dir,
      command.context,
    );
  }

  // Simple command with executable
  if (command.command) {
    return [
      {
        service: serviceId,
        command: commandName,
        executable: command.command,
        env: command.env,
        dir: command.dir,
        context: command.context,
      },
    ];
  }

  // Deps-only command (pure composition) — no own executable
  if (command.deps && command.deps.length > 0) {
    return [];
  }

  throw new Error(
    `Command '${commandName}' in service '${serviceId}' has no executable`,
  );
}

/**
 * Navigate to a specific subcommand path and resolve it.
 */
function resolveSubCommandPath(
  serviceId: string,
  basePath: string,
  command: NormalizedCommand,
  subPath: string[],
  selector?: CommandSelector,
): ResolvedCommand[] {
  let current: NormalizedCommand | NormalizedSubCommand = command;
  let currentPath = basePath;
  // Inherit env/dir/context from parent commands
  let inheritedEnv: Record<string, string> | undefined = command.env;
  let inheritedDir: string | undefined = command.dir;
  let inheritedContext: CommandContext | undefined = command.context;

  for (const part of subPath) {
    currentPath = `${currentPath}:${part}`;

    // A service that simply doesn't declare this subcommand is SKIPPED, not an error: `nopo
    // test:integration db af-api` must run af-api and leave db alone. A missing ROOT command
    if (!current.commands || !current.commands[part]) {
      return [];
    }

    current = current.commands[part];
    // Child env/dir/context overrides parent
    if (current.env) inheritedEnv = { ...inheritedEnv, ...current.env };
    if (current.dir) inheritedDir = current.dir;
    if (current.context) inheritedContext = current.context;
  }

  // Apply the selector list, if the caller wrote one.
  if (selector?.hasList) {
    if (!current.commands) {
      // An include list names children it does not have, so it is skipped; an exclude-only list
      // subtracts from "everything", and nothing here is named, so the leaf survives. This is
      if (selector.include.length > 0) return [];
    } else {
      const kept = selectChildNames(Object.keys(current.commands), selector);
      if (kept.length === 0) return [];
      const subset: Record<string, NormalizedSubCommand> = {};
      for (const name of kept) subset[name] = current.commands[name]!;
      return flattenSubCommands(
        serviceId,
        currentPath,
        subset,
        inheritedEnv,
        inheritedDir,
        inheritedContext,
      );
    }
  }

  // If we landed on a command with subcommands, flatten them
  if (current.commands) {
    return flattenSubCommands(
      serviceId,
      currentPath,
      current.commands,
      inheritedEnv,
      inheritedDir,
      inheritedContext,
    );
  }

  // Single command
  if (current.command) {
    return [
      {
        service: serviceId,
        command: currentPath,
        executable: current.command,
        env: current.env ? { ...inheritedEnv, ...current.env } : inheritedEnv,
        dir: current.dir || inheritedDir,
        context: current.context || inheritedContext,
      },
    ];
  }

  // Deps-only subcommand (pure composition)
  if (current.deps && current.deps.length > 0) {
    return [];
  }

  throw new Error(
    `Command '${currentPath}' in service '${serviceId}' has no executable`,
  );
}

/**
 * Flatten all subcommands into resolved commands.
 */
function flattenSubCommands(
  serviceId: string,
  basePath: string,
  subCommands: Record<string, NormalizedSubCommand>,
  parentEnv?: Record<string, string>,
  parentDir?: string,
  parentContext?: CommandContext,
): ResolvedCommand[] {
  const result: ResolvedCommand[] = [];

  for (const [name, subCmd] of Object.entries(subCommands)) {
    const cmdPath = `${basePath}:${name}`;
    // Merge env from parent, child overrides
    const mergedEnv = subCmd.env ? { ...parentEnv, ...subCmd.env } : parentEnv;
    // Child dir/context overrides parent
    const effectiveDir = subCmd.dir || parentDir;
    const effectiveContext = subCmd.context || parentContext;

    if (subCmd.commands) {
      // Recurse into nested subcommands
      result.push(
        ...flattenSubCommands(
          serviceId,
          cmdPath,
          subCmd.commands,
          mergedEnv,
          effectiveDir,
          effectiveContext,
        ),
      );
    } else if (subCmd.command) {
      result.push({
        service: serviceId,
        command: cmdPath,
        executable: subCmd.command,
        env: mergedEnv,
        dir: effectiveDir,
        context: effectiveContext,
      });
    }
    // deps-only subcommands are valid but produce no executable task
    // — their deps are resolved as dependency edges in addTasksForCommand
  }

  return result;
}

/** Resolves the dependencies for a specific command on a service. Returns a flat list of
 * CommandDependencySpec objects representing all dependencies that need to run before this
 * command. @param project - The normalized project configuration @param commandName - The
 * command to resolve dependencies for @param serviceId - The service ID to resolve
 */
export function resolveCommandDependencies(
  project: NormalizedProjectConfig,
  commandName: string,
  serviceId: string,
): CommandDependencySpec[] {
  const service = project.services.entries[serviceId];
  if (!service) {
    return [];
  }

  // Get the root command (before subcommand path)
  const rootCommand = commandName.split(":")[0]!;
  const command = service.commands[rootCommand];
  const visited = new Set<string>();
  const result: CommandDependencySpec[] = [];

  // Determine which dependencies to use
  const commandDeps = command?.dependencies;

  // Empty object means explicitly no dependencies
  if (
    commandDeps !== undefined &&
    typeof commandDeps === "object" &&
    !Array.isArray(commandDeps) &&
    Object.keys(commandDeps).length === 0
  ) {
    return [];
  }

  // Get the effective dependencies
  const deps = getEffectiveDependencies(service, rootCommand);

  // Resolve each dependency recursively
  for (const dep of deps) {
    collectDependencies(
      project,
      dep.service,
      dep.command,
      visited,
      result,
      new Set([serviceId]),
    );
  }

  return result;
}

/**
 * Get effective dependencies for a service command.
 * Uses only explicit command.depends_on - no fallback to service-level dependencies.
 * Returns empty array if command.depends_on is not defined.
 */
function getEffectiveDependencies(
  service: NormalizedService,
  commandName: string,
): CommandDependencySpec[] {
  const command = service.commands[commandName];
  const commandDeps = command?.dependencies;

  // Only use explicit command dependencies
  if (commandDeps !== undefined) {
    return normalizeDependencies(commandDeps, commandName);
  }

  // No implicit dependencies - return empty array
  return [];
}

/**
 * Normalize various dependency formats to a flat list of specs.
 */
function normalizeDependencies(
  deps: CommandDependencies,
  defaultCommand: string,
): CommandDependencySpec[] {
  if (!deps) {
    return [];
  }

  // Array format: ["backend", "worker"] -> same command on each
  if (Array.isArray(deps)) {
    return deps.map((service) => ({
      service,
      command: defaultCommand,
    }));
  }

  // Object format: { backend: ["build", "clean"] }
  const result: CommandDependencySpec[] = [];
  for (const [service, commands] of Object.entries(deps)) {
    for (const cmd of commands) {
      result.push({ service, command: cmd });
    }
  }
  return result;
}

/**
 * Recursively collect all dependencies for a service/command.
 * @throws Error if a dependency service does not have the required command
 */
function collectDependencies(
  project: NormalizedProjectConfig,
  serviceId: string,
  commandName: string,
  visited: Set<string>,
  result: CommandDependencySpec[],
  path: Set<string>,
): void {
  const key = `${serviceId}:${commandName}`;

  // Skip if already visited
  if (visited.has(key)) {
    return;
  }

  const service = project.services.entries[serviceId];
  if (!service) {
    throw new Error(`Unknown service '${serviceId}' referenced as dependency`);
  }

  // Error if service doesn't have this command (changed from skip to error)
  const command = service.commands[commandName];
  if (!command) {
    throw new Error(
      `Service '${serviceId}' does not define command '${commandName}'. ` +
        `Dependencies must have the required command defined.`,
    );
  }

  // Mark as visited
  visited.add(key);

  // Get this service's dependencies and recurse first
  const deps = getEffectiveDependencies(service, commandName);
  for (const dep of deps) {
    // Check for circular dependencies
    if (path.has(dep.service)) {
      continue; // Skip circular for dependency collection (checked in build plan)
    }

    const newPath = new Set(path);
    newPath.add(serviceId);

    collectDependencies(
      project,
      dep.service,
      dep.command,
      visited,
      result,
      newPath,
    );
  }

  // Add this dependency to result
  result.push({ service: serviceId, command: commandName });
}

/** Builds an execution plan that groups independent commands into stages that can be run in
 * parallel. @param project - The normalized project configuration @param commandName - The
 * command to build the plan for @param targets - The top-level target service IDs @param
 * commandPaths - Optional per-target command path override. One user-typed name can
 */
export function buildExecutionPlan(
  project: NormalizedProjectConfig,
  commandName: string,
  targets: string[],
  commandPaths?: ReadonlyMap<string, string>,
): ExecutionPlan {
  // Collect all tasks that need to run, including subcommands
  const allTasks = new Map<string, ResolvedCommand>();
  const taskDependencies = new Map<string, Set<string>>();

  for (const target of targets) {
    const targetCommand = commandPaths?.get(target) ?? commandName;

    // First, add all dependencies for this target
    const deps = resolveCommandDependencies(project, targetCommand, target);
    for (const dep of deps) {
      addTasksForCommand(
        project,
        dep.service,
        dep.command,
        allTasks,
        taskDependencies,
      );
    }

    // Then add the target itself
    addTasksForCommand(
      project,
      target,
      targetCommand,
      allTasks,
      taskDependencies,
    );
  }

  // Build dependency graph for topological sort
  const graph = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  // Initialize graph nodes
  for (const [key] of allTasks) {
    graph.set(key, new Set());
    inDegree.set(key, 0);
  }

  // Build edges based on dependencies
  for (const [key] of allTasks) {
    const deps = taskDependencies.get(key) || new Set();

    for (const depKey of deps) {
      // Only add edge if the dependency is in our task set
      if (allTasks.has(depKey)) {
        const edges = graph.get(depKey) || new Set();
        edges.add(key);
        graph.set(depKey, edges);

        const degree = inDegree.get(key) || 0;
        inDegree.set(key, degree + 1);
      }
    }
  }

  // Detect circular dependencies using Kahn's algorithm
  const stages: ResolvedCommand[][] = [];
  const remaining = new Map(inDegree);

  while (remaining.size > 0) {
    // Find all tasks with no remaining dependencies
    const stage: ResolvedCommand[] = [];

    for (const [key, degree] of remaining) {
      if (degree === 0) {
        const task = allTasks.get(key);
        if (task) {
          stage.push(task);
        }
      }
    }

    // If no tasks can be executed, we have a circular dependency
    if (stage.length === 0) {
      const remainingTasks = Array.from(remaining.keys()).join(", ");
      throw new Error(
        `Circular dependency detected. Cannot resolve: ${remainingTasks}`,
      );
    }

    // Add stage and update degrees
    stages.push(stage);

    for (const task of stage) {
      const key = `${task.service}:${task.command}`;
      remaining.delete(key);

      const edges = graph.get(key);
      if (edges) {
        for (const dependentKey of edges) {
          const degree = remaining.get(dependentKey);
          if (degree !== undefined) {
            remaining.set(dependentKey, degree - 1);
          }
        }
      }
    }
  }

  return { stages };
}

/**
 * Navigate the command tree and return the node at the given path.
 */
function getCommandNode(
  service: NormalizedService,
  commandPath: string,
): NormalizedCommand | NormalizedSubCommand | undefined {
  const parts = commandPath.split(":");
  const rootCommand = parts[0]!;
  const command = service.commands[rootCommand];
  if (!command) return undefined;

  let current: NormalizedCommand | NormalizedSubCommand = command;
  for (const part of parts.slice(1)) {
    if (!current.commands?.[part]) return undefined;
    current = current.commands[part];
  }
  return current;
}

/**
 * Get deps from a command node at the given path.
 */
function getCommandNodeDeps(
  service: NormalizedService,
  commandPath: string,
): string[] {
  const node = getCommandNode(service, commandPath);
  return node?.deps ?? [];
}

/**
 * Collect all deps-only subcommand paths from a composite command.
 * These are subcommands that have deps but no command/subcommands.
 */
function collectDepsOnlySubcommands(
  service: NormalizedService,
  commandPath: string,
): string[] {
  const node = getCommandNode(service, commandPath);
  if (!node?.commands) return [];

  const result: string[] = [];
  for (const [name, sub] of Object.entries(node.commands)) {
    const subPath = `${commandPath}:${name}`;
    if (sub.deps && sub.deps.length > 0 && !sub.command && !sub.commands) {
      result.push(subPath);
    }
    // Recurse into nested subcommands
    if (sub.commands) {
      for (const [subName, subSub] of Object.entries(sub.commands)) {
        const subSubPath = `${subPath}:${subName}`;
        if (subSub.deps && subSub.deps.length > 0 && !subSub.command) {
          result.push(subSubPath);
        }
      }
    }
  }
  return result;
}

/** `@` separates the optional service target; `:` is reserved for subcommands. "stop" →
 * same service, top-level command "setup:registry" → same service, subcommand
 * "stop@backend" → cross-service top-level command "setup:registry@runner" → cross-service
 * subcommand
 */
function parseDep(
  dep: string,
  defaultService: string,
): { service: string; command: string } {
  const atIdx = dep.indexOf("@");
  if (atIdx >= 0) {
    return {
      command: dep.slice(0, atIdx),
      service: dep.slice(atIdx + 1),
    };
  }
  return { command: dep, service: defaultService };
}

/**
 * Add dep tasks to the graph and return their resolved task keys.
 * For deps-only commands (which resolve to []), returns the keys of
 * their own deps transitively so that dependents wait on the right tasks.
 */
function addDepsToGraph(
  project: NormalizedProjectConfig,
  depStrings: string[],
  serviceId: string,
  allTasks: Map<string, ResolvedCommand>,
  taskDependencies: Map<string, Set<string>>,
): string[] {
  const depKeys: string[] = [];
  for (const dep of depStrings) {
    const { command: depCommand, service: depService } = parseDep(
      dep,
      serviceId,
    );
    // Recursively add dep commands as tasks
    addTasksForCommand(
      project,
      depService,
      depCommand,
      allTasks,
      taskDependencies,
    );
    // Collect resolved task keys from this dep
    const depResolved = resolveCommand(project, depCommand, depService);
    if (depResolved.length > 0) {
      for (const depTask of depResolved) {
        depKeys.push(`${depTask.service}:${depTask.command}`);
      }
    } else {
      // Deps-only command: propagate its own deps' keys transitively
      const depServiceObj = project.services.entries[depService];
      if (depServiceObj) {
        const transitiveDeps = getCommandNodeDeps(depServiceObj, depCommand);
        const transitiveKeys = addDepsToGraph(
          project,
          transitiveDeps,
          depService,
          allTasks,
          taskDependencies,
        );
        depKeys.push(...transitiveKeys);
      }
    }
  }
  return depKeys;
}

/**
 * Add tasks for a command, handling subcommands and deps.
 */
function addTasksForCommand(
  project: NormalizedProjectConfig,
  serviceId: string,
  commandName: string,
  allTasks: Map<string, ResolvedCommand>,
  taskDependencies: Map<string, Set<string>>,
): void {
  const resolved = resolveCommand(project, commandName, serviceId);
  const rootCommand = commandName.split(":")[0]!;

  // Get cross-service dependencies for this command
  const service = project.services.entries[serviceId];
  const serviceDeps = service
    ? getEffectiveDependencies(service, rootCommand)
    : [];

  // Get root-level deps (from the command path itself)
  const rootDeps = service ? getCommandNodeDeps(service, commandName) : [];

  // Add root-level deps to the graph
  const rootDepKeys = addDepsToGraph(
    project,
    rootDeps,
    serviceId,
    allTasks,
    taskDependencies,
  );

  for (const task of resolved) {
    const key = `${task.service}:${task.command}`;
    if (!allTasks.has(key)) {
      allTasks.set(key, task);

      const deps = new Set<string>();

      // Cross-service dependencies
      for (const dep of serviceDeps) {
        try {
          const depResolved = resolveCommand(project, dep.command, dep.service);
          for (const depTask of depResolved) {
            deps.add(`${depTask.service}:${depTask.command}`);
          }
        } catch {
          // If dependency doesn't have the command, it was already validated
        }
      }

      // Root-level deps apply to all resolved tasks
      for (const depKey of rootDepKeys) {
        deps.add(depKey);
      }

      // Per-subcommand deps: check if this specific task's command path has deps
      if (service) {
        const taskDeps = getCommandNodeDeps(service, task.command);
        const taskDepKeys = addDepsToGraph(
          project,
          taskDeps,
          serviceId,
          allTasks,
          taskDependencies,
        );
        for (const depKey of taskDepKeys) {
          deps.add(depKey);
        }
      }

      taskDependencies.set(key, deps);
    }
  }

  // Process deps-only subcommands that weren't included in resolved tasks.
  // These have deps but no executable — their deps still need to be in the graph.
  if (service) {
    const depsOnlySubs = collectDepsOnlySubcommands(service, commandName);
    for (const subPath of depsOnlySubs) {
      const subDeps = getCommandNodeDeps(service, subPath);
      addDepsToGraph(project, subDeps, serviceId, allTasks, taskDependencies);
    }
  }
}
