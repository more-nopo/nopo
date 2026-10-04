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
export interface VitestTarget {
  id: string;
  root: string;
  config?: string;
  env: Record<string, string>;
}

const configNames = ["ts", "mts", "cts", "js", "mjs", "cjs"].map(
  (ext) => `vitest.config.${ext}`,
);

/** Target discovery never executes a Vitest config or guesses at test-file globs. */
export function discoverTargets(
  services: Record<string, NormalizedService>,
  requested: readonly string[],
  project: ProjectOptions,
  baseEnv: Record<string, string | undefined>,
): VitestTarget[] {
  const ids = requested.length
    ? [...new Set(requested)]
    : Object.keys(services).sort();
  const targets: VitestTarget[] = [];
  for (const id of ids) {
    const service = services[id];
    if (!service) throw new Error(`Unknown nopo target '${id}'.`);
    const raw = service.pluginData?.vitest;
    const config = raw === undefined ? undefined : targetSchema.parse(raw);
    if (config === false) {
      if (requested.length) throw new Error(`Vitest is disabled for '${id}'.`);
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
      throw new Error(`[vitest] ${id}: config file does not exist: ${file}`);
    }
    if (
      raw === undefined &&
      !file &&
      !hasPluginCommand(service.commands, "vitest")
    ) {
      if (requested.length) {
        throw new Error(
          `Target '${id}' has no Vitest config. Opt in with plugins.vitest: {}.`,
        );
      }
      continue;
    }
    // Target environment belongs to Vitest's isolated project, not the shared
    // config-loading process. Production NODE_ENV must not leak into React tests.
    const env = expandEnvValues(
      { ...service.env, NODE_ENV: "test", ...project.env, ...options.env },
      baseEnv,
    );
    targets.push({ id, root, config: file, env });
  }
  if (!targets.length)
    throw new Error(
      "No Vitest targets found. Add a vitest.config.ts or plugins.vitest: {} to a target.",
    );
  return targets;
}

/** Resolve the consumer's installation. Never download a runner or silently use the
 * plugin's devDependency, which may differ from the version its tests were written for.
 */
function resolveVitest(root: string): { binary: string; version: string } {
  try {
    const require = createRequire(path.join(root, "package.json"));
    const manifestPath = require.resolve("vitest/package.json");
    const manifest = z
      .object({ version: z.string(), bin: z.record(z.string()) })
      .parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    const bin = manifest.bin.vitest;
    if (!bin) throw new Error("Vitest has no CLI entry point");
    return {
      binary: path.resolve(path.dirname(manifestPath), bin),
      version: manifest.version,
    };
  } catch (error) {
    throw new Error(
      `Cannot resolve an installed Vitest from ${root}. Install Vitest in that workspace.`,
      { cause: error },
    );
  }
}

// These options change which target/config is executed and belong to the plugin's
// target mapping. All other Vitest options and file filters are forwarded verbatim.
function validateForwardedArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (/^(?:--(?:root|config|workspace|projects)(?:=|\.|$)|-[cr])/.test(arg)) {
      throw new Error(
        `${arg} would replace nopo's target configuration. Use plugins.vitest.config instead.`,
      );
    }
  }
}

/** Vitest owns discovery, Vite plugins, aliases, setup, and file filtering for each
 * project. This config binds nopo target IDs to native Vitest project names.
 */
export function createVitestConfig(targets: readonly VitestTarget[]) {
  return {
    test: {
      projects: targets.map((target) => ({
        ...(target.config ? { extends: target.config } : {}),
        root: target.root,
        test: { name: target.id, env: target.env },
      })),
    },
  };
}

function renderConfig(targets: readonly VitestTarget[]): string {
  // Validate inside Vitest's config-loading lifecycle: evaluating configs in nopo
  // would execute them twice and could use a different Vite version/environment.
  return `
const config = ${JSON.stringify(createVitestConfig(targets))};
for (const project of config.test.projects) {
  project.plugins = [{
    name: 'nopo-vitest-project',
    enforce: 'post',
    configResolved(resolved) {
      if (resolved.test?.projects || resolved.test?.workspace) {
        throw new Error('[vitest] ' + project.test.name + ': nested projects/workspaces are unsupported. Point plugins.vitest.config at a single project config.');
      }
    },
  }];
}
export default config;
`;
}

