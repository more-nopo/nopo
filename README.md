# Nopo

A TypeScript CLI for monorepo Docker builds, service orchestration, testing, and deployment.

Nopo is licensed under GPL-3.0-only.

The published package is `@more-nopo/nopo`. The bin name is `nopo`.

This repository ships the CLI, first-party plugins, docs, and an MCP server (`nopo/mcp`). Docs publish to https://more-nopo.github.io/nopo/.

## Setup

```bash
bun install
nopo --help
```

`bun install` links workspace `@more-nopo/nopo` so the `nopo` bin is on PATH.

Install from GitHub Packages:

```bash
# .npmrc
# @more-nopo:registry=https://npm.pkg.github.com
bun add -g @more-nopo/nopo
```

GitHub Packages still needs a token with `read:packages` for install.

## Commands

```bash
nopo build [service]
nopo up [service]
nopo check [service]
nopo test [service]
nopo fix [service]
nopo env
nopo status
nopo list
```

Target commands can delegate directly to a registered plugin:

```yaml
commands:
  test:
    plugin: vitest
    args: ["--maxWorkers=2"]
```

`nopo test ui` passes the owning target and command environment to Vitest. Plugins
may declare an explicit default command; missing defaults or command references
fail validation before execution. See [command configuration](nopo/docs/cli/commands/config.md).

The [Vitest plugin](nopo/plugins/vitest/README.md) provides `run` (default) and
`list`. The [Bun plugin](nopo/plugins/bun/README.md) provides `test` (default),
`run`, and `build`, independently of Bun package-manager configuration.

```bash
nopo vitest run web ui
nopo vitest list web ui -- --filesOnly --json
nopo bun test api -- ./test/
```

## CI

Merges to `main` go through GitHub's native merge queue. Job `ci` runs `nopo test` on pull requests and on the merge group. Job `platforms` (ubuntu and macOS) runs on the merge group only.

## Prerequisites

- Bun 1.3+
- Node.js 22+
