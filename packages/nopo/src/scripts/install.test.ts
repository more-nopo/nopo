import { describe, expect, it } from "vitest";

import type { PackageManagerConfig } from "../config/index.ts";
import { serializePlan } from "../plan.ts";
import { ScriptArgs } from "../script-args.ts";
import InstallScript, {
  type InstallExec,
  type InstallLogger,
  installRun,
} from "./install.ts";

// stubs

interface StubLogger extends InstallLogger {
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

// InstallScript.plan() — shape

describe("InstallScript.plan", () => {
  it("returns a single-node plan with the install:run builtin", () => {
    const plan = InstallScript.plan(new ScriptArgs({}), { targets: ["a"] });

    expect(plan.nodes.size).toBe(1);
    const node = plan.nodes.get("install");
    if (node === undefined) throw new Error("expected 'install' node");
    expect(node.id).toBe("install");
    if (node.handler.kind !== "builtin") {
      throw new Error(`expected builtin handler, got ${node.handler.kind}`);
    }
    expect(node.handler.name).toBe("install:run");
    expect([...node.needs]).toEqual([]);
    expect(node.meta?.script).toBe("install");
  });

  it("serializePlan round-trips the install plan losslessly", () => {
    const plan = InstallScript.plan(new ScriptArgs({}), { targets: [] });
    const serialized = serializePlan(plan);
    const json: unknown = JSON.parse(JSON.stringify(serialized));
    expect(json).toEqual(serialized);
    expect(serialized.nodes).toHaveLength(1);
    expect(serialized.nodes[0]).toMatchObject({
      id: "install",
      handler: { kind: "builtin", name: "install:run" },
      needs: [],
      meta: { script: "install" },
    });
  });
});

// installRun — behavior

describe("installRun", () => {
  it("logs a single 'No package managers' line and returns on empty packageManagers", async () => {
    const logger = stubLogger();
    const exec = stubExec({});
    await installRun({
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

  it("invokes `sh -c <pm.install>` for each PM in order", async () => {
    const logger = stubLogger();
    const exec = stubExec({});
    const pmA = makePm("a", { install: { dev: "a-install" } });
    const pmB = makePm("b", { install: { dev: "b-install" } });

    await installRun({
      packageManagers: [pmA, pmB],
      env: { NODE_ENV: "test" },
      logger,
      exec: exec.fn,
    });

    expect(exec.calls).toHaveLength(2);
    expect(exec.calls[0]).toMatchObject({
      cmd: "sh",
      args: ["-c", "a-install"],
      cwd: "/proj",
    });
    expect(exec.calls[1]).toMatchObject({
      cmd: "sh",
      args: ["-c", "b-install"],
    });
  });

  it("emits per-PM start + complete log lines", async () => {
    const logger = stubLogger();
    const exec = stubExec({});
    await installRun({
      packageManagers: [makePm("bun")],
      env: {},
      logger,
      exec: exec.fn,
    });
    expect(logger.lines).toContain("Installing bun dependencies...");
    expect(logger.lines).toContain("bun install complete");
  });

  it("throws when a PM install command exits non-zero, surfacing the stderr", async () => {
    const logger = stubLogger();
    const exec = stubExec({
      "broken-install": { exitCode: 2, stderr: "boom" },
    });

    await expect(
      installRun({
        packageManagers: [
          makePm("broken", { install: { dev: "broken-install" } }),
        ],
        env: {},
        logger,
        exec: exec.fn,
      }),
    ).rejects.toThrow(/broken install failed \(exit 2\)/);
  });
});
