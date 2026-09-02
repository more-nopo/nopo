import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { NormalizedService } from "@more-nopo/nopo/config";
import type { HookContext, NopoPluginFactory } from "@more-nopo/nopo/plugin";
import { ScriptArgs } from "@more-nopo/nopo/script-args";
import picomatch from "picomatch";

const execFileAsync = promisify(execFile);

/** A service's `plugins.diff` block: map of group name → list of globs (relative to the service root).
 * plugins: diff: migrations: - drizzle/** - drizzle.config.ts application: - src/**
 */
export type DiffPluginConfig = Record<string, string[]>;

export function getServiceDiffConfig(
  service: NormalizedService,
): DiffPluginConfig {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- pluginData is passthrough
  const raw = (service.pluginData?.diff ?? {}) as Record<string, unknown>;
  const out: DiffPluginConfig = {};
  for (const [name, patterns] of Object.entries(raw)) {
    if (
      Array.isArray(patterns) &&
      patterns.every((p) => typeof p === "string")
    ) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- type-guard above narrows unknown[] to string[]
      out[name] = patterns as string[];
    }
  }
  return out;
}

export interface GroupResult {
  changed: boolean;
  files: string[];
}

export interface ServiceResult {
  groups: Record<string, GroupResult>;
}

export interface CheckResult {
  since: string | Record<string, string>;
  head: string;
  services: Record<string, ServiceResult>;
}

async function gitDiffNames(
  cwd: string,
  since: string,
  pathPrefix: string,
): Promise<string[]> {
  /** Three-dot diff scopes to changes on HEAD relative to merge-base with
   * <since>. This is what we want for "what did this branch add?" Two-dot
   * is the fallback in case the merge-base isn't reachable.
   */
  const tryDiff = async (rangeOp: string): Promise<string[]> => {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", `${since}${rangeOp}HEAD`, "--", pathPrefix],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split("\n").filter(Boolean);
  };
  try {
    return await tryDiff("...");
  } catch {
    return await tryDiff("..");
  }
}

async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd,
  });
  return stdout.trim();
}

/** Build the per-service result for one service given the changed files
 * within its root and the include/exclude flags.
 *
 * Exported for unit tests; pure given the inputs.
 */
export function classifyServiceFiles(
  serviceFiles: string[],
  groups: DiffPluginConfig,
  serviceRel: string,
  includes: string[],
  excludes: string[],
): ServiceResult {
  const matchers: Record<string, (p: string) => boolean> = {};
  for (const [name, patterns] of Object.entries(groups)) {
    matchers[name] = picomatch(patterns, { dot: true });
  }

  const filterIncludes = includes.length > 0 ? new Set(includes) : null;
  const filterExcludes = excludes.length > 0 ? new Set(excludes) : null;

  const out: ServiceResult = { groups: {} };

  /** Positive groups — what to emit:
   * --include given      → only those (must be declared)
   * --exclude only given → none (only the synthetic not_ groups appear)
   * no flags             → all declared groups + `other`
   */
  let positiveGroupsToEmit: string[];
  if (filterIncludes) {
    positiveGroupsToEmit = [...filterIncludes].filter(
      (n) => matchers[n] !== undefined,
    );
  } else if (filterExcludes) {
    positiveGroupsToEmit = [];
  } else {
    positiveGroupsToEmit = Object.keys(matchers);
  }

  for (const name of positiveGroupsToEmit) {
    const matcher = matchers[name]!;
    const matched = serviceFiles.filter((f) => matcher(f));
    out.groups[name] = {
      changed: matched.length > 0,
      files: matched.map((f) => path.posix.join(serviceRel, f)),
    };
  }

  if (filterExcludes) {
    for (const name of filterExcludes) {
      const matcher = matchers[name];
      if (!matcher) continue;
      const nonMatched = serviceFiles.filter((f) => !matcher(f));
      out.groups[`not_${name}`] = {
        changed: nonMatched.length > 0,
        files: nonMatched.map((f) => path.posix.join(serviceRel, f)),
      };
    }
  }

  /** `other` is the catch-all for declared-group complement. Only emitted
   * when no filter flags were passed (otherwise the user is asking for
   * a specific projection, not the full picture).
   */
  if (!filterIncludes && !filterExcludes) {
    const anyMatcher = picomatch(Object.values(groups).flat(), { dot: true });
    const otherFiles = serviceFiles.filter((f) => !anyMatcher(f));
    out.groups.other = {
      changed: otherFiles.length > 0,
      files: otherFiles.map((f) => path.posix.join(serviceRel, f)),
    };
  }

  return out;
}

