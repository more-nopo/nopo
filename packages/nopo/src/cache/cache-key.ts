/**
 * Cache key computation for plan steps.
 *
 * A step key is a content-addressable hash combining:
 * - Target's git tree hash and its dependency targets' tree hashes (transitive)
 * - Root-level config files (tsconfig*, eslint.config.*, .nvmrc, etc.)
 * - Lockfile content hashes (all lockfiles)
 * - Plugin source hashes (for plugin hooks)
 * - Toolchain/runtime version (node/bun version)
 * - nopo package version
 * - Step's command and arguments
 * - Declared environment variable inputs (default + service-declared cache.env)
 * - Extra input file hashes (service-declared cache.inputs)
 *
 * The design is hierarchical to enable future granularity:
 * - Plan key = hash of all step keys
 * - Step key = hash of step inputs (current implementation)
 * - Per-file key = future extension for file-level caching
 *
 * IMPORTANT: Only side-effect-free checks are cacheable (lint/test/typecheck).
 * Side-effectful operations (install, build, up/down, etc.) must never be cached.
 *
 * IMPORTANT: Container-context steps (--context container) are never cached
 * because they execute in a different environment.
 *
 * IMPORTANT: If any input path cannot be hashed (git unavailable, gitignored),
 * the step is not cacheable. Gitignored inputs must be declared via cache.inputs.
 */

import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { glob } from "glob";

import type { NormalizedProjectConfig, NormalizedService, LoadedPlugin } from "../config/index.ts";
import type { PlanNode } from "../plan.ts";

// Root-level config files that affect all targets and should be included in cache keys
const ROOT_CONFIG_PATTERNS = [
  "tsconfig*.json",
  "eslint.config.*",
  ".eslintrc*",
  ".nvmrc",
  ".node-version",
  "bunfig.toml",
  "package.json",
  "nopo.yml",
  "nopo.yaml",
] as const;

// All possible lockfiles to include in cache key
const LOCKFILE_NAMES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
] as const;

// Builtins and plugin hooks that are ALLOWED to be cached (side-effect-free)
// Everything else is NOT cacheable by default
const CACHEABLE_HANDLERS: ReadonlySet<string> = new Set([
  // Side-effect-free command execution (lint, test, typecheck)
  "builtin:command:exec",
]);

// Plugin hooks that are cacheable (typically lint/test operations)
const CACHEABLE_PLUGIN_HOOKS: ReadonlySet<string> = new Set([
  "lint",
  "lintBatch",
  "test",
  "testBatch",
  "typecheck",
  "typecheckBatch",
]);

/** Cache configuration declared in service nopo.yml */
export interface ServiceCacheConfig {
  /** Additional environment variable names that affect this service's cache key */
  env?: string[];
  /** Extra input file globs relative to service root (gitignored files must be declared here) */
  inputs?: string[];
}

/** Inputs that contribute to a step's cache key */
export interface StepKeyInputs {
  /** Target ID (service/package name) */
  targetId: string;
  /** Command/handler being executed */
  command: string;
  /** Command arguments */
  args?: readonly string[];
  /** Handler payload (serialized, excluding stageIndex/targets that vary by invocation) */
  payload?: unknown;
  /** Git tree hashes for target and its dependencies (transitive), keyed by target ID */
  treeHashes: Record<string, string>;
  /** Root config hashes (tsconfig*, eslint.config.*, etc.) */
  rootConfigHashes?: Record<string, string>;
  /** Lockfile content hashes (all lockfiles) */
  lockfileHashes?: Record<string, string>;
  /** Plugin source hashes (for plugin hooks) */
  pluginHashes?: Record<string, string>;
  /** @deprecated Use lockfileHashes instead */
  lockfileHash?: string;
  /** Runtime/toolchain version (e.g., node version, bun version) */
  runtimeVersion: string;
  /** nopo package version */
  nopoVersion?: string;
  /** Declared environment variable values that affect the step */
  envInputs: Record<string, string>;
  /** Extra input files outside the target directory (hashed content) */
  extraInputHashes?: Record<string, string>;
}

/** Result of checking if a handler is cacheable */
export interface CacheableCheck {
  /** Whether the handler is cacheable */
  cacheable: boolean;
  /** Reason if not cacheable */
  reason?: string;
}

