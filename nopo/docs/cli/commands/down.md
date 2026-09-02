# down

Bring down the containers and clean up resources.

## Overview

The `down` command stops and removes all Docker containers, networks, and volumes created by the nopo project. It also removes locally-built images to ensure a clean slate.

## Usage

```bash
nopo down [targets...]
```

## Arguments

| Argument | Description |
|----------|-------------|
| `targets` | Optional list of targets to stop. If omitted, stops all targets |

### Available Targets

Targets are discovered from `apps/*/Dockerfile` (e.g., `backend`, `web`).

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--filter <expr>` / `-F <expr>` | Filter targets by expression (can be used multiple times) | None |
| `--since <ref>` | Git reference for `changed` filter | default branch |

### Filtering

You can filter which services to stop using expressions:

```bash
# Stop only services with changes since main branch
nopo down --filter changed

# Stop services with database
nopo down --filter infrastructure.hasDatabase=true
```

See [`list`](./list.md) for full filter expression documentation.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENV_FILE` | Path to the environment file | `.env` |

The command uses environment variables from the `.env` file to identify which containers and resources to remove.

## Dependencies

The `down` command automatically runs the following commands first:

| Command | Condition |
|---------|-----------|
| [`env`](./env.md) | Always (ensures environment is loaded) |

## Examples

### Stop and remove all containers

```bash
nopo down
```

### Stop specific targets

```bash
nopo down backend
```

### Use a custom environment file

```bash
ENV_FILE=.env.staging nopo down
```

## How It Works

1. **Environment Setup**: Runs the `env` command to load environment variables
2. **Container Shutdown**: Uses `docker-compose down` to stop all running containers
3. **Volume Cleanup**: Removes all volumes associated with the project
4. **Image Cleanup**: Removes locally-built images (tagged as `local`)
5. **Network Cleanup**: Removes project networks

### Docker Compose Options

The command runs with the following options:

| Option | Description |
|--------|-------------|
| `--rmi local` | Remove images that were built locally |
| `--volumes` | Remove named volumes declared in the compose file |

## Output

The command outputs logs for each step of the shutdown process, prefixed with `[down]` in yellow:

```plaintext
[down] Stopping containers...
[down] Removing volumes...
[down] Removing local images...
```

## Use Cases

### Clean Development Reset

When you want to start fresh with a clean development environment:

```bash
nopo down
nopo up
```

### Before Switching Branches

To avoid conflicts when switching to a branch with different configurations:

```bash
nopo down
git checkout feature-branch
nopo up
```

### Freeing Disk Space

Remove all containers, volumes, and images to reclaim disk space:

```bash
nopo down
docker system prune -a
```

## Caution

This command removes:

- All running and stopped containers for the project
- All named volumes (including database data)
- Locally-built images

**Data in volumes will be permanently deleted.** Back up any important data before running this command.

## See Also

- [`up`](./up.md) - Start the services
- [`status`](./status.md) - Check the status of services
- [`env`](./env.md) - Set up environment variables

