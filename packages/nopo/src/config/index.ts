import { globSync } from "glob";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type {
  LoadedPlugin,
  NopoPluginFactory,
  OverrideHookName,
  PluginReference,
} from "../plugin.ts";
import { RUNTIME_DISPATCHED_HOOKS } from "../plugin.ts";
import type { Healthcheck, RuntimeMap, Volume } from "./runtime.ts";
import {
  autoWrapRuntime,
  HealthcheckSchema,
  RuntimeMapSchema,
  VolumeSchema,
} from "./runtime.ts";

export type { InstallCommands, InstallPhase } from "./install-phase.ts";
export {
  INSTALL_PHASES,
  resolveInstallCommand,
  SERVICE_DIR_TOKEN,
  SERVICE_SCOPED_PHASES,
} from "./install-phase.ts";
export type {
  DefaultRuntimeBlock,
  Healthcheck,
  ResolvedEnv,
  ResolvedRuntime,
  RuntimeBlock,
  RuntimeMap,
  Volume,
} from "./runtime.ts";
export {
  autoWrapRuntime,
  DefaultRuntimeBlockSchema,
  healthcheckDurationToSeconds,
  HealthcheckSchema,
  isRuntimeMapShape,
  mergeRuntimeBlock,
  resolveRuntime,
  RuntimeBlockSchema,
  RuntimeMapSchema,
  VolumeSchema,
} from "./runtime.ts";

import { type InstallCommands, SERVICE_DIR_TOKEN } from "./install-phase.ts";

const DEFAULT_DEPENDENCIES: Record<string, string> = {
  "build-essential": "",
  jq: "",
  curl: "",
};

// Target type: "service" if it has runtime config, "package" if build-only
export type TargetType = "package" | "service";

// Command dependency specification: Array of strings: ["backend", "worker"] -> same
// command on each service Object with arrays: { backend: ["build", "clean"] } -> specific
const CommandDependenciesSchema = z
  .union([
    z.array(z.string().min(1)),
    z.record(z.string().min(1), z.array(z.string().min(1))),
  ])
  .optional();

// Service-level dependency arrays (simple list of service/package names)
const ServiceDepsSchema = z.array(z.string().min(1)).default([]);

// Runtime configuration for services
// A target is a "service" if it has runtime config, otherwise it's a "package"
const ServiceRuntimeSchema = z.object({
  pre_command: z.string().optional(),
  command: z.string().optional(),
  post_command: z.string().optional(),
  cpu: z.string().default("1"),
  memory: z.string().default("512Mi"),
  port: z.number().int().positive().default(3000),
  // Additional Service ports beyond the primary `port`, for containers that listen on more
  // than one port (e.g. jaeger: 16686 UI + 4317/4318 OTLP). Only the k8s/terraform plugin
  extra_ports: z.array(z.number().int().positive()).optional(),
  deps: ServiceDepsSchema,
});

// Build command: either a raw shell string (legacy) or an object with `deps` that
// references top-level `commands:` on the same service. When `deps` is used, normalization
const ServiceBuildCommandSchema = z.union([
  z.string().min(1),
  z
    .object({
      deps: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);

// Build configuration for services and packages
const ServiceBuildSchema = z.object({
  command: ServiceBuildCommandSchema.optional(),
  // Custom Dockerfile path (relative to service root). When set, the Docker
  // plugin uses this Dockerfile directly instead of generating an inline one.
  dockerfile: z.string().optional(),
  // include can be a single string or array of strings (paths to include in the build
  // context). Project-root-relative paths or globs. When unset, the docker plugin uses
  include: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      return Array.isArray(val) ? val : [val];
    }),
  // output can be a single string or array of strings (paths to include in final image)
  output: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      return Array.isArray(val) ? val : [val];
    }),
  packages: z.array(z.string()).optional(), // OS packages to install
  env: z.record(z.string()).optional(),
  // Working directory for the build command (relative to monorepo root). Defaults to the
  // service directory (e.g., "apps/web"). Use "." or omit to use the service directory.
  working_dir: z.string().optional(),
  deps: ServiceDepsSchema,
  depends_on: CommandDependenciesSchema,
});

// Environment variables for commands
const CommandEnvSchema = z.record(z.string().min(1), z.string()).optional();

// Working directory for commands: absolute path, relative to service, or "root"
const CommandDirSchema = z.string().optional();

// Execution context for commands: host (default) or container
const CommandContextSchema = z.enum(["host", "container"]).optional();

// Command deps: run these commands on the same target first
const CommandDepsSchema = z.array(z.string().min(1)).optional();

// Sub-sub-command schema (deepest level - no further nesting)
const SubSubCommandObjectSchema = z
  .object({
    command: z.string().min(1).optional(),
    env: CommandEnvSchema,
    dir: CommandDirSchema,
    context: CommandContextSchema,
    deps: CommandDepsSchema,
    dependencies: z.never().optional(), // Explicitly disallow cross-service dependencies
  })
  .refine(
    (data) => {
      const hasCommand = !!data.command;
      const hasDeps = !!data.deps && data.deps.length > 0;
      return hasCommand || hasDeps;
    },
    {
      message: "Must specify 'command' or 'deps'.",
    },
  );

const SubSubCommandSchema = z.union([
  z
    .string()
    .min(1)
    .transform((cmd) => ({
      command: cmd,
      env: undefined,
      dir: undefined,
      context: undefined,
      deps: undefined,
    })),
  SubSubCommandObjectSchema,
]);

// Sub-command schema (can have sub-sub-commands)
const SubCommandObjectSchema = z
  .object({
    command: z.string().min(1).optional(),
    env: CommandEnvSchema,
    dir: CommandDirSchema,
    context: CommandContextSchema,
    deps: CommandDepsSchema,
    commands: z.record(z.string().min(1), SubSubCommandSchema).optional(),
    dependencies: z.never().optional(), // Explicitly disallow cross-service dependencies
  })
  .refine(
    (data) => {
      // Must have at least one of command, commands, or deps
      const hasCommand = !!data.command;
      const hasCommands =
        !!data.commands && Object.keys(data.commands).length > 0;
      const hasDeps = !!data.deps && data.deps.length > 0;
      if (hasCommand && hasCommands) {
        return false;
      }
      return hasCommand || hasCommands || hasDeps;
    },
    {
      message:
        "Must specify 'command', 'commands', or 'deps'. Cannot combine 'command' and 'commands'.",
    },
  );

const SubCommandSchema = z.union([
  z
    .string()
    .min(1)
    .transform((cmd) => ({
      command: cmd,
      env: undefined,
      dir: undefined,
      context: undefined,
      deps: undefined,
      commands: undefined,
    })),
  SubCommandObjectSchema,
]);

// Top-level command schema
const CommandObjectSchema = z
  .object({
    command: z.string().min(1).optional(),
    env: CommandEnvSchema,
    dir: CommandDirSchema,
    context: CommandContextSchema,
    deps: CommandDepsSchema,
    dependencies: CommandDependenciesSchema,
    commands: z.record(z.string().min(1), SubCommandSchema).optional(),
  })
  .refine(
    (data) => {
      // Must have at least one of command, commands, or deps
      const hasCommand = !!data.command;
      const hasCommands =
        !!data.commands && Object.keys(data.commands).length > 0;
      const hasDeps = !!data.deps && data.deps.length > 0;
      if (hasCommand && hasCommands) {
        return false;
      }
      return hasCommand || hasCommands || hasDeps;
    },
    {
      message:
        "Must specify 'command', 'commands', or 'deps'. Cannot combine 'command' and 'commands'.",
    },
  );

const CommandSchema = z.union([
  z
    .string()
    .min(1)
    .transform((cmd) => ({
      command: cmd,
      env: undefined,
      dir: undefined,
      context: undefined,
      deps: undefined,
      dependencies: undefined,
      commands: undefined,
    })),
  CommandObjectSchema,
]);

const CommandsSchema = z.record(z.string().min(1), CommandSchema).default({});

// `manifest` accepts a single path or an array. Normalized to string[].
const ManifestSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

