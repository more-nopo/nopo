import { describe, expect, it } from "vitest";

import type { PackageManagerConfig } from "../config/index.ts";
import { serializePlan } from "../plan.ts";
import { ScriptArgs } from "../script-args.ts";
import type { InstallExec } from "./install.ts";
import SyncScript, { type SyncLogger, syncRun } from "./sync.ts";

interface StubLogger extends SyncLogger {
  lines: string[];
}

function stubLogger(): StubLogger {
  const lines: string[] = [];
  return {
    lines,
    log: (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    },
  };
}

function makePm(
  name: string,
  overrides: Partial<PackageManagerConfig> = {},
): PackageManagerConfig {
  return {
    name,
    lockfile: `/proj/${name}.lock`,
    manifest: [`/proj/${name}.json`],
    install: { dev: `${name} install` },
    sync: `${name} sync`,
    modules: `/proj/${name}_modules`,
    cwd: "/proj",
    requires_source: false,
    ...overrides,
  };
}

interface RecordedExec {
  cmd: string;
  args: string[];
  cwd: string;
}

function stubExec(
  results: Record<string, { exitCode: number; stderr?: string }>,
): { fn: InstallExec; calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  const fn: InstallExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const key = args.at(-1) ?? "";
    const r = results[key] ?? { exitCode: 0 };
    return { exitCode: r.exitCode, stderr: r.stderr ?? "" };
  };
  return { fn, calls };
}

describe("SyncScript.plan", () => {
  it("returns a single-node plan with the sync:run builtin", () => {
    const plan = SyncScript.plan(new ScriptArgs({}), { targets: [] });

    expect(plan.nodes.size).toBe(1);
    const node = plan.nodes.get("sync");
    if (node === undefined) throw new Error("expected 'sync' node");
    if (node.handler.kind !== "builtin") {
      throw new Error(`expected builtin handler, got ${node.handler.kind}`);
    }
    expect(node.handler.name).toBe("sync:run");
    expect(node.meta?.script).toBe("sync");
  });

  it("serializePlan round-trips the sync plan losslessly", () => {
    const plan = SyncScript.plan(new ScriptArgs({}), { targets: [] });
    const serialized = serializePlan(plan);
    expect(serialized.nodes).toHaveLength(1);
    expect(serialized.nodes[0]).toMatchObject({
      id: "sync",
      handler: { kind: "builtin", name: "sync:run" },
    });
  });
});

describe("syncRun", () => {
  it("logs a single 'No package managers' line and returns on empty packageManagers", async () => {
    const logger = stubLogger();
    const exec = stubExec({});
    await syncRun({
      packageManagers: [],
      env: {},
      logger,
      exec: exec.fn,
    });
    expect(logger.lines).toEqual([
      "No package managers configured for targets",
    ]);
    expect(exec.calls).toEqual([]);
  });

  it("invokes `sh -c <pm.sync>` for each PM", async () => {
    const logger = stubLogger();
    const exec = stubExec({});
    await syncRun({
      packageManagers: [makePm("uv", { sync: "uv sync --frozen" })],
      env: {},
      logger,
      exec: exec.fn,
    });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]).toMatchObject({
      cmd: "sh",
      args: ["-c", "uv sync --frozen"],
    });
    expect(logger.lines).toContain("Syncing uv dependencies...");
    expect(logger.lines).toContain("uv sync complete");
  });

  it("throws when a PM sync command exits non-zero", async () => {
    const logger = stubLogger();
    const exec = stubExec({
      "uv-sync-fail": { exitCode: 1, stderr: "lockfile drift" },
    });
    await expect(
      syncRun({
        packageManagers: [makePm("uv", { sync: "uv-sync-fail" })],
        env: {},
        logger,
        exec: exec.fn,
      }),
    ).rejects.toThrow(/uv sync failed \(exit 1\)/);
  });
});
