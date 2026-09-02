import type { NormalizedService } from "./config/index.ts";
import {
  applyFiltersToNames,
  type FilterContext,
  type FilterExpression,
  parseFilterExpression,
} from "./filter.ts";
import { minimist } from "./lib.ts";

interface ParseTargetArgsOptions {
  leadingPositionals?: number; // For 'run': 1 (script name)
  boolean?: string[];
  string?: string[];
  alias?: Record<string, string | string[]>;
  // Enable filtering for this command
  supportsFilter?: boolean;
  // Pre-filter (like 'buildable' for build command)
  preFilter?: FilterExpression;
}

interface FilteredTargetArgsOptions extends ParseTargetArgsOptions {
  supportsFilter: true;
  services: Record<string, NormalizedService>;
  projectRoot: string;
}

interface ParsedTargetArgs {
  targets: string[];
  leadingArgs: string[]; // e.g., ['test'] for run
  options: Record<string, unknown>;
  filters?: FilterExpression[];
  since?: string;
}

/** @param commandName - The command name (e.g., 'build', 'up', 'run') @param argv - The raw
 * argv array (typically runner.argv.slice(1)) @param availableTargets - List of valid
 * target names to validate against @param opts - Options for parsing (minimist options +
 * leadingPositionals + filtering) @returns Parsed targets, leading args, options,
 */
export function parseTargetArgs(
  commandName: string,
  argv: string[],
  availableTargets: string[],
  opts: ParseTargetArgsOptions | FilteredTargetArgsOptions = {},
): ParsedTargetArgs {
  const {
    leadingPositionals = 0,
    supportsFilter = false,
    preFilter,
    ...rest
  } = opts;

  // Extract services and projectRoot if filtering is enabled
  const services =
    supportsFilter && "services" in opts ? opts.services : undefined;
  const projectRoot =
    supportsFilter && "projectRoot" in opts ? opts.projectRoot : undefined;

  // Build minimist options, adding filter and since when filtering is enabled
  const minimistOpts: Parameters<typeof minimist>[1] = {
    boolean: rest.boolean || [],
    string: [...(rest.string || [])],
    alias: { ...(rest.alias || {}) },
  };

  if (supportsFilter) {
    minimistOpts.string!.push("filter", "since", "tags");
    minimistOpts.alias!["F"] = "filter";
  }

  // Parse with minimist
  const parsed = minimist(argv, minimistOpts);

  // Extract leading positionals (e.g., script name for 'run')
  const leadingArgs: string[] = [];
  const positionalArgs: string[] = [];

  for (let i = 0; i < parsed._.length; i++) {
    const arg = parsed._[i];
    if (!arg) continue;
    if (i < leadingPositionals) {
      leadingArgs.push(arg);
    } else {
      positionalArgs.push(arg.toLowerCase());
    }
  }

  // Extract options (everything except _ and filter/since/tags when filtering enabled)
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "_") continue;
    if (
      supportsFilter &&
      (key === "filter" || key === "since" || key === "tags" || key === "F")
    )
      continue;
    options[key] = value;
  }

  // Handle filtering
  let filters: FilterExpression[] = [];
  let since: string | undefined;
  let filteredTargets = availableTargets;
  let requestedTags: string[] = [];

  if (supportsFilter) {
    // Parse filter expressions
    const filterValue = parsed.filter;
    if (filterValue) {
      const filterArgs = Array.isArray(filterValue)
        ? filterValue
        : [filterValue];
      filters = filterArgs
        .filter((f): f is string => typeof f === "string" && f.length > 0)
        .map(parseFilterExpression);
    }

    // Add pre-filter if specified
    if (preFilter) {
      filters = [preFilter, ...filters];
    }

    // Get since value
    since = typeof parsed.since === "string" ? parsed.since : undefined;

    // Parse --tags (comma-separated, trim, dedupe)
    const tagsRaw = parsed.tags;
    requestedTags =
      typeof tagsRaw === "string"
        ? [
            ...new Set(
              tagsRaw
                .split(",")
                .map((t: string) => t.trim())
                .filter(Boolean),
            ),
          ]
        : [];
    if (
      tagsRaw !== undefined &&
      tagsRaw !== null &&
      (typeof tagsRaw !== "string" || requestedTags.length === 0)
    ) {
      throw new Error(
        "--tags requires at least one non-empty tag (comma-separated)",
      );
    }

    // Apply filters to available targets if we have the services data
    if (services && projectRoot && filters.length > 0) {
      const context: FilterContext = { projectRoot, since };
      filteredTargets = applyFiltersToNames(
        availableTargets,
        services,
        filters,
        context,
      );
    }

    // Apply tag filter (intersection with current filteredTargets)
    if (services && requestedTags.length > 0) {
      filteredTargets = filteredTargets.filter((name) => {
        const service = services[name];
        if (!service?.tags?.length) return false;
        return requestedTags.some((tag) => service.tags.includes(tag));
      });
    }
  }

  // Determine final targets
  let targets: string[];
  if (positionalArgs.length > 0) {
    // User specified explicit targets - validate them
    validateTargets(positionalArgs, availableTargets);
    // PreFilter only applies when no explicit targets are given.
    // User-provided filters (via --filter) still apply to explicit targets.
    const userFilters = filters.filter((f) => f !== preFilter);
    if (supportsFilter && userFilters.length > 0 && services && projectRoot) {
      // Apply only user filters to explicit targets
      const context: FilterContext = { projectRoot, since };
      const userFilteredTargets = applyFiltersToNames(
        availableTargets,
        services,
        userFilters,
        context,
      );
      targets = positionalArgs.filter((t) => userFilteredTargets.includes(t));
    } else {
      // No user filters - use explicit targets as-is
      targets = positionalArgs;
    }
    // Apply tag filter to explicit targets when --tags is used
    if (supportsFilter && services && requestedTags.length > 0) {
      targets = targets.filter((name) => {
        const service = services[name];
        if (!service?.tags?.length) return false;
        return requestedTags.some((tag) => service.tags.includes(tag));
      });
    }
  } else {
    // No explicit targets - use filtered targets (includes preFilter and tags)
    targets =
      supportsFilter && (filters.length > 0 || requestedTags.length > 0)
        ? filteredTargets
        : [];
  }

  return {
    targets,
    leadingArgs,
    options,
    ...(supportsFilter ? { filters, since } : {}),
  };
}

/** Validate that all provided targets exist in the available targets list. @param targets -
 * Target names to validate @param availableTargets - List of valid target names @throws
 * Error if any target is unknown
 */
export function validateTargets(
  targets: string[],
  availableTargets: string[],
): void {
  const unknown = targets.filter((t) => !availableTargets.includes(t));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown target${unknown.length > 1 ? "s" : ""} '${unknown.join("', '")}'. ` +
        `Available targets: ${availableTargets.join(", ")}`,
    );
  }
}
