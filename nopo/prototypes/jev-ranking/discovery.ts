import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { HookContext } from "@more-nopo/nopo/plugin";

export interface Inventory {
  files: string[];
  authority: "native" | "advisory";
  scopeLimit: string;
}

// Consume the runner's resolved argv: profiles and --files have already expanded.
// Fail closed on unfamiliar option syntax instead of inventing an exact inventory.
export function bunCandidates(cwd: string, argv: string[]): Inventory {
  const filters: string[] = [];
  const valued = new Set([
    "--timeout",
    "--preload",
    "--test-name-pattern",
    "-t",
    "--rerun-each",
    "--seed",
    "--reporter",
    "--reporter-outfile",
    "--bail",
    "--max-concurrency",
  ]);
  const flags = new Set([
    "--coverage",
    "--only",
    "--todo",
    "--randomize",
    "--concurrent",
    "--silent",
    "--update-snapshots",
    "-u",
    "--pass-with-no-tests",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const name = arg.split("=")[0]!;
    if (valued.has(name)) {
      if (!arg.includes("=")) {
        if (!argv[i + 1] || argv[i + 1]!.startsWith("-"))
          throw new Error("ambiguous-bun-option");
        i++;
      }
    } else if (flags.has(arg)) continue;
    else if (arg.startsWith("-"))
      throw new Error("unsupported-bun-discovery-option");
    else filters.push(arg);
  }
  const configFile = path.join(cwd, "bunfig.toml");
  const config = existsSync(configFile)
    ? (
        globalThis as unknown as {
          Bun: { TOML: { parse(text: string): { test?: { root?: string } } } };
        }
      ).Bun.TOML.parse(readFileSync(configFile, "utf8"))
    : {};
  const root = path.resolve(cwd, config.test?.root ?? ".");
  const files = new Set<string>();
  function visit(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.isSymbolicLink()
      )
        continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/(?:\.|_)(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name))
        files.add(file);
    }
  }
  visit(root);
  const explicit = filters.filter(
    (filter) => filter.startsWith("./") || path.isAbsolute(filter),
  );
  for (const filter of explicit) {
    const file = path.resolve(cwd, filter);
    if (statSync(file).isDirectory()) visit(file);
    else files.add(file);
  }
  return {
    files: [...files].filter(
      (file) =>
        !filters.length ||
        filters.some((filter) => {
          if (!explicit.includes(filter))
            return path.relative(cwd, file).includes(filter);
          const relative = path.relative(path.resolve(cwd, filter), file);
          return (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative))
          );
        }),
    ),
    authority: "advisory",
    scopeLimit:
      "Bun pattern inventory with resolved path filters; not native discovery. Test-name filters, custom loaders and inherited configuration may differ.",
  };
}

export async function vitestCandidates(
  ctx: HookContext,
  cmd: string,
  argv: string[],
  options: Parameters<HookContext["io"]["spawn"]>[2],
): Promise<Inventory> {
  // Use the exact resolved config (including gate/audit overlays), before sharding.
  // Listing must not overwrite the execution's JSON report.
  const args: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (/^--(?:outputFile|reporter|json|shard)(?:=|$)/.test(arg)) {
      if (!arg.includes("=")) i++;
    } else args.push(arg);
  }
  const result = await ctx.io.spawn(
    cmd,
    [argv[0]!, "list", ...args, "--filesOnly", "--json"],
    {
      ...options,
      stdio: "pipe",
      onChunk: undefined,
      signal: AbortSignal.timeout(10000),
    },
  );
  if (result.exitCode) throw new Error("vitest-list-failed");
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.some((row) => typeof row?.file !== "string"))
    throw new Error("vitest-invalid-inventory");
  return {
    files: rows.map((row: { file: string }) =>
      path.resolve(options?.cwd ?? ctx.io.cwd(), row.file),
    ),
    authority: "native",
    scopeLimit:
      "Native inventory for this policy phase before sharding; filesOnly does not establish which individual test cases execute.",
  };
}