// The platform owns which phases exist (see ./install-phase.ts); a package manager owns
// only the command strings. A plain string declares `dev` alone, and the fallback chain
const InstallSchema = z
  .union([
    z.string().min(1),
    z.object({
      // Everything, for working in the repo. Not frozen on purpose:
      // installing something new and updating the lockfile is the point.
      dev: z.string().min(1),
      // What compiles the service. Frozen, and scoped where the package
      // manager can express it.
      build: z.string().min(1).optional(),
      // Only what the service RUNS. Frozen and scoped.
      prod: z.string().min(1).optional(),
    }),
  ])
  .transform((v) => (typeof v === "string" ? { dev: v } : v))
  .superRefine((commands, ctx) => {
    // `dev` runs against the whole repo with no service in hand, so a {service_dir} there
    // could never be expanded. Fail at load rather than emit a literal token into a shell
    if (commands.dev.includes(SERVICE_DIR_TOKEN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `install.dev cannot use ${SERVICE_DIR_TOKEN} — the dev phase has no service scope. Use it in install.build or install.prod.`,
      });
    }
  });

// Service-level package manager override (inline definition)
const ServicePackageManagerOverrideSchema = z.object({
  name: z.string().min(1),
  lockfile: z.string().min(1),
  manifest: ManifestSchema,
  install: InstallSchema,
  sync: z.string().min(1),
  modules: z.string().min(1),
  // Image builds delete it after the install so it never reaches a layer; host installs keep
  // it. Shell-expanded at RUN time, so `${HOME}` etc. are allowed.
  cache_dir: z.string().min(1).optional(),
  cwd: z.string().optional(),
  // True when `install` reads workspace source (uv, cargo, poetry). The docker plugin runs
  // source-requiring installs AFTER the full source COPY; manifest-only installs
  requires_source: z.boolean().default(true),
});

// Service-level package_managers: string[] | array of string | override objects
const ServicePackageManagerItemSchema = z.union([
  z.string().min(1),
  ServicePackageManagerOverrideSchema,
]);

const ServicePackageManagersSchema = z
  .array(ServicePackageManagerItemSchema)
  .optional();

const ServiceFileSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    static_path: z.string().default("build"),
    tags: z.array(z.string().min(1)).default([]),
    // Service-level env vars inherited by all commands in this service
    env: CommandEnvSchema,
    // Production (deploy): values come from k8s Secrets via envFrom; nopo.yml never carries
    // real prod values. Non-prod (host runs, throwaway test pods): the terraform plugin reads
    secrets: z
      .array(
        z.union([
          z.string().min(1),
          z.record(
            z.string().min(1),
            z.union([
              z.string().min(1),
              z.object({
                test: z.string().optional(),
              }),
            ]),
          ),
        ]),
      )
      .default([]),
    // New: build configuration
    build: ServiceBuildSchema.optional(),
    // Accepted shapes: (1) Flat (legacy): runtime: { command: ..., port: ..., cpu: ... }
    // Auto-wrapped to `runtime: { default: <flat> }` on parse. 2. Map: runtime
    runtime: z.unknown(),
    commands: CommandsSchema,
    // Package managers: string references to project-level or inline overrides
    package_managers: ServicePackageManagersSchema,
  })
  .passthrough();

const ServicesSchema = z
  .object({
    dir: z.string().optional(),
    dirs: z.array(z.string().min(1)).optional(),
  })
  .transform((data) => {
    // Support both 'dir' (single) and 'dirs' (multiple)
    if (data.dirs && data.dirs.length > 0) {
      return { dirs: data.dirs };
    }
    return { dirs: [data.dir ?? "./apps"] };
  });

const DependencyVersionSchema = z
  .string()
  .transform((value) => value.trim())
  .optional()
  .default("");

const DependenciesSchema = z
  .union([
    z.record(z.string().min(1), DependencyVersionSchema),
    z.array(z.record(z.string().min(1), DependencyVersionSchema)),
  ])
  .default({})
  .transform((value) => {
    if (Array.isArray(value)) {
      return value.reduce<Record<string, string>>((acc, entry) => {
        for (const [key, val] of Object.entries(entry)) {
          if (key && val) acc[key] = val;
        }
        return acc;
      }, {});
    }
    return value;
  });

const BaseImageSchema = z.union([
  z.string().min(1),
  z.object({
    image: z.string().min(1),
  }),
]);

const ProjectOsSchema = z.object({
  base: BaseImageSchema.default("node:22.16.0-slim"),
  dependencies: DependenciesSchema,
  user: z
    .object({
      uid: z.number().int().nonnegative().default(1001),
      gid: z.number().int().nonnegative().default(1001),
      home: z.string().default("/home/nopo"),
    })
    .default({}),
});

// Root service commands configuration (simplified - no dockerfile/image required)
const RootCommandsSchema = z.object({
  commands: CommandsSchema.default({}),
});

const PluginReferenceSchema = z.object({
  name: z.string().min(1),
  path: z.string().optional(),
  config: z.record(z.unknown()).optional(),
});

/** Runtime entry — maps a runtime name to a plugin + optional namespace. Simple form:
 * `runtimes: { default: docker-compose, prod: terraform }` (string is shorthand for `{
 * plugin: <string> }`). Full form: `runtimes: { default: docker-compose, preview: {
 * plugin: terraform, namespace: nopo-prev } }` The simple form is the pass-through:
 */
const RuntimeEntrySchema = z.object({
  plugin: z.string().min(1),
  namespace: z.string().min(1).optional(),
});

export type RuntimeEntry = z.infer<typeof RuntimeEntrySchema>;

/** Root `runtimes:` map — names a runtime → the plugin name that owns its dispatch (`up` /
 * `down` / `status`). Each value MUST match a registered plugin name from the `plugins:`
 * array (validated in loadPlugins after plugins are resolved). `default` is required when
 * this field is set. Accepts two value shapes: `string` — shorthand
 */
const RuntimesMapSchema = z
  .record(z.string().min(1), z.union([z.string().min(1), RuntimeEntrySchema]))
  .refine((m) => "default" in m, {
    message:
      "runtimes: must declare a `default:` entry. Each entry maps a runtime name to a registered plugin (e.g. runtimes: { default: docker-compose, prod: terraform }).",
  })
  .transform((m) => {
    const out: Record<string, { plugin: string; namespace?: string }> = {};
    for (const [name, value] of Object.entries(m)) {
      if (typeof value === "string") {
        out[name] = { plugin: value };
      } else {
        out[name] = { plugin: value.plugin, namespace: value.namespace };
      }
    }
    return out;
  });

// Project-level package manager definition
const ProjectPackageManagerSchema = z.object({
  lockfile: z.string().min(1),
  manifest: ManifestSchema,
  install: InstallSchema,
  sync: z.string().min(1),
  modules: z.string().min(1),
  // Image builds delete it after the install so it never reaches a layer; host installs keep
  // it. Shell-expanded at RUN time, so `${HOME}` etc. are allowed.
  cache_dir: z.string().min(1).optional(),
  cwd: z.string().optional(),
  requires_source: z.boolean().default(true),
});

const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  os: ProjectOsSchema.default({
    base: "node:22.16.0-slim",
  }),
  services: ServicesSchema.default({}),
  root_name: z.string().min(1).default("root"),
  root: RootCommandsSchema.optional(),
  plugins: z.array(PluginReferenceSchema).default([]),
  // Project-level deps that every discovered service implicitly depends on at both build and
  // runtime. Used for cross-cutting concerns like the nopo CLI itself
  system_deps: z.array(z.string().min(1)).default([]),
  /** Root-level runtime map: `<name>: <plugin-name>`. Governs runtime commands (`up`, `down`,
   * `status`). When set, `nopo up` (no flag) dispatches to the plugin under `default`; `nopo
   * up --runtime <name>` dispatches to the plugin under `<name>`. (enforced in loadPlugins
   * after plugins are loaded) Optional for back-compat. When absent, dispatch falls back
   */
  runtimes: RuntimesMapSchema.optional(),
  package_managers: z
    .record(z.string().min(1), ProjectPackageManagerSchema)
    .optional(),
});

type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
type ServiceBuildInput = z.infer<typeof ServiceBuildSchema>;

