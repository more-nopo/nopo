# env

Set up environment variables and generate the `.env` file.

## Overview

The `env` command parses, validates, and generates environment variables for the nopo project. It creates or updates the `.env` file with computed values for Docker tags, git information, and other configuration.

## Usage

```bash
nopo env
```

## Arguments

This command does not accept any arguments.

## Options

This command does not accept any options.

## Environment Variables

### Input Variables

These variables can be set to override computed values:

| Variable | Description | Default |
|----------|-------------|---------|
| `ENV_FILE` | Path to the environment file | `.env` |
| `DOCKER_TAG` | Complete Docker image tag | Computed from components |
| `DOCKER_REGISTRY` | Docker registry URL | Empty (Docker Hub) |
| `DOCKER_IMAGE` | Base image name | `more-nopo/nopo` |
| `DOCKER_VERSION` | Image version/tag | `local` |
| `DOCKER_DIGEST` | Image digest (sha256) | Empty |
| `DOCKER_TARGET` | Build target stage | `development` (local) or `production` |
| `DOCKER_PORT` | Port for services | Random free port |
| `NODE_ENV` | Node.js environment | Matches `DOCKER_TARGET` |
| `GIT_REPO` | Git repository URL | Auto-detected |
| `GIT_BRANCH` | Current git branch | Auto-detected |
| `GIT_COMMIT` | Current git commit hash | Auto-detected |

### Output Variables

The command generates these variables in the `.env` file:

| Variable | Description | Example |
|----------|-------------|---------|
| `DOCKER_PORT` | Port for the main service | `8080` |
| `DOCKER_TAG` | Complete Docker image tag | `more-nopo/nopo:local` |
| `DOCKER_REGISTRY` | Docker registry URL | Empty or `ghcr.io` |
| `DOCKER_IMAGE` | Base image name | `more-nopo/nopo` |
| `DOCKER_VERSION` | Image version | `local` |
| `DOCKER_DIGEST` | Image digest | Empty or `sha256:...` |
| `DOCKER_TARGET` | Build target | `development` |
| `NODE_ENV` | Node.js environment | `development` |
| `GIT_REPO` | Git repository URL | `https://github.com/user/repo` |
| `GIT_BRANCH` | Git branch | `main` |
| `GIT_COMMIT` | Git commit hash | `abc1234...` |

## Dependencies

This command has no dependencies and runs independently.

## Examples

### Generate default environment

```bash
nopo env
```

### Use a specific Docker tag

```bash
DOCKER_TAG=myregistry/myimage:v1.0.0 nopo env
```

### Set a specific version

```bash
DOCKER_VERSION=v1.0.0 nopo env
```

### Use a custom environment file

```bash
ENV_FILE=.env.staging nopo env
```

### Set registry for production

```bash
DOCKER_REGISTRY=ghcr.io/more-nopo nopo env
```

## How It Works

1. **Load Previous Environment**: Reads existing `.env` file if present
2. **Merge Environment Sources**: Combines previous values with process environment variables
3. **Resolve Docker Tag**: Parses and validates Docker tag components
4. **Detect Git Information**: Automatically detects repository, branch, and commit
5. **Find Free Port**: Allocates an available port if not specified
6. **Validate Configuration**: Uses Zod schema to validate all values
7. **Compute Diff**: Determines what changed from the previous environment
8. **Save Environment**: Writes the sorted environment to `.env` file

### Environment Resolution Precedence

1. **Process environment variables** (highest priority)
2. **Previous `.env` file values**
3. **Computed defaults** (lowest priority)

### Docker Tag Resolution

The Docker tag can be specified in several ways:

```bash
# Full tag
DOCKER_TAG=ghcr.io/more-nopo/nopo:v1.0.0

# Individual components
DOCKER_REGISTRY=ghcr.io/more-nopo
DOCKER_IMAGE=nopo
DOCKER_VERSION=v1.0.0

# With digest
DOCKER_TAG=more-nopo/nopo:v1.0.0@sha256:abc123...
```

### Target Environment

The `DOCKER_TARGET` and `NODE_ENV` are automatically set based on version:

| Version | DOCKER_TARGET | NODE_ENV |
|---------|---------------|----------|
| `local` | `development` | `development` |
| Any other | `production` | `production` |

## Output

The command displays a diff of the environment changes:

```plaintext
Updated: /path/to/project/.env
----------------------------------
added
DOCKER_PORT: 8080
GIT_COMMIT: abc123...

updated
DOCKER_VERSION: v1.0.0

unchanged
DOCKER_IMAGE: more-nopo/nopo
```

### Diff Categories

| Category | Color | Description |
|----------|-------|-------------|
| `added` | Magenta | New variables not in previous `.env` |
| `updated` | Yellow | Variables with changed values |
| `unchanged` | White | Variables with same values |
| `removed` | Red | Variables removed from configuration |

## Extra Environment Variables

In addition to the base environment, the command supports extra environment variables for service-specific configurations:

- Variables matching the pattern `*_IMAGE` are preserved
- These are typically set by the [`build`](./build.md) command for service images

Example:

```plaintext
BACKEND_IMAGE="more-nopo/nopo-backend:local"
WEB_IMAGE="more-nopo/nopo-web:local"
```

## Validation

The environment is validated using a Zod schema:

- `DOCKER_PORT` - Required string
- `DOCKER_TAG` - Required string
- `DOCKER_REGISTRY` - Required string (can be empty)
- `DOCKER_IMAGE` - Required string
- `DOCKER_VERSION` - Required string
- `DOCKER_DIGEST` - Optional string
- `DOCKER_TARGET` - Must be `development`, `production`, `test`, `base`, or `build`
- `NODE_ENV` - Must be `development`, `production`, or `test`
- `GIT_REPO` - Required string
- `GIT_BRANCH` - Required string
- `GIT_COMMIT` - Required string

## See Also

- [`build`](./build.md) - Build Docker images
- [`up`](./up.md) - Start the services
- [`status`](./status.md) - Check the status of services


