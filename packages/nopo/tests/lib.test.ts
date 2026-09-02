import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  $,
  chalk,
  dotenv,
  makeCtxExec,
  makeCtxShell,
  minimist,
  ProcessOutput,
  tmpfile,
} from "../src/lib.ts";
import { mockIO } from "../src/test-utils/mock-io.ts";

describe("chalk replacement", () => {
  it("should colorize text when level > 0", () => {
    chalk.level = 2;
    expect(chalk.red("test")).toBe("\x1b[31mtest\x1b[0m");
    expect(chalk.green("test")).toBe("\x1b[32mtest\x1b[0m");
    expect(chalk.yellow("test")).toBe("\x1b[33mtest\x1b[0m");
    expect(chalk.blue("test")).toBe("\x1b[34mtest\x1b[0m");
    expect(chalk.magenta("test")).toBe("\x1b[35mtest\x1b[0m");
    expect(chalk.cyan("test")).toBe("\x1b[36mtest\x1b[0m");
    expect(chalk.white("test")).toBe("\x1b[37mtest\x1b[0m");
    expect(chalk.gray("test")).toBe("\x1b[90mtest\x1b[0m");
    expect(chalk.grey("test")).toBe("\x1b[90mtest\x1b[0m");
    expect(chalk.bold("test")).toBe("\x1b[1mtest\x1b[0m");
    expect(chalk.black("test")).toBe("\x1b[30mtest\x1b[0m");
  });

  it("should not colorize text when level is 0", () => {
    chalk.level = 0;
    expect(chalk.red("test")).toBe("test");
    expect(chalk.green("test")).toBe("test");
    expect(chalk.bold("test")).toBe("test");
    chalk.level = 2; // Reset
  });

  it("should handle non-string inputs", () => {
    expect(chalk.red(123)).toBe("\x1b[31m123\x1b[0m");
    expect(chalk.blue(null)).toBe("\x1b[34m\x1b[0m");
    expect(chalk.green(undefined)).toBe("\x1b[32m\x1b[0m");
  });
});

describe("minimist replacement", () => {
  it("should parse positional arguments", () => {
    const args = ["arg1", "arg2", "arg3"];
    const parsed = minimist(args);
    expect(parsed._).toEqual(["arg1", "arg2", "arg3"]);
  });

  it("should parse long options with values", () => {
    const args = ["--name", "value", "--flag"];
    const parsed = minimist(args);
    expect(parsed.name).toBe("value");
    expect(parsed.flag).toBe(true);
  });

  it("should parse long options with = syntax", () => {
    const args = ["--name=value", "--bool=true", "--falseBool=false"];
    const parsed = minimist(args);
    expect(parsed.name).toBe("value");
    expect(parsed.bool).toBe(true);
    expect(parsed.falseBool).toBe(false);
  });

  it("should parse short options", () => {
    const args = ["-a", "-bc"];
    const parsed = minimist(args);
    expect(parsed.a).toBe(true);
    expect(parsed.b).toBe(true);
    expect(parsed.c).toBe(true);
  });

  it("should handle -- separator", () => {
    const args = ["--option", "value", "--", "arg1", "--not-an-option"];
    const parsed = minimist(args);
    expect(parsed.option).toBe("value");
    expect(parsed._).toEqual(["arg1", "--not-an-option"]);
    expect(parsed["not-an-option"]).toBeUndefined();
  });

  it("should handle mixed arguments", () => {
    const args = ["command", "--verbose", "-f", "file.txt", "positional"];
    const parsed = minimist(args);
    expect(parsed._).toEqual(["command", "file.txt", "positional"]);
    expect(parsed.verbose).toBe(true);
    expect(parsed.f).toBe(true);
  });
});

