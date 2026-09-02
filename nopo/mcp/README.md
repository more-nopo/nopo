# Nopo MCP Server

MCP server for the nopo CLI. It exposes monorepo tools over the Model Context Protocol.

## What is Nopo?

Nopo is a CLI for Docker-based monorepos: build, orchestrate, test, and deploy services defined in `nopo.yml`.

## Core Concepts

### nopo.yml

The project root `nopo.yml` defines:

- **Services**: discovered under `services.dirs` (default `./packages` here)
- **Root commands**: commands that run at the project root
- **Plugins**: docker, docker-compose, terraform, playwright, sonar, diff, docs

Each service directory can have its own `nopo.yml`.

### Commands

Commands in `nopo.yml` can be a shell string or a map of named sub-commands (for example `check:lint`).

When you run `nopo <command> [targets]`, nopo:

1. Finds services that define that command
2. Filters to the specified targets (or runs on all)
3. Resolves a dependency-ordered plan
4. Runs commands in parallel stages

### Targets

- `nopo test nopo` — run tests on the `nopo` package
- `nopo check:types nopo` — run one sub-command of `check`
- `nopo test` — run `test` across every service that defines it

## MCP Tools

| Tool | Description |
|------|-------------|
| `nopo_info` | This documentation |
| `nopo_list` | List services/packages as JSON, with optional filter and jq |
| `nopo_status` | Check Docker containers and service health |
| `nopo_run` | Run infrastructure commands (build, up, down, env, pull, act) |
| `nopo_service_command` | Run service-defined commands (test, check, fix, compile, …) |

## Run locally

```bash
bun install
bun --cwd nopo/mcp run build
bun nopo/mcp/src/index.ts
```

Or via `.mcp.json` in this repo (`stdio` + `bun nopo/mcp/src/index.ts`).
