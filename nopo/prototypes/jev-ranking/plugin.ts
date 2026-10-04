import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  HookContext,
  NopoPlugin,
  NopoPluginFactory,
} from "@more-nopo/nopo/plugin";
import { evidence } from "./evidence.ts";
import { score } from "./score.ts";

// Bun 1.3 has no native listing command. This is advisory inventory only.
function bunCandidates(ctx: HookContext): string[] {
  const cwd = ctx.commandContext!.cwd;
  const configFile = path.join(cwd, "bunfig.toml");
  const config = existsSync(configFile)
    ? (
        globalThis as unknown as {
          Bun: { TOML: { parse(text: string): Record<string, unknown> } };
        }
      ).Bun.TOML.parse(readFileSync(configFile, "utf8"))
    : {};
  const test = config.test as { root?: string } | undefined;
  const root = path.resolve(cwd, test?.root ?? ".");
  const files: string[] = [];
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
        files.push(file);
    }
  }
  visit(root);
  return files;
}

async function vitestCandidates(
  plugin: NopoPlugin,
  ctx: HookContext,
  args: Parameters<NonNullable<NopoPlugin["commands"]>[number]["fn"]>[1],
) {
  let output = "";
  const list = plugin.commands!.find((command) => command.name === "list")!;
  await list.fn(
    {
      ...ctx,
      argv: [...(ctx.argv ?? []), "--filesOnly", "--json"],
      exec: (cmd, argv, opts) => {
        const promise = ctx.exec(cmd, argv, {
          ...opts,
          stdio: "pipe",
          silent: true,
        });
        void promise.then(
          (result) => {
            output = result.stdout;
          },
          () => {},
        );
        return promise;
      },
    },
    args,
  );
  const rows: unknown = JSON.parse(output);
  if (!Array.isArray(rows) || rows.some((row) => typeof row?.file !== "string"))
    throw new Error("vitest-invalid-inventory");
  return rows.map((row: { file: string }) =>
    path.resolve(ctx.commandContext!.cwd, row.file),
  );
}

export function rankInside(
  factory: NopoPluginFactory,
  runner: "vitest" | "bun",
): NopoPluginFactory {
  return (config) => {
    const plugin = factory(config);
    return {
      ...plugin,
      commands: plugin.commands?.map((command) => ({
        ...command,
        async fn(ctx, args) {
          const directory = ctx.io.env.NOPO_JEV_REPORT_DIR;
          const eligible =
            ctx.commandContext &&
            command.name === (runner === "vitest" ? "run" : "test");
          if (!directory || !eligible) return command.fn(ctx, args);
          const provider = ctx.io.env.NOPO_JEV_PROVIDER ?? "jev";
          const report: Record<string, unknown> = {
            schemaVersion: 1,
            mode: "observe",
            runner,
            provider,
            target: ctx.commandContext!.target,
            command: ctx.commandContext!.command,
            model: provider === "mock" ? null : "jev-latest",
            discovery:
              runner === "vitest" ? "native-list" : "advisory-bun-patterns",
            scopeLimit:
              runner === "bun"
                ? "Inventory does not apply argv filters, shard or test-name selection."
                : null,
            execution: "unchanged",
            skippedFiles: 0,
            status: "unavailable",
          };
          try {
            const files =
              runner === "vitest"
                ? await vitestCandidates(plugin, ctx, args)
                : bunCandidates(ctx);
            const input = await evidence(ctx, files);
            report.baseSha = input.baseSha;
            report.fingerprint = input.fingerprint;
            report.diffTruncated = input.diffTruncated;
            let scores = new Map<string, number>();
            try {
              scores = await score(
                input,
                provider,
                ctx.io.env.TYPESAFE_API_KEY,
              );
              report.status = "ranked";
            } catch {
              report.reason = "scoring-unavailable";
            }
            report.ranking = input.candidates
              .map(({ id, file, changed }) => ({
                file,
                probability: scores.get(id) ?? null,
                changed,
              }))
              .sort(
                (a, b) =>
                  (b.probability ?? -1) - (a.probability ?? -1) ||
                  a.file.localeCompare(b.file),
              );
            report.unscored = input.candidates.length - scores.size;
          } catch {
            report.reason = "discovery-or-context-unavailable";
          }
          // Reporting failures must not suppress the actual test run.
          try {
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const label = createHash("sha256")
              .update(`${report.target}:${report.command}`)
              .digest("hex")
              .slice(0, 12);
            const file = path.join(
              directory,
              `${runner}-${label}-${randomUUID()}.json`,
            );
            writeFileSync(file, JSON.stringify(report, null, 2) + "\n", {
              mode: 0o600,
            });
            ctx.io.stderr.write(
              `[jev] ${report.status}; full test invocation retained; report: ${file}\n`,
            );
          } catch {
            ctx.io.stderr.write(
              "[jev] report unavailable; full test invocation retained\n",
            );
          }
          await command.fn(ctx, args);
        },
      })),
    };
  };
}