describe("dotenv replacement", () => {
  describe("parse", () => {
    it("should parse basic env format", () => {
      const content = `KEY1=value1
KEY2=value2
KEY3=value3`;
      const parsed = dotenv.parse(content);
      expect(parsed).toEqual({
        KEY1: "value1",
        KEY2: "value2",
        KEY3: "value3",
      });
    });

    it("should handle quoted values", () => {
      const content = `KEY1="value with spaces"
KEY2='single quotes'
KEY3=no_quotes`;
      const parsed = dotenv.parse(content);
      expect(parsed).toEqual({
        KEY1: "value with spaces",
        KEY2: "single quotes",
        KEY3: "no_quotes",
      });
    });

    it("should ignore comments and empty lines", () => {
      const content = `# This is a comment
KEY1=value1

# Another comment
KEY2=value2
  # Indented comment
KEY3=value3`;
      const parsed = dotenv.parse(content);
      expect(parsed).toEqual({
        KEY1: "value1",
        KEY2: "value2",
        KEY3: "value3",
      });
    });

    it("should handle empty values", () => {
      const content = `KEY1=
KEY2=""
KEY3=''`;
      const parsed = dotenv.parse(content);
      expect(parsed).toEqual({
        KEY1: "",
        KEY2: "",
        KEY3: "",
      });
    });
  });

  describe("stringify", () => {
    it("should stringify env object", () => {
      const env = {
        KEY1: "value1",
        KEY2: "value2",
        KEY3: "value3",
      };
      const stringified = dotenv.stringify(env);
      expect(stringified).toBe(`KEY1="value1"
KEY2="value2"
KEY3="value3"`);
    });

    it("should filter undefined values", () => {
      const env = {
        KEY1: "value1",
        KEY2: undefined,
        KEY3: "value3",
      };
      const stringified = dotenv.stringify(env);
      expect(stringified).toBe(`KEY1="value1"
KEY3="value3"`);
    });
  });

  describe("load", () => {
    let tempFile: string;

    beforeEach(() => {
      tempFile = path.join(os.tmpdir(), `test-${Date.now()}.env`);
    });

    afterEach(() => {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    });

    it("should load env file", () => {
      const content = `KEY1=value1
KEY2=value2`;
      fs.writeFileSync(tempFile, content);
      const loaded = dotenv.load(tempFile);
      expect(loaded).toEqual({
        KEY1: "value1",
        KEY2: "value2",
      });
    });

    it("should return empty object for non-existent file", () => {
      const loaded = dotenv.load("/non/existent/file.env");
      expect(loaded).toEqual({});
    });
  });
});

describe("tmpfile replacement", () => {
  it("should create a temporary file", () => {
    const content = "test content";
    const tmpPath = tmpfile("test.txt", content);

    expect(fs.existsSync(tmpPath)).toBe(true);
    expect(path.basename(tmpPath)).toBe("test.txt");
    expect(fs.readFileSync(tmpPath, "utf-8")).toBe(content);

    // Cleanup
    fs.unlinkSync(tmpPath);
    fs.rmdirSync(path.dirname(tmpPath));
  });

  it("should create unique temp directories", () => {
    const path1 = tmpfile("test1.txt", "content1");
    const path2 = tmpfile("test2.txt", "content2");

    expect(path.dirname(path1)).not.toBe(path.dirname(path2));

    // Cleanup
    fs.unlinkSync(path1);
    fs.rmdirSync(path.dirname(path1));
    fs.unlinkSync(path2);
    fs.rmdirSync(path.dirname(path2));
  });
});

describe("ProcessOutput", () => {
  it("should create ProcessOutput with all properties", () => {
    const output = new ProcessOutput(0, null, "stdout", "stderr");
    expect(output.exitCode).toBe(0);
    expect(output.signal).toBe(null);
    expect(output.stdout).toBe("stdout");
    expect(output.stderr).toBe("stderr");
    expect(output.combined).toBe("stdoutstderr");
    expect(output.message).toBe("Process exited with code 0");
  });

  it("should create ProcessOutput with custom message", () => {
    const output = new ProcessOutput(1, null, "", "", "Custom error");
    expect(output.message).toBe("Custom error");
  });

  it("should be an instance of Error", () => {
    const output = new ProcessOutput(1, null, "", "");
    expect(output).toBeInstanceOf(Error);
    expect(output.name).toBe("ProcessOutput");
  });
});

