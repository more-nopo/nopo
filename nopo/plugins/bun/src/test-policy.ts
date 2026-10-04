import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { HookContext } from "@more-nopo/nopo/plugin";
import { z } from "zod";

export const profileSchema = z
  .object({
    args: z.array(z.string()).default([]),
    files: z.array(z.string().min(1)).default([]),
  })
  .strict();
export const testSchema = z
  .object({
    profiles: z.record(profileSchema).optional(),
    shutdown: z.enum(["strict", "after-success"]).optional(),
  })
  .strict();
export type TestOptions = z.infer<typeof testSchema>;

/** Profiles own default scope; explicit files replace it, never append to it. */
export function selectTestArgs(
  argv: string[],
  options: TestOptions,
  cwd: string,
): string[] {
  const args = [...argv];
  let profile: z.infer<typeof profileSchema> = { args: [], files: [] };
  const at = args.findIndex(
    (arg) => arg === "--profile" || arg.startsWith("--profile="),
  );
  if (at >= 0) {
    const name = args[at] === "--profile" ? args[at + 1] : args[at]!.slice(10);
    if (!name || !options.profiles?.[name])
      throw new Error(`[bun] Unknown test profile '${name ?? ""}'.`);
    profile = options.profiles![name]!;
    args.splice(at, args[at] === "--profile" ? 2 : 1);
  }
  if (args.some((arg) => arg === "--profile" || arg.startsWith("--profile=")))
    throw new Error("[bun] Only one test profile may be selected.");
  const filesAt = args.indexOf("--files");
  if (filesAt < 0) return [...profile.args, ...profile.files, ...args];
  const files = args.splice(filesAt).slice(1);
  if (!files.length)
    throw new Error("[bun] --files requires at least one test file.");
  const root = realpathSync(cwd);
  const selected = files.map((file) => {
    const absolute = realpathSync(path.resolve(cwd, file));
    const relative = path.relative(root, absolute);
    if (
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      !statSync(absolute).isFile()
    )
      throw new Error(`[bun] Test file must be inside the target: ${file}`);
    return absolute;
  });
  return [...profile.args, ...args, ...selected];
}

export async function runBunTest(
  context: HookContext,
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  options: TestOptions,
): Promise<void> {
  const args = selectTestArgs(argv, options, cwd);
  if (options.shutdown !== "after-success") {
    await context.exec("bun", ["test", ...args], {
      cwd,
      env,
      stdio: "inherit",
    });
    return;
  }
  // Pipe through nopo IO: output remains streamed and each invocation has its own capture.
  const result = await context.exec("bun", ["test", ...args], {
    cwd,
    env,
    stdio: "pipe",
    nothrow: true,
  });
  if (!result.exitCode) return;
  const output = `${result.stdout}\n${result.stderr}`.replace(
    /\u001b\[[0-9;]*m/g,
    "",
  );
  const summaries = [...output.matchAll(/^\s*(\d+) fail\s*$/gm)].map((match) =>
    Number(match[1]),
  );
  if (
    [99, 100].includes(result.exitCode) &&
    summaries.length &&
    summaries.every((count) => count === 0)
  ) {
    context.io.stderr.write(
      `[bun] Accepted shutdown exit ${result.exitCode} after a clean test summary.\n`,
    );
    return;
  }
  throw result;
}
