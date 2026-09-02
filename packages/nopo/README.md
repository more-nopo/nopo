# Nopo CLI

A TypeScript CLI for managing the nopo monorepo — Docker builds, service orchestration, testing, and deployment.

## Setup

Bun runs TypeScript directly — no build step needed.

```bash
# From the monorepo root:
bun install                    # Installs deps + links nopo to node_modules/.bin/

# Make nopo available as a bare command:
sudo ln -sf "$(pwd)/node_modules/.bin/nopo" /usr/local/bin/nopo
```

## How it works

1. `bun install` reads root `package.json` workspaces, finds `packages/nopo` (package name: `@more-nopo/nopo`)
2. The `bin` field in `packages/nopo/package.json` points to `bin.js`
3. `bin.js` has `#!/usr/bin/env bun` and `await import("./bin.ts")` — Bun runs TypeScript natively. `bin.ts` awaits `main()` under a process keep-alive so Bun cannot exit 0 while work is still pending.
4. `bun install` creates a symlink: `node_modules/.bin/nopo` → `packages/nopo/bin.js`
5. The `/usr/local/bin` symlink makes `nopo` available globally

## Commands

```bash
nopo build [service]      # Build Docker images
nopo up [service]         # Start services
nopo check [service]      # Lint + type check
nopo test [service]       # Run tests
nopo fix [service]        # Auto-fix lint issues
nopo env                  # Set up environment variables
nopo status               # Show project status
nopo list                 # List all services
```

## Prerequisites

- Bun 1.3+
- Docker and Docker Compose
- Node.js 22+ (for some tooling that doesn't support Bun yet)

## Architecture

The CLI uses a plugin system. Plugins are loaded from `nopo/plugins/*/src/index.ts` (Bun runs TS directly — no compilation needed).

| Plugin | Purpose |
|--------|---------|
| docker | Docker Buildx image builds |
| terraform | K8s deployment, infrastructure |
| playwright | E2E testing |
| docs | Documentation site |

Nopo is licensed under GPL-3.0-only.
