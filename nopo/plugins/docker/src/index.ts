import { globSync } from "glob";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveCommandDag,
  serializeCommandDagAsShell,
} from "@more-nopo/nopo/command-dag";
import {
  type BuildableService,
  extractDependencyNames,
  type InstallPhase,
  isBuildableService,
  isBuildCommandDeps,
  type NormalizedService,
  requiresBuild,
  resolveInstallCommand,
  resolveRuntime,
} from "@more-nopo/nopo/config";
import { DockerTag } from "@more-nopo/nopo/docker-tag";
import { chalk, type ProcessPromise, tmpfile } from "@more-nopo/nopo/lib";
import type { HookContext, NopoPluginFactory } from "@more-nopo/nopo/plugin";

/**
 * Common root files included in every isolated build context.
 * Skipped silently if missing (opportunistic).
 */
const COMMON_ROOT_FILES = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "tsconfig.json",
  "tsconfig.base.json",
  "nopo.yml",
  ".npmrc",
];

/** BuildKit secret id matching bake `secret[].id` and Dockerfile `--mount=id=`. */
export const NODE_AUTH_SECRET_ID = "node_auth_token";

/** Prefix for `RUN` so bun can expand `.npmrc` `${NODE_AUTH_TOKEN}` inside the build. */
export function ghprInstallSecretMount(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!env.NODE_AUTH_TOKEN) return "";
  return `--mount=type=secret,id=${NODE_AUTH_SECRET_ID},env=NODE_AUTH_TOKEN `;
}

/** Bake `secret` field. Omit when the token is unset so local builds stay unchanged. */
export function ghprBakeSecretField(
  env: NodeJS.ProcessEnv = process.env,
): { secret: Array<{ id: string; env: string }> } | Record<string, never> {
  if (!env.NODE_AUTH_TOKEN) return {};
  return {
    secret: [{ id: NODE_AUTH_SECRET_ID, env: "NODE_AUTH_TOKEN" }],
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // malformed JSON — caller treats as empty
  }
  return null;
}

function readWorkspacePatterns(rootDir: string): string[] {
  const root = readJsonSafe(path.join(rootDir, "package.json"));
  if (root && isStringArray(root.workspaces)) return root.workspaces;
  return [];
}

/** Build a name → relative-dir map of every workspace package. */
function buildWorkspaceMap(rootDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pattern of readWorkspacePatterns(rootDir)) {
    const matches = globSync(pattern, { cwd: rootDir });
    for (const match of matches) {
      const pkg = readJsonSafe(path.join(rootDir, match, "package.json"));
      if (pkg && typeof pkg.name === "string") {
        map.set(pkg.name, match);
      }
    }
  }
  return map;
}

/** Names of workspace packages this package.json depends on (any field). */
function extractWorkspaceDeps(
  pkg: Record<string, unknown>,
  wsMap: Map<string, string>,
): string[] {
  const result: string[] = [];
  const fields = ["dependencies", "devDependencies", "peerDependencies"];
  for (const field of fields) {
    const deps = pkg[field];
    if (!isPlainObject(deps)) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== "string") continue;
      if (!version.startsWith("workspace:")) continue;
      if (wsMap.has(name)) result.push(name);
    }
  }
  return result;
}

/** Resolve all paths that should appear in a service's isolated build context. Returns
 * project-root-relative paths. Throws if any explicit `build.include` path doesn't exist (fails the
 * build clearly).
 */
export function resolveServiceIncludes(
  service: NormalizedService,
  entries: Record<string, NormalizedService>,
  rootDir: string,
): { paths: string[]; missing: string[] } {
  const includeSet = new Set<string>();
  const missing: string[] = [];

  // 1. Service dir + transitive BUILD deps (only build.depends_on, not runtime)
  const visited = new Set<string>();
  const queue = [service.id];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const current = entries[currentId];
    if (!current) continue;

    const relPath = path.relative(rootDir, current.paths.root);
    if (relPath && !relPath.startsWith("..")) {
      includeSet.add(relPath);
    }

    // Walk only build-time deps
    const buildDeps = extractDependencyNames(current.build?.depends_on);
    for (const dep of buildDeps) {
      if (!visited.has(dep) && entries[dep]) {
        queue.push(dep);
      }
    }
  }

  // 2. Common root files (skip silently if missing)
  for (const file of COMMON_ROOT_FILES) {
    if (fs.existsSync(path.join(rootDir, file))) {
      includeSet.add(file);
    }
  }

  /** 2b. Every declared workspace's package.json so root `bun install
   * --frozen-lockfile` can resolve workspaces. Without this, bun fails
   * with "Workspace not found" when staging an isolated context.
   */
  const wsMap = buildWorkspaceMap(rootDir);
  for (const wsDir of wsMap.values()) {
    const wsPkg = path.join(wsDir, "package.json");
    if (fs.existsSync(path.join(rootDir, wsPkg))) {
      includeSet.add(wsPkg);
    }
  }

  /** 2c. Stage the FULL source of every workspace package this service
   * depends on via `workspace:*` (transitively). Tsconfig extends, vite
   * plugins, codegen all need real files at build time, not just manifests.
   */
  const servicePkgPath = path.join(service.paths.root, "package.json");
  const servicePkg = readJsonSafe(servicePkgPath);
  if (servicePkg) {
    const wsVisited = new Set<string>();
    const wsQueue = extractWorkspaceDeps(servicePkg, wsMap);
    while (wsQueue.length > 0) {
      const depName = wsQueue.shift()!;
      if (wsVisited.has(depName)) continue;
      wsVisited.add(depName);

      const depDir = wsMap.get(depName);
      if (!depDir) continue;
      includeSet.add(depDir);

      const depPkg = readJsonSafe(path.join(rootDir, depDir, "package.json"));
      if (depPkg) {
        for (const transitive of extractWorkspaceDeps(depPkg, wsMap)) {
          if (!wsVisited.has(transitive)) wsQueue.push(transitive);
        }
      }
    }
  }

  // 3. Custom Dockerfile parent dir (auto-include)
  if (service.build?.dockerfile) {
    const dockerfilePath = path.resolve(
      service.paths.root,
      service.build.dockerfile,
    );
    const parentDir = path.dirname(dockerfilePath);
    const relParent = path.relative(rootDir, parentDir);
    if (relParent && !relParent.startsWith("..")) {
      includeSet.add(relParent);
    }
  }

  // 4. Explicit includes (validate existence)
  if (service.build?.include) {
    for (const pattern of service.build.include) {
      const isGlob =
        pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
      if (isGlob) {
        const matches = globSync(pattern, { cwd: rootDir });
        if (matches.length === 0) {
          missing.push(pattern);
          continue;
        }
        for (const match of matches) {
          includeSet.add(match);
        }
      } else {
        if (!fs.existsSync(path.join(rootDir, pattern))) {
          missing.push(pattern);
          continue;
        }
        includeSet.add(pattern);
      }
    }
  }

  return {
    paths: Array.from(includeSet).sort(),
    missing,
  };
}

/**
 * Stage the resolved include paths into a temp directory.
 * Uses hardlinks for speed; falls back to copy on EXDEV.
 * Returns the temp directory path (used as buildx context).
 */
export function assembleBuildContext(paths: string[], rootDir: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-ctx-"));

  for (const relPath of paths) {
    const src = path.join(rootDir, relPath);
    const dest = path.join(tempDir, relPath);
    if (!fs.existsSync(src)) continue;
    copyRecursive(src, dest);
  }

  return tempDir;
}

function copyRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    // Skip node_modules and .git unless explicitly requested
    const base = path.basename(src);
    if (base === "node_modules" || base === ".git") return;

    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else if (stat.isFile()) {
    if (fs.existsSync(dest)) return; // already staged via earlier path
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.linkSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest);
    }
  }
}

interface BakeTarget {
  context: string;
  dockerfile?: string;
  "dockerfile-inline"?: string;
  tags: string[];
  target?: string;
  args?: Record<string, string>;
  labels?: Record<string, string>;
  contexts?: Record<string, string>;
  "cache-from"?: string[];
  "cache-to"?: string[];
  output?: string[];
  platforms?: string[];
  secret?: Array<{ id: string; env: string }>;
}

interface BakeDefinition {
  group: {
    default: {
      targets: string[];
    };
  };
  target: Record<string, BakeTarget>;
}

const SERVICE_IMAGE_SUFFIX = "_IMAGE";
const DEFAULT_PLATFORMS = "linux/amd64,linux/arm64";

/** Bake target + named context carrying ONLY /build-info.json. The file is generated from ARG
 * GIT_COMMIT, so it changes every commit. It used to sit in the root image's `user` stage, which every
 * service build stage derives from — putting a per-commit layer above all 38 manifest COPYs and above
 * `bun install`.
 */
const BUILD_INFO_CONTEXT = "root-info";

/** Both install passes in the build stage ask for this phase. The plugin's
 * entire contribution to the install question is naming which phase it is
 * in; the command itself comes back resolved from nopo/config.
 */
const BUILD_PHASE: InstallPhase = "build";

interface DockerPluginConfig {
  os?: {
    base?: string;
    dependencies?: Record<string, string>;
    user?: {
      uid?: number;
      gid?: number;
      home?: string;
    };
  };
}

const DEFAULT_BASE = "node:22.16.0-slim";
const DEFAULT_USER_UID = 1001;
const DEFAULT_USER_HOME = "/home/nopoapp";

/** Payload shape carried on the coalesced `build:bake` plan node. `targets` is the list of
 * docker-eligible services claimed by the compaction pass. `noCache` / `output` / `registries` are
 * script-wide flags (identical across every claimed `build:<t>` node) lifted off the first claimed
 * node's payload — the BuildScript writes the same values into each per-target payload, so any one is
 */
interface BuildBatchPayload {
  targets: string[];
  noCache: boolean;
  output?: string;
  registries?: string;
}

function asBuildBatchPayload(payload: unknown): BuildBatchPayload {
  if (payload !== null && typeof payload === "object" && "targets" in payload) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing payload to read its `targets` field after the `in` check
    const targets = (payload as Record<string, unknown>).targets;
    if (Array.isArray(targets)) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- shape-checked above
      return payload as BuildBatchPayload;
    }
  }
  throw new Error(
    `docker buildBatch hook: payload missing { targets: string[] } (got ${JSON.stringify(payload)})`,
  );
}

/** Read the `noCache` / `output` / `registries` script-wide flags off a claimed `build:<target>` node's
 * `BuildExecPayload`. Every claimed node carries identical values (the BuildScript writes them once
 * and fans them out per-target), so reading from `claimed[0]` is sufficient. Defaults match the {@link
 * BuildExecPayload} contract: `noCache=false`, `output`/`registries` undefined.
 */
function extractBuildFlagsFromClaimed(
  claimed: ReadonlyArray<{ payload?: unknown }>,
): { noCache: boolean; output?: string; registries?: string } {
  const first = claimed[0]?.payload;
  if (first === null || typeof first !== "object") {
    return { noCache: false };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing the per-target build:exec payload (known shape, declared by the script in build.ts)
  const rec = first as Record<string, unknown>;
  const out: { noCache: boolean; output?: string; registries?: string } = {
    noCache: typeof rec.noCache === "boolean" ? rec.noCache : false,
  };
  if (typeof rec.output === "string") out.output = rec.output;
  if (typeof rec.registries === "string") out.registries = rec.registries;
  return out;
}

const dockerPlugin: NopoPluginFactory = (config) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- plugin config validated externally
  const pluginConfig = (config ?? {}) as DockerPluginConfig;

  return {
    name: "docker",
    description: "Build Docker images using buildx bake",

    hooks: {
      /** Coalesced batch handler — invoked once per `nopo build` with every docker-eligible service folded
       * into a single payload. Replaces the legacy per-target `overrides.build` path (which ran the full
       * bake N times for N services). See `decisions/0012_plugin_batches.md` for the rationale.
       */
      buildBatch: async (context: HookContext) => {
        const builder = new DockerBuilder(context, pluginConfig);
        const payload = asBuildBatchPayload(context.payload);
        await builder.buildTargets(payload.targets);
      },
    },

    batches: [
      {
        claims: (node, ctx) =>
          node.handler.kind === "builtin" &&
          node.handler.name === "build:exec" &&
          node.target !== undefined &&
          ctx.services[node.target] !== undefined &&
          isDockerBakeTarget(ctx.services[node.target]!),
        coalesce: (claimed) => {
          const flags = extractBuildFlagsFromClaimed(claimed);
          const payload: BuildBatchPayload = {
            targets: claimed.map((n) => {
              if (n.target === undefined) {
                throw new Error(
                  `docker batch: claimed node "${n.id}" has no target`,
                );
              }
              return n.target;
            }),
            noCache: flags.noCache,
          };
          if (flags.output !== undefined) payload.output = flags.output;
          if (flags.registries !== undefined)
            payload.registries = flags.registries;

          return {
            id: "build:bake",
            handler: {
              kind: "plugin-hook",
              plugin: "docker",
              hook: "buildBatch",
            },
            payload,
            meta: { batchOf: claimed.map((n) => n.id) },
          };
        },
      },
    ],
  };
};

export default dockerPlugin;

/** Whether a service should be baked into a Docker image by this plugin. Two conditions must hold: 1.
 * The service explicitly opts in via `plugins.docker:` in its nopo.yml (any value — typically `{}`).
 * This makes bake-eligibility a service declaration rather than an implicit shape rule, so a
 * build-only service (no runtime) can still bake.
 */
export function isDockerBakeTarget(service: NormalizedService): boolean {
  return service.pluginData?.docker !== undefined && requiresBuild(service);
}

/** Resolve how a build context is referenced from the bake definition. Contexts inside the project root
 * stay root-relative ("." for the root itself) — bake always runs with cwd pinned to the project root,
 * so these are stable.
 */
export function bakeContextPath(rootDir: string, contextDir: string): string {
  const rel = path.relative(rootDir, contextDir);
  if (!rel) return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return path.resolve(contextDir);
  }
  return rel;
}

/** The git sha stamped into every bake target as the `NOPO_GIT_SHA` build arg +
 * `org.opencontainers.image.revision` OCI label. CI's `GITHUB_SHA` wins (the exact commit the workflow
 * ran for); otherwise the environment's resolved `GIT_COMMIT` (`git rev-parse HEAD`, see {@link
 * GitInfo}).
 */
export function resolveGitSha(
  processEnv: Record<string, string | undefined>,
  env: Record<string, string | undefined>,
): string {
  return processEnv.GITHUB_SHA || env.GIT_COMMIT || "unknown";
}

export interface ServiceBakeInput {
  target: string;
  /** Bake context reference — see {@link bakeContextPath}. */
  contextPath: string;
  service: BuildableService;
  rootName: string;
  configRoot: string;
  tags: string[];
  /** Git sha stamped as NOPO_GIT_SHA arg + OCI revision label. */
  gitSha: string;
  output?: { output?: string[] };
  platforms?: string[];
  cache?: { "cache-from"?: string[]; "cache-to"?: string[] };
}

