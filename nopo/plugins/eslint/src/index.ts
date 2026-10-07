import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NormalizedService } from "@more-nopo/nopo/config";
import { expandEnvValues } from "@more-nopo/nopo/expand-env";
import {
  hasPluginCommand,
  type HookContext,
  type NopoPluginFactory,
} from "@more-nopo/nopo/plugin";
import { ScriptArgs } from "@more-nopo/nopo/script-args";
import { z } from "zod";

const optionsSchema = z
  .object({
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
  })
  .strict();

const projectSchema = optionsSchema.default({});
const targetOptionsSchema = z
  .object({
    config: z.string().min(1).optional(),
    env: z.record(z.string()).default({}),
  })
  .strict();
const targetSchema = z.union([z.boolean(), targetOptionsSchema]);

type ProjectOptions = z.infer<typeof projectSchema>;

export interface EslintTarget {
  id: string;
  root: string;
  config?: string;
  env: Record<string, string>;
}

const configNames = ["js", "mjs", "cjs", "ts", "mts", "cts"].map(
  (ext) => `eslint.config.${ext}`,
);

/** Target discovery never executes an ESLint config or guesses lint globs. */
export function discoverTargets(
  services: Record<string, NormalizedService>,
  requested: readonly string[],
  project: ProjectOptions,
  baseEnv: Record<string, string | undefined>,
): EslintTarget[] {
  const ids = requested.length
    ? [...new Set(requested)]
    : Object.keys(services).sort();
  const targets: EslintTarget[] = [];
  for (const id of ids) {
    const service = services[id];
    if (!service) throw new Error(`Unknown nopo target '${id}'.`);
    const raw = service.pluginData?.eslint;
    const config = raw === undefined ? undefined : targetSchema.parse(raw);
    if (config === false) {
      if (requested.length) throw new Error(`ESLint is disabled for '${id}'.`);
      continue;
    }
    const options =
      typeof config === "object" ? config : targetOptionsSchema.parse({});
    const root = service.paths.root;
    const configuredPath = options.config;
    const file = configuredPath
      ? path.resolve(root, configuredPath)
      : configNames.map((name) => path.join(root, name)).find(existsSync);
    if (file && !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`[eslint] ${id}: config file does not exist: ${file}`);
    }
    if (
      raw === undefined &&
      !file &&
      !hasPluginCommand(service.commands, "eslint")
    ) {
      if (requested.length) {
        throw new Error(
          `Target '${id}' has no ESLint config. Opt in with plugins.eslint: {}.`,
        );
      }
      continue;
    }
    const env = expandEnvValues(
      { ...service.env, ...project.env, ...options.env },
      baseEnv,
    );
    targets.push({
      id,
      root,
      config: file,
      env,
    });
  }
  if (!targets.length)
    throw new Error(
      "No ESLint targets found. Add an eslint.config.* or plugins.eslint: {} to a target.",
    );
  return targets;
}

/** Resolve the consumer's installation. Never download a runner or silently use the
 * plugin's devDependency, which may differ from the version its lint rules expect.
 */
function resolveEslint(root: string): { binary: string; version: string } {
  try {
    const require = createRequire(path.join(root, "package.json"));
    const manifestPath = require.resolve("eslint/package.json");
    const manifest = z
      .object({ version: z.string(), bin: z.union([z.string(), z.record(z.string())]) })
      .parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    const bin =
      typeof manifest.bin === "string"
        ? manifest.bin
        : manifest.bin.eslint;
    if (!bin) throw new Error("ESLint has no CLI entry point");
    return {
      binary: path.resolve(path.dirname(manifestPath), bin),
      version: manifest.version,
    };
  } catch (error) {
    throw new Error(
      `Cannot resolve an installed ESLint from ${root}. Install ESLint in that workspace.`,
      { cause: error },
    );
  }
}

function validateForwardedArgs(
  args: readonly string[],
  singleTarget: boolean,
): void {
  for (const arg of args) {
    if (!singleTarget && /^(?:--config(?:=|$)|-c(?:=|$))/.test(arg)) {
      throw new Error(
        `${arg} would replace nopo's target configuration. Use plugins.eslint.config instead.`,
      );
    }
  }
}

/** Meta flat-config that scopes each target's native config under its project root.
 * ESLint loads this once; file path prefixes attribute results back to targets.
 */
