# build

Build base image and target images using Docker Buildx Bake.

## Overview

The `build` command creates Docker images for the nopo project using Docker Buildx Bake for parallel and efficient builds. It also builds package targets that define `build.command` in their `nopo.yml`, honoring `build.depends_on` ordering before image builds.

## Usage

```bash
nopo build [targets...] [options]

# Get help for this command
nopo build help
nopo build --help
```

## Arguments

| Argument | Description |
|----------|-------------|
| `targets` | Optional list of targets to build. If omitted, builds all targets (base + all discovered targets) |

### Available Targets

- `root` - The root image containing shared dependencies (configurable via `root_name` in `nopo.yml`)
- Target names discovered from `apps/*/Dockerfile` (e.g., `backend`, `web`)
- Package targets discovered from `services.dirs` that define `build.command` (e.g., `prompts`, `claude`)

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--no-cache` | Build without using cache | `false` |
| `--output <path>` | Path to write build info JSON | None |
| `--filter <expr>` / `-F <expr>` | Filter targets by expression (can be used multiple times) | None |
| `--since <ref>` | Git reference for `changed` filter | default branch |
| `--tags <tags>` | Filter targets by tags (comma-separated; match any) | None |

### Filtering

The build command automatically filters to buildable services (those with Dockerfiles). You can further filter using expressions:

```bash
# Build only services with changes since main branch
nopo build --filter changed

# Build changed services since a specific commit
nopo build --filter changed --since abc123

# Build services with database
nopo build --filter infrastructure.hasDatabase=true

# Build only services with a given tag (e.g. CI-related packages)
nopo build --tags github-actions

# Multiple tags match any (OR)
nopo build --tags github-actions,frontend
```

See [`list`](./list.md) for full filter expression documentation. Tags are defined per service in each service's `nopo.yml` (see [Configuration](../guides/configuration.md)).

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DOCKER_BUILDER` | Custom Docker Buildx builder name | `nopo-builder` |
| `DOCKER_PUSH` | Push images to registry after build | `false` |
| `DOCKER_PLATFORMS` | Target platforms for multi-arch builds (comma-separated, only used when `DOCKER_PUSH=true`) | `linux/amd64,linux/arm64` |
| `DOCKER_METADATA_FILE` | Path to write bake metadata | Temp file |
| `DOCKER_TAG` | Base image tag | From `.env` or `more-nopo/nopo:local` |
| `DOCKER_TARGET` | Build target stage | `development` or `production` |
| `DOCKER_VERSION` | Image version | `local` |
| `DOCKER_REGISTRY` | Docker registry URL | Empty |
| `DOCKER_IMAGE` | Base image name | `more-nopo/nopo` |
| `GIT_REPO` | Git repository URL | Auto-detected |
| `GIT_BRANCH` | Current git branch | Auto-detected |
| `GIT_COMMIT` | Current git commit hash | Auto-detected |

## Dependencies

The `build` command automatically runs the following commands first:

| Command | Condition |
|---------|-----------|
| [`env`](./env.md) | Always (sets up environment variables) |

## Examples

### Build all images

```bash
nopo build
```

### Build only the root image

```bash
nopo build root
```

### Build a specific target

```bash
nopo build backend
```

### Build multiple targets in parallel

```bash
nopo build backend web
```

### Build without cache

```bash
nopo build --no-cache
```

### Build and push to registry

```bash
DOCKER_PUSH=true nopo build
```

### Build and push multi-arch images

When pushing, images are built for both `linux/amd64` and `linux/arm64` by default:

```bash
DOCKER_PUSH=true nopo build
```

### Build for a single architecture only

```bash
DOCKER_PUSH=true DOCKER_PLATFORMS=linux/amd64 nopo build
```

### Build with custom builder

```bash
DOCKER_BUILDER=my-builder nopo build
```

### Output build info to file

```bash
nopo build --output build-info.json
```

## How It Works

1. **Environment Setup**: Runs the `env` command to ensure environment variables are configured
2. **Package Build Phase**: Runs package `build.command` on host for package targets and their `build.depends_on` package dependencies
3. **Target Resolution**: Determines which image targets to build based on arguments or defaults to all
4. **Builder Setup**: Creates or uses an existing Docker Buildx builder (`nopo-builder`)
5. **Bake Definition**: Generates a Docker Bake JSON definition with all image targets and their configurations
6. **Parallel Build**: Executes Docker Buildx Bake for parallel image building
7. **Image Loading**: Loads built images into the local Docker daemon
8. **Environment Update**: Records target image tags as `<TARGET>_IMAGE` in `.env`

### Build Arguments

The following build arguments are passed to the Dockerfile:

| Argument | Description |
|----------|-------------|
| `DOCKER_TARGET` | Build target stage |
| `DOCKER_TAG` | Base image tag |
| `DOCKER_VERSION` | Image version |
| `DOCKER_BUILD` | Same as version (for compatibility) |
| `GIT_REPO` | Git repository URL |
| `GIT_BRANCH` | Current git branch |
| `GIT_COMMIT` | Current git commit hash |
| `SERVICE_NAME` | Name of the target being built (Docker build arg name) |
| `NOPO_APP_UID` | Application user ID (`1001`) |
| `NOPO_APP_GID` | Application group ID (`1001`) |

### Cache Configuration

By default, the build uses GitHub Actions cache:

- Cache from: `type=gha`
- Cache to: `type=gha,mode=max`

### Target Image Tags

Target images are tagged following the pattern:

```plaintext
[registry/]<image>-<target>:<version>
```

For example, if the base tag is `more-nopo/nopo:local` and the target is `backend`, the target image tag would be `more-nopo/nopo-backend:local`.

## Output

When using `--output`, the command writes a JSON file with build information:

```json
[
  {
    "name": "root",
    "tag": "more-nopo/nopo:local",
    "registry": "",
    "image": "more-nopo/nopo",
    "version": "local",
    "digest": null
  },
  {
    "name": "backend",
    "tag": "more-nopo/nopo-backend:local",
    "registry": "",
    "image": "more-nopo/nopo-backend",
    "version": "local",
    "digest": null
  }
]
```

When `DOCKER_PUSH=true`, the `digest` field contains the image digest from the registry.

## See Also

- [`env`](./env.md) - Set up environment variables
- [`up`](./up.md) - Start targets (automatically builds if needed)
- [`pull`](./pull.md) - Pull images from registry instead of building