/**
 * Check if a plan node's handler is cacheable.
 * Only side-effect-free checks (lint, test, typecheck) are cacheable.
 * Side-effectful operations (install, build, up/down, etc.) are never cached.
 * Container-context steps (--context container) are never cached.
 */
export function isHandlerCacheable(node: PlanNode): CacheableCheck {
  // Check for container context override - never cache container steps
  // Container steps execute via kubectl exec in a different environment
  const payload = node.payload as { contextOverride?: string } | undefined;
  if (payload?.contextOverride === "container") {
    return {
      cacheable: false,
      reason: "container context steps cannot be cached",
    };
  }

  if (node.handler.kind === "builtin") {
    const handlerKey = `builtin:${node.handler.name}`;
    if (CACHEABLE_HANDLERS.has(handlerKey)) {
      return { cacheable: true };
    }
    return {
      cacheable: false,
      reason: `builtin ${node.handler.name} has side effects`,
    };
  }

  if (node.handler.kind === "plugin-hook") {
    if (CACHEABLE_PLUGIN_HOOKS.has(node.handler.hook)) {
      return { cacheable: true };
    }
    return {
      cacheable: false,
      reason: `plugin hook ${node.handler.plugin}:${node.handler.hook} may have side effects`,
    };
  }

  return { cacheable: false, reason: "unknown handler kind" };
}

/** Computed step key with metadata for debugging */
export interface StepKey {
  /** The cache key (SHA-256 hash) */
  key: string;
  /** Human-readable key version for debugging */
  version: string;
  /** Inputs that produced this key (for cache miss debugging) */
  inputs: StepKeyInputs;
}

// Bumped to v3: added pluginHashes, cache.env/cache.inputs support
const KEY_VERSION = "v3";

/**
 * Compute a stable cache key for a plan step.
 *
 * The key is a SHA-256 hash of the canonical JSON representation of
 * all inputs. Using JSON ensures deterministic serialization.
 */
export function computeStepKey(inputs: StepKeyInputs): StepKey {
  // Sanitize payload to remove invocation-specific fields that would prevent
  // cross-invocation cache hits (e.g., stageIndex varies by plan structure)
  const sanitizedPayload = sanitizePayload(inputs.payload);

  const canonicalInputs = {
    v: KEY_VERSION,
    target: inputs.targetId,
    command: inputs.command,
    args: inputs.args ?? [],
    payload: sanitizedPayload,
    trees: sortObjectSafe(inputs.treeHashes),
    rootConfigs: sortObjectSafe(inputs.rootConfigHashes),
    // Support both new lockfileHashes and deprecated lockfileHash
    lockfiles: inputs.lockfileHashes
      ? sortObjectSafe(inputs.lockfileHashes)
      : (inputs.lockfileHash ? { default: inputs.lockfileHash } : null),
    plugins: sortObjectSafe(inputs.pluginHashes),
    runtime: inputs.runtimeVersion,
    nopo: inputs.nopoVersion ?? null,
    env: sortObjectSafe(inputs.envInputs),
    extraInputs: inputs.extraInputHashes ? sortObjectSafe(inputs.extraInputHashes) : null,
  };

  const serialized = JSON.stringify(canonicalInputs);
  const hash = createHash("sha256").update(serialized).digest("hex");

  return {
    key: hash,
    version: KEY_VERSION,
    inputs,
  };
}

/**
 * Sanitize payload by removing invocation-specific fields that would
 * prevent cross-invocation cache hits.
 */
function sanitizePayload(payload: unknown): unknown {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map(sanitizePayload);

  const obj = payload as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Skip invocation-specific fields
    if (key === "stageIndex" || key === "targets") continue;
    sanitized[key] = sanitizePayload(value);
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

/**
 * Compute a plan-level key from all step keys.
 * This enables whole-plan cache hits in the future.
 */
export function computePlanKey(stepKeys: readonly StepKey[]): string {
  const sortedKeys = [...stepKeys].sort((a, b) => a.key.localeCompare(b.key));
  const combined = sortedKeys.map((k) => k.key).join(":");
  return createHash("sha256").update(combined).digest("hex");
}

/** Sort object keys for deterministic JSON serialization */
function sortObject<T>(obj: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key]!;
  }
  return sorted;
}

/** Sort object keys, safely handling null/undefined */
function sortObjectSafe<T>(obj: Record<string, T> | undefined | null): Record<string, T> | null {
  if (obj === undefined || obj === null) return null;
  return sortObject(obj);
}

