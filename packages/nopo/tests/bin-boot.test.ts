import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(pkgRoot, "../..");
const binJs = path.join(pkgRoot, "bin.js");
const binTs = path.join(pkgRoot, "bin.ts");

describe("CLI boot keep-alive", () => {
  it("bin.js awaits the TypeScript entry", () => {
    const src = readFileSync(binJs, "utf8");
    expect(src).toMatch(/await\s+import\(\s*["']\.\/bin\.ts["']\s*\)/);
    expect(src).not.toMatch(
      /^\s*import\(\s*["']\.\/bin\.ts["']\s*\)\s*;?\s*$/m,
    );
  });

  it("bin.ts awaits main() under withProcessKeepAlive", () => {
    const src = readFileSync(binTs, "utf8");
    expect(src).toMatch(/withProcessKeepAlive/);
    expect(src).toMatch(/await\s+main\s*\(/);
  });

  it("bun bin.js --help reaches main and exits 0", async () => {
    const result = await new Promise<{
      exitCode: number | null;
      stdout: string;
    }>((resolve, reject) => {
      const child = spawn("bun", [binJs, "--help"], {
        cwd: repoRoot,
        env: process.env,
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({ exitCode, stdout });
      });
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Usage: nopo/);
  });
});
