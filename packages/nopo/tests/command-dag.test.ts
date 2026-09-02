import { describe, expect, it } from "vitest";

import {
  resolveCommandDag,
  serializeCommandDagAsShell,
  shellQuote,
} from "../src/command-dag.ts";
import type { NormalizedCommand } from "../src/config/index.ts";

type CommandMap = Record<string, NormalizedCommand>;

function cmd(fields: Partial<NormalizedCommand> = {}): NormalizedCommand {
  return fields;
}

describe("resolveCommandDag", () => {
  it("returns roots in topological order", () => {
    const commands: CommandMap = {
      schema: cmd({ command: "bun export-schema" }),
      codegen: cmd({ command: "bunx graphql-codegen", deps: ["schema"] }),
      admin: cmd({ command: "bunx vite build", deps: ["codegen"] }),
      types: cmd({ command: "tsc --noEmit" }),
    };
    const steps = resolveCommandDag({
      serviceId: "svc",
      commands,
      roots: ["admin", "types"],
    });
    expect(steps.map((s) => s.name)).toEqual([
      "schema",
      "codegen",
      "admin",
      "types",
    ]);
  });

  it("deduplicates shared transitive deps", () => {
    const commands: CommandMap = {
      a: cmd({ command: "a" }),
      b: cmd({ command: "b", deps: ["a"] }),
      c: cmd({ command: "c", deps: ["a"] }),
    };
    const steps = resolveCommandDag({
      serviceId: "svc",
      commands,
      roots: ["b", "c"],
    });
    expect(steps.map((s) => s.name)).toEqual(["a", "b", "c"]);
  });

  it("skips composition nodes (deps-only, no command)", () => {
    const commands: CommandMap = {
      a: cmd({ command: "echo a" }),
      b: cmd({ command: "echo b" }),
      bundle: cmd({ deps: ["a", "b"] }),
    };
    const steps = resolveCommandDag({
      serviceId: "svc",
      commands,
      roots: ["bundle"],
    });
    expect(steps.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("forwards env and dir through to the step", () => {
    const commands: CommandMap = {
      run: cmd({
        command: "do-thing",
        env: { FOO: "bar" },
        dir: "sub",
      }),
    };
    const [step] = resolveCommandDag({
      serviceId: "svc",
      commands,
      roots: ["run"],
    });
    expect(step).toEqual({
      name: "run",
      command: "do-thing",
      env: { FOO: "bar" },
      dir: "sub",
    });
  });

  it("rejects cycles with a readable chain", () => {
    const commands: CommandMap = {
      a: cmd({ command: "a", deps: ["b"] }),
      b: cmd({ command: "b", deps: ["a"] }),
    };
    expect(() =>
      resolveCommandDag({ serviceId: "svc", commands, roots: ["a"] }),
    ).toThrowError(/cycle in service "svc": a \u2192 b \u2192 a/);
  });

  it("rejects unknown refs with a helpful message", () => {
    expect(() =>
      resolveCommandDag({
        serviceId: "svc",
        commands: {},
        roots: ["missing"],
      }),
    ).toThrowError(/references unknown command "missing"/);
  });

  it("rejects context: container commands", () => {
    const commands: CommandMap = {
      run: cmd({ command: "x", context: "container" }),
    };
    expect(() =>
      resolveCommandDag({ serviceId: "svc", commands, roots: ["run"] }),
    ).toThrowError(/context: container/);
  });

  it("rejects commands with nested sub-commands", () => {
    const commands: CommandMap = {
      run: cmd({ commands: { inner: { command: "echo" } } }),
    };
    expect(() =>
      resolveCommandDag({ serviceId: "svc", commands, roots: ["run"] }),
    ).toThrowError(/commands with sub-commands are not supported/);
  });

  it("rejects commands with cross-service dependencies", () => {
    const commands: CommandMap = {
      run: cmd({ command: "x", dependencies: ["other-service"] }),
    };
    expect(() =>
      resolveCommandDag({ serviceId: "svc", commands, roots: ["run"] }),
    ).toThrowError(/cross-service 'dependencies:'/);
  });

  it("reports the offending service id in errors", () => {
    expect(() =>
      resolveCommandDag({
        serviceId: "api",
        commands: {},
        roots: ["missing"],
      }),
    ).toThrowError(/Service "api"/);
  });
});

describe("serializeCommandDagAsShell", () => {
  it("wraps each step in its own subshell", () => {
    const script = serializeCommandDagAsShell([
      { name: "a", command: "echo a" },
      { name: "b", command: "echo b" },
    ]);
    expect(script).toBe(`( echo a )\n( echo b )`);
  });

  it("prefixes env exports before the command", () => {
    const script = serializeCommandDagAsShell([
      { name: "run", command: "do-thing", env: { FOO: "bar", BAZ: "qux" } },
    ]);
    expect(script).toBe(`( export FOO='bar' && export BAZ='qux' && do-thing )`);
  });

  it("prefixes cd when dir is set", () => {
    const script = serializeCommandDagAsShell([
      { name: "run", command: "x", dir: "sub/dir" },
    ]);
    expect(script).toBe(`( cd 'sub/dir' && x )`);
  });

  it("combines env and dir in stable order (env then dir)", () => {
    const script = serializeCommandDagAsShell([
      { name: "run", command: "x", env: { K: "v" }, dir: "d" },
    ]);
    expect(script).toBe(`( export K='v' && cd 'd' && x )`);
  });

  it("produces empty string for an empty step list", () => {
    expect(serializeCommandDagAsShell([])).toBe("");
  });

  it("end-to-end: resolve + serialize reproduces the expected heredoc body", () => {
    const commands: CommandMap = {
      schema: cmd({
        command: "bun run scripts/export-schema.ts schema.graphql",
      }),
      codegen: cmd({
        command: "cd admin && bunx graphql-codegen --config codegen.ts",
        deps: ["schema"],
      }),
      admin: cmd({
        command: "cd admin && bunx vite build",
        deps: ["codegen"],
      }),
      types: cmd({ command: "bun x tsc -p tsconfig.types.json" }),
    };
    const steps = resolveCommandDag({
      serviceId: "api",
      commands,
      roots: ["admin", "types"],
    });
    expect(serializeCommandDagAsShell(steps)).toBe(
      [
        `( bun run scripts/export-schema.ts schema.graphql )`,
        `( cd admin && bunx graphql-codegen --config codegen.ts )`,
        `( cd admin && bunx vite build )`,
        `( bun x tsc -p tsconfig.types.json )`,
      ].join("\n"),
    );
  });
});

describe("shellQuote", () => {
  it("wraps plain values in single quotes", () => {
    expect(shellQuote("hello")).toBe(`'hello'`);
  });

  it("escapes embedded single quotes POSIX-safely", () => {
    // `'it's'` → `'it'\''s'` — standard single-quote escape
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it("leaves $ / backticks / spaces literal so no re-expansion happens", () => {
    expect(shellQuote("$FOO `cmd` hi")).toBe(`'$FOO \`cmd\` hi'`);
  });
});
