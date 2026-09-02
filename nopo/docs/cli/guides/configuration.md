# Configuration

Setup nopo projects with Docker tags, builds, and environment variables.

## Quick Setup

```bash
# 1. Validate configuration
nopo list --validate

# 2. Set environment
NODE_ENV=development

# 3. Start services
nopo up
```

## Docker Tags

### Tag Format

```
[registry/]image[:version][@sha256:digest]
```

### Environment Variables

| Variable     | Priority | Example                   |
| ------------ | -------- | ------------------------- |
| `DOCKER_TAG` | Highest  | `registry.com/app:v1.0.0` |
| Components   | Medium   | See below                 |
| Defaults     | Lowest   | Auto from git             |

### Component Variables

| Variable          | Description   |
| ----------------- | ------------- |
| `DOCKER_REGISTRY` | Registry URL  |
| `DOCKER_IMAGE`    | Image name    |
| `DOCKER_VERSION`  | Version/tag   |
| `DOCKER_DIGEST`   | SHA256 digest |

### Examples

```bash
# Complete tag
DOCKER_TAG=registry.com/app:v1.0.0

# Components
DOCKER_REGISTRY=registry.com
DOCKER_IMAGE=app
DOCKER_VERSION=v1.0.0

# With digest (content-addressable)
DOCKER_TAG=app@sha256:abc123...

# Service-specific
WEB_IMAGE=registry.com/web:v1.0.0
```

## Build Configuration

### Cache Strategy

| Environment | Cache Type           |
| ----------- | -------------------- |
| Development | Local Docker cache   |
| CI          | GitHub Actions cache |
| Custom      | Registry cache       |

### Build Variables

| Variable         | Description      | Default        |
| ---------------- | ---------------- | -------------- |
| `DOCKER_BUILD`   | Force building   | Empty          |
| `DOCKER_PUSH`    | Push after build | `false`        |
| `DOCKER_TARGET`  | Build stage      | `development`  |
| `DOCKER_BUILDER` | Builder name     | `nopo-builder` |

### Build Arguments

Automatically passed to Dockerfiles:

- `DOCKER_TARGET`, `DOCKER_TAG`, `DOCKER_VERSION`
- `GIT_REPO`, `GIT_BRANCH`, `GIT_COMMIT`
- `SERVICE_NAME`, `NOPO_APP_UID`, `NOPO_APP_GID`

### Package Build Configuration

Package targets (no runtime/image) should declare explicit build settings:

```yaml
name: claude

build:
  command: pnpm exec tsx scripts/build-actions.ts
  depends_on:
    - prompts
```

Notes:

- `nopo build <package>` requires `build.command` on that package.
- `build.depends_on` is resolved before running package build commands.

## Service Configuration

### nopo.yml Structure

```yaml
name: backend
description: Backend service
dockerfile: Dockerfile
static_path: build
tags: []   # optional; used by --tags filter (match any)

runtime:
  cpu: "1"
  memory: "512Mi"
  port: 3000

# Per-deploy migration / setup commands belong on the terraform plugin:
# plugins:
#   terraform:
#     pre_deploy:
#       - bunx prisma migrate deploy

dependencies:
  - database
  - shared

commands:
  lint: eslint .
  build: npm run build
  test: npm test
  start: npm start
```

**Tags**: Optional top-level `tags` is an array of non-empty strings (default `[]`). Used by `--tags` on `build`, `list`, and other target-based commands: comma-separated values match any of the service's tags (OR). Example: `tags: ["github-actions"]` for CI-only packages.

### Command Patterns

```yaml
# Simple command
lint: eslint .

# With environment
build:
  command: npm run build
  env:
    NODE_ENV: production

# Subcommands (parallel)
check:
  commands:
    lint: eslint .
    types: tsc --noEmit

# Dependencies
deploy:
  command: npm run deploy
  dependencies:
    - backend
    - api
```

### Working Directory

```yaml
commands:
  # Service root (default)
  test: npm test

  # Project root
  lint:
    command: eslint .
    dir: root

  # Absolute path
  deploy:
    command: ./deploy.sh
    dir: /opt/deploy

  # Relative to service
  format:
    command: prettier --write .
    dir: ./src
```

### Dependencies

#### Service Level

```yaml
dependencies:
  - backend
  - shared
```

#### Command Level

```yaml
commands:
  # No dependencies (override service)
  lint:
    dependencies: {}
    command: eslint .

  # Same command on multiple services
  build:
    dependencies:
      - backend
      - shared
    command: npm run build

  # Different commands per service
  deploy:
    dependencies:
      backend: [build, migrate]
      api: [build]
    command: npm run deploy
```

## Environment Management

### Development

```bash
# .env.development
NODE_ENV=development
DOCKER_TAG=myapp:dev
DOCKER_TARGET=development
DEBUG=1
```

### Production

```bash
# .env.production
NODE_ENV=production
DOCKER_REGISTRY=registry.com
DOCKER_IMAGE=myapp
DOCKER_VERSION=v1.2.3
DOCKER_PUSH=true
DOCKER_TARGET=production
```

### CI/CD

```bash
# CI environment
CI=true
DOCKER_BUILDKIT_CACHE_TO=type=gha,mode=max
DOCKER_PUSH=true
NO_COLOR=1
```

## Best Practices

### Tags

1. **Use semantic versions**: `v1.0.0`
2. **Include digests for production**: `v1.0.0@sha256:abc123...`
3. **Environment-specific registries**: `registry.com` vs `localhost:5000`
4. **Service-specific images**: Use `<SERVICE>_IMAGE` overrides

### Builds

1. **Enable caching**: Use GitHub Actions cache in CI
2. **Multi-stage Dockerfiles**: Optimize layer caching
3. **Parallel builds**: Target multiple services
4. **Selective builds**: Use specific targets

### Configuration

1. **Validate regularly**: `nopo list --validate`
2. **Use inheritance**: Subcommands inherit parent settings
3. **Clear dependencies**: Define explicit relationships
4. **Environment separation**: Different `.env` files per environment

---

**See Also**: [Reference](../reference.md) - Complete variable and option reference
