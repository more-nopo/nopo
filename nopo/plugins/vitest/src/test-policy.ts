import { runVitestProcess } from "./session.ts";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HookContext } from "@more-nopo/nopo/plugin";
import { z } from "zod";
import {
  observeTestRun,
  relevanceSchema,
  relevanceArgs,
  vitestSelectionArgs,
} from "@more-nopo/nopo-test-relevance";
import { vitestCandidates } from "./discovery.ts";

export const policySchema = z
  .object({
    relevance: relevanceSchema.optional(),
    quarantine: z.string().min(1).optional(),
    sharding: z.enum(["native", "clamp"]).optional(),
  })
  .strict();
export type TestPolicy = z.infer<typeof policySchema>;

export function shardSelection(args: string[]) {
  const at = args.findIndex(
    (arg) => arg === "--shard" || arg.startsWith("--shard="),
  );
  if (at < 0) return { args: [...args] };
  const separate = args[at] === "--shard";
  const raw = separate ? args[at + 1] : args[at]!.slice(8);
  const match = /^(\d+)\/(\d+)$/.exec(raw ?? "");
  if (!match || Number(match[1]) < 1 || Number(match[2]) < Number(match[1]))
    throw new Error("[vitest] --shard must be i/N with 1 <= i <= N.");
  const rest = [...args];
  rest.splice(at, separate ? 2 : 1);
  if (rest.some((arg) => arg === "--shard" || arg.startsWith("--shard=")))
    throw new Error("[vitest] Only one shard may be selected.");
  return {
    args: rest,
    index: Number(match[1]),
    total: Number(match[2]),
    at,
    span: separate ? 2 : 1,
  };
}

export function clampShard(args: string[], count: number): string[] | null {
  const shard = shardSelection(args);
  if (!shard.total || count === 0 || count >= shard.total) return args;
  if (shard.index! > count) return null;
  const next = [...args];
  next.splice(shard.at!, shard.span!, `--shard=${shard.index}/${count}`);
  return next;
}

function nativeConfig(args: string[], root: string, fallback?: string) {
  const rest = [...args];
  let config = fallback;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--config" || arg === "-c" || arg.startsWith("--config=")) {
      config = arg.startsWith("--config=") ? arg.slice(9) : rest[i + 1];
      if (!config) throw new Error("[vitest] --config requires a file.");
      rest.splice(i, arg.startsWith("--config=") ? 1 : 2);
      i--;
    }
  }
  if (!config)
    config = ["ts", "mts", "cts", "js", "mjs", "cjs"]
      .map((ext) => path.join(root, `vite.config.${ext}`))
      .find(existsSync);
  return {
    args: rest,
    config: config ? path.resolve(root, config) : undefined,
  };
}

function quarantineFiles(root: string, manifest: string): string[] {
  const parsed = z
    .object({ files: z.record(z.string()) })
    .passthrough()
    .parse(JSON.parse(readFileSync(path.resolve(root, manifest), "utf8")));
  const canonicalRoot = realpathSync(root);
  return Object.keys(parsed.files).map((file) => {
    const absolute = realpathSync(path.resolve(root, file));
    const relative = path.relative(canonicalRoot, absolute);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(
        `[vitest] Quarantined file is outside the target: ${file}`,
      );
    return path.resolve(root, file);
  });
}

/** A native config overlay: the consumer's Vite loader evaluates its config once. */
function policyConfig(
  directory: string,
  root: string,
  native: string | undefined,
  files: string[],
  phase: "gate" | "audit",
) {
  const consumer = createRequire(path.join(root, "package.json"));
  const require = createRequire(
    realpathSync(consumer.resolve("vitest/package.json")),
  );
  const vite = path.join(
    path.dirname(require.resolve("vite/package.json")),
    "dist/node/index.js",
  );
  const defaults = require.resolve("vitest/config");
  const aliases = [
    ...new Set(files.flatMap((file) => [file, realpathSync(file)])),
  ];
  const file = path.join(directory, `${phase}.mjs`);
  writeFileSync(
    file,
    `
import { loadConfigFromFile, mergeConfig } from ${JSON.stringify(pathToFileURL(vite).href)};
import { configDefaults } from ${JSON.stringify(pathToFileURL(defaults).href)};
export default async env => {
  const loaded = ${native ? `await loadConfigFromFile(env, ${JSON.stringify(native)}, ${JSON.stringify(root)})` : "undefined"};
  if (${JSON.stringify(Boolean(native))} && !loaded) throw new Error('Cannot load native Vitest config');
  const config = loaded?.config ?? {};
  if (config.test?.projects || config.test?.workspace) throw new Error('Quarantine requires a single native project config');
  const files = ${JSON.stringify(aliases)};
  const test = ${JSON.stringify(phase)} === 'gate'
    ? { exclude: [...(config.test?.exclude ?? configDefaults.exclude), ...files] }
    : { include: files };
  const merged = mergeConfig(config, { root: config.root ?? ${JSON.stringify(root)} });
  merged.test = { ...merged.test, ...test };
  return merged;
};\n`,
    { mode: 0o600 },
  );
  return file;
}

