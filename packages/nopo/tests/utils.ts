import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DockerTag } from "../src/docker-tag.ts";
import {
  createConfig,
  dotenv,
  Logger,
  Runner,
  Script,
  tmpfile,
} from "../src/lib.ts";
import { Environment } from "../src/parse-env.ts";

// Extract root is 3 levels up (tests/utils.ts -> nopo -> packages -> nopo-oss).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTRACT_ROOT = path.resolve(__dirname, "..", "..", "..");
const PARENT_ROOT = path.resolve(EXTRACT_ROOT, "..");
// Product-graph tests still load this monorepo while the extract lives here.
export const PROJECT_ROOT = fs.existsSync(path.join(PARENT_ROOT, "apps"))
  ? PARENT_ROOT
  : EXTRACT_ROOT;
/** Product-graph tests need `apps/` (this monorepo). The public CLI repo does not. */
export const HAS_PRODUCT_GRAPH = fs.existsSync(
  path.join(PROJECT_ROOT, "apps"),
);
// Fixtures live at <extract root>/nopo/fixtures.
export const FIXTURES_ROOT = path.resolve(EXTRACT_ROOT, "nopo", "fixtures");

export function createTestConfig(
  options: Parameters<typeof createConfig>[0] = {},
) {
  return createConfig({
    rootDir: PROJECT_ROOT,
    // Provide clean processEnv by default to isolate tests from real environment
    processEnv: {},
    ...options,
  });
}

export function createFixtureConfig(
  options: Omit<Parameters<typeof createConfig>[0], "rootDir"> = {},
) {
  return createConfig({
    rootDir: FIXTURES_ROOT,
    // Provide clean processEnv by default to isolate tests from real environment
    processEnv: {},
    ...options,
  });
}

export const dockerTag = new DockerTag({
  registry: "docker.io",
  image: "org/repo",
  version: "sha-123abc",
  digest:
    "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
});

export function createTmpEnv(env = {}) {
  const str = dotenv.stringify(env);
  const tmpPath = tmpfile(".env.test", str);
  return tmpPath;
}

export function runScript(
  script: typeof Script,
  config: ReturnType<typeof createConfig>,
  argv: string[] = [],
) {
  // shape is opt-in via `--print --json`. The legacy test suite asserts on JSON output, so
  // we auto-inject `--json` when a test passes `--print` alone. Tests that want to lock
  const finalArgv =
    argv.includes("--print") && !argv.includes("--json")
      ? [...argv, "--json"]
      : argv;
  const logger = new Logger(config);
  const environment = new Environment(config);
  const runner = new Runner(config, environment, finalArgv, logger);
  return runner.run(script);
}
