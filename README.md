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

## CI

Merges to `main` go through GitHub's native merge queue. Job `ci` runs `nopo test` on pull requests and on the merge group. Job `platforms` (ubuntu and macOS) runs on the merge group only.

## Prerequisites

- Bun 1.3+
- Node.js 22+
