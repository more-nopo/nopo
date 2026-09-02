import { ScriptArgs } from "./script-args.ts";

/** Base arguments available to all scripts Scripts can extend these with their own specific
 * arguments Command-specific args (like context for CommandScript) should be defined in
 * the individual script files.
 */
export const baseArgs = new ScriptArgs({
  filter: {
    type: "string[]",
    description: 'Filter targets by expression (e.g., "buildable", "changed")',
    alias: ["f"],
    default: undefined,
  },

  since: {
    type: "string",
    description:
      'Git ref or JSON map of per-service refs (e.g., \'{"backend":"abc","api":"def"}\')',
    alias: ["s"],
    default: undefined,
  },

  tags: {
    type: "string",
    description: "Filter targets by tags (comma-separated, match any)",
    default: undefined,
  },

  changed: {
    type: "boolean",
    description: "Only target services with changed files",
    default: false,
  },

  "with-dependants": {
    type: "boolean",
    description: "Include transitive dependants of targeted services",
    default: false,
  },

  print: {
    type: "boolean",
    description:
      "Print the execution plan as an ASCII DAG instead of running. " +
      "By default shows the post-compaction plan (the one that actually " +
      "runs). Pass `--print=raw` to inspect the pre-compaction plan. " +
      "Add --json to emit the legacy JSON resolution document.",
    default: false,
  },

  json: {
    type: "boolean",
    description:
      "When combined with --print, emit the JSON resolution document " +
      "instead of the rendered ASCII DAG. Used by CI workflows that " +
      "parse the resolved targets/dependencies.",
    default: false,
  },

  runtime: {
    type: "string",
    description:
      'Runtime name from root `runtimes:` map (e.g., "prod"). Governs `up`, `down`, `status` dispatch. Defaults to `default`.',
    default: undefined,
  },

  "failed-tail": {
    type: "number",
    description:
      "Number of trailing output lines retained per node for the " +
      "failure post-mortem footer. Defaults to 30. Pass 0 to suppress " +
      "the per-node tail (the summary line still prints).",
    default: 30,
  },
});