/** Multi-process services declare named processes (e.g. `worker`) that share the service's
 * image but run different commands. Single-process services are synthesized as a single
 * `default` process by the normalizer. Plugins (terraform, docker-compose) iterate
 * `service.runtime.processes` to emit one Deployment / compose-service per process.
 */
export interface NormalizedProcess {
  /** Process name. `default` is the conventional single-process name. */
  name: string;
  /** Process command. Optional when the service runs via its image entrypoint. */
  command?: string;
  /**
   * Pre-deploy hook for this process. Emitted as an initContainer on THIS
   * process's Deployment only — not on any sibling process's Deployment.
   */
  preCommand?: string;
  /**
   * Post-start hook for this process. Emitted as a postStart lifecycle hook on
   * THIS process's container.
   */
  postCommand?: string;
  /** Dev command(s). */
  dev?: string[];
  cpu: string;
  memory: string;
  /** Port this process exposes. Any process may declare a port; each port-bearing process emits a Service. */
  port?: number;
  /** Additional ports this process exposes on its Service, beyond the primary `port` — for
   * containers listening on more than one port (e.g. jaeger: 16686 UI + 4317/4318 OTLP).
   * Only the k8s/terraform plugin renders these; k8s routes to a numeric targetPort even
   * without a matching containerPort, and docker-compose inter-container traffic needs no
   */
  extraPorts?: number[];
  /** Per-process scaling. Floor at 1 when emitting replicas. */
  minInstances: number;
  maxInstances: number;
  /** Per-process env (inherits service-level env; process keys win). */
  env?: Record<string, string>;
  /** Runtime deps for this process. */
  deps: string[];
  /**
   * Per-process probe override. Falls back to the runtime-block healthcheck
   * when omitted. Plugins translate this into compose `healthcheck:` or k8s
   * `readinessProbe`; only port-bearing processes get a probe emitted.
   */
  healthcheck?: Healthcheck;
  /**
   * Per-process persistent volumes. Plugins emit one PVC + volumeMount per
   * entry. Falls back to the runtime-block-level `volumes:` when the process
   * doesn't declare its own.
   */
  volumes?: Volume[];
  /**
   * Per-process Kubernetes-specific overrides. Plugins that don't target
   * k8s (e.g. docker-compose) ignore this block. Today only
   * `serviceAccountName` is honored — extend as new k8s-only fields land.
   */
  kubernetes?: {
    /** Required for processes that need RBAC beyond the namespace's default SA (e.g. api
     * worker spawning agent pods needs `pods/create`). Omitted in YAML when unset — k8s falls
     * back to `default`.
     */
    serviceAccountName?: string;
  };
}

// Runtime resources (renamed from infrastructure, with optional command)
interface NormalizedServiceRuntime {
  /**
   * @deprecated Read preCommand from `processes.<name>.preCommand` instead.
   * Kept for back-compat until all callers migrate.
   */
  preCommand?: string;
  command?: string;
  /**
   * @deprecated Read postCommand from `processes.<name>.postCommand` instead.
   * Kept for back-compat until all callers migrate.
   */
  postCommand?: string;
  cpu: string;
  memory: string;
  port: number;
  /** Additional Service ports beyond the primary `port` (k8s/terraform only). */
  extraPorts?: number[];
  /** Runtime service/package dependencies */
  deps: string[];
  /** Always populated — single-process services are synthesized as a single `default` entry
   * so plugins can always iterate this map. Prefer this map over the scalar `command` /
   * `cpu` / `port` fields — those are back-compat readers for the single-process path.
   */
  processes?: Record<string, NormalizedProcess>;
}

/** Build command: either a raw shell string (legacy) or a deps ref that plugins resolve via
 * `resolveCommandDag()` against the service's top-level `commands:` map. The normalizer
 * keeps the shape discriminated so plugins stay in control of how they execute the DAG
 * (heredoc RUN in the docker plugin today; other plugins can serialize differently).
 */
interface BuildCommandDeps {
  deps: string[];
}
type NormalizedBuildCommand = string | BuildCommandDeps;

export function isBuildCommandDeps(
  value: NormalizedBuildCommand | undefined,
): value is BuildCommandDeps {
  return typeof value === "object" && value !== null && "deps" in value;
}

// Build configuration
interface NormalizedServiceBuild {
  command?: NormalizedBuildCommand;
  dockerfile?: string;
  include?: string[];
  output?: string[];
  packages?: string[];
  env?: Record<string, string>;
  working_dir?: string;
  /** Build-time service/package dependencies */
  deps: string[];
  depends_on?: CommandDependencies;
}

// Command dependency types
export type CommandDependencies =
  | string[] // Array of service names (same command)
  | Record<string, string[]> // Object with service -> commands mapping
  | undefined;

/** Extract dependency service names from CommandDependencies format. Handles both array
 * format and object format. @param deps - The dependencies to extract names from @returns
 * Array of service names @example extractDependencyNames(['backend', 'db']) // ['backend',
 * 'db'] extractDependencyNames({ backend: ['build'], db: ['migrate'] }) // ['backend'
 */
export function extractDependencyNames(deps: CommandDependencies): string[] {
  if (!deps) return [];
  if (Array.isArray(deps)) return deps;
  return Object.keys(deps);
}

// Execution context type
export type CommandContext = "host" | "container";

// Sub-command (no cross-service dependencies, but deps allowed)
export interface NormalizedSubCommand {
  command?: string;
  env?: Record<string, string>;
  dir?: string;
  context?: CommandContext;
  deps?: string[];
  commands?: Record<string, NormalizedSubCommand>;
}

export interface NormalizedCommand {
  command?: string;
  env?: Record<string, string>;
  dir?: string;
  context?: CommandContext;
  deps?: string[];
  dependencies?: CommandDependencies;
  commands?: Record<string, NormalizedSubCommand>;
}

/**
 * Resolved package manager configuration.
 * Paths (lockfile, manifest, cwd) are absolute after resolution.
 */
export interface PackageManagerConfig {
  name: string;
  lockfile: string;
  /** Project manifest file(s) the install command reads (e.g. `package.json`,
   * `pyproject.toml`, `requirements.txt`). Drives the docker plugin's install-time COPY
   * layer — when these files don't change, the install layer caches.
   */
  manifest: string[];
  /**
   * Install command per phase. Read it through `resolveInstallCommand` —
   * that applies the phase fallback chain and expands `{service_dir}`.
   */
  install: InstallCommands;
  sync: string;
  modules: string;
  /** The docker plugin deletes it at the end of the install RUN — it is pure throwaway in an
   * image, and on the inode-bound copy/export path it is expensive: measured 146,775
   * dirents, 47% of api's install layer. Bun hardlinks cache->node_modules (link count 2,
   * sampled), so removing it loses no bytes.
   */
  cache_dir?: string;
  cwd: string;
  /** True when `install` reads workspace source (uv, cargo, poetry, pip with editable
   * installs). The docker plugin runs source-requiring installs AFTER the full source COPY;
   * manifest-only installs (bun, npm, yarn, pnpm) run BEFORE, so their layer caches on
   * lockfile content alone. Defaults to `true` (safe — no broken installs for new PMs); set
   */
  requires_source: boolean;
}

/** `name` is the env var key; `test` is an optional deterministic value the terraform
 * plugin injects during `run` (test throwaway-pod / host) invocations. Production deploys
 * never read `test` — values come from k8s Secrets via `envFrom`. Consumers reach this
 * shape via `NormalizedService["secrets"][number]`.
 */
interface NormalizedSecret {
  name: string;
  test?: string;
}

