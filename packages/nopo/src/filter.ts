import path from "node:path";

import {
  isPackageService,
  isRunnableService,
  type NormalizedService,
  requiresBuild,
} from "./config/index.ts";
import { GitInfo } from "./git-info.ts";

export type FilterExpression = {
  type: "preset" | "exists" | "not_exists" | "equals";
  field?: string;
  value?: string;
};

/** Parse a filter expression string into a FilterExpression object. Supported formats:
 * "buildable" -> preset filter (services that can be built) "changed" -> preset filter
 * (services with changed files) "package"/"packages" -> preset filter (packages -
 * build-only, no runtime) "service"/"services" -> preset filter
 */
export function parseFilterExpression(expr: string): FilterExpression {
  // Named presets (support both singular and plural forms)
  if (expr === "buildable") {
    return { type: "preset", field: "buildable" };
  }
  if (expr === "changed") {
    return { type: "preset", field: "changed" };
  }
  if (expr === "package" || expr === "packages") {
    return { type: "preset", field: "package" };
  }
  if (expr === "service" || expr === "services") {
    return { type: "preset", field: "service" };
  }
  if (expr === "testable") {
    return { type: "preset", field: "testable" };
  }

  // Negation: !fieldname
  if (expr.startsWith("!")) {
    return { type: "not_exists", field: expr.slice(1) };
  }

  // Equality: fieldname=value
  if (expr.includes("=")) {
    const [field, ...rest] = expr.split("=");
    return { type: "equals", field, value: rest.join("=") };
  }

  // Field exists
  return { type: "exists", field: expr };
}

/**
 * Context for evaluating filters that may require external data.
 */
export interface FilterContext {
  /** Project root directory */
  projectRoot: string;
  /** Global git reference to compare against for 'changed' filter (defaults to default branch) */
  since?: string;
  /** Per-service git references — keys are service IDs, values are commit SHAs */
  sinceMap?: Record<string, string>;
  /** Per-ref cache of changed files (populated lazily) */
  _changedFilesCache?: Map<string, string[]>;
  /** Cached "fleet baseline" — oldest git-sha across sinceMap, used for infra services */
  _fleetBaseline?: string | null;
}

/** Parse a --since argument that can be either a plain git ref or a JSON map of per-service
 * refs. Plain ref: `"abc123"` → `{ since: "abc123" }` JSON map:
 * `'{"backend":"abc","af-api":"def"}'` → `{ sinceMap: {...} }`
 */
export function parseSinceArg(
  since: string | undefined,
): Pick<FilterContext, "since" | "sinceMap"> {
  if (!since) return {};

  if (since.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(since);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSON.parse returns unknown, we validate it's a non-null non-array object above
        return { sinceMap: parsed as Record<string, string> };
      }
    } catch {
      // Not valid JSON — treat as a plain ref
    }
  }

  return { since };
}

/**
 * Get the list of changed files for a specific git ref, using a per-ref cache.
 */
function getChangedFilesForRef(ref: string, context: FilterContext): string[] {
  if (!context._changedFilesCache) {
    context._changedFilesCache = new Map();
  }
  const cached = context._changedFilesCache.get(ref);
  if (cached !== undefined) return cached;

  const files = GitInfo.getChangedFiles(ref);
  context._changedFilesCache.set(ref, files);
  return files;
}

/** A valid git sha (short or long): hex, at least 7 chars. */
function looksLikeGitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

/** Find the "fleet baseline" — the oldest git-sha across all entries in sinceMap. Used for
 * infra services whose sinceMap entry is an image ref (no git identity of their own).
 * Diffing their service dir against this baseline catches config/manifest changes that the
 * image-ref check misses.
 */
function getFleetBaseline(context: FilterContext): string | null {
  if (context._fleetBaseline !== undefined) return context._fleetBaseline;
  if (!context.sinceMap) {
    context._fleetBaseline = null;
    return null;
  }
  let oldest: { sha: string; ts: number } | null = null;
  for (const value of Object.values(context.sinceMap)) {
    if (!looksLikeGitSha(value)) continue;
    const ts = GitInfo.getCommitTimestamp(value);
    if (ts === null) continue;
    if (!oldest || ts < oldest.ts) oldest = { sha: value, ts };
  }
  context._fleetBaseline = oldest?.sha ?? null;
  return context._fleetBaseline;
}

/** When sinceMap is present, uses the service-specific ref if available. Two shapes of
 * "changed" depending on the kind of service: • **Runnable with no build** (third-party
 * image — db, redis, upstream grafana, etc.) — primary identity is the image ref in
 * nopo.yml. A change to the pinned image (e.g. `postgres:16` → `postgres:17`) means
 */