/**
 * Build a BakeTarget for a single service.
 * Services with `build.dockerfile` get a direct Dockerfile reference.
 * Services with `build.command` get an inline-generated Dockerfile.
 */
export function buildServiceBakeTarget(
  input: ServiceBakeInput,
  generateInlineDockerfile: (
    service: BuildableService,
    rootName: string,
    relativeServicePath: string,
  ) => string,
): BakeTarget {
  const { target, contextPath, service, rootName, configRoot, tags, gitSha } =
    input;

  if (service.build.dockerfile) {
    const dockerfilePath = path.relative(
      configRoot,
      path.resolve(service.paths.root, service.build.dockerfile),
    );

    return {
      context: contextPath,
      dockerfile: dockerfilePath,
      tags,
      ...(input.output ?? {}),
      ...(input.platforms ? { platforms: input.platforms } : {}),
      ...(input.cache ?? {}),
      ...ghprBakeSecretField(),
      args: {
        SERVICE_NAME: target,
        NOPO_GIT_SHA: gitSha,
      },
      labels: {
        "org.opencontainers.image.revision": gitSha,
      },
    };
  }

  const relativeServicePath =
    path.relative(configRoot, service.paths.root) || ".";
  const dockerfileInline = generateInlineDockerfile(
    service,
    rootName,
    relativeServicePath,
  );

  return {
    context: contextPath,
    "dockerfile-inline": dockerfileInline,
    tags,
    ...(input.output ?? {}),
    ...(input.platforms ? { platforms: input.platforms } : {}),
    ...(input.cache ?? {}),
    ...ghprBakeSecretField(),
    contexts: {
      [rootName]: `target:${rootName}`,
      // The `info` stage alone, so the runtime stage can pull
      // /build-info.json as its LAST layer.
      [BUILD_INFO_CONTEXT]: `target:${BUILD_INFO_CONTEXT}`,
    },
    args: {
      SERVICE_NAME: target,
      NOPO_GIT_SHA: gitSha,
    },
    labels: {
      "org.opencontainers.image.revision": gitSha,
    },
  };
}

class DockerBuilder {
  private ctx: HookContext;
  private pluginConfig: DockerPluginConfig;
  private tempContexts: string[] = [];

  constructor(context: HookContext, pluginConfig: DockerPluginConfig) {
    this.ctx = context;
    this.pluginConfig = pluginConfig;
  }

  /** Resolve the build context for a service. If `build.include` is set, stages a temp dir with only the
   * resolved paths. Otherwise returns the legacy full-monorepo context. Tracks created temp dirs for
   * cleanup after the build completes.
   */
  resolveServiceContext(service: NormalizedService): string {
    if (!service.build?.include) {
      // Legacy: full monorepo context
      return service.paths.context;
    }

    const entries = this.runner.config.project.services.entries;
    const rootDir = this.runner.config.root;
    const { paths, missing } = resolveServiceIncludes(
      service,
      entries,
      rootDir,
    );

    if (missing.length > 0) {
      throw new Error(
        `Service '${service.id}' build.include path(s) not found: ${missing.join(", ")}`,
      );
    }

    const tempDir = assembleBuildContext(paths, rootDir);
    this.tempContexts.push(tempDir);
    this.log(
      `[${service.id}] isolated build context: ${paths.length} paths → ${tempDir}`,
    );
    return tempDir;
  }

  /**
   * Clean up any temp contexts created during build.
   * Called in finally{} blocks. Honors DEBUG_DOCKER_CONTEXT=1 to keep them.
   */
  cleanupTempContexts(): void {
    if (process.env.DEBUG_DOCKER_CONTEXT === "1") {
      for (const dir of this.tempContexts) {
        this.log(`[debug] preserved temp context: ${dir}`);
      }
      return;
    }
    for (const dir of this.tempContexts) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    this.tempContexts = [];
  }

  private get runner() {
    return this.ctx.runner;
  }

  private get env() {
    return {
      ...this.runner.environment.processEnv,
      ...this.runner.environment.env,
      ...this.runner.environment.extraEnv,
    };
  }

  private log(...message: unknown[]) {
    this.runner.logger.log(chalk.yellow(...message));
  }

  private get shell() {
    return this.ctx.shell({
      cwd: this.runner.config.root,
      stdio: "pipe",
      env: this.env,
    });
  }

  /** Build Docker images for the given target list. Called once per `nopo build` invocation with every
   * docker-eligible service folded into a single batch by the plugin's {@link BatchSpec}; package builds
   * (services with `build.command` but no `plugins.docker:` opt-in) are dispatched as separate
   * `build:<target>` plan nodes that fall through to the host-build fallback in core dispatch — they
   */
  async buildTargets(targets: string[]): Promise<void> {
    const isDev = this.runner.environment.env.DOCKER_TARGET === "development";

    // In dev mode, most services use the base image with bind-mounted code.
    // Build the base image + any services that can't use the base (no dev command).
    if (isDev) {
      this.log(
        "Dev mode — building base image + services without dev commands",
      );
      const bakeFile = this.generateBaseOnlyBakeDefinition();
      if (bakeFile) {
        await this.runBake(bakeFile, [], false);
      }

      // Also build services that need their own image (no `dev:` runtime overlay)
      const needsBuild = targets.filter((t) => {
        const svc = this.runner.config.project.services.entries[t];
        if (!svc || svc.image) return false;
        // Services with a `dev:` overlay use the base image + bind-mount;
        // no per-service build.
        if (svc.runtimes?.dev !== undefined) return false;
        return requiresBuild(svc); // needs its own Docker build
      });

      if (needsBuild.length > 0) {
        this.log(
          `Building ${needsBuild.length} service(s) without dev commands: ${needsBuild.join(", ")}`,
        );
        const serviceBakeFile = this.generateBakeDefinition(needsBuild, false);
        if (serviceBakeFile) {
          await this.runBake(serviceBakeFile, needsBuild, false);
        }
      }
      return;
    }

    /** Script-wide build flags live on the batch payload — the BuildScript bakes them into every
     * `build:<target>` node's BuildExecPayload, and the coalesce step copies them up to the batch node so
     * they survive into the hook dispatch (where `ctx.args` is empty by construction; see
     * `dispatchPluginHook` in `packages/nopo/src/dispatch.ts`).
     */
    const batchPayload =
      this.ctx.payload !== undefined
        ? asBuildBatchPayload(this.ctx.payload)
        : ({ targets, noCache: false } satisfies BuildBatchPayload);
    const noCache = batchPayload.noCache;
    const output = batchPayload.output;
    const registries = batchPayload.registries
      ? batchPayload.registries.split(",").filter(Boolean)
      : [];
    const imageTargets = this.filterRequestedImageTargets(targets);

    const push = this.runner.config.processEnv.DOCKER_PUSH === "true";

    // When user requested targets (e.g. via --tags) and none are image targets, skip bake entirely.
    // When no targets requested, build all image targets.
    const requestedForBake =
      targets.length === 0
        ? this.getAllImageTargetsForBake()
        : imageTargets.length > 0
          ? imageTargets
          : null;

    if (requestedForBake === null) {
      this.log("Build complete - no image targets to build");
      if (output) {
        this.writeEmptyOutput(output);
      }
      return;
    }

    try {
      const bakeFile = this.generateBakeDefinition(
        requestedForBake,
        push,
        registries,
      );

      if (!bakeFile) {
        this.log("Build complete - no targets to build");
        if (output) {
          this.writeEmptyOutput(output);
        }
        return;
      }

      await this.runBake(bakeFile, targets, noCache);

      if (output) {
        await this.outputBuildInfo(targets, output);
      }
    } finally {
      this.cleanupTempContexts();
    }
  }