export interface NormalizedService {
  id: string;
  name: string;
  description: string;
  staticPath: string;
  tags: string[];
  /**
   * Secret env var definitions. See NormalizedSecret. Prod values come
   * from k8s Secrets via envFrom; `test` values are used for non-prod
   * runs.
   */
  secrets: NormalizedSecret[];
  /** Service-level env vars inherited by all commands */
  env?: Record<string, string>;
  /** Target type: "service" (has runtime) or "package" (build-only, no runtime) */
  type: TargetType;
  /** Build configuration */
  build?: NormalizedServiceBuild;
  /** Runtime configuration (services only, packages have undefined). @deprecated The
   * `service.runtime` field exposes only the `default` runtime block. Per-runtime overlays
   * are not visible here — reading cpu/port/memory/etc. from this field misses any overrides
   * set under named runtimes (e.g. `prod: { cpu: "2" }`). Use
   */
  runtime?: NormalizedServiceRuntime;
  /** The full runtime map (always has `default` when present). Flat-shape services:
   * synthesized as `{ default: <flat> }` during normalization; `runtimes.default` is the
   * only entry. Map-shape services: parsed verbatim, with `default` required and every named
   * overlay validated. Use `resolveRuntime(service.runtimes, name)` to get the merged
   */
  runtimes?: RuntimeMap;
  configPath: string;
  image?: string;
  /** Build-time dependencies (from build.deps) */
  buildDeps: string[];
  /** Runtime dependencies (from runtime.deps) */
  runtimeDeps: string[];
  /** Project-level deps inherited from root nopo.yml `system_deps:`. Every service implicitly
   * depends on these for change-detection purposes — a change to a system dep cascades to
   * every consumer via `--with-dependants`. Kept distinct from buildDeps + runtimeDeps so
   * plugins (docker bake targets, docker-compose `depends_on:`, terraform manifests) don't
   */
  systemDeps: string[];
  commands: Record<string, NormalizedCommand>;
  paths: {
    root: string;
    context: string;
  };
  /** Plugin-specific config from service nopo.yml `plugins:` section (passthrough data) */
  pluginData?: Record<string, unknown>;
  /** Resolved package managers for this service (merged with project-level) */
  packageManagers: PackageManagerConfig[];
}

/**
 * Service that can be built into a Docker image.
 * Has either build.command (inline Dockerfile) or build.dockerfile (custom Dockerfile).
 */
export interface BuildableService extends NormalizedService {
  build: NormalizedServiceBuild;
}

/**
 * Check if a service can be built (has build.command or build.dockerfile).
 */
export function isBuildableService(
  service: NormalizedService,
): service is BuildableService {
  return (
    service.build?.command !== undefined ||
    service.build?.dockerfile !== undefined
  );
}

/**
 * Check if a service requires building (has a build command).
 */
export function requiresBuild(service: NormalizedService): boolean {
  return isBuildableService(service);
}

/**
 * Check if a service is a package (build-only, no runtime).
 * Packages don't have runtime configuration and don't run as containers.
 */
export function isPackageService(service: NormalizedService): boolean {
  return service.type === "package";
}

/**
 * Check if a service is a runnable service (has runtime configuration).
 * Services have runtime concerns like ports, scaling, and databases.
 */
export function isRunnableService(service: NormalizedService): boolean {
  return service.type === "service";
}

interface NormalizedOsConfig {
  base: {
    from: string;
  };
  dependencies: Record<string, string>;
  user: {
    uid: number;
    gid: number;
    home: string;
  };
}

interface NormalizedServicesConfig {
  dirs: string[];
  entries: Record<string, NormalizedService>;
  targets: string[];
}

export interface NormalizedProjectConfig {
  name: string;
  configPath: string;
  os: NormalizedOsConfig;
  services: NormalizedServicesConfig;
  rootName: string;
  /** Plugin references from nopo.yml (not yet loaded — call loadPlugins() to resolve) */
  pluginRefs: PluginReference[];
  /** Loaded plugins (populated after async loadPlugins() call) */
  plugins: LoadedPlugin[];
  /** Runtime → plugin name map from the root `runtimes:` block. `undefined` when not declared
   * (legacy projects). Values are normalized to `{ plugin: string, namespace?: string }` —
   * use `resolveRuntimePlugin()` to pick the right plugin and `resolveRuntimeNamespace()` to
   * derive the namespace.
   */
  runtimes?: Record<string, { plugin: string; namespace?: string }>;
  /** Project-level package manager definitions (keyed by name) */
  packageManagers: Record<string, PackageManagerConfig>;
}

export function loadProjectConfig(
  rootDir: string,
  configPath?: string,
): NormalizedProjectConfig {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedConfigPath = configPath
    ? path.resolve(configPath)
    : path.join(resolvedRoot, "nopo.yml");

  if (!fs.existsSync(resolvedConfigPath)) {
    throw new Error(
      `Missing nopo.yml configuration at ${resolvedConfigPath}. Add one to continue.`,
    );
  }

  const document = parseYamlFile(resolvedConfigPath);
  const parsed = ProjectConfigSchema.parse(document);
  const rootName = parsed.root_name;
  const rootCommands = parsed.root
    ? normalizeCommands(parsed.root.commands)
    : {};

  // Normalize project-level package managers
  const projectPackageManagers = normalizeProjectPackageManagers(
    parsed.package_managers,
    resolvedRoot,
  );

  const services = normalizeServices(
    parsed.services,
    resolvedRoot,
    rootName,
    rootCommands,
    resolvedConfigPath,
    projectPackageManagers,
    parsed.system_deps,
  );

  const project: NormalizedProjectConfig = {
    name: parsed.name,
    configPath: resolvedConfigPath,
    os: normalizeOs(parsed.os),
    services,
    rootName,
    pluginRefs: parsed.plugins,
    plugins: [], // populated later via async loadPlugins()
    runtimes: parsed.runtimes,
    packageManagers: projectPackageManagers,
  };

  warnUnknownNamedRuntimes(project);

  return project;
}

/** Soft cross-reference check: warn when a service declares a named runtime overlay
 * (anything other than `default`) for a runtime name that isn't in the root nopo.yml
 * `runtimes:` map. Such overlays are dead config — no deploy plugin knows how to
 * materialize them — but harmless, so we surface a warning instead of failing the load.
 */
function warnUnknownNamedRuntimes(project: NormalizedProjectConfig): void {
  const knownRuntimes = new Set(Object.keys(project.runtimes ?? {}));
  if (knownRuntimes.size === 0) return; // legacy project — feature not enabled
  for (const [serviceId, service] of Object.entries(project.services.entries)) {
    if (!service.runtimes) continue;
    for (const runtimeName of Object.keys(service.runtimes)) {
      if (runtimeName === "default") continue;
      if (knownRuntimes.has(runtimeName)) continue;
      console.warn(
        `[${serviceId}] runtime.${runtimeName} declared but not in root \`runtimes:\` map. ` +
          `Add it to root nopo.yml so deploy plugins know how to materialize it, or remove the named overlay.`,
      );
    }
  }
}

/** Resolve a runtime name (or `undefined` for `default`) to the plugin name that owns its
 * dispatch. Returns `null` when: no `runtimes:` map is declared in nopo.yml (legacy
 * project), AND no specific runtime was requested. Throws when the runtime name is unknown
 * — fail-fast guarantees the user sees a clear error before any plugin runs.
 */
export function resolveRuntimePlugin(
  project: NormalizedProjectConfig,
  runtimeName: string | undefined,
): string | null {
  const map = project.runtimes;
  if (!map) {
    if (runtimeName !== undefined) {
      throw new Error(
        `--runtime ${runtimeName}: no \`runtimes:\` map declared in root nopo.yml. ` +
          `Add a runtimes block, e.g. \`runtimes: { default: docker-compose }\`.`,
      );
    }
    return null;
  }
  const name = runtimeName ?? "default";
  const entry = map[name];
  if (!entry) {
    const available = Object.keys(map).sort().join(", ");
    throw new Error(
      `Unknown runtime "${name}". Declared runtimes: ${available || "(none)"}.`,
    );
  }
  return entry.plugin;
}

/** Derive the k8s namespace from a runtime entry's `namespace` field. Returns the namespace
 * string when the runtime declares one, or `null` when no namespace is bound (the caller
 * should use `NOPO_NAMESPACE` or a plugin-level default).
 */
export function resolveRuntimeNamespace(
  project: NormalizedProjectConfig,
  runtimeName: string | undefined,
): string | null {
  const map = project.runtimes;
  if (!map) return null;
  const name = runtimeName ?? "default";
  const entry = map[name];
  return entry?.namespace ?? null;
}