/**
 * Per-run memoization cache for tree hashes.
 * Key: `${repoRoot}:${ref}:${relativePath}`
 */
export type TreeHashCache = Map<string, string | null>;

/**
 * Get git tree hash for a path without requiring a full checkout.
 * Uses `git ls-tree` which works on the index/refs.
 *
 * @param repoRoot - Root of the git repository
 * @param relativePath - Path relative to repo root (empty string for root)
 * @param ref - Git ref to use (defaults to HEAD)
 * @param cache - Optional per-run memoization cache
 */
export function getGitTreeHash(
  repoRoot: string,
  relativePath: string,
  ref = "HEAD",
  cache?: TreeHashCache,
): string | null {
  // Check cache first
  const cacheKey = `${repoRoot}:${ref}:${relativePath || "."}`;
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  let treeHash: string | null = null;

  // For empty path (repo root), get the tree of the commit
  if (!relativePath || relativePath === ".") {
    const result = spawnSync("git", ["rev-parse", `${ref}^{tree}`], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    if (result.status === 0) {
      treeHash = result.stdout.trim();
    }
  } else {
    // For a specific path, use ls-tree
    const result = spawnSync(
      "git",
      ["ls-tree", ref, "--", relativePath],
      { cwd: repoRoot, encoding: "utf-8" },
    );

    if (result.status === 0 && result.stdout.trim()) {
      // Output format: "<mode> <type> <hash>\t<path>"
      const match = result.stdout.match(/^\S+\s+\S+\s+(\S+)/);
      treeHash = match?.[1] ?? null;
    }
  }

  // Store in cache
  cache?.set(cacheKey, treeHash);
  return treeHash;
}

/**
 * Collect git tree hashes for a target and all its dependencies (transitive).
 *
 * @param project - Normalized project config
 * @param targetId - Target to collect hashes for
 * @param repoRoot - Repository root path
 * @param visited - Set of already-visited targets (for cycle detection)
 * @param treeHashCache - Optional per-run memoization cache for tree hashes
 * @returns Record of target ID -> tree hash, or null if any hash is missing (git unavailable)
 */
export function collectTreeHashes(
  project: NormalizedProjectConfig,
  targetId: string,
  repoRoot: string,
  visited = new Set<string>(),
  treeHashCache?: TreeHashCache,
): Record<string, string> | null {
  const hashes: Record<string, string> = {};

  if (visited.has(targetId)) return hashes;
  visited.add(targetId);

  const service = project.services.entries[targetId];
  if (!service) return hashes;

  // Get tree hash for this target's directory
  const relativePath = path.relative(repoRoot, service.paths.root);
  const treeHash = getGitTreeHash(repoRoot, relativePath, "HEAD", treeHashCache);

  // If tree hash is null, git is unavailable or path doesn't exist - don't cache
  if (treeHash === null) {
    return null;
  }

  hashes[targetId] = treeHash;

  // Recursively collect for dependencies (transitive)
  const allDeps = [
    ...service.buildDeps,
    ...service.runtimeDeps,
    ...service.systemDeps,
  ];
  for (const dep of new Set(allDeps)) {
    const depHashes = collectTreeHashes(project, dep, repoRoot, visited, treeHashCache);
    if (depHashes === null) {
      return null; // Propagate null if any dep hash is missing
    }
    Object.assign(hashes, depHashes);
  }

  return hashes;
}

/**
 * Collect tree hashes for multiple targets (used for batch nodes).
 * Returns null if any target's hash is missing.
 *
 * @param project - Project configuration
 * @param targetIds - Target IDs to collect hashes for
 * @param repoRoot - Repository root path
 * @param treeHashCache - Optional per-run memoization cache for tree hashes
 */
export function collectTreeHashesForTargets(
  project: NormalizedProjectConfig,
  targetIds: readonly string[],
  repoRoot: string,
  treeHashCache?: TreeHashCache,
): Record<string, string> | null {
  const hashes: Record<string, string> = {};
  const visited = new Set<string>();

  for (const targetId of targetIds) {
    const targetHashes = collectTreeHashes(project, targetId, repoRoot, visited, treeHashCache);
    if (targetHashes === null) {
      return null;
    }
    Object.assign(hashes, targetHashes);
  }

  return hashes;
}

/**
 * Hash file content using SHA-256.
 */
export function hashFileContent(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Get current runtime version string.
 * Includes both Node.js and Bun versions when running under Bun.
 */
export function getRuntimeVersion(): string {
  const nodeVersion = process.version;
  // Bun sets process.versions.bun when running
  const bunVersion = (process as unknown as { versions?: { bun?: string } }).versions?.bun;
  if (bunVersion) {
    return `bun:${bunVersion},node-compat:${nodeVersion}`;
  }
  return `node:${nodeVersion}`;
}

/**
 * Get nopo package version for cache key.
 */
export function getNopoVersion(): string {
  try {
    // Try to read version from package.json in the nopo package
    const pkgPath = path.resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Collect hashes for root-level config files that affect all targets.
 * These include tsconfig*.json, eslint.config.*, .nvmrc, etc.
 */
export function collectRootConfigHashes(repoRoot: string): Record<string, string> {
  const hashes: Record<string, string> = {};

  try {
    const files = fs.readdirSync(repoRoot);

    for (const file of files) {
      // Check if file matches any root config pattern
      const isRootConfig = ROOT_CONFIG_PATTERNS.some((pattern) => {
        if (pattern.includes("*")) {
          // Convert glob pattern to regex
          const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
          return regex.test(file);
        }
        return file === pattern;
      });

      if (isRootConfig) {
        const filePath = path.join(repoRoot, file);
        if (fs.statSync(filePath).isFile()) {
          const hash = hashFileContent(filePath);
          if (hash) {
            hashes[file] = hash;
          }
        }
      }
    }
  } catch {
    // If we can't read the directory, just return empty
  }

  return hashes;
}

/**
 * Collect hashes for all lockfiles in the repo root.
 */
export function collectLockfileHashes(repoRoot: string): Record<string, string> {
  const hashes: Record<string, string> = {};

  for (const lockfile of LOCKFILE_NAMES) {
    const lockfilePath = path.join(repoRoot, lockfile);
    const hash = hashFileContent(lockfilePath);
    if (hash) {
      hashes[lockfile] = hash;
    }
  }

  return hashes;
}

/** Result of building step key inputs */
export interface BuildStepKeyResult {
  /** The step key inputs, or null if not cacheable */
  inputs: StepKeyInputs | null;
  /** Reason if not cacheable */
  reason?: string;
}

/**
 * Build step key inputs from a plan node and project context.
 * Returns null if the node is not cacheable (missing tree hashes, side-effectful, etc.)
 *
 * @param node - The plan node to compute key for
 * @param project - Project configuration
 * @param repoRoot - Repository root path
 * @param declaredEnvInputs - Environment variable names that affect this step
 * @param env - Current environment variables
 * @param treeHashCache - Optional per-run memoization cache for tree hashes
 */
export function buildStepKeyInputs(
  node: PlanNode,
  project: NormalizedProjectConfig,
  repoRoot: string,
  declaredEnvInputs: readonly string[],
  env: Record<string, string | undefined>,
  treeHashCache?: TreeHashCache,
): BuildStepKeyResult {
  // Check if handler is cacheable (side-effect-free, not container context)
  const cacheableCheck = isHandlerCacheable(node);
  if (!cacheableCheck.cacheable) {
    return { inputs: null, reason: cacheableCheck.reason };
  }

  // Compute command string from handler
  let command: string;
  let pluginName: string | undefined;
  if (node.handler.kind === "plugin-hook") {
    command = `plugin:${node.handler.plugin}:${node.handler.hook}`;
    pluginName = node.handler.plugin;
  } else {
    command = `builtin:${node.handler.name}`;
  }

  // Collect tree hashes for target and dependencies (or claimed targets for batch nodes)
  let treeHashes: Record<string, string> | null;
  let service: NormalizedService | undefined;

  // Check if this is a batch node with claimed targets
  const payload = node.payload as { targets?: string[] } | undefined;
  const claimedTargets = payload?.targets;

  if (claimedTargets && claimedTargets.length > 0) {
    // Batch node: collect tree hashes for all claimed targets
    treeHashes = collectTreeHashesForTargets(project, claimedTargets, repoRoot, treeHashCache);
    // For batch nodes, use the first claimed target's service for cache config
    service = project.services.entries[claimedTargets[0]!];
  } else if (node.target) {
    // Regular node with a target
    treeHashes = collectTreeHashes(project, node.target, repoRoot, new Set(), treeHashCache);
    service = project.services.entries[node.target];
  } else {
    // No target and no claimed targets - can't compute meaningful key
    return { inputs: null, reason: "no target or claimed targets" };
  }

  // If tree hashes are null, git is unavailable - don't cache
  if (treeHashes === null) {
    return { inputs: null, reason: "git tree hash unavailable for target or dependency" };
  }

  // Don't cache if no tree hashes (empty object means nothing to cache against)
  if (Object.keys(treeHashes).length === 0) {
    return { inputs: null, reason: "no tree hashes computed" };
  }

  const targetId = node.target ?? (claimedTargets ? `batch:${claimedTargets.join(",")}` : "__plan__");

  // Collect root config hashes (tsconfig*, eslint.config.*, etc.)
  const rootConfigHashes = collectRootConfigHashes(repoRoot);

  // Collect all lockfile hashes
  const lockfileHashes = collectLockfileHashes(repoRoot);

  // Collect plugin source hashes for plugin hooks
  const pluginHashes = pluginName
    ? collectPluginHashes(project.plugins, pluginName)
    : {};

  // Collect extra input hashes from service cache.inputs config
  const extraInputHashes = collectExtraInputHashes(service, repoRoot);
  if (extraInputHashes === null) {
    return { inputs: null, reason: "extra input file hash unavailable (gitignored inputs must exist)" };
  }

  // Collect declared env inputs (default + service-declared cache.env)
  const envInputs: Record<string, string> = {};
  for (const name of declaredEnvInputs) {
    const value = env[name];
    if (value !== undefined) {
      envInputs[name] = value;
    }
  }

  return {
    inputs: {
      targetId,
      command,
      args: undefined, // Args are in payload
      payload: node.payload,
      treeHashes,
      rootConfigHashes,
      lockfileHashes,
      pluginHashes: Object.keys(pluginHashes).length > 0 ? pluginHashes : undefined,
      runtimeVersion: getRuntimeVersion(),
      nopoVersion: getNopoVersion(),
      envInputs,
      extraInputHashes: Object.keys(extraInputHashes).length > 0 ? extraInputHashes : undefined,
    },
  };
}

/**
 * Extract the list of environment variables declared as cache inputs
 * for a service. Includes default vars plus service-declared cache.env.
 *
 * Default always-included env vars that affect execution:
 * - CI (affects some behaviors)
 * - NODE_ENV (affects builds)
 */
const DEFAULT_ENV_INPUTS = ["CI", "NODE_ENV"];

/**
 * Get service-level cache configuration from pluginData or direct cache field.
 * Services can declare cache.env and cache.inputs in their nopo.yml.
 */
export function getServiceCacheConfig(
  service: NormalizedService | undefined,
): ServiceCacheConfig | undefined {
  if (!service) return undefined;
  // Check for cache config in service (could be under pluginData.cache or direct)
  const cacheConfig = (service as { cache?: ServiceCacheConfig }).cache ??
    (service.pluginData?.cache as ServiceCacheConfig | undefined);
  return cacheConfig;
}

export function getDeclaredEnvInputs(
  service: NormalizedService | undefined,
): readonly string[] {
  const serviceConfig = getServiceCacheConfig(service);
  const serviceEnvInputs = serviceConfig?.env ?? [];
  // Combine default + service-declared, deduplicated
  return [...new Set([...DEFAULT_ENV_INPUTS, ...serviceEnvInputs])];
}

/**
 * Collect hashes for extra input files declared in service cache.inputs.
 * These are globs relative to the service root.
 * Returns null if any declared input file is missing (gitignored files must exist).
 */
export function collectExtraInputHashes(
  service: NormalizedService | undefined,
  repoRoot: string,
): Record<string, string> | null {
  const serviceConfig = getServiceCacheConfig(service);
  if (!serviceConfig?.inputs || serviceConfig.inputs.length === 0) {
    return {};
  }

  const hashes: Record<string, string> = {};
  const serviceRoot = service?.paths.root ?? repoRoot;

  for (const pattern of serviceConfig.inputs) {
    try {
      // Resolve glob pattern relative to service root
      const matches = glob.sync(pattern, {
        cwd: serviceRoot,
        nodir: true,
        absolute: false,
      });

      if (matches.length === 0) {
        // Pattern matched nothing - could be gitignored file that doesn't exist
        // This is a configuration error
        console.warn(`[cache] Extra input pattern "${pattern}" matched no files in ${serviceRoot}`);
      }

      for (const match of matches) {
        const filePath = path.join(serviceRoot, match);
        const hash = hashFileContent(filePath);
        if (hash === null) {
          // File exists but couldn't be read, or doesn't exist
          return null;
        }
        // Use relative path from repo root as key
        const relPath = path.relative(repoRoot, filePath);
        hashes[relPath] = hash;
      }
    } catch {
      // Glob failed - treat as uncacheable
      return null;
    }
  }

  return hashes;
}

/**
 * Collect hashes for plugin source files.
 * For plugin hooks, includes the plugin's source file hash to invalidate
 * cache when plugin code changes.
 */
export function collectPluginHashes(
  plugins: LoadedPlugin[],
  pluginName?: string,
): Record<string, string> {
  const hashes: Record<string, string> = {};

  // If a specific plugin is requested, only hash that one
  const pluginsToHash = pluginName
    ? plugins.filter(p => p.definition.name === pluginName)
    : plugins;

  for (const plugin of pluginsToHash) {
    // Hash the plugin's source file if available
    const sourcePath = plugin.definition.sourcePath;
    if (sourcePath) {
      const hash = hashFileContent(sourcePath);
      if (hash) {
        hashes[plugin.definition.name] = hash;
      }
    }
  }

  return hashes;
}

/**
 * Check if any of the given paths have uncommitted or untracked changes.
 * Uses `git status --porcelain -z` for reliable NUL-separated parsing.
 *
 * @param repoRoot - Root of the git repository
 * @param relativePaths - Paths relative to repo root to check
 * @returns Array of dirty paths (empty if all clean)
 */
export function getDirtyPaths(
  repoRoot: string,
  relativePaths: readonly string[],
): string[] {
  if (relativePaths.length === 0) return [];

  // Run git status with -z for NUL-separated output (more reliable parsing)
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "-z", "--", ...relativePaths],
    { cwd: repoRoot, encoding: "utf-8" },
  );

  if (result.status !== 0) {
    // Git command failed - treat as dirty to be safe
    return [...relativePaths];
  }

  const output = result.stdout;
  if (!output) return [];

  // Parse NUL-separated porcelain output
  // Format: "XY path\0" or "XY oldpath\0newpath\0" for renames
  const dirtyPaths: string[] = [];
  const parts = output.split("\0");

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part) {
      i++;
      continue;
    }

    // Skip the status prefix (2 chars + space)
    const pathPart = part.slice(3);

    // Check if this is a rename (status starts with R)
    if (part.startsWith("R")) {
      // For renames, the next part is the new name
      dirtyPaths.push(pathPart);
      if (i + 1 < parts.length && parts[i + 1]) {
        dirtyPaths.push(parts[i + 1]!);
        i++;
      }
    } else if (pathPart) {
      dirtyPaths.push(pathPart);
    }

    i++;
  }

  return dirtyPaths;
}

