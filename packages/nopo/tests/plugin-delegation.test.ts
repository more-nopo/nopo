import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../bin.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(
  commands: Record<string, unknown>,
  options: { defaultCommand?: string; names?: string[]; noPlugin?: boolean } = {
    defaultCommand: "run",
  },
) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "nopo-delegation-")),
  );
  roots.push(root);
  mkdirSync(path.join(root, "apps/app/sub"), { recursive: true });
  const log = path.join(root, "calls.jsonl");
  const child = `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ ...JSON.parse(process.env.CALL), cwd: process.cwd(), env: process.env.VALUE, inherited: process.env.INHERITED }) + '\\n')`;
  writeFileSync(
    path.join(root, "plugin.mjs"),
    `export default () => ({name: 'fixture', defaultCommand: ${JSON.stringify(options.defaultCommand)}, commands: ${JSON.stringify(options.names ?? ["run", "list"])}.map(name => ({name, description: name, async fn(ctx) {
    const owner = ctx.commandContext;
    await ctx.exec('bun', ['-e', ${JSON.stringify(child)}], {env: {CALL: JSON.stringify({name, argv: ctx.argv, target: owner?.target, command: owner?.command})}});
  }}))});`,
  );
  writeFileSync(
    path.join(root, "nopo.yml"),
    JSON.stringify({
      name: "fixture",
      services: { dirs: ["./apps"] },
      plugins: options.noPlugin
        ? []
        : [{ name: "fixture", path: "./plugin.mjs" }],
    }),
  );
  writeFileSync(
    path.join(root, "apps/app/nopo.yml"),
    JSON.stringify({
      name: "app",
      env: { VALUE: "service", INHERITED: "service" },
      commands,
    }),
  );
  return root;
}
function run(root: string, ...args: string[]) {
  const result = spawnSync("bun", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, ROOT_DIR: root, DOCKER_PORT: "80", NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  return { code: result.status, output: result.stdout + result.stderr };
}
function calls(
  root: string,
): Array<{
  name: string;
  argv: string[];
  target: string;
  command: string;
  cwd: string;
  env: string;
  inherited: string;
}> {
  const file = path.join(root, "calls.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

describe("target plugin delegation through the CLI", () => {
  it("resolves the explicit default and passes target, argv, env and dir without a shell", () => {
    const root = fixture({
      test: {
        plugin: "fixture",
        dir: "sub",
        env: { VALUE: "command" },
        args: ["a b", "$(touch unsafe)"],
      },
    });
    const result = run(root, "test", "app", "--", "--name=x", "one two");
    expect(result.code, result.output).toBe(0);
    expect(calls(root)).toEqual([
      {
        name: "run",
        target: "app",
        command: "test",
        argv: ["a b", "$(touch unsafe)", "--name=x", "one two"],
        cwd: path.join(root, "apps/app/sub"),
        env: "command",
        inherited: "service",
      },
    ]);
    expect(existsSync(path.join(root, "apps/app/sub/unsafe"))).toBe(false);
  });
  it("forwards native print/help flags without treating them as core controls", () => {
    const root = fixture({ test: { plugin: "fixture" } });
    const result = run(
      root,
      "test",
      "app",
      "--",
      "--print",
      "--help",
      "--json",
    );
    expect(result.code, result.output).toBe(0);
    expect(calls(root)[0]?.argv).toEqual(["--print", "--help", "--json"]);
  });
  it("prints a resolved plugin command without executing it", () => {
    const root = fixture({ test: { plugin: "fixture", args: ["one two"] } });
    const result = run(root, "test", "app", "--print", "--json");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('"plugin":"fixture"');
    expect(result.output).toContain('"executable":"run"');
    expect(calls(root)).toEqual([]);
  });
  it("supports explicit commands without a default and inherited nested settings", () => {
    const root = fixture(
      {
        test: {
          env: { VALUE: "parent" },
          dir: "sub",
          commands: {
            integration: { plugin: "fixture", command: "list" },
            unit: { plugin: "fixture", command: "run" },
          },
        },
      },
      {},
    );
    const result = run(root, "test:integration", "app");
    expect(result.code, result.output).toBe(0);
    expect(calls(root)).toMatchObject([
      {
        name: "list",
        command: "test:integration",
        env: "parent",
        cwd: path.join(root, "apps/app/sub"),
      },
    ]);
  });
  it("orders delegated dependencies before their owner and deduplicates shared dependencies", () => {
    const root = fixture({
      prepare: { plugin: "fixture", command: "list" },
      test: {
        deps: ["prepare"],
        commands: {
          one: { plugin: "fixture", deps: ["prepare"] },
          two: { plugin: "fixture", deps: ["prepare"] },
        },
      },
    });
    const result = run(root, "test", "app");
    expect(result.code, result.output).toBe(0);
    expect(calls(root)[0]?.command).toBe("prepare");
    expect(
      calls(root)
        .map((c) => c.command)
        .sort(),
    ).toEqual(["prepare", "test:one", "test:two"]);
  });
  it("supports literal colon command keys and excluded child selectors", () => {
    const root = fixture({
      "literal:test": { plugin: "fixture" },
      test: {
        commands: {
          unit: { plugin: "fixture" },
          integration: { plugin: "fixture", command: "list" },
        },
      },
    });
    expect(run(root, "literal:test", "app").code).toBe(0);
    expect(run(root, "test:-integration", "app").code).toBe(0);
    expect(calls(root).map((c) => c.command)).toEqual([
      "literal:test",
      "test:unit",
    ]);
  });
  it.each([
    {
      label: "no default",
      delegation: { plugin: "fixture" },
      options: {},
      error: "has no default command",
    },
    {
      label: "unloaded plugin",
      delegation: { plugin: "missing" },
      options: {},
      error: "is not loaded",
    },
    {
      label: "unknown command",
      delegation: { plugin: "fixture", command: "missing" },
      options: {},
      error: "has no command 'missing'",
    },
    {
      label: "invalid declared default",
      delegation: { plugin: "fixture" },
      options: { defaultCommand: "missing" },
      error: "is not registered",
    },
    {
      label: "duplicate command",
      delegation: { plugin: "fixture" },
      options: { names: ["run", "run"] },
      error: "duplicate command",
    },
  ])(
    "rejects $label before any prerequisite executes",
    ({ delegation, options, error }) => {
      const root = fixture(
        {
          prepare: { plugin: "fixture", command: "list" },
          test: { ...delegation, deps: ["prepare"] },
        },
        options,
      );
      const result = run(root, "test", "app");
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(error);
      expect(calls(root)).toEqual([]);
    },
  );
  it("does not infer a default even for a plugin with only a command named run", () => {
    const root = fixture({ test: { plugin: "fixture" } }, { names: ["run"] });
    const result = run(root, "test", "app", "--print");
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("has no default command");
    expect(calls(root)).toEqual([]);
  });
  it.each([
    { args: ["x"], command: "echo x" },
    { plugin: "fixture", commands: { child: "echo x" } },
    { plugin: "fixture", args: "x" },
  ])("rejects an invalid delegation shape %j", (command) => {
    const root = fixture({ test: command });
    expect(run(root, "test", "app").code).toBe(1);
    expect(calls(root)).toEqual([]);
  });
  it("fails the plan when an invalid delegate is only reachable through dependencies", () => {
    const root = fixture({
      prepare: { plugin: "missing" },
      test: { plugin: "fixture", deps: ["prepare"] },
    });
    const result = run(root, "test", "app");
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("app:prepare");
    expect(calls(root)).toEqual([]);
  });
  it("rejects container delegation during planning", () => {
    const root = fixture({ test: { plugin: "fixture", context: "container" } });
    const result = run(root, "test", "app", "--print");
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("requires context: host");
    expect(calls(root)).toEqual([]);
  });
});