/** Load, validate, and instantiate plugins declared in nopo.yml. Uses dynamic import() for
 * ESM compatibility. Resolution order: (1) If `path` is specified: resolve relative to
 * project root, dynamic import 2. Otherwise: resolve built-in from
 * `@more-nopo/nopo-plugin-<name>` workspace package No two plugins define the same override
 */
export async function loadPlugins(
  project: NormalizedProjectConfig,
): Promise<void> {
  if (project.pluginRefs.length === 0) {
    return;
  }

  const rootDir = path.dirname(project.configPath);
  const loaded: LoadedPlugin[] = [];
  const overrideOwners = new Map<OverrideHookName, string>();

  const BUILTIN_COMMANDS = new Set([
    "act",
    "build",
    "command",
    "down",
    "env",
    "help",
    "install",
    "list",
    "pull",
    "secret",
    "status",
    "sync",
    "up",
  ]);
  // `definition.hooks` is a string-keyed map that mixes two roles: built-in additive
  // lifecycle hooks (`pre_build`, `post_build`, `pre_up`, ...) and arbitrary batch handler
  const VALID_OVERRIDE_HOOKS = new Set([
    "build",
    "up",
    "down",
    "status",
    "run",
  ]);

  for (const ref of project.pluginRefs) {
    const factory = await resolvePluginFactory(ref, rootDir);
    const definition = factory(ref.config);

    // Validate the plugin definition has required fields
    if (!definition || typeof definition !== "object" || !definition.name) {
      throw new Error(
        `Plugin '${ref.name}' factory must return an object with a 'name' field. ` +
          `Got: ${JSON.stringify(definition)}`,
      );
    }

    // Check for duplicate plugin names
    if (loaded.some((p) => p.definition.name === definition.name)) {
      throw new Error(
        `Duplicate plugin name '${definition.name}'. Each plugin must have a unique name.`,
      );
    }

    // Check for collision with built-in command names
    if (BUILTIN_COMMANDS.has(definition.name)) {
      throw new Error(
        `Plugin name '${definition.name}' conflicts with built-in command '${definition.name}'. ` +
          `Choose a different plugin name.`,
      );
    }

    // Validate project-level config with plugin's schema if defined
    let validatedProjectConfig: unknown = ref.config;
    if (definition.configSchema?.project) {
      validatedProjectConfig = definition.configSchema.project.parse(
        ref.config,
      );
    }

    if (definition.overrides) {
      for (const hookName of Object.keys(definition.overrides)) {
        if (!VALID_OVERRIDE_HOOKS.has(hookName)) {
          throw new Error(
            `Plugin '${definition.name}' defines unknown override '${hookName}'. ` +
              `Valid overrides: ${[...VALID_OVERRIDE_HOOKS].join(", ")}`,
          );
        }
      }
    }

    // Hooks in RUNTIME_DISPATCHED_HOOKS (up/down/status/run) are dispatched per-invocation by
    // the root `runtimes:` map (or `--runtime <name>` arg), so multiple plugins legitimately
    if (definition.overrides) {
      for (const hookName of Object.keys(definition.overrides)) {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- iterating override keys which are OverrideHookName
        const key = hookName as OverrideHookName;
        if (RUNTIME_DISPATCHED_HOOKS.has(key)) {
          continue;
        }
        const existing = overrideOwners.get(key);
        if (existing) {
          throw new Error(
            `Plugin '${definition.name}' override '${key}' conflicts with plugin '${existing}'. ` +
              `Only one plugin can override each hook.`,
          );
        }
        overrideOwners.set(key, definition.name);
      }
    }

    // Collect per-service plugin configs from NormalizedService.pluginData
    const serviceConfigs: Record<string, unknown> = {};
    for (const [serviceId, service] of Object.entries(
      project.services.entries,
    )) {
      const pluginServiceConfig = service.pluginData?.[definition.name];
      if (pluginServiceConfig !== undefined) {
        // Validate with plugin's service schema if defined
        if (definition.configSchema?.service) {
          serviceConfigs[serviceId] =
            definition.configSchema.service.parse(pluginServiceConfig);
        } else {
          serviceConfigs[serviceId] = pluginServiceConfig;
        }
      }
    }

    loaded.push({
      definition,
      projectConfig: validatedProjectConfig,
      serviceConfigs,
    });
  }

  project.plugins = loaded;

  // Validate `runtimes:` map: every value must name a registered plugin. We check after
  // plugin load so we have the resolved plugin definitions
  if (project.runtimes) {
    const pluginNames = new Set(loaded.map((p) => p.definition.name));
    for (const [runtimeName, entry] of Object.entries(project.runtimes)) {
      if (!pluginNames.has(entry.plugin)) {
        const available = [...pluginNames].sort().join(", ");
        throw new Error(
          `runtimes.${runtimeName}: plugin "${entry.plugin}" is not registered. ` +
            `Registered plugins: ${available || "(none)"}.`,
        );
      }
    }
  }
}

/**
 * Resolve a plugin factory from a plugin reference.
 * Uses dynamic import() for ESM compatibility.
 */
async function resolvePluginFactory(
  ref: PluginReference,
  rootDir: string,
): Promise<NopoPluginFactory> {
  if (ref.path) {
    // Local file path
    const resolvedPath = path.resolve(rootDir, ref.path);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(
        `Plugin '${ref.name}' path '${ref.path}' not found (resolved to ${resolvedPath})`,
      );
    }
    const mod = await import(resolvedPath);
    return getFactoryFromModule(mod, ref.name);
  }

  // Try workspace package: @more-nopo/nopo-plugin-<name>
  const packageName = `@more-nopo/nopo-plugin-${ref.name}`;
  try {
    const mod = await import(packageName);
    return getFactoryFromModule(mod, ref.name);
  } catch (err) {
    // Only convert to "not found" if the top-level plugin package is missing. If the plugin
    // exists but has its own broken imports, re-throw the real error. Transitive ESM failures
    const isTopLevelNotFound =
      err instanceof Error &&
      "code" in err &&
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- checking Node.js error code
      (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" &&
      err.message.includes(packageName);
    if (isTopLevelNotFound) {
      throw new Error(
        `Plugin '${ref.name}' not found. Tried:\n` +
          `  - Package: ${packageName}\n` +
          `  - Specify 'path' in nopo.yml to load from a local file.`,
      );
    }
    throw err;
  }
}

/**
 * Extract the NopoPluginFactory from a loaded module.
 * Supports both default export and named 'plugin' export.
 */
