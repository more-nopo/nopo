/**
 * Cache key computation for plan steps.
 *
 * A step key is a content-addressable hash combining:
 * - Target's git tree hash and its dependency targets' tree hashes
 * - Lockfile content hash
 * - Toolchain/runtime version (node/bun version)
 * - Step's command and arguments
 * - Declared environment variable inputs
 *
 * The design is hierarchical to enable future granularity:
 * - Plan key = hash of all step keys
 * - Step key = hash of step inputs (current implementation)
 * - Per-file key = future extension for file-level caching
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NormalizedProjectConfig, NormalizedService } from "../config/index.ts";
import type { PlanNode } from "../plan.ts";

/** Inputs that contribute to a step's cache key */
export interface StepKeyInputs {
  /** Target ID (service/package name) */
  targetId: string;
  /** Command/handler being executed */
  command: string;
  /** Command arguments */
  args?: readonly string[];
  /** Handler payload (serialized) */
  payload?: unknown;
  /** Git tree hashes for target and its dependencies, keyed by target ID */
  treeHashes: Record<string, string>;
  /** Lockfile content hash */
  lockfileHash?: string;
  /** Runtime/toolchain version (e.g., node version) */
  runtimeVersion: string;
  /** Declared environment variable values that affect the step */
  envInputs: Record<string, string>;
  /** Extra input files outside the target directory (hashed content) */
  extraInputHashes?: Record<string, string>;
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

const KEY_VERSION = "v1";

/**
 * Compute a stable cache key for a plan step.
 *
 * The key is a SHA-256 hash of the canonical JSON representation of
 * all inputs. Using JSON ensures deterministic serialization.
 */
export function computeStepKey(inputs: StepKeyInputs): StepKey {
  const canonicalInputs = {
    v: KEY_VERSION,
    target: inputs.targetId,
    command: inputs.command,
    args: inputs.args ?? [],
    payload: inputs.payload ?? null,
    trees: sortObject(inputs.treeHashes),
    lockfile: inputs.lockfileHash ?? null,
    runtime: inputs.runtimeVersion,
    env: sortObject(inputs.envInputs),
    extraInputs: inputs.extraInputHashes ? sortObject(inputs.extraInputHashes) : null,
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
  const { spawnSync } = require("node:child_process");

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
 * Collect git tree hashes for a target and all its dependencies.
 *
 * @param project - Normalized project config
 * @param targetId - Target to collect hashes for
 * @param visited - Set of already-visited targets (for cycle detection)
 */
export function collectTreeHashes(
  project: NormalizedProjectConfig,
  targetId: string,
  repoRoot: string,
  visited = new Set<string>(),
): Record<string, string> {
  const hashes: Record<string, string> = {};

  if (visited.has(targetId)) return hashes;
  visited.add(targetId);

  const service = project.services.entries[targetId];
  if (!service) return hashes;

  // Get tree hash for this target's directory
  const relativePath = path.relative(repoRoot, service.paths.root);
  const treeHash = getGitTreeHash(repoRoot, relativePath);
  if (treeHash) {
    hashes[targetId] = treeHash;
  }

  // Recursively collect for dependencies
  const allDeps = [
    ...service.buildDeps,
    ...service.runtimeDeps,
    ...service.systemDeps,
  ];
  for (const dep of new Set(allDeps)) {
    Object.assign(hashes, collectTreeHashes(project, dep, repoRoot, visited));
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
 */
export function getRuntimeVersion(): string {
  return `node:${process.version}`;
}

/**
 * Build step key inputs from a plan node and project context.
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
): StepKeyInputs {
  const targetId = node.target ?? "__plan__";
  const service = node.target ? project.services.entries[node.target] : undefined;

  // Compute command string from handler
  let command: string;
  if (node.handler.kind === "plugin-hook") {
    command = `plugin:${node.handler.plugin}:${node.handler.hook}`;
  } else {
    command = `builtin:${node.handler.name}`;
  }

  // Collect tree hashes for target and dependencies
  const treeHashes = node.target
    ? collectTreeHashes(project, node.target, repoRoot)
    : {};

  // Get lockfile hash (from first package manager if available)
  let lockfileHash: string | undefined;
  if (service && service.packageManagers.length > 0) {
    const lockfilePath = service.packageManagers[0]!.lockfile;
    lockfileHash = hashFileContent(lockfilePath) ?? undefined;
  } else {
    // Fall back to project root lockfile
    const rootLockfile = path.join(repoRoot, "bun.lock");
    if (fs.existsSync(rootLockfile)) {
      lockfileHash = hashFileContent(rootLockfile) ?? undefined;
    }
  }

  // Collect declared env inputs
  const envInputs: Record<string, string> = {};
  for (const name of declaredEnvInputs) {
    const value = env[name];
    if (value !== undefined) {
      envInputs[name] = value;
    }
  }

  return {
    targetId,
    command,
    args: undefined, // Args are in payload
    payload: node.payload,
    treeHashes,
    lockfileHash,
    runtimeVersion: getRuntimeVersion(),
    envInputs,
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