const diffPlugin: NopoPluginFactory = () => {
  return {
    name: "diff",
    description:
      "Bucket changed files into per-service groups for CI policy decisions",
    commands: [
      {
        name: "check",
        description:
          "Bucket files changed since <since> into per-service groups. " +
          "Usage: nopo diff check --since <sha-or-json-map> [--include <name>...] [--exclude <name>...] [--print]",
        args: new ScriptArgs({
          since: {
            type: "string",
            description:
              "Base ref to diff HEAD against. Either a single SHA/ref or a " +
              "JSON map of {serviceId: sha} (matches `nopo build --since` " +
              "convention). Required.",
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- undefined default for required arg
            default: undefined as unknown as string,
          },
          include: {
            type: "string[]",
            description:
              "Restrict positive groups in output to these declared names. " +
              "Repeatable: --include foo --include bar.",
            default: [],
          },
          exclude: {
            type: "string[]",
            description:
              "Add a synthetic `not_<name>` group containing files NOT " +
              "matching <name>'s globs. Repeatable.",
            default: [],
          },
          print: {
            type: "boolean",
            description: "Print result as JSON to stdout.",
            default: false,
          },
        }),
        fn: async (context: HookContext, args: ScriptArgs) => {
          const runner = context.runner;
          const sinceArg = args.get<string>("since");
          if (!sinceArg) {
            throw new Error(
              "--since is required (a SHA, ref, or JSON {serviceId: sha} map)",
            );
          }

          let sinceMap: Record<string, string> | null = null;
          try {
            const parsed = JSON.parse(sinceArg);
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSON.parse returns unknown; we've narrowed to a plain object above
              sinceMap = parsed as Record<string, string>;
            }
          } catch {
            // Not JSON — treat as a single ref/SHA.
          }

          const includes = args.get<string[]>("include") ?? [];
          const excludes = args.get<string[]>("exclude") ?? [];

          const allEntries = runner.config.project.services.entries;
          const services = Object.values(allEntries);
          const repoRoot = services[0]?.paths.context;
          if (!repoRoot) {
            throw new Error("No services found in project");
          }

          const result: CheckResult = {
            since: sinceMap ?? sinceArg,
            head: await gitHead(repoRoot),
            services: {},
          };

          for (const service of services) {
            const groups = getServiceDiffConfig(service);
            if (Object.keys(groups).length === 0) continue;

            const since = sinceMap ? sinceMap[service.id] : sinceArg;
            if (!since) continue;

            const serviceRel = path.relative(repoRoot, service.paths.root);
            const changedFiles = await gitDiffNames(
              repoRoot,
              since,
              serviceRel,
            );

            // git diff paths are repo-relative; rebase to service-relative
            // so the picomatch globs (also service-relative) line up.
            const serviceFiles = changedFiles
              .map((f) => path.relative(serviceRel, f))
              .filter((f) => f && !f.startsWith(".."));

            result.services[service.id] = classifyServiceFiles(
              serviceFiles,
              groups,
              serviceRel,
              includes,
              excludes,
            );
          }

          if (args.get<boolean>("print")) {
            context.io.stdout.write(JSON.stringify(result) + "\n");
            return;
          }

          const log = (msg: string) => runner.logger.log(msg);
          log(
            `since: ${typeof result.since === "string" ? result.since : "(per-service map)"}`,
          );
          log(`head:  ${result.head}`);
          for (const [serviceId, svc] of Object.entries(result.services)) {
            log(`\n${serviceId}:`);
            for (const [groupName, group] of Object.entries(svc.groups)) {
              log(
                `  ${groupName}: ${group.changed ? `${group.files.length} file(s)` : "no changes"}`,
              );
            }
          }
        },
      },
    ],
  };
};

export default diffPlugin;