export async function runWithPolicy(
  context: HookContext,
  binary: string,
  root: string,
  env: Record<string, string>,
  argv: string[],
  config: string | undefined,
  policy: TestPolicy,
) {
  const parsed = relevanceArgs(argv, policy.relevance);
  argv = parsed.args;
  policy = { ...policy, relevance: parsed.relevance };
  const temporary = mkdtempSync(path.join(tmpdir(), "nopo-vitest-policy-"));
  try {
    const native = nativeConfig(argv, root, config);
    const files = policy.quarantine
      ? quarantineFiles(root, policy.quarantine)
      : [];
    const gateConfig = files.length
      ? policyConfig(temporary, root, native.config, files, "gate")
      : native.config;
    const execute = (
      mode: "run" | "list",
      args: string[],
      configFile = gateConfig,
      capture = false,
      nothrow = false,
      mandatory = false,
    ) => {
      const argv = [
        binary,
        mode,
        ...(configFile ? ["--config", configFile] : []),
        ...args,
      ];
      const options = {
        cwd: root,
        env,
        stdio: capture ? ("pipe" as const) : ("inherit" as const),
        silent: capture,
        nothrow,
      };
      if (mode === "list") return runVitestProcess(context, argv, options);
      return observeTestRun(
        context,
        {
          runner: "vitest",
          cwd: root,
          relevance: policy.relevance,
          mandatory,
        },
        () => vitestCandidates(context, "node", argv, { cwd: root, env }),
        (selection) =>
          runVitestProcess(
            context,
            vitestSelectionArgs(argv, selection),
            options,
          ),
      );
    };
    const list = async (args: string[], configFile = gateConfig) => {
      const report = path.join(temporary, "inventory.json");
      rmSync(report, { force: true });
      await execute(
        "list",
        [...args, "--filesOnly", `--json=${report}`],
        configFile,
        true,
      );
      const rows = z
        .array(z.object({ file: z.string() }))
        .parse(JSON.parse(readFileSync(report, "utf8")));
      return [
        ...new Set(
          rows.map((row) => realpathSync(path.resolve(root, row.file))),
        ),
      ];
    };
    const shard = shardSelection(native.args);
    let gateArgs: string[] | null = native.args;
    if (policy.sharding === "clamp" && shard.total)
      gateArgs = clampShard(native.args, (await list(shard.args)).length);
    if (gateArgs) await execute("run", gateArgs);
    else
      context.io.stderr.write(
        `[vitest] Shard ${shard.index}/${shard.total} has no test files.\n`,
      );
    if (!files.length) return;
    if (shard.index && shard.index !== 1) {
      context.io.stderr.write(
        "[vitest] Quarantine audit runs on shard 1 only.\n",
      );
      return;
    }
    const auditConfig = policyConfig(
      temporary,
      root,
      native.config,
      files,
      "audit",
    );
    const selected = await list(shard.args, auditConfig);
    if (!selected.length) {
      context.io.stderr.write(
        "[vitest] No quarantined specs match this selection.\n",
      );
      return;
    }
    const output = path.join(temporary, "audit.json");
    const result = await execute(
      "run",
      [...shard.args, "--reporter=json", `--outputFile=${output}`],
      auditConfig,
      false,
      true,
      true,
    );
    const report = z
      .object({
        testResults: z.array(
          z.object({ name: z.string(), status: z.string() }),
        ),
      })
      .parse(JSON.parse(readFileSync(output, "utf8")));
    const statuses = new Map(
      report.testResults.map((row) => [
        realpathSync(path.resolve(root, row.name)),
        row.status,
      ]),
    );
    const unseen = selected.filter((file) => !statuses.has(file));
    const graduated = selected.filter(
      (file) => statuses.get(file) === "passed",
    );
    const unexpected = selected.filter(
      (file) => !["passed", "failed"].includes(statuses.get(file) ?? ""),
    );
    if (unseen.length || unexpected.length)
      throw new Error(
        "[vitest] Quarantine audit did not execute every selected spec.",
      );
    if (graduated.length)
      throw new Error(
        `[vitest] Quarantined specs now PASS; remove them from the manifest:\n${graduated.join("\n")}`,
      );
    if (result.exitCode !== 1)
      throw new Error(
        `[vitest] Unexpected quarantine audit exit: ${result.exitCode}`,
      );
    context.io.stderr.write(
      `[vitest] All ${selected.length} selected quarantined specs still fail as expected.\n`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