export function renderMetaConfig(
  targets: readonly EslintTarget[],
  cwd: string,
): string {
  const payload = targets.map((target) => ({
    id: target.id,
    root: target.root,
    config: target.config ?? null,
    relative: path.relative(cwd, target.root).split(path.sep).join("/") || ".",
  }));
  return `import { pathToFileURL } from "node:url";
import path from "node:path";

const targets = ${JSON.stringify(payload)};

function asArray(value) {
  if (value == null) return [{}];
  return Array.isArray(value) ? value : [value];
}

function scopePatterns(patterns, prefix) {
  return asArray(patterns).flatMap((pattern) => {
    if (typeof pattern !== "string") return [pattern];
    if (path.isAbsolute(pattern) || pattern.startsWith("!")) return [pattern];
    const cleaned = pattern.replace(/^\\.\\//, "");
    if (prefix === "." || cleaned.startsWith(prefix + "/")) return [cleaned];
    return [prefix + "/" + cleaned];
  });
}

function scopeEntry(entry, prefix, id) {
  const scoped = { ...entry, name: entry.name ?? \`nopo:\${id}\` };
  scoped.files = entry.files
    ? scopePatterns(entry.files, prefix)
    : [prefix === "." ? "**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}" : \`\${prefix}/**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}\`];
  if (entry.ignores) scoped.ignores = scopePatterns(entry.ignores, prefix);
  return scoped;
}

const configs = [];
for (const target of targets) {
  const prefix = target.relative;
  if (!target.config) {
    configs.push(scopeEntry({}, prefix, target.id));
    continue;
  }
  const mod = await import(pathToFileURL(target.config).href);
  for (const entry of asArray(mod.default)) {
    configs.push(scopeEntry(entry ?? {}, prefix, target.id));
  }
}
export default configs;
`;
}

export interface EslintMessageFile {
  filePath: string;
  errorCount: number;
  warningCount: number;
  messages: Array<{ severity: number; message: string; ruleId?: string | null; line?: number }>;
}

export interface TargetAttribution {
  id: string;
  errorCount: number;
  warningCount: number;
  files: string[];
}

/** Map ESLint JSON results onto discovered targets by absolute path prefix. */
export function attributeResults(
  targets: readonly EslintTarget[],
  results: readonly EslintMessageFile[],
): TargetAttribution[] {
  const sorted = [...targets].sort(
    (a, b) => b.root.length - a.root.length || a.id.localeCompare(b.id),
  );
  return targets.map((target) => {
    const files: string[] = [];
    let errorCount = 0;
    let warningCount = 0;
    for (const result of results) {
      const owner = sorted.find((candidate) => {
        const relative = path.relative(candidate.root, result.filePath);
        return (
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      });
      if (owner?.id !== target.id) continue;
      if (result.errorCount || result.warningCount || result.messages.length) {
        files.push(result.filePath);
      }
      errorCount += result.errorCount;
      warningCount += result.warningCount;
    }
    return { id: target.id, errorCount, warningCount, files };
  });
}

function parseEslintJson(stdout: string): EslintMessageFile[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error("[eslint] Expected JSON formatter output from ESLint.");
  }
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("[eslint] Expected JSON array from ESLint formatter.");
  }
  return parsed.map((row) => {
    const item = z
      .object({
        filePath: z.string(),
        errorCount: z.number().default(0),
        warningCount: z.number().default(0),
        messages: z
          .array(
            z.object({
              severity: z.number(),
              message: z.string(),
              ruleId: z.string().nullish(),
              line: z.number().optional(),
            }),
          )
          .default([]),
      })
      .parse(row);
    return item;
  });
}

function reportAttribution(
  context: HookContext,
  attribution: readonly TargetAttribution[],
): void {
  for (const target of attribution) {
    if (!target.errorCount && !target.warningCount) {
      context.io.stderr.write(`[eslint] ${target.id}: clean\n`);
      continue;
    }
    context.io.stderr.write(
      `[eslint] ${target.id}: ${target.errorCount} error(s), ${target.warningCount} warning(s) in ${target.files.length} file(s)\n`,
    );
  }
}

