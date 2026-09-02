/** Service-local command DAG — a primitive shared across plugins. Plugins that compose work
 * out of a service's top-level `commands:` map (currently the docker plugin's
 * `build.command: { deps: [...] }` form) use these helpers to: (1) Walk deps from one or
 * more roots, topologically sort, and validate that every referenced command is a leaf
 */
import type { NormalizedCommand } from "./config/index.ts";

/** A leaf step in the DAG, ready to execute or serialize. */
interface CommandDagStep {
  name: string;
  /** The shell command to run — never empty once we return the step. */
  command: string;
  env?: Record<string, string>;
  dir?: string;
}

interface ResolveCommandDagOptions {
  /** Used only for error messages. */
  serviceId: string;
  /** The service's top-level `commands:` map. */
  commands: Record<string, NormalizedCommand>;
  /** Root command names to resolve. Deps are walked transitively. */
  roots: string[];
}

/** Walk the DAG from `roots`, topologically sort, and return the ordered leaf steps.
 * Composition nodes (commands with `deps` but no `command`) are skipped in the output —
 * their deps already ran. Rejects with a thrown Error on: missing refs cycles `context:
 * container` (DAG must run on host — the default) nested `commands:`
 */
export function resolveCommandDag(
  opts: ResolveCommandDagOptions,
): CommandDagStep[] {
  const { serviceId, commands, roots } = opts;
  const ordered: string[] = [];
  const permanent = new Set<string>();
  const temporary = new Set<string>();

  const visit = (name: string, chain: string[]): void => {
    if (permanent.has(name)) return;
    if (temporary.has(name)) {
      throw new Error(
        `Command DAG cycle in service "${serviceId}": ${[...chain, name].join(" \u2192 ")}`,
      );
    }

    const cmd = commands[name];
    if (!cmd) {
      throw new Error(
        `Service "${serviceId}" references unknown command "${name}". ` +
          `Declare it under the service's top-level commands: map.`,
      );
    }
    if (cmd.context === "container") {
      throw new Error(
        `Service "${serviceId}" command DAG cannot reference "${name}" \u2014 ` +
          `it declares context: container. DAG must run on host (the default).`,
      );
    }
    if (cmd.commands !== undefined) {
      throw new Error(
        `Service "${serviceId}" command DAG cannot reference "${name}" \u2014 ` +
          `commands with sub-commands are not supported. ` +
          `Reference a leaf command with a plain 'command:' string.`,
      );
    }
    if (cmd.dependencies !== undefined) {
      throw new Error(
        `Service "${serviceId}" command DAG cannot reference "${name}" \u2014 ` +
          `it declares cross-service 'dependencies:'. DAG must be ` +
          `self-contained to the service.`,
      );
    }

    temporary.add(name);
    for (const dep of cmd.deps ?? []) {
      visit(dep, [...chain, name]);
    }
    temporary.delete(name);
    permanent.add(name);
    ordered.push(name);
  };

  for (const root of roots) {
    visit(root, []);
  }

  const steps: CommandDagStep[] = [];
  for (const name of ordered) {
    const cmd = commands[name]!;
    if (!cmd.command) {
      // Composition node (deps-only) — nothing to execute, its deps ran.
      continue;
    }
    steps.push({
      name,
      command: cmd.command,
      env: cmd.env,
      dir: cmd.dir,
    });
  }
  return steps;
}

/** Serialize resolved DAG steps as a newline-joined shell script. Each step runs in its own
 * subshell: ( export FOO='bar' && cd sub/dir && the-command ) The subshell keeps `cd` and
 * `export` local to the step. The caller is responsible for shell hardening (e.g. the
 * docker plugin wraps the script in `<<'EOF'` + `set -e`).
 */
export function serializeCommandDagAsShell(steps: CommandDagStep[]): string {
  return steps.map(serializeStep).join("\n");
}

function serializeStep(step: CommandDagStep): string {
  const parts: string[] = [];
  if (step.env) {
    for (const [k, v] of Object.entries(step.env)) {
      parts.push(`export ${k}=${shellQuote(v)}`);
    }
  }
  if (step.dir) {
    parts.push(`cd ${shellQuote(step.dir)}`);
  }
  parts.push(step.command);
  return `( ${parts.join(" && ")} )`;
}

/**
 * POSIX-safe single-quote escape. Used for env values and dirs so nothing
 * re-expands in the subshell.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