async function spawnVitest(
  context: HookContext,
  binary: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  // Through nopo IO: argv boundaries, streamed output, and tracked subprocesses.
  await context.exec("node", [binary, ...args], { cwd, env, stdio: "inherit" });
}

export async function executeVitest(
  context: HookContext,
  args: ScriptArgs,
  mode: "run" | "list",
  project: ProjectOptions,
): Promise<void> {
  // ScriptArgs deliberately accepts unknown options for older plugins. Here a
  // misplaced Vitest filter must fail, rather than silently running the full suite.
  const invocationArgs = context.argv ?? context.runner.argv?.slice(2) ?? [];
  const separator = invocationArgs.indexOf("--");
  for (const arg of context.commandContext
    ? []
    : separator < 0
      ? invocationArgs
      : invocationArgs.slice(0, separator)) {
    if (arg.startsWith("-") && arg.split("=")[0] !== "--print") {
      throw new Error(
        `Unknown nopo Vitest option '${arg}'. Put Vitest options after --.`,
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
          // Core already expanded command env; the child inherits it via baseEnv.
          // Expanding it again would corrupt values containing literal dollar signs.
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
  // Delegated argv belongs entirely to Vitest: the owning target is separate context.
  const passthrough = context.commandContext
    ? (context.argv ?? [])
    : (context.passthrough ?? []);
  validateForwardedArgs([...project.args, ...passthrough]);
  if (!context.commandContext && args.get<boolean>("print")) {
    // No environment values, config evaluation, temporary files, or subprocesses.
    context.io.stdout.write(
      JSON.stringify({
        command: `vitest ${mode}`,
        targets: targets.map(({ id, root, config }) => ({ id, root, config })),
        args: project.args,
        passthrough,
      }) + "\n",
    );
    return;
  }

  // Preflight every target before starting any tests.
  const installations = targets.map((target) => resolveVitest(target.root));
  const installation = installations[0]!;
  if (installations.some((item) => item.binary !== installation.binary)) {
    throw new Error(
      "Selected targets must share one Vitest installation. Install a common version in their workspace.",
    );
  }
  const [major = 0, minor = 0] = installation.version.split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 2)) {
    throw new Error(
      "The nopo Vitest plugin requires Vitest 3.2 or newer (test.projects support).",
    );
  }
  const temporary = mkdtempSync(path.join(tmpdir(), "nopo-vitest-"));
  try {
    const configFile = path.join(temporary, "vitest.config.mjs");
    writeFileSync(configFile, renderConfig(targets), { mode: 0o600 });
    context.io.stderr.write(
      `[vitest] Targets: ${targets.map((t) => t.id).join(", ")}\n`,
    );
    const env = expandEnvValues({ NODE_ENV: "test", ...project.env }, baseEnv);
    await spawnVitest(
      context,
      installation.binary,
      [mode, "--config", configFile, ...project.args, ...passthrough],
      context.runner.config.root,
      { ...baseEnv, ...env },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const vitestPlugin: NopoPluginFactory = (raw) => {
  const project = projectSchema.parse(raw);
  return {
    name: "vitest",
    defaultCommand: "run",
    description: "Run or discover Vitest tests across nopo targets",
    configSchema: { project: projectSchema, service: targetSchema },
    commands: (["run", "list"] as const).map((mode) => ({
      name: mode,
      description: `nopo vitest ${mode} [targets...] [--print] -- [Vitest options and filters]`,
      args: new ScriptArgs({
        print: {
          type: "boolean",
          default: false,
          description: "Print selected targets without executing Vitest",
        },
      }),
      fn: (context, args) => executeVitest(context, args, mode, project),
    })),
  };
};

export default vitestPlugin;