function getFactoryFromModule(
  mod: Record<string, unknown>,
  pluginName: string,
): NopoPluginFactory {
  const factory = mod.default ?? mod.plugin;
  if (typeof factory !== "function") {
    throw new Error(
      `Plugin '${pluginName}' module must export a default function (NopoPluginFactory). ` +
        `Got: ${typeof factory}`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- validated that factory is a function
  return factory as NopoPluginFactory;
}

function parseYamlFile(filePath: string): unknown {
  try {
    const contents = fs.readFileSync(filePath, "utf-8");
    return contents ? (parseYaml(contents) ?? {}) : {};
  } catch (error) {
    throw new Error(
      `Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeOs(osConfig: ProjectConfig["os"]): NormalizedOsConfig {
  const base = normalizeBaseImage(osConfig.base);
  return {
    base,
    dependencies: {
      ...DEFAULT_DEPENDENCIES,
      ...osConfig.dependencies,
    },
    user: {
      uid: osConfig.user.uid,
      gid: osConfig.user.gid,
      home: osConfig.user.home,
    },
  };
}

function normalizeBaseImage(
  base: ProjectConfig["os"]["base"],
): NormalizedOsConfig["base"] {
  const fromImage = typeof base === "string" ? base : base.image;
  return { from: fromImage };
}

/** Supports glob patterns (e.g., "./apps/*") and exclusion patterns (prefixed with "!").
 * @param patterns - Array of directory patterns, where patterns prefixed with "!" are
 * exclusions @param rootDir - The project root directory for resolving relative paths
 * @returns Array of resolved, unique directory paths
 */
function resolveDirectoryPatterns(
  patterns: string[],
  rootDir: string,
): string[] {
  const includeDirs = new Set<string>();
  const excludePatterns: string[] = [];

  // Separate include patterns from exclude patterns
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      // Exclusion pattern - store for later filtering
      excludePatterns.push(pattern.slice(1));
    } else {
      // Include pattern - could be literal path or glob
      const isGlobPattern =
        pattern.includes("*") || pattern.includes("?") || pattern.includes("[");

      if (isGlobPattern) {
        // Use glob to expand pattern
        // Use mark: true to add trailing slash to directories, then filter
        const matches = globSync(pattern, {
          cwd: rootDir,
          absolute: true,
          mark: true,
        });
        for (const match of matches) {
          // Only include directories (marked with trailing slash)
          if (match.endsWith("/")) {
            includeDirs.add(match.slice(0, -1)); // Remove trailing slash
          } else if (fs.existsSync(match) && fs.statSync(match).isDirectory()) {
            // Fallback: check if it's a directory without trailing slash
            includeDirs.add(match);
          }
        }
      } else {
        // Literal directory path
        const resolvedDir = path.resolve(rootDir, pattern);
        if (!fs.existsSync(resolvedDir)) {
          throw new Error(
            `Configured services.dir "${pattern}" does not exist (resolved to ${resolvedDir}).`,
          );
        }
        includeDirs.add(resolvedDir);
      }
    }
  }

  // Apply exclusion patterns
  if (excludePatterns.length > 0) {
    const excludeDirs = new Set<string>();
    for (const pattern of excludePatterns) {
      const isGlobPattern =
        pattern.includes("*") || pattern.includes("?") || pattern.includes("[");

      if (isGlobPattern) {
        // Use mark: true to add trailing slash to directories, then filter
        const matches = globSync(pattern, {
          cwd: rootDir,
          absolute: true,
          mark: true,
        });
        for (const match of matches) {
          // Only include directories (marked with trailing slash)
          if (match.endsWith("/")) {
            excludeDirs.add(match.slice(0, -1)); // Remove trailing slash
          } else if (fs.existsSync(match) && fs.statSync(match).isDirectory()) {
            // Fallback: check if it's a directory without trailing slash
            excludeDirs.add(match);
          }
        }
      } else {
        excludeDirs.add(path.resolve(rootDir, pattern));
      }
    }

    // Remove excluded directories
    for (const dir of excludeDirs) {
      includeDirs.delete(dir);
    }
  }

  return Array.from(includeDirs).sort();
}

function normalizeServices(
  servicesConfig: ProjectConfig["services"],
  rootDir: string,
  rootName: string,
  rootCommands: Record<string, NormalizedCommand>,
  rootConfigPath: string,
  projectPackageManagers: Record<string, PackageManagerConfig>,
  systemDeps: string[],
): NormalizedServicesConfig {
  const entries: Record<string, NormalizedService> = {};

  // Resolve directory patterns (including globs and exclusions)
  const resolvedDirs = resolveDirectoryPatterns(servicesConfig.dirs, rootDir);

  // Discover services in each resolved directory
  for (const servicesDir of resolvedDirs) {
    discoverServices(
      servicesDir,
      entries,
      rootDir,
      rootName,
      projectPackageManagers,
    );
  }

  // Add the root service if it has commands
  if (Object.keys(rootCommands).length > 0) {
    if (entries[rootName]) {
      throw new Error(
        `Service "${rootName}" conflicts with root_name. Use a different root_name in nopo.yml.`,
      );
    }

    entries[rootName] = {
      id: rootName,
      name: "Root",
      description: "Root-level project commands",
      staticPath: "",
      tags: [],
      secrets: [],
      type: "package", // Root is a package (no runtime)
      build: undefined,
      runtime: undefined,
      configPath: rootConfigPath,
      image: undefined,
      buildDeps: [],
      runtimeDeps: [],
      systemDeps: [],
      commands: rootCommands,
      paths: {
        root: rootDir,
        context: rootDir,
      },
      packageManagers: [],
    };
  }

  // Inject project-level system_deps into every service's `systemDeps`. Kept distinct from
  // build/runtime deps so the dependency-graph walker can cascade through them
  if (systemDeps.length > 0) {
    for (const dep of systemDeps) {
      if (!entries[dep]) {
        throw new Error(
          `system_deps references unknown service "${dep}". Each entry in the project-level \`system_deps:\` list must name a registered service.`,
        );
      }
    }
    for (const [id, service] of Object.entries(entries)) {
      const inject = systemDeps.filter((d) => d !== id);
      if (inject.length === 0) continue;
      entries[id] = {
        ...service,
        systemDeps: [...new Set([...service.systemDeps, ...inject])],
      };
    }
  }

  const targets = Object.keys(entries).sort();

  return {
    dirs: resolvedDirs,
    entries,
    targets,
  };
}

function discoverServices(
  servicesDir: string,
  entries: Record<string, NormalizedService>,
  projectRoot: string,
  rootName: string,
  projectPackageManagers: Record<string, PackageManagerConfig>,
): void {
  const children = fs.readdirSync(servicesDir, { withFileTypes: true });

  for (const child of children) {
    if (!child.isDirectory()) continue;
    const serviceId = child.name;
    const serviceRoot = path.join(servicesDir, serviceId);
    const serviceConfigPath = path.join(serviceRoot, "nopo.yml");

    // Skip directories without nopo.yml - they are not nopo services
    if (!fs.existsSync(serviceConfigPath)) {
      continue;
    }

    const serviceDocument = parseYamlFile(serviceConfigPath);
    const parsed = ServiceFileSchema.parse(serviceDocument);
    const commands = normalizeCommands(parsed.commands);

    // Two-step runtime parse: (1) Auto-wrap flat shape into `{ default: <flat> }`, then
    // validate with RuntimeMapSchema. This is where ENC[...] enforcement
    const runtimes = normalizeRuntimeMap(parsed.runtime, serviceConfigPath);
    const runtime = runtimes
      ? normalizeRuntime(parsed.runtime, serviceConfigPath)
      : undefined;

    // `build.command` stays a discriminated union (string | { deps: [...] }); plugins that
    // consume it resolve the DAG via `resolveCommandDag()` from command-dag.ts.
    const build = normalizeBuild(parsed.build);

    // A target is a "service" if it has runtime configuration or image, otherwise it's a "package"
    const targetType: TargetType =
      runtimes || parsed.image ? "service" : "package";

    // Collect build and runtime deps from their respective sections
    const buildDeps = [
      ...(build?.deps ?? []),
      ...extractDependencyNames(build?.depends_on),
    ];
    const runtimeDeps = [...(runtime?.deps ?? [])];

    // Validate that root cannot be in deps
    if (buildDeps.includes(rootName) || runtimeDeps.includes(rootName)) {
      throw new Error(
        `Service "${serviceId}" cannot depend on "${rootName}" at service level. ` +
          `Root can only be specified in command-level dependencies.`,
      );
    }

    // Resolve service-level package managers
    const packageManagers = resolveServicePackageManagers(
      parsed.package_managers,
      projectPackageManagers,
      serviceRoot,
      projectRoot,
      serviceId,
    );

    // Extract plugin-specific data from passthrough fields ServiceFileSchema uses
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing passthrough field from Zod .passthrough()
    const pluginData = (parsed as Record<string, unknown>).plugins as
      | Record<string, unknown>
      | undefined;

    const normalized: NormalizedService = {
      id: serviceId,
      name: parsed.name ?? serviceId,
      description: parsed.description ?? "",
      staticPath: parsed.static_path,
      tags: parsed.tags,
      secrets: normalizeSecrets(parsed.secrets),
      env: parsed.env,
      type: targetType,
      build,
      runtime,
      runtimes,
      configPath: serviceConfigPath,
      image: parsed.image,
      buildDeps: [...new Set(buildDeps)],
      runtimeDeps: [...new Set(runtimeDeps)],
      systemDeps: [],
      commands,
      paths: {
        root: serviceRoot,
        context: projectRoot,
      },
      pluginData,
      packageManagers,
    };

    if (entries[serviceId]) {
      const existingPath = entries[serviceId]!.configPath;
      throw new Error(
        `Duplicate service "${serviceId}" found at "${serviceConfigPath}". ` +
          `A service with this ID already exists at "${existingPath}". ` +
          `Service IDs must be unique across all service directories.`,
      );
    }
    entries[serviceId] = normalized;
  }
}

