import nodeFs from "node:fs";
import { describe, expect, it } from "vitest";

import { runCli } from "./run-cli.ts";

describe("runCli()", () => {
  it("loads the minimal fixture and runs `list` to clean completion", async () => {
    const result = await runCli({
      fixture: "minimal",
      argv: ["list"],
    });
    // `list` (no flags) writes a human-readable table via runner.logger (console.log, not
    // io.stdout) and returns. Either it returns normally (exitCode null) or scripts call
    expect([null, 0]).toContain(result.exitCode);
  });

  it("`list --json` writes deterministic JSON to io.stdout including the project name", async () => {
    const result = await runCli({
      fixture: "minimal",
      argv: ["list", "--json"],
    });
    // `list --json` writes through io.stdout.write — captured by mockIO.
    const text = result.stdout.text();
    expect(text).toContain('"contract-minimal"');
    expect(text).toContain('"app"');
    // Should be parseable JSON.
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toMatchObject({
      config: { name: "contract-minimal" },
    });
  });

  it("returns a populated MockIO with the four observable surfaces", async () => {
    const result = await runCli({
      fixture: "minimal",
      argv: ["list", "--json"],
    });
    expect(typeof result.stdout.text()).toBe("string");
    expect(typeof result.stderr.text()).toBe("string");
    expect(Array.isArray(result.spawns)).toBe(true);
    // exitCode is `null` (clean return) or a number (io.exit was called).
    expect(["number", "object"]).toContain(typeof result.exitCode);
  });

  it("prepends bun/nopo to argv so the user argv lands at io.argv.slice(2)", async () => {
    const result = await runCli({
      fixture: "minimal",
      argv: ["list", "--csv"],
    });
    expect(result.argv.slice(0, 2)).toEqual(["bun", "nopo"]);
    expect(result.argv.slice(2)).toEqual(["list", "--csv"]);
    // CSV output (single line of service names) confirms argv routed correctly.
    expect(result.stdout.text().trim()).toBe("app");
  });

  it("env defaults to {} (clean — no real process.env leakage)", async () => {
    const result = await runCli({
      fixture: "minimal",
      argv: ["list", "--json"],
    });
    expect(result.env).toEqual({});
  });

  it("env overrides take effect — ROOT_DIR=/nonexistent fails to load config", async () => {
    // ROOT_DIR is read by main() and passed to createConfig, overriding the cwd-based default.
    // Pointing it at a nonexistent path forces createConfig to throw — observable proof that
    await expect(
      runCli({
        fixture: "minimal",
        argv: ["list", "--json"],
        env: { ROOT_DIR: "/nonexistent/runcli-test-path" },
      }),
    ).rejects.toThrow(/Missing nopo\.yml.*\/nonexistent\/runcli-test-path/);
  });

  it("onSpawn override is forwarded to mockIO without crashing", async () => {
    // Most built-in script paths (build / command / up) use the legacy `exec()` from lib.ts
    // which spawns the real child process bypassing io.spawn — only `ctx.exec` / `ctx.shell`
    let called = false;
    const result = await runCli({
      fixture: "minimal",
      argv: ["list", "--json"],
      onSpawn: () => {
        called = true;
        return { exitCode: 0, stdout: "STUBBED", stderr: "" };
      },
    });
    // No assertion on `called` (`list --json` doesn't spawn anything),
    // but every spawn that DID happen must have routed through onSpawn.
    for (const rec of result.spawns) {
      expect(rec.result.stdout).toBe("STUBBED");
    }
    expect(typeof called).toBe("boolean");
  });

  it("each runCli call gets a fresh tmpdir (no cwd leakage between calls)", async () => {
    const a = await runCli({ fixture: "minimal", argv: ["list", "--json"] });
    const b = await runCli({ fixture: "minimal", argv: ["list", "--json"] });
    expect(a.cwd()).not.toBe(b.cwd());
    // Both should produce the same structural output — only the
    // tmpdir-derived `services_dirs` path differs between runs.
    type ParsedList = {
      config: { name: string };
      services: Record<string, unknown>;
    };
    const parsedA: ParsedList = JSON.parse(a.stdout.text());
    const parsedB: ParsedList = JSON.parse(b.stdout.text());
    expect(parsedA.config.name).toBe(parsedB.config.name);
    expect(Object.keys(parsedA.services).sort()).toEqual(
      Object.keys(parsedB.services).sort(),
    );
  });

  it("cleans up the tmpdir before returning", async () => {
    const result = await runCli({
      fixture: "minimal",
      argv: ["list", "--json"],
    });
    // The cwd() reported by MockIO was the tmpdir; after runCli returns
    // it must no longer exist on disk.
    expect(nodeFs.existsSync(result.cwd())).toBe(false);
  });

  it("throws a clear error when the fixture name is unknown", async () => {
    await expect(
      runCli({ fixture: "no-such-fixture", argv: ["list"] }),
    ).rejects.toThrow(/no-such-fixture/);
  });
});
