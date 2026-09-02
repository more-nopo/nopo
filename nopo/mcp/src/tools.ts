import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { spawnNopo } from "./spawn.js";

// In CJS (esbuild bundle), __dirname is a global.
// In ESM (tsx), we derive it from import.meta.url.
const _dir =
  typeof __dirname === "string"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
const INFO_TEXT = readFileSync(resolve(_dir, "../README.md"), "utf-8");

const RUN_COMMANDS = ["build", "up", "down", "env", "pull", "act"] as const;

async function run(args: string[], timeoutMs?: number) {
  try {
    const result = await spawnNopo(args, timeoutMs);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const text = output || "(no output)";

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Exit code ${result.exitCode}\n${text}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text" as const, text }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: err instanceof Error ? err.message : String(err),
        },
      ],
      isError: true,
    };
  }
}

export function registerTools(server: McpServer) {
  server.tool(
    "nopo_info",
    "Get documentation about the nopo CLI: what it is, how it works, how to discover services/commands, and common workflows. Call this first if you are unfamiliar with nopo.",
    async () => {
      return {
        content: [{ type: "text" as const, text: INFO_TEXT }],
      };
    },
  );

  server.tool(
    "nopo_list",
    "List services and packages in the nopo monorepo with their configuration. Returns JSON. Use filter to narrow results and jq to extract specific fields.",
    {
      filter: z
        .array(z.string())
        .optional()
        .describe("Filter expressions (e.g. ['buildable', 'changed'])"),
      jq: z
        .string()
        .optional()
        .describe(
          "jq expression to extract specific fields from the JSON output",
        ),
      since: z
        .string()
        .optional()
        .describe("Git ref for changed filter (e.g. 'main', 'HEAD~3')"),
      tags: z
        .string()
        .optional()
        .describe("Tag filter (comma-separated, e.g. 'frontend,backend')"),
      validate: z
        .boolean()
        .optional()
        .describe("Validate nopo.yml configuration"),
    },
    async ({ filter, jq, since, tags, validate }) => {
      const args = ["list", "--json"];
      if (filter) {
        for (const f of filter) {
          args.push("--filter", f);
        }
      }
      if (since) {
        args.push("--since", since);
      }
      if (tags) {
        args.push("--tags", tags);
      }
      if (validate) {
        args.push("--validate");
      }
      if (jq) {
        args.push("--jq", jq);
      }
      return run(args);
    },
  );

  server.tool(
    "nopo_status",
    "Check the status of the nopo project: Docker containers, services, and overall health.",
    async () => {
      return run(["status"]);
    },
  );

  server.tool(
    "nopo_run",
    "Run a core nopo infrastructure command. Use this for build, up, down, env, pull, or act. If Docker is not running (e.g. 'Cannot connect to the Docker daemon'), commands that support it can be retried with context: 'host'.",
    {
      command: z.enum(RUN_COMMANDS).describe("The nopo command to run"),
      args: z
        .array(z.string())
        .optional()
        .describe("Additional arguments to pass to the command"),
      targets: z
        .array(z.string())
        .optional()
        .describe(
          "Service targets (e.g. ['backend', 'web']). Applies to build, up, down.",
        ),
      filter: z
        .array(z.string())
        .optional()
        .describe("Filter expressions (e.g. ['buildable', 'changed'])"),
      since: z
        .string()
        .optional()
        .describe("Git ref for changed filter (e.g. 'main', 'HEAD~3')"),
      tags: z
        .string()
        .optional()
        .describe("Tag filter (comma-separated, e.g. 'frontend,backend')"),
      no_cache: z
        .boolean()
        .optional()
        .describe("Build without cache (only applies to build command)"),
      timeout_ms: z
        .number()
        .optional()
        .describe("Timeout in milliseconds (default 120000, max 600000)"),
    },
    async ({
      command,
      args: extraArgs,
      targets,
      filter,
      since,
      tags,
      no_cache,
      timeout_ms,
    }) => {
      const args: string[] = [command];
      if (filter) {
        for (const f of filter) {
          args.push("--filter", f);
        }
      }
      if (since) {
        args.push("--since", since);
      }
      if (tags) {
        args.push("--tags", tags);
      }
      if (no_cache) {
        args.push("--no-cache");
      }
      if (extraArgs) {
        args.push(...extraArgs);
      }
      if (targets) {
        args.push(...targets);
      }
      return run(args, timeout_ms);
    },
  );

  server.tool(
    "nopo_service_command",
    "Run a service-specific command defined in nopo.yml (e.g. test, check, fix, compile, lint, format, migrate, makemigrations). This is the primary way to run quality checks and tests. If Docker is not running (e.g. 'Cannot connect to the Docker daemon'), retry with context: 'host' to run directly on the host machine.",
    {
      command: z
        .string()
        .describe(
          "The command to run (e.g. 'test', 'check', 'fix', 'compile', 'lint')",
        ),
      subcommand: z
        .string()
        .optional()
        .describe(
          "Sub-command inserted after command name (e.g. 'lint' for 'check lint')",
        ),
      targets: z
        .array(z.string())
        .optional()
        .describe(
          "Service/package targets to run the command on (e.g. ['backend', 'ui']). Omit to run on all.",
        ),
      context: z
        .enum(["host", "container"])
        .optional()
        .describe(
          "Override execution context: 'host' runs directly on host, 'container' runs in Docker",
        ),
      filter: z
        .array(z.string())
        .optional()
        .describe("Filter expressions (e.g. ['buildable', 'changed'])"),
      since: z
        .string()
        .optional()
        .describe("Git ref for changed filter (e.g. 'main', 'HEAD~3')"),
      timeout_ms: z
        .number()
        .optional()
        .describe("Timeout in milliseconds (default 120000, max 600000)"),
    },
    async ({
      command,
      subcommand,
      targets,
      context,
      filter,
      since,
      timeout_ms,
    }) => {
      const args: string[] = [command];
      if (subcommand) {
        args.push(subcommand);
      }
      if (context) {
        args.push("--context", context);
      }
      if (filter) {
        for (const f of filter) {
          args.push("--filter", f);
        }
      }
      if (since) {
        args.push("--since", since);
      }
      if (targets) {
        args.push(...targets);
      }
      return run(args, timeout_ms);
    },
  );
}
