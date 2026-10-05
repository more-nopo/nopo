import { z } from "zod";
export const relevanceSchema = z.union([
  z.enum(["off", "observe", "dry", "select"]),
  z
    .object({
      mode: z.enum(["dry", "select"]).default("dry"),
      threshold: z.number().finite().min(0).max(1).default(0.65),
    })
    .strict(),
]);
export type RelevanceOptions = z.infer<typeof relevanceSchema>;
export interface TestSelection {
  included: string[];
  excluded: string[];
}
export function relevanceOptions(value?: RelevanceOptions) {
  return typeof value === "object"
    ? value
    : { mode: value ?? "off", threshold: 0.65 };
}
export function relevanceArgs(argv: string[], configured?: RelevanceOptions) {
  const args: string[] = [];
  let mode: string | undefined, threshold: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!,
      key = arg.split("=")[0];
    if (key !== "--relevance" && key !== "--relevance-threshold") {
      args.push(arg);
      continue;
    }
    const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
    if (!raw || raw.startsWith("--"))
      throw new Error(`${key} requires a value`);
    if (key === "--relevance") {
      if (mode !== undefined) throw new Error("Duplicate --relevance");
      mode = raw;
    } else {
      if (threshold !== undefined)
        throw new Error("Duplicate --relevance-threshold");
      threshold = Number(raw);
    }
  }
  const base = relevanceOptions(configured);
  if (threshold !== undefined && (mode ?? base.mode) === "off")
    throw new Error("--relevance-threshold requires an enabled relevance mode");
  const relevance =
    mode === undefined && threshold === undefined
      ? configured
      : relevanceSchema.parse(
          (mode ?? base.mode) === "off"
            ? "off"
            : {
                mode:
                  (mode ?? base.mode) === "observe"
                    ? "dry"
                    : (mode ?? base.mode),
                threshold: threshold ?? base.threshold,
              },
        );
  return { args, relevance };
}
/** Native Vitest exclude patterns, escaped so metacharacters cannot remove other files. */
export function vitestSelectionArgs(args: string[], selection?: TestSelection) {
  return selection
    ? [
        ...args,
        "--passWithNoTests",
        ...selection.excluded.flatMap((file) => [
          "--exclude",
          file.replace(/\\/g, "/").replace(/([*?{}()[\]!])/g, "\\$1"),
        ]),
      ]
    : args;
}