  /**
   * Generate a bake definition that only builds the root/base image.
   * Used in dev mode where services use the base image with bind-mounted code.
   */
  private generateBaseOnlyBakeDefinition(): string | null {
    const env = this.runner.environment.env;
    const rootName = this.runner.config.project.rootName;
    const rootDockerfile = path.join(
      this.runner.config.root,
      "nopo",
      "docker",
      "Dockerfile",
    );

    const rootArgs = this.getRootBuildArgs();
    const gitSha = resolveGitSha(this.runner.config.processEnv, env);

    const definition: BakeDefinition = {
      group: { default: { targets: [rootName] } },
      target: {
        [rootName]: {
          context: ".",
          dockerfile: path.relative(this.runner.config.root, rootDockerfile),
          tags: [env.DOCKER_TAG],
          target: env.DOCKER_TARGET,
          output: ["type=docker"],
          args: {
            ...rootArgs,
            DOCKER_TARGET: env.DOCKER_TARGET,
            DOCKER_TAG: env.DOCKER_TAG,
            DOCKER_VERSION: env.DOCKER_VERSION,
            DOCKER_BUILD: env.DOCKER_VERSION,
            GIT_REPO: env.GIT_REPO,
            GIT_BRANCH: env.GIT_BRANCH,
            GIT_COMMIT: env.GIT_COMMIT,
            NOPO_GIT_SHA: gitSha,
          },
          labels: {
            "org.opencontainers.image.revision": gitSha,
          },
        },
      },
    };

    const content = JSON.stringify(definition, null, 2);
    return tmpfile("docker-bake.json", content);
  }

  private filterRequestedImageTargets(requestedTargets: string[]): string[] {
    if (requestedTargets.length === 0) {
      return requestedTargets;
    }

    const rootName = this.runner.config.project.rootName;

    return requestedTargets.filter((target) => {
      if (target === rootName) {
        return true;
      }
      const service = this.runner.config.project.services.entries[target];
      return !service || isDockerBakeTarget(service);
    });
  }

  private getAllImageTargetsForBake(): string[] {
    const rootName = this.runner.config.project.rootName;
    const targets = this.runner.config.targets;
    const buildableTargets = targets.filter((t) => {
      const service = this.runner.getService(t);
      return isDockerBakeTarget(service);
    });
    return [rootName, ...buildableTargets];
  }

  private isRemoteBuilder(): boolean {
    return !!process.env.BUILDKIT_HOST;
  }

  private generateBakeDefinition(
    requestedTargets: string[],
    push: boolean,
    registries: string[] = [],
  ): string | null {
    const env = this.runner.environment.env;
    const targets = this.runner.config.targets;
    const rootName = this.runner.config.project.rootName;
    const isRemote = this.isRemoteBuilder();
    const gitSha = resolveGitSha(this.runner.config.processEnv, env);

    const platforms = push ? this.getPlatforms() : undefined;

    const buildableTargets = targets.filter((t) => {
      const service = this.runner.getService(t);
      return requiresBuild(service);
    });

    const allTargets = [rootName, ...buildableTargets];
    const buildTargets =
      requestedTargets.length > 0
        ? requestedTargets.filter(
            (t) => t === rootName || buildableTargets.includes(t),
          )
        : allTargets;

    for (const target of targets) {
      if (!buildableTargets.includes(target)) {
        this.log(`Skipping '${target}' - uses pre-built image`);
      }
    }

    if (buildTargets.length === 0) {
      this.log("No buildable targets - skipping build");
      return null;
    }

    const definition: BakeDefinition = {
      group: {
        default: {
          targets: buildTargets,
        },
      },
      target: {},
    };

    const needsRoot =
      buildTargets.includes(rootName) ||
      buildTargets.some((t) => targets.includes(t));

    /** When using a remote builder (no local Docker daemon), images can't be
     * loaded locally. Push to the registry instead. When local (dev machine),
     * load into the Docker daemon for k8s to pick up.
     */
    const needsLocalOutput = !push && !isRemote;
    const needsRegistryOutput = !push && isRemote;

    const isCI =
      process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

    /** In CI, `push=false` means "validate the build but don't ship the image" (PR CI doesn't consume the
     * image — release.yml rebuilds with push=true post-merge). `type=cacheonly` runs the build, populates
     * buildkitd's cache, and discards the image — eliminating the registry blob upload that dominates wall
     * time on the typical PR build (~100s+).
     */
    const noPushOutput = isCI ? "type=cacheonly" : "type=registry";

    // push=true. Set explicitly rather than via bake's `--push` shorthand,
    // which would overwrite every target's output with plain gzip.
    const pushOutput = { output: [pushImageOutput()] };

    if (needsRoot) {
      const rootDockerfile = path.join(
        this.runner.config.root,
        "nopo",
        "docker",
        "Dockerfile",
      );

      const rootArgs = this.getRootBuildArgs();

      const rootOutput = needsLocalOutput
        ? { output: ["type=docker"] }
        : needsRegistryOutput
          ? { output: [noPushOutput] }
          : pushOutput;

      definition.target[rootName] = {
        context: ".",
        dockerfile: path.relative(this.runner.config.root, rootDockerfile),
        tags: this.rootImageTags(registries),
        target: env.DOCKER_TARGET,
        ...rootOutput,
        ...(platforms ? { platforms } : {}),
        ...this.buildCacheConfig({
          registries,
          imageName: env.DOCKER_IMAGE,
          push,
          isCI,
        }),
        ...ghprBakeSecretField(),
        args: {
          ...rootArgs,
          DOCKER_TARGET: env.DOCKER_TARGET,
          DOCKER_TAG: env.DOCKER_TAG,
          DOCKER_VERSION: env.DOCKER_VERSION,
          DOCKER_BUILD: env.DOCKER_VERSION,
          GIT_REPO: env.GIT_REPO,
          GIT_BRANCH: env.GIT_BRANCH,
          GIT_COMMIT: env.GIT_COMMIT,
          NOPO_GIT_SHA: gitSha,
        },
        labels: {
          "org.opencontainers.image.revision": gitSha,
        },
      };

      /** The `info` stage on its own. Service runtime stages consume it via the BUILD_INFO_CONTEXT named
       * context so the per-commit /build-info.json layer stays OUT of the base image every service build
       * stage derives from. No tags and no output — it exists only to be a context, so bake builds it as a
       * dependency.
       */
      definition.target[BUILD_INFO_CONTEXT] = {
        context: ".",
        dockerfile: path.relative(this.runner.config.root, rootDockerfile),
        target: "info",
        args: {
          ...rootArgs,
          DOCKER_TARGET: env.DOCKER_TARGET,
          DOCKER_TAG: env.DOCKER_TAG,
          DOCKER_VERSION: env.DOCKER_VERSION,
          DOCKER_BUILD: env.DOCKER_VERSION,
          GIT_REPO: env.GIT_REPO,
          GIT_BRANCH: env.GIT_BRANCH,
          GIT_COMMIT: env.GIT_COMMIT,
          NOPO_GIT_SHA: gitSha,
        },
      };
    }

    for (const target of buildableTargets) {
      if (!buildTargets.includes(target)) continue;

      const service = this.runner.getService(target);
      const serviceTag = this.serviceImageTag(target);

      /** Resolve build context: legacy full-monorepo OR isolated temp dir
       * (when build.include is specified on the service). Temp dirs sit
       * outside the project root and are referenced absolutely — see
       * bakeContextPath.
       */
      const contextDir = this.resolveServiceContext(service);
      const contextPath = bakeContextPath(this.runner.config.root, contextDir);

      if (isBuildableService(service)) {
        const serviceOutput = needsLocalOutput
          ? { output: ["type=docker"] }
          : needsRegistryOutput
            ? { output: [noPushOutput] }
            : pushOutput;

        /** Per-service cache: each service-image gets its own `:buildcache` tag in the registry (separate from
         * root). Without this, every service-stage RUN (apk add, package install, build) reruns from scratch
         * on a fresh runner — root-cache only covers the base image. `${DOCKER_IMAGE}-${target}` — the same
         * repo the image itself is pushed to, so the cache manifest references blobs already there.
         */
        const cache = this.buildCacheConfig({
          registries,
          imageName: `${env.DOCKER_IMAGE}-${target}`,
          push,
          isCI,
        });

        definition.target[target] = buildServiceBakeTarget(
          {
            target,
            contextPath,
            service,
            rootName,
            configRoot: this.runner.config.root,
            tags: this.serviceImageTags(target, registries),
            gitSha,
            output: serviceOutput,
            platforms,
            cache,
          },
          this.generateInlineDockerfile.bind(this),
        );
      }

      this.runner.environment.setExtraEnv(
        this.serviceEnvKey(target),
        serviceTag,
      );
    }

    this.runner.environment.save();

    const json = JSON.stringify(definition, null, 2);
    return tmpfile("docker-bake.json", json);
  }

