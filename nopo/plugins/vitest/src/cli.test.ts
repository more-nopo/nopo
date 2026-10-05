import { spawn } from "node:child_process";
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
test(${JSON.stringify(`${name}-${suffix}`)}, async () => {
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
async function nopo(root: string, ...args: string[]) {
  return new Promise<{ code: number | null; output: string; stdout: string }>(
    (resolve, reject) => {
      const child = spawn("bun", [cli, ...args], {
        cwd: root,
        env: {
          ...process.env,
          ROOT_DIR: root,
          NOPO_NO_QUEUE: "1",
          DOCKER_PORT: "80",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Fixture CLI timed out"));
      }, 30000);
      child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, output: stdout + stderr, stdout });
      });
    },
  );
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

describe("real nopo → Vitest CLI", async () => {
  it("can be invoked by an ordinary nopo target command", async () => {
    const root = fixture();
    const result = await nopo(
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
  it("opts in through delegation without a config and scopes dir and command env", async () => {
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
    const result = await nopo(root, "test", "alpha");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("own.test.js");
    expect(records(root)).toEqual([]);
  });
  it("delegates an explicit list command and forwards configured native flags", async () => {
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
    const result = await nopo(root, "inspect", "alpha");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("one.test.js");
    expect(records(root)).toEqual([]);
  });
  it("rejects nested project configs instead of accidentally running default test globs", async () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "apps/alpha/vitest.config.mjs"),
      "export default {test: {projects: ['other']}};",
    );
    const result = await run(root, "run", "alpha", "beta");
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(
      "nested projects/workspaces are unsupported",
    );
    expect(records(root)).toEqual([]);
  });
  it("runs selected targets with native aliases and project environments", async () => {
    const root = fixture();
    const result = await run(root, "run", "beta", "--", "--reporter=dot");
    expect(result.code, result.output).toBe(0);
    expect(records(root)).toHaveLength(2);
    expect(
      records(root).every(
        (r) => r.target === "beta" && r.cwd === path.join(root, "apps/beta"),
      ),
    ).toBe(true);
  });
  it("preserves single-target config overrides and root-only reporter settings", async () => {
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
    const result = await nopo(
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
  it("runs two targets in one Vitest process with separate native projects", async () => {
    const root = fixture();
    const result = await run(
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
  it("forwards a file filter and shard arguments instead of interpreting them as targets", async () => {
    const root = fixture();
    const result = await run(
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
    const shard = await run(
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
    const next = await run(
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
  it("lists native test files and supports project filtering in a shared run", async () => {
    const root = fixture();
    const listed = await run(
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
  it("propagates a real test failure from the shared run", async () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "apps/alpha/one.test.js"),
      "import { test, expect } from 'vitest'; test('broken', () => expect(1).toBe(2));",
    );
    const result = await run(
      root,
      "run",
      "alpha",
      "beta",
      "--",
      "--reporter=dot",
    );
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("broken");
    expect(records(root).filter((r) => r.target === "beta")).toHaveLength(2);
  });
  it("prints without executing tests, rejects unknown targets, and forwards --help", async () => {
    const root = fixture();
    const result = await run(root, "run", "--print", "beta");
    expect(result.code, result.output).toBe(0);
    expect(
      JSON.parse(result.stdout).targets.map((t: { id: string }) => t.id),
    ).toEqual(["beta"]);
    expect(records(root)).toEqual([]);
    expect((await run(root, "run", "typo")).code).toBe(1);
    expect((await run(root, "run", "--shard=1/2")).output).toContain(
      "Put Vitest options after --",
    );
    const help = await run(root, "run", "alpha", "--", "--help");
    expect(help.code, help.output).toBe(0);
    expect(help.output).toContain("vitest");
    expect(help.output).not.toContain("Plugin: vitest");
  });
});

describe("runner-owned test policies", async () => {
  function policyFixture() {
    const root = fixture();
    const dir = path.join(root, "apps/alpha");
    writeFileSync(
      path.join(dir, "nopo.yml"),
      JSON.stringify({
        name: "alpha",
        plugins: {
          vitest: {
            env: { PROJECT_ENV: "alpha" },
            test: { quarantine: "quarantine.json", sharding: "clamp" },
          },
        },
        commands: { test: { plugin: "vitest" } },
      }),
    );
    writeFileSync(
      path.join(dir, "red.test.js"),
      "import {test,expect} from 'vitest'; test('red',()=>expect(1).toBe(2));",
    );
    writeFileSync(
      path.join(dir, "quarantine.json"),
      JSON.stringify({ files: { "red.test.js": "fixture" } }),
    );
    return { root, dir };
  }
  it("gates normal tests and audits quarantined failures without consumer config cooperation", async () => {
    const { root } = policyFixture();
    const r = await run(root, "run", "alpha");
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("still fail as expected");
  });
  it("retains quarantine through a symlinked checkout", async () => {
    const { root } = policyFixture();
    const alias = root + "-alias";
    roots.push(alias);
    symlinkSync(root, alias, "dir");
    const r = await run(alias, "run", "alpha");
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("still fail as expected");
  });
  it("rejects graduation and missing entries", async () => {
    const { root, dir } = policyFixture();
    writeFileSync(
      path.join(dir, "red.test.js"),
      "import {test,expect} from 'vitest'; test('green',()=>expect(1).toBe(1));",
    );
    let r = await run(root, "run", "alpha");
    expect(r.code, r.output).not.toBe(0);
    expect(r.output).toContain("now PASS");
    rmSync(path.join(dir, "red.test.js"));
    r = await run(root, "run", "alpha");
    expect(r.code).not.toBe(0);
  });
  it("preserves file filters and avoids an unselected graduation", async () => {
    const { root, dir } = policyFixture();
    writeFileSync(
      path.join(dir, "red.test.js"),
      "import {test} from 'vitest'; test('green',()=>{});",
    );
    const r = await run(
      root,
      "run",
      "alpha",
      "--",
      "one.test.js",
      "--passWithNoTests",
    );
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("No quarantined specs match");
  });
  it("clamps shards and leaves excess shards empty", async () => {
    const { root, dir } = policyFixture();
    writeFileSync(path.join(dir, "quarantine.json"), '{"files":{}}');
    const r = await run(root, "run", "alpha", "--", "--shard=4/5");
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("has no test files");
    const first = await run(
      root,
      "run",
      "alpha",
      "--",
      "red.test.js",
      "--shard",
      "1/4",
    );
    expect(first.code, first.output).not.toBe(0); // no quarantine: red test really gates
  });
  it("only audits quarantine on the original first shard", async () => {
    const { root, dir } = policyFixture();
    writeFileSync(
      path.join(dir, "red.test.js"),
      "import {test} from 'vitest'; test('green',()=>{});",
    );
    const r = await run(root, "run", "alpha", "--", "--shard=2/4");
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("Quarantine audit runs on shard 1 only");
  });
});

function editTarget(
  root: string,
  target: string,
  change: (config: any) => void,
) {
  const file = path.join(root, "apps", target, "nopo.yml");
  const config = JSON.parse(readFileSync(file, "utf8"));
  change(config);
  writeFileSync(file, JSON.stringify(config));
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
describe("shared DAG coordinator", () => {
  it("runs parallel target tasks through one coordinator, preserves environments and cleans it up", async () => {
    const root = fixture();
    const result = await nopo(root, "test", "alpha", "beta", "--concurrency=4");
    expect(result.code, result.output).toBe(0);
    const rows = records(root);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.parent)).size).toBe(1);
    expect(new Set(rows.map((row) => row.target))).toEqual(
      new Set(["alpha", "beta"]),
    );
    expect(alive(rows[0]!.parent)).toBe(false);
  });
  it("keeps failure scoped to a command and runs an independent ready command", async () => {
    const root = fixture();
    const file = path.join(root, "apps/alpha/one.test.js");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        'expect(message).toBe("alpha")',
        "expect(message).toBe('broken')",
      ),
    );
    editTarget(root, "alpha", (config) => {
      config.commands.after = {
        command: "touch should-not-run",
        deps: ["test"],
      };
    });
    const result = await nopo(
      root,
      "test",
      "alpha",
      "beta",
      "--no-fail-fast",
      "--concurrency=4",
    );
    expect(result.code, result.output).toBe(1);
    expect(records(root).filter((row) => row.target === "beta")).toHaveLength(
      2,
    );
    expect(new Set(records(root).map((row) => row.parent)).size).toBe(1);
    expect(alive(records(root)[0]!.parent)).toBe(false);
    // A downstream task is still governed by the DAG failure, not the coordinator's global state.
    const after = await nopo(root, "after", "alpha");
    expect(after.code, after.output).toBe(1);
    expect(existsSync(path.join(root, "apps/alpha/should-not-run"))).toBe(
      false,
    );
  });
  it("retains dependency ordering across target tasks in the same coordinator", async () => {
    const root = fixture();
    editTarget(root, "beta", (config) => {
      config.commands.test.dependencies = { alpha: ["test"] };
    });
    const result = await nopo(root, "test", "beta");
    expect(result.code, result.output).toBe(0);
    expect(records(root).map((row) => row.target)).toEqual([
      "alpha",
      "alpha",
      "beta",
      "beta",
    ]);
    expect(new Set(records(root).map((row) => row.parent)).size).toBe(1);
  });
  it.each([1, 8])(
    "caps native maxWorkers=%s across the whole DAG",
    async (nativeWorkers) => {
      const root = fixture();
      const file = path.join(root, "events.jsonl");
      for (const name of ["alpha", "beta"]) {
        writeFileSync(
          path.join(root, "apps", name, "vitest.config.mjs"),
          `export default {test:{include:['*.test.js'],pool:'forks',fileParallelism:true,maxWorkers:${nativeWorkers}}};`,
        );
        for (const suffix of ["one", "two", "three", "four"])
          writeFileSync(
            path.join(root, "apps", name, `${suffix}.test.js`),
            `import {test,expect} from 'vitest';import {appendFileSync} from 'node:fs';test('${name}-${suffix}',async()=>{const event=phase=>appendFileSync(${JSON.stringify(file)},JSON.stringify({phase,worker:process.pid,coordinator:process.ppid,target:'${name}'})+'\\n');event('start');await new Promise(r=>setTimeout(r,80));expect(process.env.PROJECT_ENV).toBe('${name}');event('end');});`,
          );
      }
      const result = await nopo(
        root,
        "test",
        "alpha",
        "beta",
        "--concurrency=8",
        "--",
      );
      expect(result.code, result.output).toBe(0);
      const rows = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row));
      let active = 0,
        peak = 0;
      for (const row of rows) {
        active += row.phase === "start" ? 1 : -1;
        peak = Math.max(peak, active);
      }
      expect(rows).toHaveLength(16);
      expect(peak).toBeGreaterThanOrEqual(1);
      expect(peak).toBeLessThanOrEqual(Math.min(nativeWorkers, 2));
      expect(active).toBe(0);
      expect(new Set(rows.map((row) => row.coordinator)).size).toBe(1);
    },
  );
  it("supports an explicit isolated execution mode", async () => {
    const root = fixture();
    const file = path.join(root, "nopo.yml");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.plugins[0].config = { execution: "isolated" };
    writeFileSync(file, JSON.stringify(config));
    const result = await nopo(root, "test", "alpha", "beta", "--concurrency=4");
    expect(result.code, result.output).toBe(0);
    expect(new Set(records(root).map((row) => row.parent)).size).toBe(2);
  });
});

describe("reused native instance", () => {
  it("does not carry a failing file into another request and initializes matching config once", async () => {
    const root = fixture();
    const dir = path.join(root, "apps/alpha");
    const setup = path.join(dir, "global-setup.mjs");
    writeFileSync(
      setup,
      `import {appendFileSync} from 'node:fs';export default ()=>{appendFileSync(${JSON.stringify(path.join(root, "setup.log"))},process.pid+'\\n');};`,
    );
    writeFileSync(
      path.join(dir, "vitest.config.mjs"),
      `export default {test:{include:['*.test.js'],pool:'forks',globalSetup:${JSON.stringify(setup)},maxWorkers:1,fileParallelism:false}};`,
    );
    for (const name of ["one", "two", "three"])
      writeFileSync(
        path.join(dir, `${name}.test.js`),
        `import {test,expect} from 'vitest';import {appendFileSync} from 'node:fs';test('${name}',()=>{appendFileSync(${JSON.stringify(path.join(root, "ran.jsonl"))},JSON.stringify({target:'alpha',file:'${name}',parent:process.ppid})+'\\n');expect(1).toBe(${name === "two" ? 2 : 1});});`,
      );
    editTarget(root, "alpha", (config) => {
      config.commands.test = {
        commands: {
          first: { plugin: "vitest", args: ["one.test.js"] },
          second: { plugin: "vitest", args: ["two.test.js"] },
          third: { plugin: "vitest", args: ["three.test.js"] },
        },
      };
    });
    const result = await nopo(
      root,
      "test",
      "alpha",
      "--no-fail-fast",
      "--concurrency=4",
    );
    expect(result.code, result.output).toBe(1);
    expect(records(root).map((row) => row.file)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(result.output).toMatch(/1 failed/);
    expect(new Set(records(root).map((row) => row.parent)).size).toBe(1);
    expect(
      readFileSync(path.join(root, "setup.log"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
    expect(result.output).toMatch(/3 ok, 1 failed, 1 skipped/);
  });
});

it("fails a crashed active request, cleans its workers and continues queued independent work", async () => {
  if (process.platform === "win32") return;
  const root = fixture();
  const crash = path.join(root, "apps/alpha/one.test.js");
  writeFileSync(
    crash,
    `import {test} from 'vitest';import {writeFileSync} from 'node:fs';test('crash',()=>{writeFileSync(${JSON.stringify(path.join(root, "crash.json"))},JSON.stringify({worker:process.pid,coordinator:process.ppid}));process.kill(process.ppid,'SIGKILL');});`,
  );
  const result = await nopo(
    root,
    "test",
    "alpha",
    "beta",
    "--no-fail-fast",
    "--concurrency=4",
  );
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain("Shared coordinator exited");
  expect(records(root).filter((row) => row.target === "beta")).toHaveLength(2);
  const pids = JSON.parse(readFileSync(path.join(root, "crash.json"), "utf8"));
  expect(alive(pids.coordinator)).toBe(false);
  // Orphan workers may briefly remain as zombies on Unix after the process-group kill.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(alive(pids.worker)).toBe(false);
  expect(alive(records(root).at(-1)!.parent)).toBe(false);
});