describe("$ command execution", () => {
  it("should execute simple commands", async () => {
    const result = await $({ cwd: process.cwd() })`echo hello`;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("should handle command arguments", async () => {
    const args = ["arg1", "arg2"];
    const result = await $({ cwd: process.cwd() })`echo ${args}`;
    expect(result.stdout.trim()).toBe("arg1 arg2");
  });

  it("should handle exit codes", async () => {
    try {
      await $({ cwd: process.cwd() })`false`;
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessOutput);
      if (error instanceof ProcessOutput) {
        expect(error.exitCode).toBe(1);
      }
    }
  });

  it("should support nothrow option", async () => {
    // Use a command that exists and returns non-zero exit code
    const result = await $({ cwd: process.cwd(), nothrow: true })`false`;
    expect(result.exitCode).toBe(1);
  });

  it("should support sync execution", () => {
    const result = $.sync`echo hello`;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("should handle environment variables", async () => {
    const result = await $({
      env: { TEST_VAR: "test_value" },
    })`printenv TEST_VAR`;
    expect(result.stdout.trim()).toBe("test_value");
  });

  it("should handle cwd option", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"));
    const result = await $({ cwd: tmpDir })`pwd`;
    // macOS symlinks /var/folders to /private/var/folders, so normalize paths
    // Use realpathSync to resolve symlinks for comparison
    const expectedPath = fs.realpathSync(tmpDir);
    const actualPath = fs.realpathSync(result.stdout.trim());
    expect(actualPath).toBe(expectedPath);
    fs.rmdirSync(tmpDir);
  });
});

describe("HookContext-bound exec/shell streaming", () => {
  // Subprocess output streams to `io.stdout` / `io.stderr` by default — long-running
  // commands (`docker buildx bake`, `kubectl apply`, etc.) need visible progress
  it("ctxExec streams subprocess stdout to io.stdout by default", async () => {
    const io = mockIO({
      argv: [],
      cwd: "/",
      onSpawn: () => ({
        exitCode: 0,
        stdout: "build step 1\nbuild step 2\n",
        stderr: "",
      }),
    });
    const ctxExec = makeCtxExec(io);
    await ctxExec("docker", ["buildx", "bake"], {});
    expect(io.stdout.text()).toContain("build step 1");
    expect(io.stdout.text()).toContain("build step 2");
  });

  it("ctxExec streams subprocess stderr to io.stderr by default", async () => {
    const io = mockIO({
      argv: [],
      cwd: "/",
      onSpawn: () => ({
        exitCode: 0,
        stdout: "",
        stderr: "#1 [internal] load build definition\n",
      }),
    });
    const ctxExec = makeCtxExec(io);
    await ctxExec("docker", ["buildx", "bake"], {});
    expect(io.stderr.text()).toContain("#1 [internal] load build definition");
  });

  it("ctxShell streams subprocess stdout to io.stdout by default", async () => {
    // The docker plugin's `runBake` path: `ctx.shell({ stdio: "pipe" })`.
    const io = mockIO({
      argv: [],
      cwd: "/",
      onSpawn: () => ({
        exitCode: 0,
        stdout: "#5 DONE 12.3s\n",
        stderr: "",
      }),
    });
    const ctxShell = makeCtxShell(io);
    await ctxShell({})`docker buildx bake -f bake.json`;
    expect(io.stdout.text()).toContain("#5 DONE 12.3s");
  });

  it("ctxShell suppresses streaming when silent: true", async () => {
    // Data-fetch path: caller parses `result.stdout` and doesn't want
    // the raw output on the runner log.
    const io = mockIO({
      argv: [],
      cwd: "/",
      onSpawn: () => ({
        exitCode: 0,
        stdout: '{"manifests":[]}',
        stderr: "",
      }),
    });
    const ctxShell = makeCtxShell(io);
    const result = await ctxShell({
      silent: true,
    })`docker buildx imagetools inspect tag --raw`;
    expect(io.stdout.text()).toBe("");
    expect(io.stderr.text()).toBe("");
    // `silent` only suppresses streaming — buffered result is unchanged.
    expect(result.stdout).toBe('{"manifests":[]}');
  });

  it("ctxExec callback wins over default streaming", async () => {
    // When the caller registers a callback, they take ownership of the
    // chunks — default streaming would be a duplicate write.
    const io = mockIO({
      argv: [],
      cwd: "/",
      onSpawn: () => ({ exitCode: 0, stdout: "chunk-data", stderr: "" }),
    });
    const ctxExec = makeCtxExec(io);
    const seen: string[] = [];
    await ctxExec("git", ["log"], {
      callback: (chunk) => {
        seen.push(chunk.toString());
      },
    });
    expect(seen.join("")).toBe("chunk-data");
    expect(io.stdout.text()).toBe("");
  });
});
