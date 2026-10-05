import path from "node:path";
import type { HookContext } from "@more-nopo/nopo/plugin";
import type { Inventory } from "@more-nopo/nopo-test-relevance";

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