/**
 * Normalize the `secrets` array from its three accepted shapes into a
 * uniform `NormalizedSecret[]`. See the schema comment for the three
 * shapes.
 */
function normalizeSecrets(
  raw: Array<
    string | Record<string, string | { test?: string | undefined } | undefined>
  >,
): NormalizedSecret[] {
  const out: NormalizedSecret[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push({ name: entry });
      continue;
    }
    // Object form: one or more keys, each a value or options object.
    for (const [name, value] of Object.entries(entry)) {
      if (typeof value === "string") {
        out.push({ name, test: value });
      } else if (value && typeof value === "object") {
        out.push({ name, test: value.test });
      } else {
        out.push({ name });
      }
    }
  }
  return out;
}

/** Parse + validate the `runtime:` field on a service nopo.yml into the runtime map.
 * Accepts both flat shape (auto-wrapped to `{ default: <flat> }`) and the explicit map
 * shape `{ default, [name]: ... }`. Validates structurally: default block is required
 * (RuntimeMapSchema) every value under any `secrets:` block must be ENC[...] ciphertext
 */
function normalizeRuntimeMap(
  raw: unknown,
  configPath: string,
): RuntimeMap | undefined {
  const wrapped = autoWrapRuntime(raw);
  if (wrapped === undefined) return undefined;

  const result = RuntimeMapSchema.safeParse(wrapped);
  if (!result.success) {
    const lines = result.error.errors.map((e) => {
      const loc = e.path.length > 0 ? ` at runtime.${e.path.join(".")}` : "";
      return `  - ${e.message}${loc}`;
    });
    throw new Error(
      `Invalid runtime config in ${configPath}:\n${lines.join("\n")}`,
    );
  }
  return result.data;
}

/** Normalize the legacy `NormalizedServiceRuntime` view from the resolved default runtime
 * block. Kept for back-compat with non-plugin CLI consumers (status/shell/logs); new code
 * should use `resolveRuntime(svc.runtimes, ctx.runtime)` instead. For the new map shape,
 * we extract the default block from the original raw value before re-parsing.
 */
function normalizeRuntime(
  raw: unknown,
  configPath: string,
): NormalizedServiceRuntime {
  // Pull the source object that should match the legacy schema: flat shape: the original
  // `runtime:` value IS the default block. map shape: the original `runtime.default` value
  let legacySource: unknown = raw;
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "default" in raw
  ) {
    const candidate = raw.default;
    // Only treat as map shape if `default` itself is an object — otherwise
    // it's a flat-shape service that happens to have a `default` scalar.
    if (candidate && typeof candidate === "object") {
      legacySource = candidate;
    }
  }

  const result = ServiceRuntimeSchema.safeParse(legacySource);
  if (!result.success) {
    // Should be impossible — RuntimeBlockSchema is a superset structurally.
    // Emit a clear error if it ever fires.
    const lines = result.error.errors.map((e) => {
      const loc =
        e.path.length > 0 ? ` at runtime.default.${e.path.join(".")}` : "";
      return `  - ${e.message}${loc}`;
    });
    throw new Error(
      `Invalid runtime defaults in ${configPath}:\n${lines.join("\n")}`,
    );
  }
  const runtime = result.data;

  // When `processes:` is declared in nopo.yml, convert each entry into a
  // `NormalizedProcess`. When absent, synthesize a single `default` process from the flat
  const processes = normalizeProcesses(legacySource, runtime);

  return {
    preCommand: runtime.pre_command,
    command: runtime.command,
    postCommand: runtime.post_command,
    cpu: runtime.cpu,
    memory: runtime.memory,
    port: runtime.port,
    extraPorts: runtime.extra_ports,
    deps: runtime.deps,
    processes,
  };
}

/** Pull `kubernetes:` overrides off a raw process entry. The runtime schema is
 * `.passthrough()` so unknown blocks like `kubernetes:` ride through; here we narrow the
 * shape to what the terraform plugin consumes. Returns `undefined` when nothing is
 * configured so the emitted YAML stays minimal for back-compat services.
 */
function extractKubernetesBlock(
  raw: unknown,
): { serviceAccountName?: string } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- guarded above
  const k = raw as Record<string, unknown>;
  const serviceAccountName =
    typeof k.service_account_name === "string"
      ? k.service_account_name
      : typeof k.serviceAccountName === "string"
        ? k.serviceAccountName
        : undefined;
  if (serviceAccountName === undefined) return undefined;
  return { serviceAccountName };
}

/** When `processes:` is declared in nopo.yml each entry becomes a `NormalizedProcess`
 * inheriting the parent runtime's scalars (cpu, memory, minInstances, deps) with
 * process-level values taking precedence. When `processes:` is absent, a single
 * synthesized `default` process is created from the flat runtime scalars so plugins can
 */
function normalizeProcesses(
  rawSource: unknown,
  runtime: z.infer<typeof ServiceRuntimeSchema>,
): Record<string, NormalizedProcess> {
  // Read `processes` from the raw, pre-Zod source — `ServiceRuntimeSchema` strips unknown
  // keys (including `processes`), so the validated `runtime` object can't be the source
  const raw =
    rawSource && typeof rawSource === "object" && !Array.isArray(rawSource)
      ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- guarded above
        (rawSource as Record<string, unknown>)
      : {};
  const rawProcesses = raw.processes;

  // Runtime-block-level healthcheck
  const blockHealthcheck = parseHealthcheckOrUndefined(raw.healthcheck);

  // Runtime-block-level volumes (same fallback shape as healthcheck). When a service uses
  // the flat / single-process shape, these apply to the synthesized `default` process. When
  const blockVolumes = parseVolumesOrUndefined(raw.volumes);

  if (
    rawProcesses &&
    typeof rawProcesses === "object" &&
    !Array.isArray(rawProcesses)
  ) {
    const out: Record<string, NormalizedProcess> = {};
    for (const [name, entry] of Object.entries(rawProcesses)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- validated above
      const e = entry as Record<string, unknown>;
      out[name] = {
        name,
        command: typeof e.command === "string" ? e.command : runtime.command,
        // pre_command and post_command are process-level: each process owns its own initContainer
        // / postStart hook. No inheritance from parent block — a worker process should NOT inherit
        preCommand:
          typeof e.pre_command === "string" ? e.pre_command : undefined,
        postCommand:
          typeof e.post_command === "string" ? e.post_command : undefined,
        cpu: typeof e.cpu === "string" ? e.cpu : runtime.cpu,
        memory: typeof e.memory === "string" ? e.memory : runtime.memory,
        port: typeof e.port === "number" ? e.port : undefined,
        // Process-level extra_ports wins; else inherit the runtime-block list.
        extraPorts: Array.isArray(e.extra_ports)
          ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- validated as number[] by ServiceRuntimeSchema at the block level; process-level mirrors that shape
            (e.extra_ports as number[])
          : runtime.extra_ports,
        minInstances:
          typeof e.replicas === "number"
            ? e.replicas
            : typeof e.min_instances === "number"
              ? e.min_instances
              : 1,
        maxInstances: typeof e.max_instances === "number" ? e.max_instances : 1,
        env:
          e.env && typeof e.env === "object" && !Array.isArray(e.env)
            ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
              (e.env as Record<string, string>)
            : undefined,
        deps: Array.isArray(e.deps)
          ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            (e.deps as string[])
          : [...(runtime.deps ?? [])],
        // Process-level override wins; otherwise fall back to the runtime block-level healthcheck
        // so a single declaration at the block applies to every port-bearing process.
        healthcheck:
          parseHealthcheckOrUndefined(e.healthcheck) ?? blockHealthcheck,
        // Same fallback shape for volumes — process-level override wins, otherwise inherit from
        // the block. A worker with no volumes declared at process scope still mounts
        volumes: parseVolumesOrUndefined(e.volumes) ?? blockVolumes,
        kubernetes: extractKubernetesBlock(e.kubernetes),
      };
    }
    return out;
  }

  // No `processes:` declared — synthesize a single `default` process from
  // the flat runtime scalars (including pre_command/post_command).
  return {
    default: {
      name: "default",
      command: runtime.command,
      preCommand: runtime.pre_command,
      postCommand: runtime.post_command,
      cpu: runtime.cpu,
      memory: runtime.memory,
      port: runtime.port,
      extraPorts: runtime.extra_ports,
      minInstances: 1,
      maxInstances: 1,
      env: undefined,
      deps: [...(runtime.deps ?? [])],
      healthcheck: blockHealthcheck,
      volumes: blockVolumes,
    },
  };
}

