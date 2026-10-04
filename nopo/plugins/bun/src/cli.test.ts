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

const cli = fileURLToPath(
  new URL("../../../../packages/nopo/bin.ts", import.meta.url),
);
const plugin = fileURLToPath(new URL("./index.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "nopo-bun-")));
  roots.push(root);
  writeFileSync(
    path.join(root, "nopo.yml"),
    JSON.stringify({
      name: "fixture",
      services: { dirs: ["./apps"] },
      plugins: [{ name: "bun", path: plugin }],
    }),
  );
  writeFileSync(
    path.join(root, "unselected.test.ts"),
    "throw new Error('must not run root tests');",
  );
  for (const name of ["alpha", "beta"]) {
    const dir = path.join(root, "apps", name);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, "test"));
    writeFileSync(
      path.join(dir, "nopo.yml"),
      JSON.stringify({
        name,
        env: { VALUE: name },
        commands: {
          test: {
            env: { VALUE: "command-" + name },
            commands: {
              unit: { plugin: "bun", command: "test", args: ["./src/"] },
              integration: {
                plugin: "bun",
                command: "test",
                args: ["./test/"],
              },
            },
          },
          script: { plugin: "bun", args: ["./script.ts"] },
          bundle: {
            plugin: "bun",
            command: "build",
            args: ["./entry.ts", "--outdir=dist"],
          },
        },
      }),
    );
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, type: "module" }),
    );
    writeFileSync(
      path.join(dir, "bunfig.toml"),
      '[test]\npreload = ["./setup.ts"]\n',
    );
    writeFileSync(
      path.join(dir, "setup.ts"),
      `process.env.PRELOAD=${JSON.stringify(name)};`,
    );
    writeFileSync(path.join(dir, "entry.ts"), "export const value = 42;");
    writeFileSync(
      path.join(dir, "script.ts"),
      `import {writeFileSync} from 'node:fs'; writeFileSync('script.json', JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.VALUE}));`,
    );
    for (const kind of ["src", "test"])
      writeFileSync(
        path.join(dir, kind, "example.test.ts"),
        `import {test,expect} from 'bun:test'; import {appendFileSync} from 'node:fs'; test('${name}-${kind}',()=>{
      expect(process.env.PRELOAD).toBe('${name}'); expect(process.env.NODE_ENV).toBe('test');
      appendFileSync(${JSON.stringify(path.join(root, "ran.jsonl"))}, JSON.stringify({target:'${name}',kind:'${kind}',cwd:process.cwd(),value:process.env.VALUE})+'\\n');
    });`,
      );
  }
  return root;
}
function run(root: string, ...args: string[]) {
  const r = spawnSync("bun", [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      ROOT_DIR: root,
      NOPO_NO_QUEUE: "1",
      DOCKER_PORT: "80",
      NO_COLOR: "1",
      NOPO_SOURCE_VALUE: "literal$NOPO_UNKNOWN_VARIABLE",
    },
  });
  if (r.error) throw r.error;
  return { code: r.status, output: r.stdout + r.stderr, stdout: r.stdout };
}
function records(
  root: string,
): Array<{ target: string; kind: string; cwd: string; value: string }> {
  const file = path.join(root, "ran.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

describe("real nopo → Bun", () => {
  it("runs explicit test commands with native filters, preload and command environment", () => {
    const root = fixture();
    const r = run(root, "test:unit", "beta", "--", "--timeout=10000");
    expect(r.code, r.output).toBe(0);
    expect(records(root)).toEqual([
      {
        target: "beta",
        kind: "src",
        cwd: path.join(root, "apps/beta"),
        value: "command-beta",
      },
    ]);
  });
  it("does not expand resolved command environment a second time", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "apps/alpha/nopo.yml"),
      JSON.stringify({
        name: "alpha",
        env: { VALUE: "$NOPO_SOURCE_VALUE" },
        commands: {
          test: { plugin: "bun", command: "test", args: ["./src/"] },
        },
      }),
    );
    const result = run(root, "test", "alpha");
    expect(result.code, result.output).toBe(0);
    expect(records(root)[0]?.value).toBe("literal$NOPO_UNKNOWN_VARIABLE");
  });
  it("keeps integration and unit commands separately selectable", () => {
    const root = fixture();
    const r = run(root, "test:integration", "alpha");
    expect(r.code, r.output).toBe(0);
    expect(records(root).map((r) => r.kind)).toEqual(["test"]);
  });
  it("defaults to run with argv boundaries preserved", () => {
    const root = fixture();
    const r = run(root, "script", "alpha", "--", "a b", "$(touch unsafe)");
    expect(r.code, r.output).toBe(0);
    expect(
      JSON.parse(
        readFileSync(path.join(root, "apps/alpha/script.json"), "utf8"),
      ),
    ).toEqual({
      args: ["a b", "$(touch unsafe)"],
      cwd: path.join(root, "apps/alpha"),
      value: "alpha",
    });
    expect(existsSync(path.join(root, "apps/alpha/unsafe"))).toBe(false);
  });
  it("builds through an explicitly selected Bun command", () => {
    const root = fixture();
    const r = run(root, "bundle", "alpha");
    expect(r.code, r.output).toBe(0);
    expect(
      readFileSync(path.join(root, "apps/alpha/dist/entry.js"), "utf8"),
    ).toContain("42");
  });
  it("discovers delegated targets and preserves separate native environments", () => {
    const root = fixture();
    const r = run(root, "bun", "test", "--", "./src/");
    expect(r.code, r.output).toBe(0);
    expect(records(root).map((r) => [r.target, r.value])).toEqual([
      ["alpha", "alpha"],
      ["beta", "beta"],
    ]);
  });
  it("lists selection without executing and supports named direct targets", () => {
    const root = fixture();
    const preview = run(root, "bun", "test", "beta", "--print");
    expect(preview.code, preview.output).toBe(0);
    expect(JSON.parse(preview.stdout).targets).toEqual([
      { id: "beta", cwd: path.join(root, "apps/beta") },
    ]);
    expect(records(root)).toEqual([]);
    const r = run(root, "bun", "test", "beta", "--", "./test/");
    expect(r.code, r.output).toBe(0);
    expect(records(root).map((r) => r.target)).toEqual(["beta"]);
  });
  it("validates all targets before spawning and rejects misplaced native flags", () => {
    const root = fixture();
    const r = run(root, "bun", "test", "alpha", "missing");
    expect(r.code).toBe(1);
    expect(r.output).toContain("Unknown nopo target");
    expect(records(root)).toEqual([]);
    const misplaced = run(root, "bun", "test", "alpha", "--timeout=10");
    expect(misplaced.code).toBe(1);
    expect(misplaced.output).toContain("Put Bun options after --");
  });
  it("propagates native test and script failures", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "apps/alpha/src/fail.test.ts"),
      "import {test,expect} from 'bun:test'; test('fails',()=>expect(1).toBe(2));",
    );
    const r = run(root, "test:unit", "alpha");
    expect(r.code, r.output).toBe(1);
    writeFileSync(path.join(root, "apps/alpha/script.ts"), "process.exit(7);");
    expect(run(root, "script", "alpha").code).not.toBe(0);
  });
  it("honors explicit opt-out", () => {
    const root = fixture();
    writeFileSync(
      path.join(root, "apps/alpha/nopo.yml"),
      JSON.stringify({
        name: "alpha",
        plugins: { bun: false },
        commands: { test: { plugin: "bun", command: "test" } },
      }),
    );
    const r = run(root, "test", "alpha");
    expect(r.code).toBe(1);
    expect(r.output).toContain("Bun is disabled");
    expect(records(root)).toEqual([]);
  });
});
