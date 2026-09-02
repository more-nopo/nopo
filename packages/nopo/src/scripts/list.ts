import { baseArgs } from "../args.ts";
import type { NormalizedService, TargetType } from "../config/index.ts";
import { Script } from "../lib.ts";
import { type Plan, planFromNodes } from "../plan.ts";
import type { ScriptArgs } from "../script-args.ts";

/** A chalk-style colorizer: callable + chainable enough for our use. */
type Colorize = (...args: unknown[]) => string;

/**
 * The subset of the `chalk` surface {@link listRun} uses. Defined locally
 * so tests can pass a trivial stub (e.g. identity functions) without
 * dragging in the real chalk instance.
 */
export interface ListChalk {
  cyan: Colorize;
  bold: Colorize;
  gray: Colorize;
  yellow: Colorize;
  blue: Colorize;
  magenta: Colorize;
}

/**
 * Logger surface {@link listRun} uses — just `log()` plus a chalk bag for
 * the human-readable table rendering. Matches the relevant slice of
 * `Runner#logger` (lib.ts:Logger).
 */
export interface ListLogger {
  log(...args: unknown[]): void;
  chalk: ListChalk;
}

/** IO surface {@link listRun} writes to. Matches `Runner#io` (io.ts:IO). */
export interface ListIO {
  stdout: { write(s: string): void };
}

/**
 * Outcome of an exec call as the handler sees it. Narrower than the
 * real `ProcessPromise` so tests can pass a plain async function and the
 * module stays free of lib.ts internals.
 */
export interface ListExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Options the jq exec call uses — narrowed from the real `ExecOptions`. */
export interface ListExecOptions {
  cwd: string;
  input: string;
  nothrow: boolean;
  silent: boolean;
}

/** Structural shape of the `exec` dependency {@link listRun} consumes. */
export type ListExec = (
  cmd: string,
  args: string[],
  options: ListExecOptions,
) => Promise<ListExecResult>;

/**
 * Inputs to {@link listRun}. Mirrors {@link CommandPlanScope}-style pattern:
 * everything the handler needs is pre-resolved by the dispatcher so the
 * handler stays free of `Runner` dependencies.
 */
export interface ListRunContext {
  /** The resolved target service ids in display order. */
  services: readonly string[];
  /** Service map from `runner.config.project.services.entries`. */
  entries: Record<string, NormalizedService>;
  /** Project metadata for the JSON `config` block. */
  project: { name: string; servicesDirs: readonly string[] };
  /** Output format. `"text"` is the default human-readable table. */
  format: "text" | "json" | "csv";
  /** Optional jq filter expression (requires `format === "json"`). */
  jqFilter?: string;
  /** When `true`, short-circuit with a "✓ Valid nopo.yml" log line. */
  validate: boolean;
  /** Project root, used as `cwd` when shelling out to jq. */
  cwd: string;
  io: ListIO;
  logger: ListLogger;
  exec: ListExec;
}

interface ProjectConfig {
  name: string;
  services_dirs: readonly string[];
}

interface ServiceConfig {
  description?: string;
  type: TargetType;
  cpu: string;
  memory: string;
  port: number;
  static_path: string;
}

function getProjectConfig(project: ListRunContext["project"]): ProjectConfig {
  return {
    name: project.name,
    services_dirs: project.servicesDirs,
  };
}

function getServicesWithConfig(
  services: readonly string[],
  entries: Record<string, NormalizedService>,
): Record<string, ServiceConfig> {
  const result: Record<string, ServiceConfig> = {};
  for (const service of services) {
    const definition = entries[service];
    if (!definition) continue;

    const runtime = definition.runtime;
    result[service] = {
      description: definition.description,
      type: definition.type,
      cpu: runtime?.cpu ?? "1",
      memory: runtime?.memory ?? "512Mi",
      port: runtime?.port ?? 3000,
      static_path: definition.staticPath,
    };
  }

  return result;
}