async function spawnEslint(
  context: HookContext,
  binary: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await context.exec(binary, args, {
    cwd,
    env,
    nothrow: true,
    silent: true,
  });
  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export async function executeEslint(
  context: HookContext,
  args: ScriptArgs,
  project: ProjectOptions,
): Promise<void> {
  const invocationArgs = context.argv ?? context.runner.argv?.slice(2) ?? [];
  const separator = invocationArgs.indexOf("--");
  for (const arg of context.commandContext
    ? []
    : separator < 0
      ? invocationArgs
      : invocationArgs.slice(0, separator)) {
    if (arg.startsWith("-") && arg.split("=")[0] !== "--print") {
      throw new Error(
        `Unknown nopo ESLint option '${arg}'. Put ESLint options after --.`,
      );
    }
  }
  const baseEnv = {
    ...context.io.env,
    ...context.runner.environment.env,
    ...context.runner.environment.extraEnv,
    ...context.commandContext?.env,
  };
  const services = context.runner.config.project.services.entries;
  const owner = context.commandContext;
  const scopedServices = owner
    ? {
        ...services,
        [owner.target]: {
          ...services[owner.target]!,
          paths: { ...services[owner.target]!.paths, root: owner.cwd },
          env: {},
        },
      }
    : services;
  const targets = discoverTargets(
    scopedServices,
    context.commandContext
      ? [context.commandContext.target]
      : (context.positionals ?? []),
    project,
    baseEnv,
  );
  const passthrough = context.commandContext
    ? [...(context.argv ?? [])]
    : [...(context.passthrough ?? [])];
  validateForwardedArgs(
    [...project.args, ...passthrough],
    targets.length === 1,
  );
  if (!context.commandContext && args.get<boolean>("print")) {
    context.io.stdout.write(
      JSON.stringify({
        command: "eslint",
        targets: targets.map(({ id, root, config }) => ({ id, root, config })),
        args: project.args,
        passthrough,
      }) + "\n",
    );
    return;
  }

  const installations = targets.map((target) => resolveEslint(target.root));
  const installation = installations[0]!;
  if (installations.some((item) => item.binary !== installation.binary)) {
    throw new Error(
      "Selected targets must share one ESLint installation. Install a common version in their workspace.",
    );
  }
  const [major = 0] = installation.version.split(".").map(Number);
  if (major < 9) {
    throw new Error(
      "The nopo ESLint plugin requires ESLint 9 or newer (flat config).",
    );
  }

  if (targets.length === 1) {
    const target = targets[0]!;
    const forwarded = [...project.args, ...passthrough];
    const overridesConfig = forwarded.some((arg) =>
      /^(?:--config(?:=|$)|-c(?:=|$))/.test(arg),
    );
    context.io.stderr.write(`[eslint] Target: ${target.id}\n`);
    const result = await spawnEslint(
      context,
      installation.binary,
      [
        ...(target.config && !overridesConfig
          ? ["--config", target.config]
          : []),
        "--format",
        "json",
        ...forwarded,
        ...(forwarded.some((arg) => !arg.startsWith("-")) ? [] : ["."]),
      ],
      target.root,
      { ...baseEnv, ...target.env },
    );
    if (result.stderr) context.io.stderr.write(result.stderr);
    const files = parseEslintJson(result.stdout);
    const attribution = attributeResults(targets, files);
    reportAttribution(context, attribution);
    // Stream a human-readable summary of messages after attribution.
    for (const file of files) {
      for (const message of file.messages) {
        const where = message.line ? `${file.filePath}:${message.line}` : file.filePath;
        const rule = message.ruleId ? ` ${message.ruleId}` : "";
        context.io.stderr.write(`${where}  ${message.message}${rule}\n`);
      }
    }
    if (result.exitCode !== 0 || attribution.some((item) => item.errorCount > 0)) {
      throw new Error(
        `[eslint] Lint failed for ${attribution
          .filter((item) => item.errorCount > 0)
          .map((item) => item.id)
          .join(", ") || target.id}`,
      );
    }
    return;
  }

  const temporary = mkdtempSync(path.join(tmpdir(), "nopo-eslint-"));
  try {
    const configFile = path.join(temporary, "eslint.config.mjs");
    const cwd = context.runner.config.root;
    writeFileSync(configFile, renderMetaConfig(targets, cwd), { mode: 0o600 });
    context.io.stderr.write(
      `[eslint] Targets: ${targets.map((t) => t.id).join(", ")}\n`,
    );
    const env = expandEnvValues({ ...project.env }, baseEnv);
    const paths = targets.map((target) =>
      path.relative(cwd, target.root) || ".",
    );
    const result = await spawnEslint(
      context,
      installation.binary,
      [
        "--config",
        configFile,
        "--format",
        "json",
        ...project.args,
        ...passthrough,
        ...paths,
      ],
      cwd,
      { ...baseEnv, ...env },
    );
    if (result.stderr) context.io.stderr.write(result.stderr);
    const files = parseEslintJson(result.stdout);
    const attribution = attributeResults(targets, files);
    reportAttribution(context, attribution);
    for (const file of files) {
      for (const message of file.messages) {
        const where = message.line ? `${file.filePath}:${message.line}` : file.filePath;
        const rule = message.ruleId ? ` ${message.ruleId}` : "";
        context.io.stderr.write(`${where}  ${message.message}${rule}\n`);
      }
    }
    if (result.exitCode !== 0 || attribution.some((item) => item.errorCount > 0)) {
      const failed = attribution
        .filter((item) => item.errorCount > 0)
        .map((item) => item.id);
      throw new Error(
        `[eslint] Lint failed for ${failed.join(", ") || "selected targets"}`,
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const eslintPlugin: NopoPluginFactory = (raw) => {
  const project = projectSchema.parse(raw);
  return {
    name: "eslint",
    defaultCommand: "run",
    description: "Lint nopo targets with one ESLint coordinator",
    configSchema: { project: projectSchema, service: targetSchema },
    commands: [
      {
        name: "run",
        description:
          "nopo eslint run [targets...] [--print] -- [ESLint options and paths]",
        args: new ScriptArgs({
          print: {
            type: "boolean",
            default: false,
            description: "Print selected targets without executing ESLint",
          },
        }),
        fn: (context, args) => executeEslint(context, args, project),
      },
    ],
  };
};

export default eslintPlugin;
