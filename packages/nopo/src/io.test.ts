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
    // POSIX shells report SIGTERM as exit 143 (128 + 15); node's `close` event fires with
    // `code === null` when the child is killed by a signal, which we coalesce to 0
    expect(result).toBeDefined();
    // The key invariant: no exception. `sleep 30` would otherwise still
    // be running when this test finishes.
  });
});