  private generateInlineDockerfile(
    service: BuildableService,
    baseContextName: string,
    relativeServicePath: string,
  ): string {
    const serviceName = service.id;
    const build = service.build;

    const lines: string[] = [];

    lines.push(`FROM ${baseContextName} AS ${serviceName}-build`);
    lines.push("");

    if (build.packages && build.packages.length > 0) {
      const packages = build.packages.join(" ");
      lines.push("RUN apk add --no-cache " + packages);
      lines.push("");
    }

    /** Switch the build stage to the runtime UID/GID so `bun install` (and
     * any other user-space install) writes node_modules already owned by
     * nopoapp. Lets the cross-stage COPYs below drop `--chown=...`, which
     * is an O(num_files) walk over the entire node_modules tree.
     */
    lines.push(`USER $\${NOPO_APP_UID}:$\${NOPO_APP_GID}`);
    lines.push("");

    /** Stage 1: install-time files only (manifests + lockfiles + workspace package.jsons). When these don't
     * change, the install layer below caches even when source code has churned — the dominant cost in
     * repeated builds, so this cache hit is decisive. Emitted as one COPY per parent dir (no `--parents` —
     * that's experimental in 1.7-labs and not supported by stable BuildKit).
     */
    const installFiles = collectInstallTimeFiles(
      service,
      this.runner.config.root,
    );
    for (const { dest, files } of groupInstallTimeFilesByDir(installFiles)) {
      const destPath =
        dest === "./" ? `$\${APP}/` : `$\${APP}/${dest.slice(2)}`;
      lines.push(
        `COPY --chown=$\${NOPO_APP_UID}:$\${NOPO_APP_GID} ${files.join(" ")} ${destPath}`,
      );
    }
    if (installFiles.length > 0) {
      lines.push("");
    }

    // Manifest-only PM installs run BEFORE the full source COPY so their
    // layer caches on lockfile + manifest content alone.
    for (const pmLine of generatePackageManagerInstalls(
      service,
      this.runner.config.root,
      {
        requiresSource: false,
        phase: BUILD_PHASE,
        serviceDir: relativeServicePath,
      },
    )) {
      lines.push(pmLine);
      lines.push("");
    }

    // Stage 2: full source. Anything downstream invalidates on source
    // change, but the manifest-only install layer is already cached above.
    lines.push("COPY --chown=$${NOPO_APP_UID}:$${NOPO_APP_GID} . .");
    lines.push("");

    /** Source-requiring PM installs (uv, cargo) run AFTER the source COPY.
     * Their layer can't cache on source-only changes — they read source
     * by design — but they still get isolated per-PM layers.
     */
    for (const pmLine of generatePackageManagerInstalls(
      service,
      this.runner.config.root,
      {
        requiresSource: true,
        phase: BUILD_PHASE,
        serviceDir: relativeServicePath,
      },
    )) {
      lines.push(pmLine);
      lines.push("");
    }

    if (build.env && Object.keys(build.env).length > 0) {
      for (const [key, value] of Object.entries(build.env)) {
        lines.push(`ENV ${key}=${this.escapeDockerEnvValue(value)}`);
      }
      lines.push("");
    }

    const workingDir = build.working_dir ?? relativeServicePath;
    if (workingDir) {
      lines.push(`WORKDIR $\${APP}/${workingDir}`);
      lines.push("");
    }

    for (const line of generateBuildRunLines(service)) {
      lines.push(line);
    }
    lines.push("");

    // After the build, before the runtime COPYs read it: re-resolve the
    // dependency tree down to this service's production deps.
    const runtimeInstalls = generateRuntimeInstallLines(
      service,
      this.runner.config.root,
      relativeServicePath,
    );
    if (runtimeInstalls.length > 0) {
      lines.push(...runtimeInstalls);
      lines.push("");
    }

    lines.push(`FROM ${baseContextName} AS ${serviceName}`);
    lines.push("");
    lines.push("ARG SERVICE_NAME");
    /** Declared (not RUN-consumed) so the NOPO_GIT_SHA build arg the bake
     * target always passes doesn't trip BuildKit's unused-arg warning.
     * The sha itself rides the image as the OCI revision label.
     */
    lines.push("ARG NOPO_GIT_SHA");
    lines.push("");

    /** build.output declares exactly which paths get copied from the build stage into the final image. Each
     * path is either: • a path starting with "/" — absolute, e.g. "/home/nopoapp/.venv" • a path starting
     * with "@app/" — relative to the Dockerfile WORKDIR (/app), e.g. "@app/node_modules" for the hoisted
     * workspace install • anything else — relative to the service directory, e.g.
     */
    lines.push(
      ...generateRuntimeCopyLines({
        serviceName,
        relativeServicePath,
        declaredOutputs: build.output ?? [],
        workspaceDepOutputs: this.workspaceDepOutputs(service),
        manifestOutputs: this.packageManagerRuntimeOutputs(service),
      }),
    );
    lines.push("");

    lines.push("ENV SERVICE_NAME=$${SERVICE_NAME}");
    lines.push("");

    /** Build runs at runtime="default" — the image bakes the default
     * runtime's command. Dev-mode hot-reload is handled at compose-time
     * via the base image + bind-mount path (services that declare a
     * `dev:` runtime overlay), not by baking a different CMD here.
     */
    const resolved = service.runtimes
      ? resolveRuntime(service.runtimes, "default")
      : undefined;

    // Always set WORKDIR to the service directory
    const runtimeDir = resolved?.directory ?? relativeServicePath;
    if (runtimeDir) {
      lines.push(`WORKDIR $\${APP}/${runtimeDir}`);
      lines.push("");
    }

    /** Inject the CMD from the default runtime block. The image bakes ONLY the main command — `pre_command`
     * and `post_command` run in separate containers (k8s initContainer for pre, docker-compose one-shot
     * companion). This keeps a service's long-running process isolated from its lifecycle hooks: each
     * phase gets its own resource envelope and failure surface.
     */
    const cmdString = resolved?.command ?? null;

    if (cmdString) {
      // Escape $ as $$ for Docker Bake HCL parser, then escape quotes
      const escaped = cmdString.replace(/\$/g, "$$$$").replace(/"/g, '\\"');
      lines.push(`CMD ["sh", "-c", "${escaped}"]`);
      lines.push("");
    }

    /** LAST, deliberately. /build-info.json changes on every commit; as the
     * final layer it invalidates ~4 KB instead of the entire build. web
     * reads it at runtime (app/lib/build-info.server.ts), so the image must
     * still carry it.
     */
    lines.push(
      `COPY --from=${BUILD_INFO_CONTEXT} /build-info.json /build-info.json`,
    );
    lines.push("");

    return lines.join("\n");
  }

  /** Every workspace dep declared in the service's package.json (transitively) is staged into the build
   * context at its repo-relative path. When the service opts into minimal `build.output`, those dirs
   * need to be copied into the final image too — otherwise the `node_modules/@more-nopo/*` symlinks dangle.
   * Returns `@app/<wsDepDir>` paths, one per transitive workspace dep.
   */
  private workspaceDepOutputs(service: BuildableService): string[] {
    const rootDir = this.runner.config.root;
    const wsMap = buildWorkspaceMap(rootDir);
    const servicePkg = readJsonSafe(
      path.join(service.paths.root, "package.json"),
    );
    if (!servicePkg) return [];

    const visited = new Set<string>();
    const queue = extractWorkspaceDeps(servicePkg, wsMap);
    const dirs: string[] = [];
    while (queue.length > 0) {
      const depName = queue.shift()!;
      if (visited.has(depName)) continue;
      visited.add(depName);

      const depDir = wsMap.get(depName);
      if (!depDir) continue;
      dirs.push(`@app/${depDir}`);

      const depPkg = readJsonSafe(path.join(rootDir, depDir, "package.json"));
      if (depPkg) {
        for (const transitive of extractWorkspaceDeps(depPkg, wsMap)) {
          if (!visited.has(transitive)) queue.push(transitive);
        }
      }
    }
    return dirs;
  }

  /** Lockfile + manifests each declared package manager needs at RUNTIME. Same data the install-time COPY
   * uses (`collectInstallTimeFiles`), but emitted for the runtime image so that boot-time invocations
   * like `uv run` / `bun run` can discover the workspace root and its lockfile.
   */
  private packageManagerRuntimeOutputs(service: BuildableService): string[] {
    if (!service.packageManagers || service.packageManagers.length === 0) {
      return [];
    }
    const rootDir = this.runner.config.root;
    const out = new Set<string>();
    const wsMap = buildWorkspaceMap(rootDir);

    const addAbs = (abs: string) => {
      const rel = path.relative(rootDir, abs).split(path.sep).join("/");
      if (!rel || rel.startsWith("..")) return;
      if (fs.existsSync(abs)) out.add(`@app/${rel}`);
    };

    for (const pm of service.packageManagers) {
      addAbs(pm.lockfile);
      for (const m of pm.manifest) addAbs(m);

      /** Workspace members: include this PM's manifest at every workspace
       * dir so the runtime can walk the workspace tree. Mirrors the
       * install-time logic in `collectInstallTimeFiles`.
       */
      const manifestNames = pm.manifest.map((m) => path.basename(m));
      for (const wsDir of wsMap.values()) {
        for (const name of manifestNames) {
          const wsManifest = path.posix.join(wsDir, name);
          if (fs.existsSync(path.join(rootDir, wsManifest))) {
            out.add(`@app/${wsManifest}`);
          }
        }
      }
    }
    return Array.from(out).sort();
  }

  private escapeDockerEnvValue(value: string): string {
    if (value.includes(" ") || value.includes("$") || value.includes('"')) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }

  private async bake(...args: string[]): Promise<ProcessPromise> {
    process.env.BUILDX_BAKE_ENTITLEMENTS_FS = "0";
    return this.shell`docker buildx bake ${args}`;
  }

  private async builder(): Promise<string | null> {
    const customBuilder = this.runner.config.processEnv.DOCKER_BUILDER;
    if (customBuilder) return customBuilder;
    return null;
  }

  private async runBake(
    bakeFile: string,
    targets: string[],
    noCache: boolean,
  ): Promise<string> {
    const commandOptions = ["-f", bakeFile, "--debug", "--progress=plain"];

    const push = this.runner.config.processEnv.DOCKER_PUSH === "true";
    const builderName = await this.builder();

    const metadataFile =
      this.runner.config.processEnv.DOCKER_METADATA_FILE ||
      tmpfile("bake-metadata.json", "{}");

    this.log(`
      Building targets: ${targets.length > 0 ? targets.join(", ") : "all"}
      - builder: "${builderName ?? "(current context default)"}"
      - push: "${push}"
      - no-cache: "${noCache}"
      - metadata-file: "${metadataFile}"
    `);

    if (builderName) {
      commandOptions.push("--builder", builderName);
    }
    commandOptions.push("--metadata-file", metadataFile);
    /** No `--push` here. It is shorthand for `--set=*.output=type=registry`,
     * which overrides every target's output — including the zstd compression
     * `pushImageOutput` sets. The targets already carry `push=true`.
     */
    if (noCache) commandOptions.push("--no-cache");

    await this.bake(...commandOptions, "--print");
    await this.bake(...commandOptions);

    return metadataFile;
  }

  private serviceEnvKey(service: string): string {
    return `${service.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}${SERVICE_IMAGE_SUFFIX}`;
  }

  private serviceImageTag(service: string): string {
    const env = this.runner.environment.env;
    const baseImage = `${env.DOCKER_IMAGE}-${service}`;
    const parsed = new DockerTag({
      registry: env.DOCKER_REGISTRY,
      image: baseImage,
      version: env.DOCKER_VERSION,
    });
    return parsed.fullTag;
  }

  private rootImageTags(registries: string[]): string[] {
    const env = this.runner.environment.env;
    const tags = [env.DOCKER_TAG];
    for (const registry of registries) {
      tags.push(
        new DockerTag({
          registry,
          image: env.DOCKER_IMAGE,
          version: env.DOCKER_VERSION,
        }).fullTag,
      );
    }
    return tags;
  }

  private serviceImageTags(service: string, registries: string[]): string[] {
    const env = this.runner.environment.env;
    const tags = [this.serviceImageTag(service)];
    for (const registry of registries) {
      tags.push(
        new DockerTag({
          registry,
          image: service,
          version: env.DOCKER_VERSION,
        }).fullTag,
      );
    }
    return tags;
  }

  private getRootBuildArgs() {
    const baseImage = this.pluginConfig.os?.base ?? DEFAULT_BASE;
    const dependencies = this.pluginConfig.os?.dependencies ?? {};
    const userUid = this.pluginConfig.os?.user?.uid ?? DEFAULT_USER_UID;
    const userHome = this.pluginConfig.os?.user?.home ?? DEFAULT_USER_HOME;
    const packages = this.formatOsPackages(dependencies);
    const userName = path.basename(userHome) || "nopoapp";
    return {
      BASE_FROM: baseImage,
      OS_PACKAGES: packages || "make jq curl",
      USER: userName,
      USER_ID: String(userUid),
      USER_HOME: userHome,
    };
  }

  private formatOsPackages(deps: Record<string, string>): string {
    const names = Object.keys(deps);
    if (names.length === 0) return "";
    return names.join(" ");
  }

  private buildCacheConfig(args: {
    registries: string[];
    imageName: string;
    push: boolean;
    isCI: boolean;
  }): { "cache-from"?: string[]; "cache-to"?: string[] } {
    return buildCacheConfig({
      ...args,
      registries: this.cacheRegistries(args.registries),
    });
  }

  /** Registries the build cache lives in. `--registries` is a multi-registry PUBLISH flag; CI never
   * passes it, so for its whole life `buildCacheConfig` received an empty list and returned `{}`.
   * Release logs contain zero occurrences of `buildcache` and no cache import/export step — the
   * documented "single durable cache backend" was unreachable code, and every build depended entirely on
   */
  private cacheRegistries(explicit: string[]): string[] {
    /** The ambient DOCKER_REGISTRY is deliberately NOT included. #9818 added it so the registry build cache
     * would finally be used in CI.
     */
    return Array.from(new Set(explicit.filter(Boolean)));
  }

  private getPlatforms(): string[] {
    const platformsEnv =
      this.runner.config.processEnv.DOCKER_PLATFORMS || DEFAULT_PLATFORMS;
    return platformsEnv.split(",").map((p) => p.trim());
  }

  private async getImageDigest(tag: string): Promise<string | null> {
    const result = await this.ctx.shell({
      nothrow: true,
      silent: true,
    })`docker buildx imagetools inspect ${tag} --raw`;
    if (result.exitCode !== 0) {
      return null;
    }
    try {
      const json = JSON.parse(result.stdout.trim());
      return json.manifests?.[0]?.digest || null;
    } catch {
      return null;
    }
  }

  private writeEmptyOutput(outputPath: string) {
    const resolvedPath = path.isAbsolute(outputPath)
      ? outputPath
      : path.join(this.runner.config.root, outputPath);
    fs.writeFileSync(resolvedPath, "[]", "utf-8");
    this.log(`Empty build info written to: ${resolvedPath}`);
  }

  private async outputBuildInfo(targets: string[], outputPath?: string) {
    const push = this.runner.config.processEnv.DOCKER_PUSH === "true";
    const env = this.runner.environment.env;
    const configTargets = this.runner.config.targets;
    const rootName = this.runner.config.project.rootName;

    const allTargets = [rootName, ...configTargets];
    const builtTargets = targets.length > 0 ? targets : allTargets;

    const images: Array<{
      name: string;
      tag: string;
      registry: string;
      image: string;
      version: string;
      digest: string | null;
    }> = [];

    if (builtTargets.includes(rootName)) {
      const rootDigest = push
        ? await this.getImageDigest(env.DOCKER_TAG)
        : null;
      images.push({
        name: rootName,
        tag: env.DOCKER_TAG,
        registry: env.DOCKER_REGISTRY,
        image: env.DOCKER_IMAGE,
        version: env.DOCKER_VERSION,
        digest: rootDigest,
      });
    }

    for (const target of configTargets) {
      if (!builtTargets.includes(target)) continue;

      const serviceTag = this.serviceImageTag(target);
      const serviceDigest = push ? await this.getImageDigest(serviceTag) : null;

      images.push({
        name: target,
        tag: serviceTag,
        registry: env.DOCKER_REGISTRY,
        image: `${env.DOCKER_IMAGE}-${target}`,
        version: env.DOCKER_VERSION,
        digest: serviceDigest,
      });
    }

    const jsonOutput = JSON.stringify(images, null, 2);
    if (outputPath) {
      const resolvedPath = path.isAbsolute(outputPath)
        ? outputPath
        : path.join(this.runner.config.root, outputPath);
      fs.writeFileSync(resolvedPath, jsonOutput, "utf-8");
      this.log(`Build info written to: ${resolvedPath}`);
    } else {
      /** Routed through ctx.io so the per-node IO proxy attributes
       * this output to the build:post node when run under executePlan
       * (M6). `+ "\n"` mirrors `console.log`'s trailing newline.
       */
      this.ctx.io.stdout.write(jsonOutput + "\n");
    }
  }
}

/** Output config for a target whose image gets pushed. BuildKit's default registry export gzips each
 * layer on one goroutine. On a release build of api, `exporting to image` took 141.6s of a 463s
 * bake — and only 6.5s of that was `pushing layers`. The other 134.6s was local compression.
 */
export function pushImageOutput(): string {
  return "type=image,push=true,compression=zstd,oci-mediatypes=true";
}

/** Build cache-from/cache-to args for a bake target. In CI we use a single durable cache backend:
 * `registry` — lives next to the artifact image at the `:buildcache` tag, served by the in-cluster
 * registry over the cluster network (zero egress). Writes are owned by the remote buildkitd, which has
 * its own persistent hostPath layer cache, so `local`/`gha` backends would only duplicate state that
 */
export function buildCacheConfig(args: {
  registries: string[];
  imageName: string;
  push: boolean;
  isCI: boolean;
}): { "cache-from"?: string[]; "cache-to"?: string[] } {
  if (!args.isCI) return {};

  const cacheFrom: string[] = [];
  const cacheTo: string[] = [];

  for (const reg of args.registries) {
    const ref = `${reg}/${args.imageName}:buildcache`;
    cacheFrom.push(`type=registry,ref=${ref}`);
    if (args.push) {
      cacheTo.push(
        `type=registry,ref=${ref},mode=min,image-manifest=true,oci-mediatypes=true`,
      );
    }
  }

  if (cacheFrom.length === 0 && cacheTo.length === 0) return {};

  const result: { "cache-from"?: string[]; "cache-to"?: string[] } = {};
  if (cacheFrom.length > 0) result["cache-from"] = cacheFrom;
  if (cacheTo.length > 0) result["cache-to"] = cacheTo;
  return result;
}

/** Files that, when changed, must invalidate the package-manager install layer: each PM's lockfile +
 * declared manifest paths, plus every workspace's package.json (required for `bun install` workspace
 * resolution) and the common root files (tsconfig, nopo.yml). Drives the docker plugin's install-time
 * COPY layer — when these files don't change, the install layer caches even after every source-code
 */
export function collectInstallTimeFiles(
  service: BuildableService,
  rootDir: string,
): string[] {
  const set = new Set<string>();

  const addAbs = (abs: string) => {
    const rel = path.relative(rootDir, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) return;
    if (fs.existsSync(abs)) set.add(rel);
  };

  for (const file of COMMON_ROOT_FILES) {
    if (fs.existsSync(path.join(rootDir, file))) set.add(file);
  }

  const wsMap = buildWorkspaceMap(rootDir);
  for (const wsDir of wsMap.values()) {
    const wsPkg = path.posix.join(wsDir, "package.json");
    if (fs.existsSync(path.join(rootDir, wsPkg))) set.add(wsPkg);
  }

  if (service.packageManagers) {
    for (const pm of service.packageManagers) {
      /** Source-requiring PMs (uv, cargo) install AFTER the full source
       * COPY anyway — listing their files in the install-time layer just
       * adds cache churn without unlocking a cache hit. Skip them here.
       */
      if (pm.requires_source) continue;

      addAbs(pm.lockfile);
      for (const m of pm.manifest) addAbs(m);

      /** Workspace members: include this PM's manifest at every workspace
       * dir. Same pattern as bun's workspace package.jsons — install
       * resolution needs every member's manifest. Files that don't
       * exist for a given workspace dir are silently skipped.
       */
      const manifestNames = pm.manifest.map((m) => path.basename(m));
      for (const wsDir of wsMap.values()) {
        for (const name of manifestNames) {
          const wsManifest = path.posix.join(wsDir, name);
          if (fs.existsSync(path.join(rootDir, wsManifest))) {
            set.add(wsManifest);
          }
        }
      }
    }
  }

  return Array.from(set).sort();
}

/** Group install-time files by parent directory so each batch can land in one COPY without `--parents`
 * (which is in the experimental 1.7-labs channel — not supported by the stable BuildKit running on our
 * DinD runners). One COPY per directory keeps source-path layout intact: `COPY apps/svc/package.json
 * apps/svc/bun.lock ./apps/svc/` puts each file at `./apps/svc/<file>`.
 */
export function groupInstallTimeFilesByDir(
  files: string[],
): Array<{ dest: string; files: string[] }> {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    const list = byDir.get(dir);
    if (list) list.push(file);
    else byDir.set(dir, [file]);
  }
  return Array.from(byDir.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, batch]) => ({
      dest: dir === "." ? "./" : `./${dir}/`,
      files: batch.sort(),
    }));
}

