import { it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { moduleContext } from "../../plugins/test-relevance/src/module-context.ts";
import { relevanceRequest } from "../../plugins/test-relevance/src/index.ts";
import { scenarios } from "./cases.ts";

it("shows the full candidate universe in every scoring batch, with graph paths to the diff", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "nopo-graph-")));
  try {
    writeFileSync(path.join(root, "middle.ts"), "export const value=2;");
    writeFileSync(
      path.join(root, "wrapper.ts"),
      "export {value} from './middle';",
    );
    writeFileSync(
      path.join(root, "test.ts"),
      "import {value} from './wrapper';",
    );
    const modules = moduleContext(root, [path.join(root, "test.ts")]);
    expect(
      modules.modules.find((module) => module.file === "test.ts")?.imports,
    ).toEqual(["wrapper.ts"]);
    expect(
      modules.modules.find((module) => module.file === "wrapper.ts")?.imports,
    ).toEqual(["middle.ts"]);
    expect(
      modules.modules.find((module) => module.file === "middle.ts")?.excerpt,
    ).toContain("value=2");
    const candidates = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      file: `test-${i}.ts`,
      changed: false,
      excerpt: "test source",
    }));
    const input = {
      baseSha: "base",
      mergeBase: "base",
      changed: ["middle.ts"],
      graph: [],
      modules,
      candidates,
      diff: "value=1 → value=2",
      diffTruncated: false,
      untrackedContentIncluded: false,
      fingerprint: "fixture",
    };
    for (const start of [0, 32, 64, 96]) {
      const request = relevanceRequest(input, start);
      expect((request.state as any).candidates).toHaveLength(100);
      expect((request.state as any).modules.modules).toHaveLength(3);
      expect(Object.keys(request.questions)).toHaveLength(
        Math.min(32, 100 - start),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("does not follow symlinks outside the repository and reports unresolved aliases", () => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "nopo-graph-safe-")),
  );
  const outside = realpathSync(
    mkdtempSync(path.join(tmpdir(), "nopo-graph-outside-")),
  );
  try {
    writeFileSync(
      path.join(outside, "secret.ts"),
      "const secret='must not transmit';",
    );
    symlinkSync(path.join(outside, "secret.ts"), path.join(root, "link.ts"));
    writeFileSync(
      path.join(root, "test.ts"),
      "import './link';import thing from '@alias/module';",
    );
    const context = moduleContext(root, [
      path.join(root, "test.ts"),
      path.join(root, "link.ts"),
    ]);
    expect(context.modules).toHaveLength(1);
    expect(context.modules[0]?.unresolved).toEqual(["./link", "@alias/module"]);
    expect(JSON.stringify(context)).not.toContain("must not transmit");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
it("has 100 interleaved tests with ten dependency/behavior cohorts and 50 known mutation failures", () => {
  const scenario = scenarios.find((scenario) => scenario.cohorts)!;
  expect(Object.keys(scenario.tests)).toHaveLength(100);
  expect(scenario.expectedFailures).toHaveLength(50);
  expect(scenario.cohorts).toHaveLength(10);
  expect(
    new Set(scenario.cohorts!.flatMap((cohort) => cohort.files)).size,
  ).toBe(100);
  const firstBatch = Object.keys(scenario.tests).sort().slice(0, 32);
  expect(
    scenario.cohorts!.every((cohort) =>
      cohort.files.some((file) => firstBatch.includes(file)),
    ),
  ).toBe(true);
});
