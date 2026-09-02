import { describe, expect, it } from "vitest";

import {
  type ContractCase,
  expectExitCode,
  expectNoSpawns,
  expectSpawn,
  expectStderrContains,
  expectStdoutContains,
  runContractTable,
} from "./contract.ts";
import { mockIO, type SpawnRecord } from "./mock-io.ts";

// These are not contract tests of the CLI — those live under
// `packages/nopo/tests/contract/`.

function fakeIO() {
  return mockIO({ argv: ["nopo"], cwd: "/tmp/x" });
}

describe("expectExitCode", () => {
  it("passes when the captured exitCode matches", () => {
    const io = fakeIO();
    io.exitCode = 0;
    expect(() => expectExitCode(io, 0)).not.toThrow();
    io.exitCode = null;
    expect(() => expectExitCode(io, null)).not.toThrow();
  });

  it("throws when the captured exitCode does not match", () => {
    const io = fakeIO();
    io.exitCode = 1;
    expect(() => expectExitCode(io, 0)).toThrow();
  });
});

describe("expectStdoutContains", () => {
  it("accepts a substring match", () => {
    const io = fakeIO();
    io.stdout.write("hello world");
    expect(() => expectStdoutContains(io, "hello")).not.toThrow();
    expect(() => expectStdoutContains(io, "missing")).toThrow();
  });

  it("accepts a regex match", () => {
    const io = fakeIO();
    io.stdout.write("port=8080");
    expect(() => expectStdoutContains(io, /port=\d+/)).not.toThrow();
    expect(() => expectStdoutContains(io, /port=[a-z]+/)).toThrow();
  });
});

describe("expectStderrContains", () => {
  it("accepts a substring match", () => {
    const io = fakeIO();
    io.stderr.write("error: boom");
    expect(() => expectStderrContains(io, "error")).not.toThrow();
    expect(() => expectStderrContains(io, "ok")).toThrow();
  });

  it("accepts a regex match", () => {
    const io = fakeIO();
    io.stderr.write("WARN: thing failed");
    expect(() => expectStderrContains(io, /WARN/)).not.toThrow();
    expect(() => expectStderrContains(io, /^DEBUG/)).toThrow();
  });
});

describe("expectSpawn", () => {
  function pushSpawn(spawns: SpawnRecord[], cmd: string, args: string[]): void {
    spawns.push({
      cmd,
      args,
      cwd: undefined,
      env: undefined,
      input: undefined,
      result: { exitCode: 0, stdout: "", stderr: "" },
    });
  }

  it("returns the matching record when the predicate matches", () => {
    const io = fakeIO();
    pushSpawn(io.spawns, "docker", ["build", "."]);
    pushSpawn(io.spawns, "docker", ["push", "img"]);
    const found = expectSpawn(io, (s) => s.args[0] === "push");
    expect(found.args).toEqual(["push", "img"]);
  });

  it("throws with all observed spawns dumped when no match", () => {
    const io = fakeIO();
    pushSpawn(io.spawns, "docker", ["build", "."]);
    pushSpawn(io.spawns, "git", ["status"]);
    let caught: unknown;
    try {
      expectSpawn(io, (s) => s.cmd === "kubectl");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toContain("docker build .");
    expect(message).toContain("git status");
  });

  it("throws with a clear marker when no spawns recorded at all", () => {
    const io = fakeIO();
    let caught: unknown;
    try {
      expectSpawn(io, () => true);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toContain("(no spawns recorded)");
  });
});

describe("expectNoSpawns", () => {
  it("passes when spawns is empty", () => {
    const io = fakeIO();
    expect(() => expectNoSpawns(io)).not.toThrow();
  });

  it("throws when spawns is non-empty, dumping the observed calls", () => {
    const io = fakeIO();
    io.spawns.push({
      cmd: "docker",
      args: ["build", "."],
      cwd: undefined,
      env: undefined,
      input: undefined,
      result: { exitCode: 0, stdout: "", stderr: "" },
    });
    let caught: unknown;
    try {
      expectNoSpawns(io);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toContain("docker build .");
  });
});

describe("runContractTable", () => {
  // We exercise `runContractTable` in-line by letting it generate real vitest cases against
  // the `minimal` fixture. The ContractCase below uses a no-op assertion just to confirm
  const cases: ContractCase[] = [
    {
      name: "smoke: list runs against the minimal fixture",
      fixture: "minimal",
      argv: ["list", "--json"],
      expect: (io) => {
        expectStdoutContains(io, '"contract-minimal"');
      },
    },
    {
      name: "smoke: skip is honored",
      fixture: "minimal",
      argv: ["list"],
      skip: "demo of skip",
      expect: () => {
        throw new Error("this case should be skipped and never run");
      },
    },
  ];
  runContractTable(cases);
});
