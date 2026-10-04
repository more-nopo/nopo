import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HookContext } from "@more-nopo/nopo/plugin";
import type { Inventory } from "./discovery.ts";
import { evidence } from "./evidence.ts";
import { score } from "./score.ts";

/** Shared internal boundary: runner supplies inventory, engine supplies advice.
 * No command execution or native argument parsing belongs in this component. */
export async function observe(
  ctx: HookContext,
  discover: () => Promise<Inventory>,
) {
  const started = performance.now();
  const provider = ctx.io.env.NOPO_JEV_PROVIDER ?? "mock";
  const report: Record<string, unknown> = {
    schemaVersion: 2,
    mode: "observe",
    provider,
    model: provider === "jev" ? "jev-latest" : null,
    execution: "unchanged",
    skippedFiles: 0,
    status: "unavailable",
  };
  const timings: Record<string, number> = {};
  let phase = "discovery";
  let phaseStart = started;
  try {
    const inventory = await discover();
    timings.discoveryMs = performance.now() - phaseStart;
    report.discovery = inventory.authority;
    report.scopeLimit = inventory.scopeLimit;
    phase = "context";
    phaseStart = performance.now();
    const input = await evidence(ctx, inventory.files);
    timings.contextMs = performance.now() - phaseStart;
    report.baseSha = input.baseSha;
    report.mergeBase = input.mergeBase;
    report.fingerprint = input.fingerprint;
    report.diffTruncated = input.diffTruncated;
    report.candidateCount = input.candidates.length;
    let scores = new Map<string, number>();
    phase = "scoring";
    phaseStart = performance.now();
    try {
      scores = await score(input, provider, ctx.io.env.TYPESAFE_API_KEY);
      report.status = "ranked";
    } catch {
      report.reason = "scoring-unavailable";
    }
    timings.scoringMs = performance.now() - phaseStart;
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
    timings[`${phase}Ms`] = performance.now() - phaseStart;
    report.reason = `${phase}-unavailable`;
  }
  timings.observationMs = performance.now() - started;
  return { ...report, timings };
}

export function writeReport(
  ctx: HookContext,
  directory: string,
  report: Record<string, unknown>,
) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const label = createHash("sha256")
      .update(`${report.target}:${report.command}`)
      .digest("hex")
      .slice(0, 12);
    const file = path.join(
      directory,
      `${report.runner}-${label}-${randomUUID()}.json`,
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
}
