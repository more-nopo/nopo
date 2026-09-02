# Essentials

Essential nopo commands for 80% of common use cases.

## Quick Start

```bash
# 1. Validate setup
nopo list --validate

# 2. Start services
nopo up

# 3. Quick linting (host)
nopo lint

# 4. Test in containers
nopo run test

# 5. Check status
nopo status
```

## Core Commands

### Build & Deploy

| Goal           | Command                  | Notes                      |
| -------------- | ------------------------ | -------------------------- |
| Build all      | `nopo build`             | Builds base + all services |
| Build specific | `nopo build backend web` | Faster, only what you need |
| Build fresh    | `nopo build --no-cache`  | Clears cache, slower       |
| Start all      | `nopo up`                | Auto-builds if needed      |
| Start specific | `nopo up backend`        | Only required services     |
| Stop all       | `nopo down`              | Clean shutdown             |
| Stop specific  | `nopo down backend`      | Keep others running        |

### Information & Validation

| Goal               | Command                        | Output                         |
| ------------------ | ------------------------------ | ------------------------------ |
| List services      | `nopo list`                    | Table with service info        |
| JSON output        | `nopo list --json`             | Machine-readable               |
| Buildable services | `nopo list --filter buildable` | Only services with Dockerfiles |
| System status      | `nopo status`                  | Running containers             |
| Environment        | `nopo env`                     | Current env variables          |

### Development Workflow

| Phase         | Command              | Purpose                |
| ------------- | -------------------- | ---------------------- |
| Quick checks  | `nopo lint web`      | Fast, on host          |
| Testing       | `nopo run test`      | Isolated in containers |
| Code style    | `nopo run format`    | Consistent formatting  |
| Type checking | `nopo run typecheck` | Catch errors early     |

## Common Patterns

### Target Selection

```bash
# Operate on specific services
nopo build backend web
nopo up backend
nopo down web

# Single service operations
nopo lint backend
nopo run test web
```

### Environment Control

```bash
# Development
NODE_ENV=development nopo up

# Production
NODE_ENV=production DOCKER_REGISTRY=registry.com nopo build

# Local testing
DOCKER_VERSION=local nopo build
```

### Output Formats

```bash
# Human readable
nopo list
nopo status

# Machine readable
nopo list --json
nopo list --csv
nopo status --json
```

## When to Use What

### Fast Development

```bash
nopo lint web        # Quick checks (host)
nopo up web         # Start one service
nopo run test web     # Test (container)
```

### Full Workflow

```bash
nopo build           # Build everything
nopo up              # Start everything
nopo list --json     # Get inventory
nopo down            # Stop everything
```

### CI/CD Pipeline

```bash
nopo list --validate  # Check config
nopo build --no-cache # Fresh build
nopo run test         # Run tests
DOCKER_PUSH=true nopo build  # Push to registry
```

## Troubleshooting Quick Fixes

| Issue                 | Command                 | Fix                     |
| --------------------- | ----------------------- | ----------------------- |
| Service not found     | `nopo list`             | Check available targets |
| Config error          | `nopo list --validate`  | Validate setup          |
| Container won't start | `nopo down && nopo up`  | Clean restart           |
| Build fails           | `nopo build --no-cache` | Clear cache             |

---

**Need more detail?** See:

- [Reference](./reference.md) - Complete command reference
- [Configuration](./guides/configuration.md) - Advanced setup
- [Troubleshooting](./guides/troubleshooting.md) - Detailed fixes