/**
 * Check if a specific path or any of its contents are dirty.
 *
 * @param repoRoot - Root of the git repository
 * @param relativePath - Path relative to repo root (directory or file)
 * @returns true if the path has uncommitted/untracked changes
 */
export function isPathDirty(repoRoot: string, relativePath: string): boolean {
  if (!relativePath || relativePath === ".") {
    // Check entire repo
    const result = spawnSync(
      "git",
      ["status", "--porcelain", "-z"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    return result.status !== 0 || !!result.stdout;
  }

  const dirtyPaths = getDirtyPaths(repoRoot, [relativePath]);
  if (dirtyPaths.length > 0) return true;

  // Also check if there are dirty files UNDER this path (for directories)
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "-z", "--", `${relativePath}/`],
    { cwd: repoRoot, encoding: "utf-8" },
  );

  return result.status !== 0 || !!result.stdout;
}

/**
 * Result of checking cache eligibility for a step.
 */
export interface CacheEligibility {
  /** Whether the step is eligible for caching */
  eligible: boolean;
  /** Reason if not eligible */
  reason?: string;
  /** Dirty paths that caused ineligibility */
  dirtyPaths?: string[];
}

/**
 * Collect all paths that should be checked for dirty status.
 * This includes target directory, all transitive dependencies, root configs, and lockfiles.
 */
