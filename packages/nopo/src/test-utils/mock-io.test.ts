import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { IO } from "../io.ts";
import { MockExitError, mockIO } from "./mock-io.ts";

describe("mockIO()", () => {
  it("returns an object that satisfies the IO interface", () => {
    const io = mockIO({ argv: ["nopo"], cwd: "/x" });
    // Compile-time conformance: assignment to the IO type.
    const asIO: IO = io;
    expect(typeof asIO.cwd).toBe("function");
    expect(typeof asIO.exit).toBe("function");
    expect(typeof asIO.spawn).toBe("function");
    expect(typeof asIO.stdout.write).toBe("function");
    expect(typeof asIO.stderr.write).toBe("function");
    expect(asIO.stdin).toBeInstanceOf(Readable);
    expect(Array.isArray(asIO.argv)).toBe(true);
    expect(typeof asIO.env).toBe("object");
    expect(typeof asIO.platform).toBe("string");
  });

  it("reflects argv / cwd / env / platform from input", () => {
    const io = mockIO({
      argv: ["nopo", "build", "ui"],
      cwd: "/repo/root",
      env: { NODE_ENV: "test", FOO: "bar" },
      platform: "darwin",
    });
    expect(io.argv).toEqual(["nopo", "build", "ui"]);
    expect(io.cwd()).toBe("/repo/root");
    expect(io.env).toEqual({ NODE_ENV: "test", FOO: "bar" });
    expect(io.platform).toBe("darwin");
  });

  it("defaults env to {} and platform to linux when not provided", () => {
    const io = mockIO({ argv: [], cwd: "/" });
    expect(io.env).toEqual({});
    expect(io.platform).toBe("linux");
  });

  it("captures stdout writes and exposes them via .text()", () => {
    const io = mockIO({ argv: [], cwd: "/" });
    io.stdout.write("hi");
    io.stdout.write(" there");
    expect(io.stdout.text()).toBe("hi there");
  });

  it("captures stderr writes independently of stdout", () => {
    const io = mockIO({ argv: [], cwd: "/" });
    io.stdout.write("out-only");
    io.stderr.write("err-1\n");
    io.stderr.write("err-2\n");
    expect(io.stderr.text()).toBe("err-1\nerr-2\n");
    expect(io.stdout.text()).toBe("out-only");
  });

  it("exit(code) records the code and throws MockExitError", () => {
    const io = mockIO({ argv: [], cwd: "/" });
    expect(io.exitCode).toBeNull();
    let caught: unknown;
    try {
      io.exit(7);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MockExitError);
    if (!(caught instanceof MockExitError)) throw new Error("unreachable");
    expect(caught.exitCode).toBe(7);
    expect(io.exitCode).toBe(7);
  });

  it("spawn() records the call and returns the default success result", async () => {
    const io = mockIO({ argv: [], cwd: "/" });
    const result = await io.spawn("git", ["status"], {
      cwd: "/work",
      env: { GIT_DIR: ".git" },
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(io.spawns).toHaveLength(1);
    expect(io.spawns[0]).toEqual({
      cmd: "git",
      args: ["status"],
      cwd: "/work",
      env: { GIT_DIR: ".git" },
      input: undefined,
      result: { exitCode: 0, stdout: "", stderr: "" },
    });
  });

  it("spawn() records cwd/env/input as undefined when opts not provided", async () => {
    const io = mockIO({ argv: [], cwd: "/" });
    await io.spawn("ls", []);
    expect(io.spawns[0]?.cwd).toBeUndefined();
    expect(io.spawns[0]?.env).toBeUndefined();
    expect(io.spawns[0]?.input).toBeUndefined();
  });

  it("spawn() captures opts.input on the SpawnRecord", async () => {
    // without forwarding `input`, deadlocking `kubectl apply -f -` (kubectl waits for stdin
    // EOF). Mocks must capture `input` so the wrapper boundary is testable.
    const io = mockIO({ argv: [], cwd: "/" });
    await io.spawn("kubectl", ["apply", "-f", "-"], {
      input: "apiVersion: v1\nkind: Secret\n",
    });
    expect(io.spawns[0]?.input).toBe("apiVersion: v1\nkind: Secret\n");
  });

  it("onSpawn override controls the returned result and is also captured", async () => {
    const io = mockIO({
      argv: [],
      cwd: "/",
      onSpawn: (cmd) => ({
        exitCode: cmd === "fail" ? 1 : 0,
        stdout: "out-from-mock",
        stderr: cmd === "fail" ? "boom" : "",
      }),
    });
    const ok = await io.spawn("ok", ["a"]);
    const bad = await io.spawn("fail", ["b"]);
    expect(ok).toEqual({
      exitCode: 0,
      stdout: "out-from-mock",
      stderr: "",
    });
    expect(bad).toEqual({
      exitCode: 1,
      stdout: "out-from-mock",
      stderr: "boom",
    });
    expect(io.spawns).toHaveLength(2);
    expect(io.spawns[0]?.result).toEqual(ok);
    expect(io.spawns[1]?.result).toEqual(bad);
  });

  it("onSpawn may return a Promise (async resolution)", async () => {
    const io = mockIO({
      argv: [],
      cwd: "/",
      onSpawn: async (_cmd, _args) => {
        await Promise.resolve();
        return { exitCode: 42, stdout: "async", stderr: "" };
      },
    });
    const result = await io.spawn("anything", []);
    expect(result).toEqual({ exitCode: 42, stdout: "async", stderr: "" });
    expect(io.spawns[0]?.result.exitCode).toBe(42);
  });

  it("stdin defaults to a closed Readable", async () => {
    const io = mockIO({ argv: [], cwd: "/" });
    const chunks: unknown[] = [];
    for await (const chunk of io.stdin) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });

  it("stdin can be overridden", async () => {
    const stdin = Readable.from(["hello", " world"]);
    const io = mockIO({ argv: [], cwd: "/", stdin });
    const parts: string[] = [];
    for await (const chunk of io.stdin) {
      parts.push(typeof chunk === "string" ? chunk : chunk.toString());
    }
    expect(parts.join("")).toBe("hello world");
  });

  it("two mockIO instances do not share state", () => {
    const a = mockIO({ argv: ["a"], cwd: "/a" });
    const b = mockIO({ argv: ["b"], cwd: "/b" });
    a.stdout.write("from-a");
    expect(b.stdout.text()).toBe("");
    expect(a.spawns).not.toBe(b.spawns);
  });

  it("spawn resolves with a SIGTERM-shaped result when the signal aborts", async () => {
    const io = mockIO({
      argv: ["nopo"],
      cwd: "/",
      // Mock a long-running watcher — never resolves on its own.
      onSpawn: () => new Promise(() => {}),
    });
    const abort = new AbortController();
    const spawnPromise = io.spawn("kubectl", ["get", "events", "--watch"], {
      signal: abort.signal,
    });
    abort.abort();
    const result = await spawnPromise;
    // 143 = 128 + SIGTERM(15) — the conventional exit code for a child terminated by SIGTERM.
    // The contract is
    expect(result.exitCode).toBe(143);
    expect(io.spawns[0]?.cmd).toBe("kubectl");
  });

  it("spawn returns immediately when the signal is already aborted", async () => {
    const io = mockIO({
      argv: ["nopo"],
      cwd: "/",
      onSpawn: () => new Promise(() => {}),
    });
    const abort = new AbortController();
    abort.abort();
    const result = await io.spawn("kubectl", ["logs", "-f"], {
      signal: abort.signal,
    });
    expect(result.exitCode).toBe(143);
  });
});
