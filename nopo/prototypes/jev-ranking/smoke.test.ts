import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { score } from "./score.ts";
import type { Evidence } from "./evidence.ts";

const directory = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(directory, "../../../packages/nopo/bin.ts");
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture(runner: "bun" | "vitest") {
  const root = mkdtempSync(path.join(tmpdir(), "nopo-jev-"));
  roots.push(root);
  mkdirSync(path.join(root, "apps/demo"), { recursive: true });
  mkdirSync(path.join(root, "node_modules"));
  symlinkSync(
    path.dirname(
      createRequire(
        path.resolve(directory, "../../plugins/vitest/package.json"),
      ).resolve("vitest/package.json"),
    ),
    path.join(root, "node_modules/vitest"),
    "junction",
  );
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    path.join(root, "nopo.yml"),
    JSON.stringify({
      name: "fixture",
      services: { dirs: ["apps"] },
      plugins: [{ name: runner, path: path.join(directory, `${runner}.ts`) }],
    }),
  );
  writeFileSync(
    path.join(root, "apps/demo/nopo.yml"),
    JSON.stringify({
      name: "demo",
      commands: {
        test: {
          plugin: runner,
          ...(runner === "bun"
            ? { command: "test" }
            : { args: ["--maxWorkers=1"] }),
        },
      },
    }),
  );
  for (const name of ["one", "two", "three"])
    writeFileSync(
      path.join(root, `apps/demo/${name}.test.ts`),
      `
      import {test,expect} from '${runner === "bun" ? "bun:test" : "vitest"}';
      import {appendFileSync} from 'node:fs';
      test('${name}',()=>{ appendFileSync('ran.txt','${name}\\n'); expect(1).toBe(1); });
    `,
    );
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  };
  git("init", "-q");
  git("add", "apps", "nopo.yml", "package.json");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
  );
  return root;
}
function run(root: string, provider = "mock") {
  const r = spawnSync("bun", [cli, "test", "demo"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      NOPO_NO_QUEUE: "1",
      DOCKER_PORT: "80",
      ROOT_DIR: root,
      NOPO_JEV_PROVIDER: provider,
      NOPO_JEV_REPORT_DIR: path.join(root, "reports"),
      TYPESAFE_API_KEY: "",
    },
  });
  return { ...r, output: r.stdout + r.stderr };
}
describe("ranking inside runner plugins", () => {
  for (const runner of ["vitest", "bun"] as const) {
    it(`${runner}: emits scores but executes every file`, () => {
      const root = fixture(runner);
      const result = run(root);
      expect(result.status, result.output).toBe(0);
      expect(
        readFileSync(path.join(root, "apps/demo/ran.txt"), "utf8")
          .trim()
          .split("\n")
          .sort(),
      ).toEqual(["one", "three", "two"]);
      const report = JSON.parse(
        readFileSync(
          path.join(
            root,
            "reports",
            readdirSync(path.join(root, "reports"))[0]!,
          ),
          "utf8",
        ),
      );
      expect(report).toMatchObject({
        mode: "observe",
        provider: "mock",
        status: "ranked",
        skippedFiles: 0,
      });
      expect(report.ranking).toHaveLength(3);
      expect(
        report.ranking.every(
          (row: { probability: number }) =>
            row.probability >= 0 && row.probability <= 1,
        ),
      ).toBe(true);
    });
    it(`${runner}: missing credentials still runs the full suite and preserves failure`, () => {
      const root = fixture(runner);
      const file = path.join(root, "apps/demo/three.test.ts");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          "expect(1).toBe(1)",
          "expect(1).toBe(2)",
        ),
      );
      const result = run(root, "jev");
      expect(result.status).toBe(1);
      expect(
        readFileSync(path.join(root, "apps/demo/ran.txt"), "utf8")
          .trim()
          .split("\n"),
      ).toHaveLength(3);
      const report = JSON.parse(
        readFileSync(
          path.join(
            root,
            "reports",
            readdirSync(path.join(root, "reports"))[0]!,
          ),
          "utf8",
        ),
      );
      expect(report.status).toBe("unavailable");
      expect(
        report.ranking.every(
          (row: { probability: null }) => row.probability === null,
        ),
      ).toBe(true);
    });
  }
});

const input: Evidence = {
  baseSha: "a",
  mergeBase: "a",
  changed: ["source.ts"],
  graph: [],
  candidates: [
    { id: "abc", file: "a.test.ts", changed: false, excerpt: "test" },
  ],
  diff: "diff",
  diffTruncated: false,
  fingerprint: "a",
  untrackedContentIncluded: false,
};
it("uses Jev's typed question contract and rejects missing, unknown, and invalid scores", async () => {
  const responses = [
    { answers: {} },
    { answers: { abc: { type: "noul", noul: 2 } } },
    {
      answers: {
        abc: { type: "noul", noul: 0.2 },
        invented: { type: "noul", noul: 1 },
      },
    },
  ];
  for (const body of responses)
    await expect(
      score(input, "jev", "fixture", async () => Response.json(body)),
    ).rejects.toThrow();
  const result = await score(input, "jev", "fixture", async (url, init) => {
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    const request = JSON.parse(String(init?.body));
    expect(request.questions.abc.type).toBe("noul");
    expect(request.questions.abc.instructions.candidate.file).toBe("a.test.ts");
    return Response.json({ answers: { abc: { type: "noul", noul: 0.25 } } });
  });
  expect(result.get("abc")).toBe(0.25);
});