async function processJq(
  ctx: ListRunContext,
  jsonInput: string,
  filter: string,
): Promise<string> {
  const result = await ctx.exec("jq", ["-c", filter], {
    cwd: ctx.cwd,
    input: jsonInput,
    nothrow: true,
    silent: true,
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr?.trim() || "Unknown error";
    throw new Error(`jq filter failed: ${stderr}`);
  }

  return result.stdout.trim();
}

function printConfigTable(ctx: ListRunContext): void {
  const { services, entries, logger } = ctx;
  const { chalk } = logger;
  const configs = getServicesWithConfig(services, entries);

  // Define columns
  const columns = [
    { key: "service", header: "SERVICE", width: 12 },
    { key: "type", header: "TYPE", width: 8 },
    { key: "cpu", header: "CPU", width: 5 },
    { key: "memory", header: "MEMORY", width: 8 },
    { key: "port", header: "PORT", width: 6 },
  ];

  // Calculate column widths based on content
  for (const service of services) {
    const config = configs[service]!;
    columns[0]!.width = Math.max(columns[0]!.width, service.length);
    columns[1]!.width = Math.max(columns[1]!.width, config.cpu.length);
    columns[2]!.width = Math.max(columns[2]!.width, config.memory.length);
  }

  // Print header
  const headerRow = columns
    .map((col) => col.header.padEnd(col.width))
    .join("  ");
  logger.log(chalk.cyan(chalk.bold(headerRow)));

  // Print separator
  const separator = columns.map((col) => "-".repeat(col.width)).join("  ");
  logger.log(chalk.gray(separator));

  // Print rows
  for (const service of services) {
    const config = configs[service]!;
    const typeLabel =
      config.type === "package"
        ? chalk.blue("package")
        : chalk.magenta("service");
    const row = [
      chalk.yellow(service.padEnd(columns[0]!.width)),
      typeLabel.padEnd(columns[1]!.width + 9), // +9 for color codes
      config.cpu.padEnd(columns[2]!.width),
      config.memory.padEnd(columns[3]!.width),
      String(config.port).padEnd(columns[4]!.width),
    ];
    logger.log(row.join("  "));
  }

  logger.log("");
  logger.log(chalk.gray(`Total: ${services.length} service(s)`));
}

/** Backs the `"list:run"` builtin. Single source of truth for what `nopo list` (and
 * `--json` / `--csv` / `--validate` / `--jq`) emit.
 */
export async function listRun(ctx: ListRunContext): Promise<void> {
  const { services, entries, project, format, jqFilter, validate } = ctx;

  // Validate --jq requires --json
  if (jqFilter && format !== "json") {
    throw new Error("--jq requires --json format");
  }

  // If --validate, just output success message (config already validated during load)
  if (validate) {
    ctx.logger.log(
      `✓ Valid nopo.yml: ${project.name} (${services.length} services)`,
    );
    return;
  }

  if (format === "json") {
    const output = {
      config: getProjectConfig(project),
      services: getServicesWithConfig(services, entries),
    };
    const jsonOutput = JSON.stringify(output, null, 2);

    if (jqFilter) {
      const result = await processJq(ctx, jsonOutput, jqFilter);
      ctx.io.stdout.write(result + "\n");
    } else {
      ctx.io.stdout.write(jsonOutput + "\n");
    }
    return;
  }

  if (format === "csv") {
    ctx.io.stdout.write(services.join(",") + "\n");
    return;
  }

  // text
  if (services.length === 0) {
    ctx.logger.log("No services found.");
    return;
  }

  printConfigTable(ctx);
}

export default class ListScript extends Script {
  static override skipQueue = true; // instant, read-only — never wait
  static override name = "list";
  static override description = "List discovered services";

  static override args = baseArgs.extend({
    format: {
      type: "string",
      description: "Output format (text, json, csv)",
      // Note: -f conflicts with baseArgs --filter alias, use long form
      default: "text",
    },
    json: {
      type: "boolean",
      description: "Output as JSON (shortcut for --format json)",
      alias: ["j"],
      default: false,
    },
    csv: {
      type: "boolean",
      description: "Output as CSV (shortcut for --format csv)",
      default: false,
    },
    jq: {
      type: "string",
      description: "jq filter expression for JSON output",
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- undefined default for optional arg, typed as string when provided
      default: undefined as unknown as string,
    },
    validate: {
      type: "boolean",
      description: "Validate configuration only",
      alias: ["v"],
      default: false,
    },
    "with-dependencies": {
      type: "boolean",
      description: "Include direct dependencies of filtered services",
      default: false,
    },
  });

  /** Single-node plan dispatching to {@link listRun} via `"list:run"`. */
  static plan(_args: ScriptArgs, _scope: { targets: readonly string[] }): Plan {
    return planFromNodes([
      {
        id: "list",
        handler: { kind: "builtin", name: "list:run" },
        needs: [],
        meta: { script: "list" },
      },
    ]);
  }
}
