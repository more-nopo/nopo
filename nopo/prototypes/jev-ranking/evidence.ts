import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { HookContext } from "@more-nopo/nopo/plugin";

export async function evidence(ctx: HookContext, files: string[]) {
  const root = realpathSync(ctx.runner.config.root);
  const git = async (...args: string[]) => {
    const result = await ctx.io.spawn("git", args, { cwd: root });
    if (result.exitCode) throw new Error("git-context-unavailable");
    return result.stdout;
  };
  const base = ctx.io.env.NOPO_JEV_BASE ?? "HEAD";
  const baseSha = (
    await git("rev-parse", "--verify", "--end-of-options", `${base}^{commit}`)
  ).trim();
  const mergeBase = (await git("merge-base", baseSha, "HEAD")).trim();
  const changed = [
    ...new Set(
      [
        ...(
          await git(
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            mergeBase,
            "--",
          )
        ).split("\0"),
        ...(
          await git("ls-files", "--others", "--exclude-standard", "-z")
        ).split("\0"),
      ].filter(Boolean),
    ),
  ].sort();
  const diff = await git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--unified=3",
    mergeBase,
    "--",
  );
  const graph = [...ctx.runner.graph.targets.values()].map((node) => ({
    target: node.id,
    directory: path.relative(root, node.service.paths.root),
    dependencies: node.dependencies,
    systemDependencies: node.service.systemDeps,
  }));
  const candidates = [...new Set(files.map((file) => realpathSync(file)))]
    .sort()
    .map((file) => {
      const relative = path.relative(root, file);
      if (relative.startsWith("../") || path.isAbsolute(relative))
        throw new Error("candidate-outside-repository");
      return {
        id: createHash("sha256").update(relative).digest("hex").slice(0, 20),
        file: relative,
        changed: changed.includes(relative),
        excerpt: readFileSync(file, "utf8").slice(0, 1200),
      };
    });
  return {
    baseSha,
    mergeBase,
    changed,
    graph,
    candidates,
    diff: diff.slice(0, 16000),
    diffTruncated: diff.length > 16000,
    untrackedContentIncluded: false,
    // For comparing reports, not a cache key: excerpts are deliberately bounded.
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ mergeBase, changed, diff, candidates }))
      .digest("hex"),
  };
}
export type Evidence = Awaited<ReturnType<typeof evidence>>;