function hasChangedFiles(
  service: NormalizedService,
  context: FilterContext,
): boolean {
  const mapped = context.sinceMap?.[service.id];

  // Infra services (no build block) have two axes to check: (1) Image ref — a pin change
  // always redeploys. 2. Service-dir file diff vs. fleet baseline — catches config manifest
  if (isRunnableService(service) && !service.build) {
    if (context.sinceMap && mapped === undefined) return true;
    if (mapped && !looksLikeGitSha(mapped)) {
      if (mapped !== service.image) return true;
      const baseline = getFleetBaseline(context);
      if (!baseline) return false;
      const changedFiles = getChangedFilesForRef(baseline, context);
      const serviceRoot = path.relative(
        context.projectRoot,
        service.paths.root,
      );
      return changedFiles.some(
        (file) => file === serviceRoot || file.startsWith(serviceRoot + "/"),
      );
    }
    // If we somehow got a sha for an infra service, fall through to the
    // file-based check — it's the safe default.
  }

  if (context.sinceMap && isRunnableService(service) && mapped === undefined) {
    return true;
  }

  // A service that just gained a `build:` block but is still running an upstream image (e.g.
  // `nginx:latest`) reports its image ref in the sinceMap. The ref isn't a git sha,
  if (mapped && !looksLikeGitSha(mapped) && requiresBuild(service)) {
    return true;
  }

  const ref = mapped ?? context.since ?? GitInfo.getDefaultBranch();

  const changedFiles = getChangedFilesForRef(ref, context);
  const serviceRoot = path.relative(context.projectRoot, service.paths.root);

  // A service whose path IS the project root (the special `root` package, owner of
  // cross-cutting commands like eslint/knip actionlint) should be considered changed
  if (serviceRoot === "") {
    return changedFiles.length > 0;
  }

  // Match against the service's own dir AND any extra build inputs it declares via
  // `build.include`
  const matchRoots =
    service.build?.include && service.build.include.length > 0
      ? [
          ...new Set([
            serviceRoot,
            ...service.build.include.map((p) => p.replace(/\/+$/, "")),
          ]),
        ]
      : [serviceRoot];

  return changedFiles.some((file) =>
    matchRoots.some((root) => file === root || file.startsWith(root + "/")),
  );
}

/**
 * Check if a service matches a single filter expression.
 */
export function matchesFilter(
  service: NormalizedService,
  filter: FilterExpression,
  context: FilterContext,
): boolean {
  switch (filter.type) {
    case "preset":
      if (filter.field === "buildable") {
        return requiresBuild(service);
      }
      if (filter.field === "changed") {
        return hasChangedFiles(service, context);
      }
      if (filter.field === "package") {
        return isPackageService(service);
      }
      if (filter.field === "service") {
        return isRunnableService(service);
      }
      if (filter.field === "testable") {
        return service.commands.test !== undefined;
      }
      return true;

    case "exists":
      return getFieldValue(service, filter.field!) !== undefined;

    case "not_exists":
      return getFieldValue(service, filter.field!) === undefined;

    case "equals": {
      const value = getFieldValue(service, filter.field!);
      if (value === undefined) return false;
      return String(value) === filter.value;
    }

    default:
      return true;
  }
}

/**
 * Get a nested field value from a service using dot notation.
 * E.g., "infrastructure.cpu" -> service.infrastructure.cpu
 */
export function getFieldValue(
  service: NormalizedService,
  field: string,
): unknown {
  // Support dotted paths like "infrastructure.cpu"
  const parts = field.split(".");
  let current: unknown = service;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- dynamic property access on unknown object for dot-notation field traversal
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Apply multiple filters to a list of services (AND logic).
 */
export function applyFilters(
  services: NormalizedService[],
  filters: FilterExpression[],
  context: FilterContext,
): NormalizedService[] {
  if (filters.length === 0) return services;

  return services.filter((service) =>
    filters.every((filter) => matchesFilter(service, filter, context)),
  );
}

/**
 * Apply filters to a list of service names, returning filtered names.
 */
export function applyFiltersToNames(
  serviceNames: string[],
  services: Record<string, NormalizedService>,
  filters: FilterExpression[],
  context: FilterContext,
): string[] {
  if (filters.length === 0) return serviceNames;

  return serviceNames.filter((name) => {
    const service = services[name];
    if (!service) return false;
    return filters.every((filter) => matchesFilter(service, filter, context));
  });
}
