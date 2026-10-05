/** Synthetic behavioral evaluation. Live scores are compared with tests that
 * actually fail under controlled mutations; mock mode only verifies integration. */
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDecisionClient,
  decisionRequestHash,
  type DecisionRequest,
} from "../../../packages/nopo/src/decisions/index.ts";
import {
  createConfig,
  Runner,
  Logger,
} from "../../../packages/nopo/src/lib.ts";
import { realIO } from "../../../packages/nopo/src/io.ts";
import { evidence } from "../../plugins/test-relevance/src/evidence.ts";
import { relevanceRequest } from "../../plugins/test-relevance/src/index.ts";
import type { HookContext } from "../../../packages/nopo/src/plugin.ts";
import { scenarios } from "./cases.ts";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const mode = process.env.NOPO_DECISION_EVAL_MODE ?? "mock";
if (!["live", "mock", "replay"].includes(mode))
  throw new Error("NOPO_DECISION_EVAL_MODE must be live, mock or replay");
if (mode === "live" && !process.env.OPENROUTER_API_KEY)
  throw new Error(
    "Live evaluation requires the GitHub Actions repository secret OPENROUTER_API_KEY. Add it and rerun this job; no mock fallback is allowed.",
  );
const output = path.resolve(
  process.env.NOPO_DECISION_EVAL_DIR ?? "/tmp/nopo-decision-eval",
);
mkdirSync(output, { recursive: true });
const model = "jev-1.13";
const baseUrl = "https://openrouter.ai/api";
const captured: Record<string, unknown> = {};
const results: unknown[] = [];
let failures = 0;
function write(root: string, file: string, content: string) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}
function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}
async function cli(root: string, extraEnv: Record<string, string>) {
  return await new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(
        "bun",
        [path.join(repository, "packages/nopo/bin.ts"), "test", "demo"],
        {
          cwd: root,
          env: {
            ...process.env,
            NOPO_NO_QUEUE: "1",
            DOCKER_PORT: "80",
            ROOT_DIR: root,
            NOPO_TIMEOUT: "2m",
            ...extraEnv,
          },
          stdio: "pipe",
        },
      );
      let log = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, 90000);
      child.stdout.on("data", (chunk) => {
        log += chunk;
      });
      child.stderr.on("data", (chunk) => {
        log += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output: log });
      });
    },
  );
}
const fixtureFile = process.env.NOPO_DECISION_REPLAY_FILE;
if (mode === "replay" && !fixtureFile)
  throw new Error("Replay requires NOPO_DECISION_REPLAY_FILE");