/** Emit a `RUN cd <container-cwd> && <install>` per declared package manager, for one install phase.
 * The plugin does not build these commands. It names the phase it is in and `resolveInstallCommand`
 * hands back a finished string — so nothing here knows that bun spells workspace scoping `--filter`
 * and uv does not.
 */
/** ` && rm -rf <cache_dir>` when the PM declares one, else "". `$` is doubled for Docker Bake's HCL
 * parser, which reads a bare `${HOME}` in an inline Dockerfile as a BAKE variable and fails the whole
 * bake with "There is no variable named HOME". `$${HOME}` reaches the Dockerfile as `${HOME}` and the
 * shell expands it at RUN time — the same escaping the generated `$${APP}` paths and the CMD string
 */
function installCacheCleanup(pm: { cache_dir?: string }): string {
  return pm.cache_dir
    ? ` && rm -rf ${pm.cache_dir.replace(/\$/g, "$$$$")}`
    : "";
}

export function generatePackageManagerInstalls(
  service: BuildableService,
  rootDir: string,
  options: {
    requiresSource: boolean;
    phase: InstallPhase;
    serviceDir: string;
    env?: NodeJS.ProcessEnv;
  },
): string[] {
  if (!service.packageManagers || service.packageManagers.length === 0) {
    return [];
  }
  const lines: string[] = [];
  for (const pm of service.packageManagers) {
    if (pm.requires_source !== options.requiresSource) continue;
    const command = resolveInstallCommand(pm.install, options.phase, {
      serviceDir: options.serviceDir,
    });
    const rel = path.relative(rootDir, pm.cwd);
    // `$${APP}` in Dockerfile source → `${APP}` after Docker Bake HCL
    // interpolation → expanded by the shell at RUN-time to `/app`.
    const containerCwd =
      !rel || rel === "."
        ? `$\${APP}`
        : `$\${APP}/${rel.split(path.sep).join("/")}`;
    /** Drop the PM's download cache in the SAME layer as the install, so it never lands in a layer at all.
     * It is throwaway in an image and the copy/export path is inode-bound: measured 146,775 dirents, 47%
     * of api's install layer. bun hardlinks cache->node_modules, so no bytes are lost.
     */
    lines.push(
      `RUN ${ghprInstallSecretMount(options.env)}cd ${containerCwd} && ${command}${installCacheCleanup(pm)}`,
    );
  }
  return lines;
}

