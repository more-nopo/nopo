import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { HookContext } from "@more-nopo/nopo/plugin";
import { runBunTest, selectTestArgs, testSchema } from "./test-policy.ts";
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
describe("Bun test policy", () => {
  it("explicit files replace the profile scope and preserve native flags", () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "bun-selection-")),
    );
    roots.push(root);
    mkdirSync(path.join(root, "test"));
    writeFileSync(path.join(root, "test/one.test.ts"), "");
    const options = testSchema.parse({
      profiles: {
        integration: { args: ["--timeout=30000"], files: ["./test/"] },
      },
    });
    expect(selectTestArgs(["--profile=integration"], options, root)).toEqual([
      "--timeout=30000",
      "./test/",
    ]);
    expect(
      selectTestArgs(
        ["--profile", "integration", "--files", "./test/one.test.ts"],
        options,
        root,
      ),
    ).toEqual(["--timeout=30000", path.join(root, "test/one.test.ts")]);
    expect(() => selectTestArgs(["--files"], options, root)).toThrow();
    expect(() =>
      selectTestArgs(["--files", "test/missing.test.ts"], options, root),
    ).toThrow();
    expect(() => selectTestArgs(["--profile=typo"], options, root)).toThrow();
  });
  it.each([99, 100, 1, 137])(
    "guards shutdown exit %i with a clean summary",
    async (code) => {
      const exec = vi.fn();
      const ctx = {
        exec,
        io: { stderr: { write: vi.fn() } },
      } as unknown as HookContext;
      const options = testSchema.parse({ shutdown: "after-success" });
      for (const summary of ["0 fail\n", "1 fail\n", "0 fail\n1 fail\n", ""]) {
        const result = { exitCode: code, stdout: "", stderr: summary };
        exec.mockResolvedValue(result);
        const promise = runBunTest(ctx, [], "/tmp", {}, options);
        if ([99, 100].includes(code) && summary === "0 fail\n")
          await expect(promise).resolves.toBeUndefined();
        else await expect(promise).rejects.toEqual(result);
      }
      expect(exec.mock.calls[0]![2]).toMatchObject({
        stdio: "pipe",
        nothrow: true,
      });
    },
  );
});
