import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(
  new URL("../../../../packages/nopo/bin.ts", import.meta.url),
);
const plugin = fileURLToPath(new URL("./index.ts", import.meta.url));
const vitestPackage = createRequire(import.meta.url).resolve(
  "vitest/package.json",
);
const roots: string[] = [];

function fixture() {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "nopo-vitest-cli-")),
  );
  roots.push(root);
  mkdirSync(path.join(root, "node_modules"));
  symlinkSync(
    path.dirname(vitestPackage),
    path.join(root, "node_modules/vitest"),
    "junction",
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", type: "module" }),
  );
  writeFileSync(
    path.join(root, "unselected.test.js"),
    "throw new Error('must not run the repository as an extra project');",
  );
  writeFileSync(
    path.join(root, "nopo.yml"),
    JSON.stringify({
      name: "fixture",
      services: { dirs: ["./apps"] },
      plugins: [{ name: "vitest", path: plugin }],
    }),
  );
  for (const name of ["alpha", "beta"]) {
    const dir = path.join(root, "apps", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "nopo.yml"),
      JSON.stringify({
        name,
        plugins: { vitest: { env: { PROJECT_ENV: name } } },
        commands: {
          test: { plugin: "vitest" },
        },
      }),
    );
    writeFileSync(
      path.join(dir, "message.js"),
      `export default ${JSON.stringify(name)};`,
    );
    writeFileSync(
      path.join(dir, "vitest.config.mjs"),
      `export default ${JSON.stringify({
        resolve: { alias: { "@message": path.join(dir, "message.js") } },
        test: {
          include: ["*.test.js"],
          env: { TARGET: name },
          maxWorkers: 1,
          fileParallelism: false,
          pool: "forks",
        },
      })};`,
    );
    for (const suffix of ["one", "two"]) {
      writeFileSync(
        path.join(dir, `${suffix}.test.js`),
        `
import { appendFileSync } from 'node:fs';
import { test, expect } from 'vitest';
import message from '@message';
test(${JSON.stringify(`${name}-${suffix}`)}, () => {
  expect(message).toBe(${JSON.stringify(name)});
  expect(process.env.PROJECT_ENV).toBe(${JSON.stringify(name)});
  expect(process.env.TARGET).toBe(${JSON.stringify(name)});
  appendFileSync(${JSON.stringify(path.join(root, "ran.jsonl"))}, JSON.stringify({ target: ${JSON.stringify(name)}, file: ${JSON.stringify(suffix)}, cwd: process.cwd(), parent: process.ppid }) + '\\n');
});`,
      );
    }
  }
  return root;
}
function nopo(root: string, ...args: string[]) {
  const result = spawnSync("bun", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    // Avoid nopo's unrelated dynamic Docker-port probe in sandboxed test runs.
    env: {
      ...process.env,
      ROOT_DIR: root,
      DOCKER_PORT: "80",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
  if (result.error) throw result.error;
  return {
    code: result.status,
    output: result.stdout + result.stderr,
    stdout: result.stdout,
  };
}
function run(root: string, ...args: string[]) {
  return nopo(root, "vitest", ...args);
}
function records(
  root: string,
): Array<{ target: string; file: string; cwd: string; parent: number }> {
  const file = path.join(root, "ran.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("real nopo → Vitest CLI", () => {
  it("can be invoked by an ordinary nopo target command", () => {
    const root = fixture();
    const result = nopo(
      root,
      "test",
      "beta",
      "--",
      "one.test.js",
      "--maxWorkers=1",
    );
    expect(result.code, result.output).toBe(0);
    expect(records(root).map((r) => `${r.target}/${r.file}`)).toEqual([
      "beta/one",
    ]);
  });
  it("opts in through delegation without a config and scopes dir and command env", () => {
    const root = fixture();
    const dir = path.join(root, "apps/alpha/nested");
    mkdirSync(dir);
    writeFileSync(
      path.join(root, "apps/alpha/nopo.yml"),
      JSON.stringify({
        name: "alpha",
        env: { COMMAND_VALUE: "service" },
        commands: {
          test: {
            plugin: "vitest",
            dir: "nested",
            env: { COMMAND_VALUE: "command" },
            args: ["--maxWorkers=1"],
          },
        },
      }),
    );
    writeFileSync(
      path.join(dir, "own.test.js"),
      `import {test,expect} from 'vitest'; test('own',()=>expect(process.env.COMMAND_VALUE).toBe('command'));`,
    );
    const result = nopo(root, "test", "alpha");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("own.test.js");
    expect(records(root)).toEqual([]);
  });
  it("delegates an explicit list command and forwards configured native flags", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "apps/alpha/nopo.yml"),
      JSON.stringify({
        name: "alpha",
        commands: {
          inspect: {
            plugin: "vitest",
            command: "list",
            args: ["--filesOnly", "--json"],
          },
        },
      }),
    );
    const result = nopo(root, "inspect", "alpha");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("one.test.js");
    expect(records(root)).toEqual([]);
  });
  it("rejects nested project configs instead of accidentally running default test globs", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "apps/alpha/vitest.config.mjs"),
      "export default {test: {projects: ['other']}};",
    );
    const result = run(root, "run", "alpha", "beta");
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(
      "nested projects/workspaces are unsupported",
    );
    expect(records(root)).toEqual([]);
  });
  it("runs selected targets with native aliases and project environments", () => {
    const root = fixture();
    const result = run(root, "run", "beta", "--", "--reporter=dot");
    expect(result.code, result.output).toBe(0);
    expect(records(root)).toHaveLength(2);
    expect(
      records(root).every(
        (r) => r.target === "beta" && r.cwd === path.join(root, "apps/beta"),
      ),
    ).toBe(true);
  });
  it("preserves single-target config overrides and root-only reporter settings", () => {
    const root = fixture();
    const dir = path.join(root, "apps/beta");
    writeFileSync(
      path.join(dir, "alternate.config.mjs"),
      `
      import base from './vitest.config.mjs';
      export default {...base, test: {...base.test, include: ['one.test.js'],
        reporters: ['json'], outputFile: './native-report.json'}};
    `,
    );
    const result = nopo(
      root,
      "test",
      "beta",
      "--",
      "--config",
      "alternate.config.mjs",
    );
    expect(result.code, result.output).toBe(0);
    expect(records(root).map((r) => r.file)).toEqual(["one"]);
    const report = JSON.parse(
      readFileSync(path.join(dir, "native-report.json"), "utf8"),
    );
    expect(report.numPassedTests).toBe(1);
  });
  it("runs two targets in one Vitest process with separate native projects", () => {
    const root = fixture();
    const result = run(
      root,
      "run",
      "alpha",
      "beta",
      "--",
      "--maxWorkers=1",
      "--reporter=dot",
    );
    expect(result.code, result.output).toBe(0);
    const ran = records(root);
    expect(ran).toHaveLength(4);
    expect(new Set(ran.map((r) => r.target))).toEqual(
      new Set(["alpha", "beta"]),
    );
    expect(new Set(ran.map((r) => r.parent)).size).toBe(1);
    expect(ran.every((r) => r.cwd === root)).toBe(true);
  });
  it("forwards a file filter and shard arguments instead of interpreting them as targets", () => {
    const root = fixture();
    const result = run(
      root,
      "run",
      "alpha",
      "--",
      "one.test.js",
      "--reporter=dot",
    );
    expect(result.code, result.output).toBe(0);
    expect(records(root).map((r) => r.file)).toEqual(["one"]);
    rmSync(path.join(root, "ran.jsonl"));
    const shard = run(
      root,
      "run",
      "alpha",
      "beta",
      "--",
      "--shard=1/2",
      "--maxWorkers=1",
    );
    expect(shard.code, shard.output).toBe(0);
    const first = records(root).map((r) => `${r.target}/${r.file}`);
    rmSync(path.join(root, "ran.jsonl"));
    const next = run(
      root,
      "run",
      "alpha",
      "beta",
      "--",
      "--shard=2/2",
      "--maxWorkers=1",
    );
    expect(next.code, next.output).toBe(0);
    const second = records(root).map((r) => `${r.target}/${r.file}`);
    expect(first.length + second.length).toBe(4);
    expect(new Set([...first, ...second]).size).toBe(4);
  }, 60_000);
  it("lists native test files and supports project filtering in a shared run", () => {
    const root = fixture();
    const listed = run(
      root,
      "list",
      "alpha",
      "beta",
      "--",
      "--filesOnly",
      "--json",
      "--project=beta",
    );
    expect(listed.code, listed.output).toBe(0);
    expect(listed.stdout).toContain("beta/one.test.js");
    expect(listed.stdout).not.toContain("alpha/one.test.js");
    expect(JSON.parse(listed.stdout)).toHaveLength(2);
    expect(records(root)).toEqual([]);
  });
  it("propagates a real test failure from the shared run", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "apps/alpha/one.test.js"),
      "import { test, expect } from 'vitest'; test('broken', () => expect(1).toBe(2));",
    );
    const result = run(root, "run", "alpha", "beta", "--", "--reporter=dot");
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("broken");
    expect(records(root).filter((r) => r.target === "beta")).toHaveLength(2);
  });
  it("prints without executing tests, rejects unknown targets, and forwards --help", () => {
    const root = fixture();
    const result = run(root, "run", "--print", "beta");
    expect(result.code, result.output).toBe(0);
    expect(
      JSON.parse(result.stdout).targets.map((t: { id: string }) => t.id),
    ).toEqual(["beta"]);
    expect(records(root)).toEqual([]);
    expect(run(root, "run", "typo").code).toBe(1);
    expect(run(root, "run", "--shard=1/2").output).toContain(
      "Put Vitest options after --",
    );
    const help = run(root, "run", "alpha", "--", "--help");
    expect(help.code, help.output).toBe(0);
    expect(help.output).toContain("vitest");
    expect(help.output).not.toContain("Plugin: vitest");
  });
});
