# run

Run a nopo.yml command inside Docker containers.

## Overview

The `run` command executes commands defined in `nopo.yml` inside Docker containers. It mirrors the behavior of `nopo <command>` (which runs on the host), but executes within container environments. This unified execution model ensures consistency: `nopo <command>` runs on host, `nopo run <command>` runs in container.

## Usage

```bash
nopo run <command> [subcommand] [targets...] [options]
```

## Arguments

| Argument | Description | Required |
|----------|-------------|----------|
| `command` | The nopo.yml command name to run (e.g., `test`, `check`, `migrate`) | Yes |
| `subcommand` | Optional subcommand (e.g., `py` for `check:py`) | No |
| `targets` | Optional list of targets to run the command in. If omitted, runs in all services that have the command | No |

### Available Targets

Targets are discovered from `apps/*/Dockerfile` (e.g., `backend`, `web`).

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--filter <expr>` / `-F <expr>` | Filter targets by expression (can be used multiple times) | None |
| `--since <ref>` | Git reference for `changed` filter | default branch |

### Filtering

You can filter which services to run commands on using expressions:

```bash
# Run tests on services with changes since main branch
nopo run test --filter changed

# Run check on buildable services only
nopo run check --filter buildable

# Run migrations on services with database
nopo run migrate --filter infrastructure.hasDatabase=true
```

See [`list`](./list.md) for full filter expression documentation.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENV_FILE` | Path to the environment file | `.env` |
| `DOCKER_BUILD` | Force local build | `false` |
| `DOCKER_VERSION` | Image version | From `.env` |

## Dependencies

The `run` command automatically runs dependencies based on conditions:

| Command | Condition |
|---------|-----------|
| [`env`](./env.md) | When service is down and needs build/pull |
| [`build`](./build.md) | When service is down and local build is needed |
| [`pull`](./pull.md) | When service is down and pull is needed |

### Dependency Logic

- If targets are provided and the target is not running:
  - If `DOCKER_VERSION=local` or `DOCKER_BUILD=true`: builds the image
  - Otherwise: pulls the image from the registry

## Examples

### Run a command in a specific target

```bash
nopo run test backend
```

This runs the `test` command from `apps/backend/nopo.yml` inside the `backend` Docker container.

### Run a command in multiple targets

```bash
nopo run test backend web
```

This runs the test command in both `backend` and `web` containers sequentially.

### Run a command across all services that have it

```bash
nopo run test
```

This runs the `test` command in all services that have it defined in their `nopo.yml`.

### Run a subcommand

```bash
nopo run check py backend
```

This runs the `check:py` subcommand (e.g., `uv tool run ruff check`) in the backend container.

### Run migrations in container

```bash
nopo run migrate run backend
```

This runs the `migrate:run` subcommand in the backend container.

### Run with filters

```bash
# Run check on changed services
nopo run check --filter changed

# Run test on buildable services
nopo run test --filter buildable
```

## How It Works

1. **Parse Arguments**: Extracts command name, optional subcommand, and targets from arguments
2. **Check Service State**: Determines if the target service container is running
3. **Resolve Dependencies**: If service is down, builds or pulls images as needed
4. **Resolve Command**: Looks up the command in the target's `nopo.yml` file
5. **Execute Command**: Runs the command inside the Docker container

### Command Resolution

Commands are resolved from each target's `nopo.yml` file:

```yaml
# apps/backend/nopo.yml
commands:
  test: uv run python manage.py test src
  check:
    commands:
      py: uv tool run ruff check
      js: pnpm exec eslint
```

| Input | Resolved Command |
|-------|------------------|
| `nopo run test backend` | `uv run python manage.py test src` |
| `nopo run check py backend` | `uv tool run ruff check` |
| `nopo run check backend` | Runs both `check:py` and `check:js` |

### Docker Execution

Commands are executed inside Docker containers:

```bash
docker compose run --rm --remove-orphans <target> sh -c "<command>"
```

Each target is run sequentially. Containers are automatically removed after execution (`--rm`).

## Output

The command streams output from the container:

```plaintext
[backend:test] uv run python manage.py test src
[backend:test] Found 10 test(s).
[backend:test] .
[backend:test] -----------------------------------------
[backend:test] Ran 10 tests in 0.345s
[backend:test]
[backend:test] OK
```

## Comparison: Host vs Container Execution

| Aspect | Host (`nopo test backend`) | Container (`nopo run test backend`) |
|--------|---------------------------|-------------------------------------|
| **Command Source** | nopo.yml | nopo.yml |
| **Environment** | Your host machine | Docker container |
| **Dependencies** | Only `EnvScript` | Full (env, build, pull) |
| **Speed** | Faster (no container overhead) | Slower (container startup) |
| **Isolation** | Uses host environment | Isolated container environment |
| **Consistency** | May vary by host | Consistent across machines |
| **Use Case** | Quick checks, development | Tests, production-like environment |

## Use Cases

### Run Tests in CI

```bash
# Run backend tests in production container
nopo run test backend
```

### Development Workflow

```bash
# Start services
nopo up

# Run migrations in container
nopo run migrate run backend

# Run type checking in container
nopo run check backend
```

### Test Production Environment

```bash
# Build production images
DOCKER_TARGET=production make build

# Run tests in production containers
nopo run test backend
```

## Error Handling

### Command Not Found

If the command doesn't exist in the service's `nopo.yml`:

```plaintext
Error: Command 'foo' not found in service 'backend'. Available commands: test, check, dev, ...
```

Solution: Check that the command is defined in the target's `nopo.yml`.

### Target Not Found

If the specified target doesn't exist:

```plaintext
Error: Unknown target 'invalid'. Available targets: backend, web
```

Solution: Check available targets with `nopo status` or check `apps/*/Dockerfile`.

### No Services Have Command

If no services define the specified command:

```plaintext
Error: No services have command 'foo'
```

Solution: Verify the command name or check which services have it defined.

## See Also

- [`up`](./up.md) - Start services before running commands
- [`status`](./status.md) - Check which services are running
- [`env`](./env.md) - Set up environment variables
- [Arbitrary Commands](./arbitrary.md) - Host vs container execution comparison

