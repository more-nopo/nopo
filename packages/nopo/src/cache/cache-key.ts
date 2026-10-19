/**
 * Cache key computation for plan steps.
 *
 * A step key is a content-addressable hash combining:
 * - Target's git tree hash and its dependency targets' tree hashes (transitive)
 * - Root-level config files (tsconfig*, eslint.config.*, .nvmrc, etc.)
 * - Lockfile content hash (all lockfiles, not just first)
 * - Toolchain/runtime version (node/bun version)
 * - nopo package version
 * - Step's command and arguments
 * - Declared environment variable inputs
 *
 * The design is hierarchical to enable future granularity:
 * - Plan key = hash of all step keys
 * - Step key = hash of step inputs (current implementation)
 * - Per-file key = future extension for file-level caching
 *
 * IMPORTANT: Only side-effect-free checks are cacheable (lint/test/typecheck).
 * Side-effectful operations (install, build, up/down, etc.) must never be cached.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NormalizedProjectConfig, NormalizedService } from "../config/index.ts";
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
 */
export function isHandlerCacheable(node: PlanNode): CacheableCheck {
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

// Bumped to v2: added rootConfigHashes, lockfileHashes (plural), nopoVersion
const KEY_VERSION = "v2";

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
 * Get git tree hash for a path without requiring a full checkout.
 * Uses `git ls-tree` which works on the index/refs.
 *
 * @param repoRoot - Root of the git repository
 * @param relativePath - Path relative to repo root (empty string for root)
 * @param ref - Git ref to use (defaults to HEAD)
 */
export function getGitTreeHash(
  repoRoot: string,
  relativePath: string,
  ref = "HEAD",
): string | null {
  // For empty path (repo root), get the tree of the commit
  if (!relativePath || relativePath === ".") {
    const result = spawnSync("git", ["rev-parse", `${ref}^{tree}`], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    if (result.status !== 0) return null;
    return result.stdout.trim();
  }

  // For a specific path, use ls-tree
  const result = spawnSync(
    "git",
    ["ls-tree", ref, "--", relativePath],
    { cwd: repoRoot, encoding: "utf-8" },
  );

  if (result.status !== 0 || !result.stdout.trim()) return null;

  // Output format: "<mode> <type> <hash>\t<path>"
  const match = result.stdout.match(/^\S+\s+\S+\s+(\S+)/);
  return match?.[1] ?? null;
}

/**
 * Collect git tree hashes for a target and all its dependencies (transitive).
 *
 * @param project - Normalized project config
 * @param targetId - Target to collect hashes for
 * @param repoRoot - Repository root path
 * @param visited - Set of already-visited targets (for cycle detection)
 * @returns Record of target ID -> tree hash, or null if any hash is missing (git unavailable)
 */
export function collectTreeHashes(
  project: NormalizedProjectConfig,
  targetId: string,
  repoRoot: string,
  visited = new Set<string>(),
): Record<string, string> | null {
  const hashes: Record<string, string> = {};

  if (visited.has(targetId)) return hashes;
  visited.add(targetId);

  const service = project.services.entries[targetId];
  if (!service) return hashes;

  // Get tree hash for this target's directory
  const relativePath = path.relative(repoRoot, service.paths.root);
  const treeHash = getGitTreeHash(repoRoot, relativePath);

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
    const depHashes = collectTreeHashes(project, dep, repoRoot, visited);
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
 */
export function collectTreeHashesForTargets(
  project: NormalizedProjectConfig,
  targetIds: readonly string[],
  repoRoot: string,
): Record<string, string> | null {
  const hashes: Record<string, string> = {};
  const visited = new Set<string>();

  for (const targetId of targetIds) {
    const targetHashes = collectTreeHashes(project, targetId, repoRoot, visited);
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
 */
export function buildStepKeyInputs(
  node: PlanNode,
  project: NormalizedProjectConfig,
  repoRoot: string,
  declaredEnvInputs: readonly string[],
  env: Record<string, string | undefined>,
): BuildStepKeyResult {
  // Check if handler is cacheable (side-effect-free)
  const cacheableCheck = isHandlerCacheable(node);
  if (!cacheableCheck.cacheable) {
    return { inputs: null, reason: cacheableCheck.reason };
  }

  // Compute command string from handler
  let command: string;
  if (node.handler.kind === "plugin-hook") {
    command = `plugin:${node.handler.plugin}:${node.handler.hook}`;
  } else {
    command = `builtin:${node.handler.name}`;
  }

  // Collect tree hashes for target and dependencies (or claimed targets for batch nodes)
  let treeHashes: Record<string, string> | null;

  // Check if this is a batch node with claimed targets
  const payload = node.payload as { targets?: string[] } | undefined;
  const claimedTargets = payload?.targets;

  if (claimedTargets && claimedTargets.length > 0) {
    // Batch node: collect tree hashes for all claimed targets
    treeHashes = collectTreeHashesForTargets(project, claimedTargets, repoRoot);
  } else if (node.target) {
    // Regular node with a target
    treeHashes = collectTreeHashes(project, node.target, repoRoot);
  } else {
    // No target and no claimed targets - can't compute meaningful key
    return { inputs: null, reason: "no target or claimed targets" };
  }

  // If tree hashes are null, git is unavailable - don't cache
  if (treeHashes === null) {
    return { inputs: null, reason: "git tree hash unavailable" };
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

  // Collect declared env inputs
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
      runtimeVersion: getRuntimeVersion(),
      nopoVersion: getNopoVersion(),
      envInputs,
    },
  };
}

/**
 * Extract the list of environment variables declared as cache inputs
 * for a service. Services can declare these in their nopo.yml.
 *
 * Default always-included env vars that affect execution:
 * - CI (affects some behaviors)
 * - NODE_ENV (affects builds)
 */
const DEFAULT_ENV_INPUTS = ["CI", "NODE_ENV"];

export function getDeclaredEnvInputs(
  service: NormalizedService | undefined,
): readonly string[] {
  // TODO: Support service-level declaration of env inputs via nopo.yml
  // For now, return the default set
  return DEFAULT_ENV_INPUTS;
}

/**
 * Check if any of the given paths have uncommitted or untracked changes.
 * Uses `git status --porcelain` to detect dirty files.
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

  // Run git status for all paths at once
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "--", ...relativePaths],
    { cwd: repoRoot, encoding: "utf-8" },
  );

  if (result.status !== 0) {
    // Git command failed - treat as dirty to be safe
    return [...relativePaths];
  }

  // Don't trim the whole output - leading space in " M file.txt" is part of
  // the porcelain format (X=index status, Y=working tree status)
  const output = result.stdout;
  if (!output.trim()) return [];

  // Parse porcelain output: each line is "XY path" or "XY path -> newpath"
  const dirtyPaths: string[] = [];
  for (const line of output.split("\n")) {
    // Trim trailing whitespace only, preserve leading space which is status
    const trimmedLine = line.trimEnd();
    if (!trimmedLine) continue;
    // Skip the status prefix (2 chars + space)
    const pathPart = trimmedLine.slice(3);
    // Handle renames: "old -> new"
    const arrowIdx = pathPart.indexOf(" -> ");
    const filePath = arrowIdx >= 0 ? pathPart.slice(0, arrowIdx) : pathPart;
    dirtyPaths.push(filePath);
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
      ["status", "--porcelain"],
      { cwd: repoRoot, encoding: "utf-8" },
    );
    return result.status !== 0 || !!result.stdout.trim();
  }

  const dirtyPaths = getDirtyPaths(repoRoot, [relativePath]);
  if (dirtyPaths.length > 0) return true;

  // Also check if there are dirty files UNDER this path (for directories)
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "--", `${relativePath}/`],
    { cwd: repoRoot, encoding: "utf-8" },
  );

  return result.status !== 0 || !!result.stdout.trim();
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
