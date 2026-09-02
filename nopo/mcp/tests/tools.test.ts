import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerTools } from "../src/tools.js";

vi.mock("../src/spawn.js", () => ({
  spawnNopo: vi.fn(),
}));

import { spawnNopo } from "../src/spawn.js";

const mockSpawn = vi.mocked(spawnNopo);

function makeResult(
  overrides: Partial<{ stdout: string; stderr: string; exitCode: number }> = {},
) {
  return { stdout: "", stderr: "", exitCode: 0, ...overrides };
}

function getTextContent(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string[] {
  const items = Array.isArray(result.content) ? result.content : [];
  return items
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text);
}

describe("MCP tools", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    mockSpawn.mockReset();
    mockSpawn.mockResolvedValue(makeResult({ stdout: "{}" }));

    server = new McpServer({ name: "nopo", version: "0.0.0" });
    registerTools(server);

    client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("lists all 5 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "nopo_info",
      "nopo_list",
      "nopo_run",
      "nopo_service_command",
      "nopo_status",
    ]);
  });

  describe("nopo_info", () => {
    it("returns README content without calling spawnNopo", async () => {
      const result = await client.callTool({
        name: "nopo_info",
        arguments: {},
      });
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      const texts = getTextContent(result);
      expect(texts).toHaveLength(1);
      const text = texts[0] ?? "";
      expect(text).toContain("# Nopo MCP Server");
      expect(text).toContain("nopo.yml");
      expect(text).toContain("nopo_list");
    });
  });

  describe("nopo_list", () => {
    it("calls spawnNopo with --json", async () => {
      const result = await client.callTool({
        name: "nopo_list",
        arguments: {},
      });
      expect(mockSpawn).toHaveBeenCalledWith(["list", "--json"], undefined);
      expect(result.isError).toBeFalsy();
    });

    it("passes filter and jq args", async () => {
      const result = await client.callTool({
        name: "nopo_list",
        arguments: { filter: ["buildable", "changed"], jq: ".name" },
      });
      expect(mockSpawn).toHaveBeenCalledWith(
        [
          "list",
          "--json",
          "--filter",
          "buildable",
          "--filter",
          "changed",
          "--jq",
          ".name",
        ],
        undefined,
      );
      expect(result.isError).toBeFalsy();
    });
  });

  describe("nopo_status", () => {
    it("calls spawnNopo with status", async () => {
      const result = await client.callTool({
        name: "nopo_status",
        arguments: {},
      });
      expect(mockSpawn).toHaveBeenCalledWith(["status"], undefined);
      expect(result.isError).toBeFalsy();
    });
  });

  describe("nopo_run", () => {
    it("calls spawnNopo with the command", async () => {
      const result = await client.callTool({
        name: "nopo_run",
        arguments: { command: "build" },
      });
      expect(mockSpawn).toHaveBeenCalledWith(["build"], undefined);
      expect(result.isError).toBeFalsy();
    });

    it("passes extra args and timeout", async () => {
      const result = await client.callTool({
        name: "nopo_run",
        arguments: { command: "up", args: ["backend"], timeout_ms: 30000 },
      });
      expect(mockSpawn).toHaveBeenCalledWith(["up", "backend"], 30000);
      expect(result.isError).toBeFalsy();
    });
  });

  describe("nopo_service_command", () => {
    it("calls spawnNopo with command and targets", async () => {
      const result = await client.callTool({
        name: "nopo_service_command",
        arguments: { command: "test", targets: ["backend", "ui"] },
      });
      expect(mockSpawn).toHaveBeenCalledWith(
        ["test", "backend", "ui"],
        undefined,
      );
      expect(result.isError).toBeFalsy();
    });

    it("runs without targets", async () => {
      const result = await client.callTool({
        name: "nopo_service_command",
        arguments: { command: "check" },
      });
      expect(mockSpawn).toHaveBeenCalledWith(["check"], undefined);
      expect(result.isError).toBeFalsy();
    });
  });

  describe("output formatting", () => {
    it("returns stdout as text content", async () => {
      mockSpawn.mockResolvedValue(
        makeResult({ stdout: "hello world", stderr: "" }),
      );
      const result = await client.callTool({
        name: "nopo_status",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
    });

    it("combines stdout and stderr", async () => {
      mockSpawn.mockResolvedValue(makeResult({ stdout: "out", stderr: "err" }));
      const result = await client.callTool({
        name: "nopo_status",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: "text", text: "out\nerr" }]);
    });

    it("returns '(no output)' when stdout and stderr are empty", async () => {
      mockSpawn.mockResolvedValue(makeResult({ stdout: "", stderr: "" }));
      const result = await client.callTool({
        name: "nopo_status",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: "text", text: "(no output)" }]);
    });
  });

  describe("error handling", () => {
    it("returns isError for non-zero exit code", async () => {
      mockSpawn.mockResolvedValue(
        makeResult({ exitCode: 1, stderr: "something failed" }),
      );
      const result = await client.callTool({
        name: "nopo_status",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const texts = getTextContent(result);
      expect(texts).toHaveLength(1);
      const text = texts[0] ?? "";
      expect(text).toContain("Exit code 1");
      expect(text).toContain("something failed");
    });

    it("returns isError when spawn rejects", async () => {
      mockSpawn.mockRejectedValue(new Error("timed out after 120000ms"));
      const result = await client.callTool({
        name: "nopo_status",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const texts = getTextContent(result);
      expect(texts).toHaveLength(1);
      const text = texts[0] ?? "";
      expect(text).toContain("timed out after 120000ms");
    });
  });
});