const primitive: DecisionRequest = {
  state: { amount: 42, currency: "USD", status: "paid" },
  questions: {
    paid: { type: "noul", instructions: "Is status exactly paid?" },
    currency: {
      type: "choice",
      instructions: "What currency is recorded?",
      criteria: { USD: "US dollars", EUR: "Euro" },
    },
    amount: {
      type: "score",
      instructions: "Which amount band matches?",
      criteria: [
        "Zero amount",
        "Between one and ninety-nine",
        "One hundred or greater",
      ],
    },
  },
};
try {
  const hash = decisionRequestHash(model, primitive);
  if (mode === "mock")
    captured[hash] = {
      model,
      answers: {
        paid: { type: "noul", noul: 0.99 },
        currency: {
          type: "choice",
          choice: "USD",
          probabilities: { USD: 0.99, EUR: 0.01 },
          confidence: 0.98,
        },
        amount: {
          type: "score",
          score: 1,
          probabilities: { "0": 0, "1": 1, "2": 0 },
          confidence: 1,
          legend: {
            "0": "Zero amount",
            "1": "Between one and ninety-nine",
            "2": "One hundred or greater",
          },
        },
      },
    };
  const mocks = path.join(output, "responses.json");
  writeFileSync(
    mocks,
    JSON.stringify({ schemaVersion: 1, responses: captured }, null, 2),
  );
  const result = await createDecisionClient(
    {
      baseUrl,
      model,
      timeoutMs: 30000,
      ...(mode === "live"
        ? {}
        : { mockResponses: mode === "replay" ? fixtureFile : mocks }),
    },
    { env: process.env },
  ).evaluate(primitive);
  assert(
    result.status === "ok",
    `Primitive evaluation unavailable: ${JSON.stringify(result)}`,
  );
  if (result.status === "ok") {
    assert(
      result.answers.paid?.type === "noul" && result.answers.paid.noul >= 0.8,
      "Noul failed a directly stated fact",
    );
    assert(
      result.answers.currency?.type === "choice" &&
        result.answers.currency.choice === "USD",
      "Choice failed a directly stated fact",
    );
    assert(
      result.answers.amount?.type === "score" &&
        Math.abs(result.answers.amount.score - 1) < 0.25,
      "Score failed a directly stated rubric",
    );
    captured[result.requestHash] = {
      model: result.model,
      answers: result.answers,
      usage: result.usage,
    };
  }
  results.push({ scenario: "typed-primitives", passed: true, result });
} catch (error) {
  failures++;
  results.push({
    scenario: "typed-primitives",
    passed: false,
    error: String(error),
  });
}
for (const runnerName of ["vitest", "bun"] as const)
  for (const scenario of scenarios) {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "nopo-decision-eval-")),
    );
    const label = `${runnerName}-${scenario.name}`;
    try {
      const pluginPath = path.join(
        repository,
        `nopo/plugins/${runnerName}/src/index.ts`,
      );
      const mockPath = path.join(output, `${label}-responses.json`);
      const config = {
        name: "evaluation",
        services: {
          dirs: scenario.name.startsWith("shared-dependency")
            ? ["apps", "packages"]
            : ["apps"],
        },
        decisions: {
          baseUrl,
          model,
          tokenEnv: "OPENROUTER_API_KEY",
          timeoutMs: 30000,
          ...(mode === "live"
            ? {}
            : { mockResponses: mode === "replay" ? fixtureFile : mockPath }),
        },
        plugins: [{ name: runnerName, path: pluginPath }],
      };
      write(root, "nopo.yml", JSON.stringify(config));
      write(root, "package.json", '{"type":"module"}');
      write(
        root,
        ".gitignore",
        ".env\nnode_modules/\nreports/\napps/demo/outcomes.jsonl\n",
      );
      const target = {
        name: "demo",
        ...(scenario.name.startsWith("shared-dependency")
          ? { build: { deps: ["money"] } }
          : {}),
        commands: {
          test: {
            plugin: runnerName,
            ...(runnerName === "bun"
              ? { command: "test" }
              : { args: ["--maxWorkers=1"] }),
          },
        },
        plugins: { [runnerName]: { test: { relevance: "off" } } },
      };
      write(root, "apps/demo/nopo.yml", JSON.stringify(target));
      for (const [file, text] of Object.entries(scenario.initial))
        write(root, file, text);
      if (scenario.name.startsWith("shared-dependency"))
        write(
          root,
          "packages/money/nopo.yml",
          JSON.stringify({ name: "money" }),
        );
      if (runnerName === "vitest") {
        mkdirSync(path.join(root, "node_modules"));
        symlinkSync(
          path.dirname(
            createRequire(
              path.join(repository, "nopo/plugins/vitest/package.json"),
            ).resolve("vitest/package.json"),
          ),
          path.join(root, "node_modules/vitest"),
          "junction",
        );
      }
      for (const [file, test] of Object.entries(scenario.tests))
        write(
          root,
          `apps/demo/${file}`,
          `import {test,expect} from '${runnerName === "bun" ? "bun:test" : "vitest"}';\nimport {appendFileSync} from 'node:fs';\n${test.body}\ntest(${JSON.stringify(file)},()=>{const actual=${test.expected[0]};const expected=${test.expected[1]};appendFileSync('outcomes.jsonl',JSON.stringify({file:${JSON.stringify(file)},failed:actual!==expected})+'\\n');expect(actual).toBe(expected);});\n`,
        );
      target.plugins[runnerName].test.relevance = "observe";
      // Establish a clean baseline including the opt-in config; only source mutation is diff evidence.
      write(root, "apps/demo/nopo.yml", JSON.stringify(target));
      for (const argv of [
        ["init", "-q"],
        ["add", "."],
        [
          "-c",
          "user.name=Evaluation",
          "-c",
          "user.email=eval@example.invalid",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-qm",
          "fixture",
        ],
      ])
        assert(
          spawnSync("git", argv, { cwd: root }).status === 0,
          "Cannot create synthetic git fixture",
        );
      // Baseline runs use the same plugin, with observation temporarily disabled.
      target.plugins[runnerName].test.relevance = "off";
      write(root, "apps/demo/nopo.yml", JSON.stringify(target));
      const baseline = await cli(root, {
        NOPO_RELEVANCE_REPORT_DIR: path.join(root, "reports"),
      });
      writeFileSync(
        path.join(output, `${label}-baseline.log`),
        baseline.output,
      );
      assert(baseline.code === 0, "Baseline tests failed");
      rmSync(path.join(root, "apps/demo/outcomes.jsonl"));
      target.plugins[runnerName].test.relevance = "observe";
      write(root, "apps/demo/nopo.yml", JSON.stringify(target));
      write(root, scenario.changedFile, scenario.replacement);
      if (mode === "mock") {
        const configuration = createConfig({
          rootDir: root,
          processEnv: {},
          silent: true,
        });
        const runner = new Runner(
          configuration,
          { env: {}, extraEnv: {} } as Runner["environment"],
          [],
          new Logger(configuration),
          realIO,
        );
        const input = await evidence(
          { runner, io: realIO } as HookContext,
          Object.keys(scenario.tests).map((file) =>
            path.join(root, "apps/demo", file),
          ),
        );
        const request = relevanceRequest(input);
        const answers = Object.fromEntries(
          input.candidates.map((candidate) => [
            candidate.id,
            {
              type: "noul",
              noul: scenario.relevant.includes(path.basename(candidate.file))
                ? 0.9
                : 0.1,
            },
          ]),
        );
        const response = { model, answers };
        writeFileSync(
          mockPath,
          JSON.stringify({
            schemaVersion: 1,
            responses: { [decisionRequestHash(model, request)]: response },
          }),
        );
      }
      const started = performance.now();
      const run = await cli(root, {
        NOPO_RELEVANCE_REPORT_DIR: path.join(root, "reports"),
      });
      writeFileSync(path.join(output, `${label}.log`), run.output);
      assert(
        run.code === (scenario.expectedFailures.length ? 1 : 0),
        "Native execution did not preserve expected mutation failure",
      );
      const outcomes = readFileSync(
        path.join(root, "apps/demo/outcomes.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row));
      assert(
        outcomes.length === Object.keys(scenario.tests).length,
        "Observation skipped tests",
      );
      assert(
        JSON.stringify(
          outcomes
            .filter((row) => row.failed)
            .map((row) => row.file)
            .sort(),
        ) === JSON.stringify([...scenario.expectedFailures].sort()),
        "Mutation ground truth mismatch",
      );
      const files = readdirSync(path.join(root, "reports"));
      assert(files.length === 1, "Expected one runner observation report");
      const report = JSON.parse(
        readFileSync(path.join(root, "reports", files[0]!), "utf8"),
      );
      assert(
        report.status === "ranked" &&
          report.unscored === 0 &&
          report.skippedFiles === 0,
        `Ranking unavailable: ${JSON.stringify(report)}`,
      );
      const ranking: { file: string; probability: number }[] = report.ranking;
      const probability = (file: string) =>
        ranking.find((row) => path.basename(row.file) === file)!.probability;
      for (const relevant of scenario.relevant) {
        assert(
          probability(relevant) >= 0.65,
          `${relevant}: failed recall threshold 0.65`,
        );
        for (const unrelated of scenario.unrelated)
          assert(
            probability(relevant) > probability(unrelated),
            `${relevant} did not outrank ${unrelated}`,
          );
      }
      for (const unrelated of scenario.unrelated)
        assert(
          probability(unrelated) <= 0.4,
          `${unrelated}: independent test scored above 0.4`,
        );
      for (const decision of report.decisions)
        captured[decision.requestHash] = {
          model: decision.model,
          answers: decision.answers,
          usage: decision.usage,
        };
      results.push({
        scenario: label,
        passed: true,
        knownFailures: scenario.expectedFailures,
        relevant: scenario.relevant,
        unrelated: scenario.unrelated,
        ranking,
        timings: report.timings,
        elapsedMs: performance.now() - started,
        decisions: report.decisions,
      });
    } catch (error) {
      failures++;
      results.push({ scenario: label, passed: false, error: String(error) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
writeFileSync(
  path.join(output, "responses.json"),
  JSON.stringify({ schemaVersion: 1, responses: captured }, null, 2),
);
writeFileSync(
  path.join(output, "results.json"),
  JSON.stringify({ mode, model, failures, results }, null, 2),
);
console.log(
  JSON.stringify({
    mode,
    scenarios: results.length,
    failures,
    artifacts: output,
  }),
);
if (failures) process.exitCode = 1;
