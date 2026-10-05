import path from "node:path";

export interface EvaluationResult {
  scenario: string;
  passed: boolean;
  error?: string;
  result?: { status: string; answers?: unknown; model?: string };
  changedFiles?: string[];
  ranking?: { file: string; probability: number | null }[];
  knownFailures?: string[];
  observedFailures?: string[];
  relevant?: string[];
  unrelated?: string[];
  timings?: Record<string, number>;
  elapsedMs?: number;
  decisions?: { model: string }[];
}
const descriptions: Record<string, string> = {
  live: "New API calls; model quality measured against synthetic mutations.",
  replay: "Recorded live Jev answers; no API calls or new quality measurement.",
  mock: "Hand-authored answers; integration check only, not model quality evidence.",
};
const cell = (value: string) =>
  value
    .replace(/[\r\n]/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`");
export function evaluationHeader(mode: string) {
  return `Decision evaluation: ${mode}\n${descriptions[mode]}\nDiff + dependency graph + native test inventory → relevance scores → unchanged native full suite.\nReplay/mock timing is local lookup overhead, not API latency. Scores are not calibrated failure probabilities. Quality gates: relevant >= 0.65, independent <= 0.40, relevant outranks independent.\n`;
}
export function scenarioReport(result: EvaluationResult): string {
  const rows = result.ranking ?? [];
  const models = [
    ...new Set(result.decisions?.map((item) => item.model) ?? []),
  ];
  const lines = [
    `### ${cell(result.scenario)} — ${result.passed ? "PASS" : "FAIL"}`,
  ];
  if (result.result)
    lines.push(
      `Typed primitives (${cell(result.result.model ?? "unavailable")}): ${JSON.stringify(result.result.answers ?? { status: result.result.status })}`,
    );
  if (result.changedFiles?.length)
    lines.push(`Changed files: ${result.changedFiles.map(cell).join(", ")}.`);
  if (models.length)
    lines.push(
      `Model: ${models.map(cell).join(", ")}. Scoring: ${Math.round(result.timings?.scoringMs ?? 0)} ms. Native execution: ${Math.round(result.timings?.executionMs ?? 0)} ms.`,
    );
  if (rows.length) {
    lines.push(
      "Baseline: all tests passed before mutation. Full suite retained; skipped files: 0.",
      "",
      "| Test | Relevance score | Expected relationship | Mutation result |",
      "| --- | ---: | --- | --- |",
    );
    for (const row of rows) {
      const name = path.basename(row.file);
      lines.push(
        `| ${cell(name)} | ${row.probability === null ? "unscored" : row.probability.toFixed(3)} | ${result.relevant?.includes(name) ? "affected" : result.unrelated?.includes(name) ? "independent" : "unspecified"} | ${result.observedFailures?.includes(name) ? "FAIL" : "PASS"} |`,
      );
    }
    const hypothetical = rows.filter(
      (row) => row.probability !== null && row.probability >= 0.65,
    );
    const missed = (result.observedFailures ?? []).filter(
      (name) => !hypothetical.some((row) => path.basename(row.file) === name),
    );
    lines.push(
      "",
      `Illustration only: a score >= 0.65 would select ${hypothetical.length}/${rows.length} files and miss ${missed.length}/${result.observedFailures?.length ?? 0} observed mutation failures. No filtering or speedup measured.`,
    );
  }
  if (result.error) lines.push(`Error: ${cell(result.error)}`);
  return lines.join("\n") + "\n";
}
export function evaluationSummary(mode: string, results: EvaluationResult[]) {
  return `# Test relevance evaluation\n\n${evaluationHeader(mode)}\n${results.filter((result) => result.passed).length}/${results.length} scenarios passed.\n\n${results.map(scenarioReport).join("\n")}`;
}
