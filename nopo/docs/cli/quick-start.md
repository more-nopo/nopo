# Quick Start

Get up and running with nopo in 5 minutes.

## 1. Installation

```bash
# From GitHub Packages
# .npmrc: @more-nopo:registry=https://npm.pkg.github.com
bun add -g @more-nopo/nopo

# Or from this repo
bun install
# bun install links workspace @more-nopo/nopo onto PATH

nopo --help
```

## 2. Project Setup

```bash
# Your project needs:
project/
├── nopo.yml                 # Project config
├── apps/
│   ├── backend/
│   │   ├── Dockerfile
│   │   └── nopo.yml       # Service config
│   └── web/
│       ├── Dockerfile
│       └── nopo.yml
└── package.json               # Root scripts
```

## 3. First Commands

```bash
# Validate your setup
nopo list --validate

# Start services (auto-builds if needed)
nopo up

# Check what's running
nopo status
```

## 4. Development Workflow

```bash
# Fast linting (host, no containers)
nopo lint web

# Testing (container, isolated)
nopo run test backend

# Make changes and restart
nopo up web
```

## 5. Common Tasks

```bash
# Build all services
nopo build

# Build specific services
nopo build backend web

# Stop everything
nopo down

# List services with filtering
nopo list --filter buildable

# Get machine-readable output
nopo list --json
nopo status --json
```

## When Things Go Wrong

| Issue                  | Command                         | Fix                    |
| ---------------------- | ------------------------------- | ---------------------- |
| **Command not found**  | `nopo help`                     | Check spelling         |
| **Docker not running** | `docker --version`              | Start Docker Desktop   |
| **Permission denied**  | `sudo usermod -aG docker $USER` | Fix Docker permissions |
| **Build fails**        | `nopo build --no-cache`         | Clear cache and retry  |

## Next Steps

- **[Essentials](./commands/essentials.md)** - Core commands for 80% of tasks
- **[Reference](./reference.md)** - Complete command reference
- **[Configuration](./guides/configuration.md)** - Advanced setup
- **[Troubleshooting](./guides/troubleshooting.md)** - Quick fixes

## Environment Templates

### Development (.env.development)

```bash
NODE_ENV=development
DOCKER_TAG=myapp:dev
DEBUG=1
```

### Production (.env.production)

```bash
NODE_ENV=production
DOCKER_REGISTRY=registry.example.com
DOCKER_IMAGE=myapp
DOCKER_VERSION=v1.0.0
DOCKER_PUSH=true
```

### CI/CD

```bash
CI=true
NODE_ENV=test
DOCKER_BUILDKIT_CACHE_TO=type=gha,mode=max
NO_COLOR=1
```