export function collectPathsForDirtyCheck(
  project: NormalizedProjectConfig,
  targetId: string | undefined,
  repoRoot: string,
  claimedTargets?: readonly string[],
): string[] {
  const pathsToCheck: string[] = [];
  const visited = new Set<string>();

  // Recursive function to collect target and all transitive deps
  const collectTargetPaths = (tid: string): void => {
    if (visited.has(tid)) return;
    visited.add(tid);

    const service = project.services.entries[tid];
    if (!service) return;

    const relativePath = path.relative(repoRoot, service.paths.root);
    // Handle root target (relativePath === "")
    if (relativePath === "" || relativePath === ".") {
      // Root target - check entire repo
      pathsToCheck.push("");
    } else if (relativePath && !relativePath.startsWith("..")) {
      pathsToCheck.push(relativePath);
    }

    // Add all transitive dependencies
    const allDeps = [
      ...service.buildDeps,
      ...service.runtimeDeps,
      ...service.systemDeps,
    ];
    for (const depId of new Set(allDeps)) {
      collectTargetPaths(depId);
    }
  };

  // Collect paths for main target
  if (targetId) {
    collectTargetPaths(targetId);
  }

  // Collect paths for claimed targets (batch nodes)
  if (claimedTargets) {
    for (const tid of claimedTargets) {
      collectTargetPaths(tid);
    }
  }

  // Add root config files
  for (const pattern of ROOT_CONFIG_PATTERNS) {
    try {
      const files = fs.readdirSync(repoRoot);
      for (const file of files) {
        const isMatch = pattern.includes("*")
          ? new RegExp(`^${pattern.replace(/\*/g, ".*")}$`).test(file)
          : file === pattern;
        if (isMatch && fs.statSync(path.join(repoRoot, file)).isFile()) {
          pathsToCheck.push(file);
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  // Add lockfiles
  for (const lockfile of LOCKFILE_NAMES) {
    const lockfilePath = path.join(repoRoot, lockfile);
    if (fs.existsSync(lockfilePath)) {
      pathsToCheck.push(lockfile);
    }
  }

  return [...new Set(pathsToCheck)];
}

/**
 * Check if a step is eligible for caching based on working tree state.
 * A step is ineligible if any of its input paths have uncommitted changes.
 * Checks the EXACT same paths used for the cache key (transitive deps, root configs, lockfiles).
 *
 * @param project - Project configuration
 * @param targetId - Target to check (or undefined for non-target steps)
 * @param repoRoot - Repository root path
 * @param claimedTargets - For batch nodes, the list of claimed targets
 */
export function checkCacheEligibility(
  project: NormalizedProjectConfig,
  targetId: string | undefined,
  repoRoot: string,
  claimedTargets?: readonly string[],
): CacheEligibility {
  const pathsToCheck = collectPathsForDirtyCheck(project, targetId, repoRoot, claimedTargets);

  if (pathsToCheck.length === 0) {
    return { eligible: true };
  }

  // Check for dirty paths
  const dirtyPaths: string[] = [];
  for (const p of pathsToCheck) {
    if (isPathDirty(repoRoot, p)) {
      dirtyPaths.push(p || "(repo root)");
    }
  }

  if (dirtyPaths.length > 0) {
    return {
      eligible: false,
      reason: `uncommitted changes in: ${dirtyPaths.join(", ")}`,
      dirtyPaths,
    };
  }

  return { eligible: true };
}

/**
 * HMAC signing for cache entries.
 *
 * When NOPO_CACHE_SIGNING_KEY is set:
 * - Entries are signed on write
 * - Unsigned or invalid entries are rejected on read
 *
 * This prevents cache poisoning from untrusted writers.
 * Recommendation: Only give write credentials to trusted CI events (push:main, merge_group).
 * PR jobs should be read-only.
 */

/**
 * Compute HMAC signature for a cache entry.
 * Signs the JSON content (excluding the signature field itself).
 */
export function signCacheEntry(content: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(content).digest("hex");
}

/**
 * Verify HMAC signature for a cache entry.
 * Returns true if signature is valid, false otherwise.
 */
export function verifyCacheEntrySignature(
  content: string,
  signature: string,
  signingKey: string,
): boolean {
  const expectedSignature = signCacheEntry(content, signingKey);
  // Use timing-safe comparison to prevent timing attacks
  if (signature.length !== expectedSignature.length) return false;
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return result === 0;
}