/** Returns `undefined` when the input is absent. Validation errors propagate as thrown Zod
 * errors so a malformed healthcheck surfaces at config-load time rather than producing a
 * probe with wrong values at deploy time.
 */
function parseHealthcheckOrUndefined(raw: unknown): Healthcheck | undefined {
  if (raw === undefined || raw === null) return undefined;
  return HealthcheckSchema.parse(raw);
}

/** Returns `undefined` when the input is absent. Validation errors (bad name, mountPath,
 * size, duplicates) propagate as thrown Zod errors so malformed volume declarations
 * surface at config-load time.
 */
function parseVolumesOrUndefined(raw: unknown): Volume[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return z.array(VolumeSchema).parse(raw);
}

/** `build.command` is passed through as-is — either a raw shell string (legacy) or `{ deps:
 * [...] }`. Plugins that consume `build.command` resolve the DAG themselves via
 * `resolveCommandDag()` from `command-dag.ts`. Keeping the discriminator here lets
 * different plugins target the DAG to different output formats
 */
function normalizeBuild(
  build: ServiceBuildInput | undefined,
): NormalizedServiceBuild | undefined {
  if (!build) {
    return undefined;
  }

  return {
    command: build.command,
    dockerfile: build.dockerfile,
    include: build.include, // Already transformed to array by schema
    output: build.output, // Already transformed to array by schema
    packages: build.packages,
    env: build.env,
    working_dir: build.working_dir,
    deps: build.deps,
    depends_on: build.depends_on,
  };
}

/**
 * Normalize project-level package_managers from nopo.yml into a Record<string, PackageManagerConfig>.
 * Lockfile paths are resolved relative to project root. CWD defaults to project root.
 */
function normalizeProjectPackageManagers(
  raw: Record<string, z.infer<typeof ProjectPackageManagerSchema>> | undefined,
  projectRoot: string,
): Record<string, PackageManagerConfig> {
  if (!raw) return {};

  const result: Record<string, PackageManagerConfig> = {};

  for (const [name, config] of Object.entries(raw)) {
    const lockfile = config.lockfile.startsWith("/")
      ? config.lockfile
      : path.resolve(projectRoot, config.lockfile);
    const cwd = config.cwd
      ? path.resolve(projectRoot, config.cwd)
      : projectRoot;
    const manifest = config.manifest.map((m) =>
      m.startsWith("/") ? m : path.resolve(cwd, m),
    );

    result[name] = {
      name,
      lockfile,
      manifest,
      install: config.install,
      sync: config.sync,
      modules: config.modules,
      cache_dir: config.cache_dir,
      cwd,
      requires_source: config.requires_source,
    };
  }

  return result;
}

/**
 * Resolve service-level package_managers by merging with project-level definitions.
 * String references use the project-level config. Objects are inline overrides.
 */
function resolveServicePackageManagers(
  raw: z.infer<typeof ServicePackageManagersSchema>,
  projectPMs: Record<string, PackageManagerConfig>,
  serviceRoot: string,
  projectRoot: string,
  serviceId: string,
): PackageManagerConfig[] {
  if (!raw || raw.length === 0) return [];

  const result: PackageManagerConfig[] = [];

  for (const item of raw) {
    if (typeof item === "string") {
      // String reference: must exist at project level
      const projectPM = projectPMs[item];
      if (!projectPM) {
        throw new Error(
          `Service "${serviceId}" references package manager "${item}" which is not defined ` +
            `at the project level in nopo.yml package_managers.`,
        );
      }
      result.push(projectPM);
    } else {
      // Inline override: resolve paths relative to service root
      const lockfile = item.lockfile.startsWith("/")
        ? item.lockfile
        : path.resolve(serviceRoot, item.lockfile);
      const cwd = item.cwd ? path.resolve(serviceRoot, item.cwd) : serviceRoot;
      const manifest = item.manifest.map((m) =>
        m.startsWith("/") ? m : path.resolve(cwd, m),
      );

      result.push({
        name: item.name,
        lockfile,
        manifest,
        install: item.install,
        sync: item.sync,
        modules: item.modules,
        cache_dir: item.cache_dir,
        cwd,
        requires_source: item.requires_source,
      });
    }
  }

  return result;
}

type CommandsInput = z.infer<typeof CommandsSchema>;
type SubCommandInput = z.infer<typeof SubCommandSchema>;
type SubSubCommandInput = z.infer<typeof SubSubCommandSchema>;

function normalizeSubCommands(
  commands: Record<string, SubCommandInput> | undefined,
  parentPath: string,
): Record<string, NormalizedSubCommand> | undefined {
  if (!commands) return undefined;

  const result: Record<string, NormalizedSubCommand> = {};

  for (const [name, cmd] of Object.entries(commands)) {
    // Check if subcommand has cross-service dependencies (not allowed)
    if ("dependencies" in cmd && cmd.dependencies !== undefined) {
      throw new Error(
        `Subcommands cannot define cross-service dependencies. Found at '${parentPath}:${name}'. Use 'deps' for same-target command composition.`,
      );
    }

    const deps = "deps" in cmd ? cmd.deps : undefined;

    if (cmd.command) {
      result[name] = {
        command: cmd.command,
        env: cmd.env,
        dir: cmd.dir,
        context: cmd.context,
        deps,
      };
    } else if (cmd.commands) {
      // Recursive for sub-sub-commands
      result[name] = {
        env: cmd.env,
        dir: cmd.dir,
        context: cmd.context,
        deps,
        commands: normalizeSubSubCommands(cmd.commands),
      };
    } else if (deps && deps.length > 0) {
      // deps-only command (pure composition, no own executable)
      result[name] = {
        env: cmd.env,
        dir: cmd.dir,
        context: cmd.context,
        deps,
      };
    }
  }

  return result;
}

function normalizeSubSubCommands(
  commands: Record<string, SubSubCommandInput> | undefined,
): Record<string, NormalizedSubCommand> | undefined {
  if (!commands) return undefined;

  const result: Record<string, NormalizedSubCommand> = {};

  for (const [name, cmd] of Object.entries(commands)) {
    result[name] = {
      command: cmd.command,
      env: cmd.env,
      dir: cmd.dir,
      context: cmd.context,
      deps: cmd.deps,
    };
  }

  return result;
}

// Reserved command names that match nopo built-in scripts
const RESERVED_COMMAND_NAMES = [
  "act",
  "build",
  "command",
  "down",
  "env",
  "help",
  "install",
  "list",
  "pull",
  "secret",
  "status",
  "sync",
  "up",
];

function normalizeCommands(
  commands: CommandsInput,
): Record<string, NormalizedCommand> {
  const result: Record<string, NormalizedCommand> = {};

  for (const [name, cmd] of Object.entries(commands)) {
    // Validate that command names don't conflict with nopo built-in scripts
    if (RESERVED_COMMAND_NAMES.includes(name)) {
      throw new Error(
        `Command name '${name}' is reserved for nopo built-in scripts. Please use a different name.`,
      );
    }

    if (cmd.command) {
      result[name] = {
        command: cmd.command,
        env: cmd.env,
        dir: cmd.dir,
        context: cmd.context,
        deps: cmd.deps,
        dependencies: cmd.dependencies,
      };
    } else if (cmd.commands) {
      result[name] = {
        env: cmd.env,
        dir: cmd.dir,
        context: cmd.context,
        deps: cmd.deps,
        dependencies: cmd.dependencies,
        commands: normalizeSubCommands(cmd.commands, name),
      };
    } else if (cmd.deps && cmd.deps.length > 0) {
      result[name] = {
        env: cmd.env,
        dir: cmd.dir,
        context: cmd.context,
        deps: cmd.deps,
        dependencies: cmd.dependencies,
      };
    }
  }

  return result;
}
