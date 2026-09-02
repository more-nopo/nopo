import { describe, expect, it } from "vitest";

import type { NormalizedService } from "../config/index.ts";
import { serializePlan } from "../plan.ts";
import { ScriptArgs } from "../script-args.ts";
import ListScript, {
  type ListChalk,
  type ListExec,
  type ListLogger,
  listRun,
  type ListRunContext,
} from "./list.ts";

// stubs

function identityChalk(): ListChalk {
  const id = (...args: unknown[]) => args.map((a) => String(a)).join("");
  return {
    cyan: id,
    bold: id,
    gray: id,
    yellow: id,
    blue: id,
    magenta: id,
  };
}

interface StubLogger extends ListLogger {
  lines: string[];
}

function stubLogger(): StubLogger {
  const lines: string[] = [];
  return {
    lines,
    chalk: identityChalk(),
    log: (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    },
  };
}

function stubIO(): {
  io: ListRunContext["io"];
  out: () => string;
} {
  let buf = "";
  const io: ListRunContext["io"] = {
    stdout: {
      write: (s: string) => {
        buf += s;
      },
    },
  };
  return { io, out: () => buf };
}

function noopExec(): ListExec {
  return async () => ({ exitCode: 0, stdout: "", stderr: "" });
}

function makeService(
  id: string,
  type: "package" | "service" = "service",
): NormalizedService {
  // listRun only reads `.description` / `.type` / `.runtime` / `.staticPath` off the entries
  // map (via getServicesWithConfig). Building a real NormalizedService here would require
  const partial = {
    id,
    type,
    description: `desc-${id}`,
    runtime: { cpu: "1", memory: "512Mi", port: 3000 },
    staticPath: `/static/${id}`,
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- structural test stub; see comment above
  return partial as unknown as NormalizedService;
}

function makeCtx(
  services: readonly string[],
  overrides: Partial<ListRunContext> = {},
): ListRunContext {
  const io = stubIO();
  const entries: Record<string, NormalizedService> = {};
  for (const id of services) entries[id] = makeService(id);
  return {
    services,
    entries,
    project: { name: "test", servicesDirs: ["./services"] },
    format: "text",
    validate: false,
    cwd: "/proj",
    io: io.io,
    logger: stubLogger(),
    exec: noopExec(),
    ...overrides,
  };
}

// ListScript.plan() — shape

describe("ListScript.plan", () => {
  it("returns a single-node plan with the list:run builtin", () => {
    const plan = ListScript.plan(new ScriptArgs({}), { targets: ["a"] });
    expect(plan.nodes.size).toBe(1);
    const node = plan.nodes.get("list");
    if (node === undefined) throw new Error("expected 'list' node");
    if (node.handler.kind !== "builtin") {
      throw new Error(`expected builtin handler, got ${node.handler.kind}`);
    }
    expect(node.handler.name).toBe("list:run");
    expect(node.meta?.script).toBe("list");
  });

  it("serializePlan round-trips the list plan losslessly", () => {
    const plan = ListScript.plan(new ScriptArgs({}), { targets: [] });
    const serialized = serializePlan(plan);
    expect(serialized.nodes).toHaveLength(1);
  });
});

// listRun — behavior

describe("listRun", () => {
  it("writes JSON with the documented shape for format=json", async () => {
    const io = stubIO();
    const ctx = makeCtx(["app"], { format: "json", io: io.io });
    await listRun(ctx);
    const parsed = JSON.parse(io.out());
    expect(Object.keys(parsed).sort()).toEqual(["config", "services"]);
    expect(parsed.config.name).toBe("test");
    expect(Object.keys(parsed.services)).toEqual(["app"]);
  });

  it("writes a comma-joined service list for format=csv", async () => {
    const io = stubIO();
    const ctx = makeCtx(["a", "b", "c"], { format: "csv", io: io.io });
    await listRun(ctx);
    expect(io.out()).toBe("a,b,c\n");
  });

  it("emits a single '✓ Valid' log line and returns when validate=true", async () => {
    const logger = stubLogger();
    const ctx = makeCtx(["a"], { validate: true, logger });
    await listRun(ctx);
    expect(logger.lines[0]).toBe("✓ Valid nopo.yml: test (1 services)");
  });

  it("throws when --jq is set without --json", async () => {
    const ctx = makeCtx(["a"], { format: "text", jqFilter: ".name" });
    await expect(listRun(ctx)).rejects.toThrow(/--jq requires --json format/);
  });

  it("logs 'No services found.' when services is empty in text format", async () => {
    const logger = stubLogger();
    const ctx = makeCtx([], { format: "text", logger });
    await listRun(ctx);
    expect(logger.lines).toContain("No services found.");
  });

  it("shells out to `jq -c <filter>` when jqFilter is set and format=json", async () => {
    interface Call {
      cmd: string;
      args: string[];
    }
    const calls: Call[] = [];
    const exec: ListExec = async (cmd, args) => {
      calls.push({ cmd, args });
      return { exitCode: 0, stdout: '"test"', stderr: "" };
    };
    const io = stubIO();
    const ctx = makeCtx(["a"], {
      format: "json",
      jqFilter: ".config.name",
      exec,
      io: io.io,
    });
    await listRun(ctx);
    expect(calls).toEqual([{ cmd: "jq", args: ["-c", ".config.name"] }]);
    expect(io.out()).toBe('"test"\n');
  });
});
