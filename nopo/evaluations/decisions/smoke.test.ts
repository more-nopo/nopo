import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createConfig,
  Runner,
  Logger,
} from "../../../packages/nopo/src/lib.ts";
import { realIO } from "../../../packages/nopo/src/io.ts";
import { decisionRequestHash } from "../../../packages/nopo/src/decisions/index.ts";
import { evidence } from "../../plugins/test-relevance/src/evidence.ts";
import { relevanceRequest } from "../../plugins/test-relevance/src/index.ts";
import type { HookContext } from "../../../packages/nopo/src/plugin.ts";

const directory = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(directory, "../../../packages/nopo/bin.ts");
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture(runner: "bun" | "vitest") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "nopo-jev-")));
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
  writeFileSync(
    path.join(root, ".gitignore"),
    ".env\n.fixture-responses.json\nreports/\nnode_modules/\napps/demo/ran.txt\n",
  );
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    path.join(root, "nopo.yml"),
    JSON.stringify({
      name: "fixture",
      services: { dirs: ["apps"] },
      plugins: [
        {
          name: runner,
          path: path.resolve(directory, `../../plugins/${runner}/src/index.ts`),
        },
      ],
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
async function run(
  root: string,
  provider = "mock",
  argv = ["test", "demo"],
  enabled = true,
) {
  configure(root, (config) => {
    const name = config.commands.test.plugin;
    config.plugins ??= {};
    config.plugins[name] ??= {};
    config.plugins[name].test ??= {};
    config.plugins[name].test.relevance = enabled ? "observe" : "off";
  });
  const projectFile = path.join(root, "nopo.yml");
  const project = JSON.parse(readFileSync(projectFile, "utf8"));
  project.decisions = {
    baseUrl: "https://example.invalid",
    model: "fixture",
    ...(provider === "mock"
      ? { mockResponses: path.join(root, ".fixture-responses.json") }
      : {}),
  };
  writeFileSync(projectFile, JSON.stringify(project));
  if (provider === "mock") {
    const config = createConfig({
      rootDir: root,
      processEnv: {},
      silent: true,
    });
    const runner = new Runner(
      config,
      { env: {}, extraEnv: {} } as Runner["environment"],
      [],
      new Logger(config),
      realIO,
    );
    const responses: Record<string, unknown> = {};
    // Cover every native subset (profiles, argv filters, gate and audit) with exact replay identities.
    for (let mask = 1; mask < 8; mask++) {
      const files = ["one", "two", "three"]
        .filter((_, i) => mask & (1 << i))
        .map((name) => path.join(root, `apps/demo/${name}.test.ts`));
      const input = await evidence(
        { runner, io: realIO } as HookContext,
        files,
      );
      responses[decisionRequestHash("fixture", relevanceRequest(input))] = {
        model: "fixture",
        answers: Object.fromEntries(
          input.candidates.map((candidate) => [
            candidate.id,
            { type: "noul", noul: 0.5 },
          ]),
        ),
      };
    }
    writeFileSync(
      path.join(root, ".fixture-responses.json"),
      JSON.stringify({ schemaVersion: 1, responses }),
    );
  }
  const r = spawnSync("bun", [cli, ...argv], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      NOPO_NO_QUEUE: "1",
      DOCKER_PORT: "80",
      ROOT_DIR: root,

      NOPO_RELEVANCE_REPORT_DIR: enabled ? path.join(root, "reports") : "",
      OPENROUTER_API_KEY: "",
    },
  });
  return { ...r, output: r.stdout + r.stderr };
}
describe("ranking inside runner plugins", async () => {
  for (const runner of ["vitest", "bun"] as const) {
    it(`${runner}: emits scores but executes every file`, async () => {
      const root = fixture(runner);
      const result = await run(root);
      expect(result.status, result.output).toBe(0);
      expect(result.output).toMatch(/\[relevance\] 0\.\d{3} .*test/);
      expect(result.output).toContain("observe mode skips 0 files");
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
      expect(report, JSON.stringify(report)).toMatchObject({
        mode: "observe",

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
    it(`${runner}: missing credentials still runs the full suite and preserves failure`, async () => {
      const root = fixture(runner);
      const file = path.join(root, "apps/demo/three.test.ts");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          "expect(1).toBe(1)",
          "expect(1).toBe(2)",
        ),
      );
      const result = await run(root, "jev");
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

function reports(root: string) {
  const result = readdirSync(path.join(root, "reports")).map((file) =>
    JSON.parse(readFileSync(path.join(root, "reports", file), "utf8")),
  );
  for (const report of result)
    if (report.reason !== "discovery-unavailable") {
      expect(report.status, JSON.stringify(report)).toBe("ranked");
      expect(report.unscored).toBe(0);
    }
  return result;
}
function configure(root: string, update: (config: any) => void) {
  const file = path.join(root, "apps/demo/nopo.yml");
  const config = JSON.parse(readFileSync(file, "utf8"));
  update(config);
  writeFileSync(file, JSON.stringify(config));
}
it("Bun ranks resolved profile files and respects explicit replacement", async () => {
  const root = fixture("bun");
  configure(root, (config) => {
    config.plugins = {
      bun: {
        test: {
          profiles: {
            unit: { args: ["--timeout=3000"], files: ["./one.test.ts"] },
          },
        },
      },
    };
    config.commands.test.args = ["--profile=unit"];
  });
  let result = await run(root);
  expect(result.status, result.output).toBe(0);
  expect(reports(root)[0].ranking.map((row: any) => row.file)).toEqual([
    "apps/demo/one.test.ts",
  ]);
  expect(
    readFileSync(path.join(root, "apps/demo/ran.txt"), "utf8").trim(),
  ).toBe("one");
  rmSync(path.join(root, "reports"), { recursive: true });
  configure(root, (config) => {
    config.commands.test.args.push("--files", "two.test.ts");
  });
  result = await run(root);
  expect(result.status, result.output).toBe(0);
  expect(reports(root)[0].ranking.map((row: any) => row.file)).toEqual([
    "apps/demo/two.test.ts",
  ]);
});
it("Vitest observes gate and mandatory quarantine audit separately after shard clamping", async () => {
  const root = fixture("vitest");
  const file = path.join(root, "apps/demo/three.test.ts");
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      "expect(1).toBe(1)",
      "expect(1).toBe(2)",
    ),
  );
  writeFileSync(
    path.join(root, "apps/demo/quarantine.json"),
    JSON.stringify({ files: { "three.test.ts": "fixture failure" } }),
  );
  configure(root, (config) => {
    config.plugins = {
      vitest: { test: { quarantine: "quarantine.json", sharding: "clamp" } },
    };
    config.commands.test.args.push("--shard=1/8");
  });
  const baseline = await run(root, "mock", ["test", "demo"], false);
  expect(baseline.status, baseline.output).toBe(0);
  const before = readFileSync(path.join(root, "apps/demo/ran.txt"), "utf8");
  rmSync(path.join(root, "apps/demo/ran.txt"));
  const result = await run(root);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("still fail as expected");
  const observed = reports(root);
  expect(observed).toHaveLength(2);
  const audit = observed.find((report) => report.exitCode === 1);
  const gate = observed.find((report) => report.exitCode === 0);
  expect(audit.ranking.map((row: any) => row.file)).toEqual([
    "apps/demo/three.test.ts",
  ]);
  expect(gate.ranking).toHaveLength(2);
  expect(
    readFileSync(path.join(root, "apps/demo/ran.txt"), "utf8")
      .trim()
      .split("\n"),
  ).toEqual(before.trim().split("\n"));
  expect(gate.ranking[0].file).not.toBe("apps/demo/three.test.ts");
  expect(
    observed.every(
      (report) => report.skippedFiles === 0 && report.timings.executionMs > 0,
    ),
  ).toBe(true);
});
for (const runner of ["bun", "vitest"] as const) {
  it(`${runner}: direct plugin invocation ranks and print does not execute`, async () => {
    const root = fixture(runner);
    const command = runner === "bun" ? "test" : "run";
    const preview = await run(root, "mock", [
      runner,
      command,
      "demo",
      "--print",
    ]);
    expect(preview.status, preview.output).toBe(0);
    expect(readdirSync(root)).not.toContain("reports");
    const result = await run(root, "mock", [
      runner,
      command,
      "demo",
      "--",
      "./two.test.ts",
    ]);
    expect(result.status, result.output).toBe(0);
    expect(reports(root)[0].ranking.map((row: any) => row.file)).toEqual([
      "apps/demo/two.test.ts",
    ]);
  });
}
it("Bun unknown discovery options do not prevent native execution", async () => {
  const root = fixture("bun");
  configure(root, (config) => {
    config.commands.test.args = ["--bail"];
  });
  const result = await run(root);
  expect(result.status, result.output).toBe(0);
  expect(reports(root)[0]).toMatchObject({
    status: "unavailable",
    reason: "discovery-unavailable",
    exitCode: 0,
  });
  expect(
    readFileSync(path.join(root, "apps/demo/ran.txt"), "utf8")
      .trim()
      .split("\n"),
  ).toHaveLength(3);
});
it("disabled observation produces no report and retains execution", async () => {
  const root = fixture("vitest");
  const result = await run(root, "mock", ["test", "demo"], false);
  expect(result.status, result.output).toBe(0);
  expect(readdirSync(root)).not.toContain("reports");
});