/** Emit the `prod` install — the tree the runtime stage copies. The build stage installs what COMPILES
 * the service. The runtime image needs only what RUNS it, but today it copies the build stage's tree
 * wholesale. For api that is 1.6 GB across ~140k files, and both the runtime COPY (89.2s) and the
 * layer export are bound by that file count. Runs after the build command, so the build still saw its
 */
export function generateRuntimeInstallLines(
  service: BuildableService,
  rootDir: string,
  serviceDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!service.packageManagers || service.packageManagers.length === 0) {
    return [];
  }
  const lines: string[] = [];
  for (const pm of service.packageManagers) {
    const prod = resolveInstallCommand(pm.install, "prod", { serviceDir });
    const build = resolveInstallCommand(pm.install, "build", { serviceDir });
    if (prod === build) continue;
    const rel = path.relative(rootDir, pm.cwd);
    const containerCwd =
      !rel || rel === "."
        ? `$\${APP}`
        : `$\${APP}/${rel.split(path.sep).join("/")}`;
    lines.push(
      `RUN ${ghprInstallSecretMount(env)}cd ${containerCwd} && ${prod}${installCacheCleanup(pm)}`,
    );
  }
  return lines;
}

/** Emit the runtime-stage COPY lines that pull build outputs into the image. `--link` is deliberately
 * NOT used for the large payloads. It builds each copy as an independent layer, then collapses the
 * chain in a "merging" phase. That merge hardlinks — it issues one link() per file plus a full
 * directory walk — so its cost tracks FILE COUNT, not bytes or layer count.
 */
