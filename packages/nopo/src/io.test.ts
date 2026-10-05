import { describe, expect, it } from "vitest";

import { realIO } from "./io.ts";

describe("realIO.spawn", () => {
  it("forwards opts.input to the child's stdin and closes the pipe", async () => {
    // stdin to EOF — `kubectl apply -f -`, `gpg --decrypt`, etc. The terraform plugin's
    // `applySecretManifestsViaStdin` hit this in CI when M2.1 first migrated to ctx.exec
    const result = await realIO.spawn("cat", [], { input: "hello world" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");
  });

  it("resolves when input is omitted (no stdin write attempt)", async () => {
    // `true` exits 0 immediately and never reads stdin. Verifies we
    // don't accidentally close stdin on the no-input path.
    const result = await realIO.spawn("true", []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("treats input='' as a real (empty) write — child sees EOF", async () => {
    // Distinguishes the empty-string case from undefined: `wc -c` should
    // see EOF immediately and report 0 bytes.
    const result = await realIO.spawn("wc", ["-c"], { input: "" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("0");
  });

  it("invokes onChunk for stdout while still buffering the result", async () => {
    const chunks: { source: "stdout" | "stderr"; text: string }[] = [];
    const result = await realIO.spawn(
      "sh",
      ["-c", "printf hello; printf world 1>&2"],
      {
        onChunk: (chunk, source) => {
          chunks.push({ source, text: chunk.toString() });
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("world");
    const stdoutText = chunks
      .filter((c) => c.source === "stdout")
      .map((c) => c.text)
      .join("");
    const stderrText = chunks
      .filter((c) => c.source === "stderr")
      .map((c) => c.text)
      .join("");
    expect(stdoutText).toBe("hello");
    expect(stderrText).toBe("world");
  });

  it("aborting the signal terminates the child without rejecting", async () => {
    const abort = new AbortController();
    // sleep 30 — should never finish naturally inside the test budget.
    const spawnPromise = realIO.spawn("sleep", ["30"], {
      signal: abort.signal,
    });
    // Give the child a moment to actually start before we kill it.
    await new Promise((r) => setTimeout(r, 50));
    abort.abort();
    const result = await spawnPromise;
    expect(result.exitCode).toBe(143);
  });
  it.each([
    ["SIGTERM", 143],
    ["SIGKILL", 137],
  ] as const)(
    "retains %s after a clean-looking summary",
    async (signal, code) => {
      const result = await realIO.spawn("node", [
        "-e",
        `require('node:fs').writeSync(1, '0 fail\\n'); process.kill(process.pid, '${signal}');`,
      ]);
      expect(result.exitCode).toBe(code);
      expect(result.stdout).toContain("0 fail");
    },
  );
});

describe("realIO.openProcess", () => {
  it("provides bidirectional IPC and tracks cleanup", async () => {
    const channel = realIO.openProcess!("node", [
      "-e",
      "process.on('message',m=>{process.send({echo:m});process.disconnect();});",
    ]);
    const message = new Promise((resolve) => channel.onMessage(resolve));
    await channel.send({ value: 42 });
    expect(await message).toEqual({ echo: { value: 42 } });
    expect(await channel.closed).toEqual({ exitCode: 0 });
    await expect(channel.send({ value: 43 })).rejects.toThrow("closed");
  });
  it("reports spawn errors through the channel without unhandled rejections", async () => {
    const channel = realIO.openProcess!("/definitely/missing/nopo-process", []);
    await expect(channel.closed).rejects.toThrow();
    await expect(channel.send({})).rejects.toThrow();
  });
  it("terminates a coordinator and its native workers as one process group", async () => {
    if (process.platform === "win32") return;
    const channel = realIO.openProcess!("node", [
      "-e",
      "const {spawn}=require('node:child_process');const child=spawn('node',['-e','setInterval(()=>{},1000)']);process.send({pid:child.pid});child.once('exit',()=>process.exit());process.on('SIGTERM',()=>{});",
    ]);
    const message = new Promise<{ pid: number }>((resolve) =>
      channel.onMessage((value) => resolve(value as { pid: number })),
    );
    const { pid } = await message;
    channel.kill("SIGTERM");
    expect((await channel.closed).exitCode).toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
