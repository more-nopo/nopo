import { expect, it } from "vitest";
import {
  evaluationHeader,
  evaluationSummary,
  scenarioReport,
} from "./report.ts";

it("identifies replay and mock as distinct from a new quality measurement", () => {
  expect(evaluationHeader("replay")).toContain(
    "no API calls or new quality measurement",
  );
  expect(evaluationHeader("mock")).toContain("not model quality evidence");
  expect(evaluationHeader("live")).toContain("New API calls");
});
it("makes a low-scored mutation failure visible even when the quality gate fails", () => {
  const result = {
    scenario: "vitest-regression",
    passed: false,
    error: "failed recall threshold 0.65",
    relevant: ["affected.test.ts"],
    unrelated: ["decoy.test.ts"],
    observedFailures: ["affected.test.ts"],
    ranking: [
      { file: "/fixture/affected.test.ts", probability: 0.2 },
      { file: "/fixture/decoy.test.ts", probability: 0.9 },
    ],
  };
  const report = scenarioReport(result);
  expect(report).toContain("| affected.test.ts | 0.200 | affected | FAIL |");
  expect(report).toContain("| decoy.test.ts | 0.900 | independent | PASS |");
  expect(report).toContain("miss 1/1 observed mutation failures");
  expect(report).toContain("skipped files: 0");
  expect(evaluationSummary("mock", [result])).toContain("0/1 scenarios passed");
});