export function generateRuntimeCopyLines(args: {
  serviceName: string;
  relativeServicePath: string;
  declaredOutputs: string[];
  workspaceDepOutputs: string[];
  manifestOutputs: string[];
}): string[] {
  const {
    serviceName,
    relativeServicePath,
    declaredOutputs,
    workspaceDepOutputs,
    manifestOutputs,
  } = args;

  // No declared output set — fall back to copying the whole /app and /home
  // trees. That is the largest payload of all, so it skips `--link` too.
  if (declaredOutputs.length === 0) {
    return [
      `COPY --from=${serviceName}-build $\${APP} $\${APP}`,
      `COPY --from=${serviceName}-build $\${HOME} $\${HOME}`,
    ];
  }

  const copyLine = (outputPath: string, link: string): string => {
    if (outputPath.startsWith("/")) {
      return `COPY${link} --from=${serviceName}-build ${outputPath} ${outputPath}`;
    }
    const rel = outputPath.startsWith("@app/")
      ? outputPath.slice("@app/".length)
      : path.posix.join(relativeServicePath, outputPath);
    return `COPY${link} --from=${serviceName}-build $\${APP}/${rel} $\${APP}/${rel}`;
  };

  return [
    ...declaredOutputs.map((p) => copyLine(p, "")),
    ...workspaceDepOutputs.map((p) => copyLine(p, "")),
    ...manifestOutputs.map((p) => copyLine(p, " --link")),
  ];
}

/** Emit only the build-step RUN lines (no installs). Heredoc is used when the command is multi-line or
 * when `build.command` uses the `{ deps: [...] }` form — the DAG resolves via the shared
 * `resolveCommandDag` primitive. Installs are emitted separately by `generatePackageManagerInstalls`,
 * BEFORE the full source COPY in `generateInlineDockerfile`, so the install layer caches on lockfile
 */
export function generateBuildRunLines(
  service: BuildableService,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const rawCommand = service.build.command;
  if (rawCommand === undefined) return [];

  let command: string;
  let forceHeredoc = false;
  if (isBuildCommandDeps(rawCommand)) {
    const steps = resolveCommandDag({
      serviceId: service.id,
      commands: service.commands,
      roots: rawCommand.deps,
    });
    command = serializeCommandDagAsShell(steps);
    forceHeredoc = true;
  } else {
    command = rawCommand.trim();
  }

  const mount = ghprInstallSecretMount(env);
  if (forceHeredoc || command.includes("\n")) {
    return [`RUN ${mount}<<'EOF'`, "set -e", command, "EOF"];
  }
  return [`RUN ${mount}${command}`];
}
