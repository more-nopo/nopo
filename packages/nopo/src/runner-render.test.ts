/** Locks in the wiring contract that flips Runner.run()'s default execution output to the
 * M7 streaming renderer: Non-trivial plans (>1 node) get a start-of-run ASCII DAG, stage
 * headers, and the M8/M9 footer (post-mortem + colored DAG). Trivial plans (≤1 node) skip
 * the renderer entirely so scripts like `nopo list --json` and `nopo secret get` keep
 */

import { describe, expect, it } from "vitest";

import { runCli } from "./test-utils/run-cli.ts";

describe("Runner.run() — M10 streaming renderer wiring", () => {
  describe("non-trivial plans (>1 node)", () => {
    it("emits the start-of-run DAG, stage headers, and footer for `nopo build`", async () => {
      // BuildScript's plan is pre/exec/post (3+ nodes for a 1-service
      // fixture), so the streaming renderer + start-of-run DAG fire.
      const io = await runCli({
        fixture: "minimal",
        argv: ["build"],
      });

      expect(io.exitCode).toBe(null);
      const stdout = io.stdout.text();

      // Start-of-run DAG: M5's renderPlanDag produces stage markers as its first row. Asserting
      // on `── stage 0 ──` keeps the test resilient to layout-character drift.
      expect(stdout).toMatch(/── stage 0 ──/);

      // Stage headers: emitted by the streaming renderer at first
      // node-start per stage.
      expect(stdout).toContain("━━━ stage 0 ━");

      // Footer: M8's plan-finish summary line.
      expect(stdout).toMatch(
        /Plan finished — \d+ ok, 0 failed, 0 skipped, total .+, max-parallel \d+/,
      );
    });

    it("places the start-of-run DAG before any stage header", async () => {
      // Ordering check: the pre-execution DAG render runs BEFORE executePlan, so its first
      // character must appear earlier than the first stage header the renderer emits
      const io = await runCli({
        fixture: "deps-chain",
        argv: ["build"],
      });

      const stdout = io.stdout.text();
      const dagIdx = stdout.indexOf("── stage 0 ──");
      const headerIdx = stdout.indexOf("━━━ stage 0 ━");
      expect(dagIdx).toBeGreaterThanOrEqual(0);
      expect(headerIdx).toBeGreaterThanOrEqual(0);
      expect(dagIdx).toBeLessThan(headerIdx);
    });
  });

  describe("trivial plans (≤1 node)", () => {
    it("does NOT emit the renderer's stage header or footer for `nopo list --json`", async () => {
      // ListScript's plan is a single `list:run` builtin node (M5 fixed the plan shape). The
      // renderer must NOT fire, otherwise its `━━━ stage 0 ━` prefix would corrupt the JSON
      const io = await runCli({
        fixture: "minimal",
        argv: ["list", "--json"],
      });

      expect(io.exitCode).toBe(null);
      const stdout = io.stdout.text();

      expect(stdout).not.toContain("━━━ stage");
      expect(stdout).not.toContain("Plan finished");
      expect(stdout).not.toMatch(/── stage 0 ──/);

      // Sanity: the JSON document still flows through unchanged.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- shape-narrow JSON.parse output for the assertion below
      const parsed = JSON.parse(stdout) as { config: { name: string } };
      expect(parsed.config.name).toBe("contract-minimal");
    });

    it("does NOT emit any renderer output for `nopo list --csv`", async () => {
      const io = await runCli({
        fixture: "minimal",
        argv: ["list", "--csv"],
      });

      const stdout = io.stdout.text();
      // CSV path also writes through ctx.io.stdout — the renderer would prefix every byte if
      // wired, breaking the `^[\w,-]*$` contract callers parse.
      expect(stdout.trim()).toMatch(/^[\w,-]+$/);
      expect(stdout).not.toContain("━━━");
      expect(stdout).not.toContain("Plan finished");
    });
  });

  describe("--print mode is unchanged", () => {
    it("`build --print` renders the DAG and exits without invoking the renderer", async () => {
      // M5 contract: bare --print short-circuits Runner.run() before executePlan. M10 must not
      // change that — no `Plan finished` footer, no stage headers from the streaming renderer.
      const io = await runCli({
        fixture: "deps-chain",
        argv: ["build", "--print"],
      });

      const stdout = io.stdout.text();
      // M5's DAG is rendered as the print payload.
      expect(stdout).toMatch(/── stage 0 ──/);
      // ...but no execution-side artifacts.
      expect(stdout).not.toContain("━━━ stage");
      expect(stdout).not.toContain("Plan finished");
    });

    it("`build --print --json` keeps emitting the JSON dry-run document", async () => {
      // Sibling of the bare-print case: --json forces M3's JSON shape.
      const io = await runCli({
        fixture: "minimal",
        argv: ["build", "--print", "--json"],
      });

      const stdout = io.stdout.text();
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- shape-narrow JSON.parse output for the assertion below
      const parsed = JSON.parse(stdout) as { command: string };
      expect(parsed.command).toBe("build");
      expect(stdout).not.toContain("━━━ stage");
      expect(stdout).not.toContain("Plan finished");
    });
  });
});
