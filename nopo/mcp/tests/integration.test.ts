import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BUILD_PATH = path.resolve(__dirname, "..", "build", "index.cjs");

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

let child: ChildProcess;
let requestId = 0;

function sendRequest(method: string, params: Record<string, unknown> = {}) {
  const id = ++requestId;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  child.stdin!.write(msg + "\n");
  return id;
}

function waitForResponse(
  expectedId: number,
  timeoutMs = 30_000,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for response id=${expectedId}`)),
      timeoutMs,
    );

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed: JsonRpcResponse = JSON.parse(line);
          if (parsed.id === expectedId) {
            clearTimeout(timer);
            child.stdout!.off("data", onData);
            resolve(parsed);
            return;
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    };

    child.stdout!.on("data", onData);
  });
}

describe.skipIf(!!process.env.CI)(
  "MCP integration",
  { timeout: 30_000 },
  () => {
    beforeAll(() => {
      child = spawn("node", [BUILD_PATH], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      });
    });

    afterAll(() => {
      child.kill("SIGTERM");
    });

    it("initializes and returns server info", async () => {
      const id = sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      });
      const resp = await waitForResponse(id);
      expect(resp.result).toBeDefined();
      expect(resp.result?.serverInfo).toEqual(
        expect.objectContaining({ name: "nopo" }),
      );

      // send initialized notification (no response expected)
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
      // small delay to let the server process the notification
      await new Promise((r) => setTimeout(r, 100));
    });

    it("lists 5 tools", async () => {
      const id = sendRequest("tools/list");
      const resp = await waitForResponse(id);
      expect(resp.result).toBeDefined();
      const tools = resp.result?.tools;
      expect(tools).toBeInstanceOf(Array);
      expect(tools).toHaveLength(5);
      const toolArray = tools instanceof Array ? tools : [];
      const names = toolArray
        .map((t: Record<string, unknown>) => String(t.name))
        .sort();
      expect(names).toEqual([
        "nopo_info",
        "nopo_list",
        "nopo_run",
        "nopo_service_command",
        "nopo_status",
      ]);
    });

    it("calls nopo_list and returns JSON output", async () => {
      const id = sendRequest("tools/call", {
        name: "nopo_list",
        arguments: {},
      });
      const resp = await waitForResponse(id, 60_000);
      expect(resp.result).toBeDefined();
      expect(resp.result?.isError).toBeFalsy();
      const content = resp.result?.content;
      expect(content).toBeInstanceOf(Array);
      expect(content).toHaveLength(1);
      const contentArray = content instanceof Array ? content : [];
      const first: Record<string, unknown> = contentArray[0] ?? {};
      const text = String(first.text ?? "");
      expect(() => JSON.parse(text)).not.toThrow();
    });
  },
);
