# Reference

Quick reference for all nopo commands, options, and environment variables.

## Quick Navigation

- [Commands](#commands) - All commands with options and examples
- [Environment Variables](#environment-variables) - All variables and their usage
- [Exit Codes](#exit-codes) - Command exit codes and error handling

---

## Commands

### Build Commands

| Command     | Description               | Basic Usage            | Key Options                     |
| ----------- | ------------------------- | ---------------------- | ------------------------------- |
| **`build`** | Build Docker images       | `nopo build [targets]` | `--no-cache`, `--output <path>` |
| **`pull`**  | Pull images from registry | `nopo pull [targets]`  | `--force`                       |

### Service Management

| Command    | Description    | Basic Usage           | Key Options                     |
| ---------- | -------------- | --------------------- | ------------------------------- |
| **`up`**   | Start services | `nopo up [targets]`   | `--build`, `--detach`           |
| **`down`** | Stop services  | `nopo down [targets]` | `--volumes`, `--remove-orphans` |

### Information Commands

| Command      | Description              | Basic Usage   | Key Options                                          |
| ------------ | ------------------------ | ------------- | ---------------------------------------------------- |
| **`list`**   | List and filter services | `nopo list`   | `--format json/csv`, `--filter <expr>`, `--validate` |
| **`status`** | Check system status      | `nopo status` | `--json`, `--detailed`                               |
| **`env`**    | Manage environment       | `nopo env`    | `--force`, `--diff`                                  |

### Arbitrary Commands

| Pattern       | Description         | Basic Usage                   | Context                    |
| ------------- | ------------------- | ----------------------------- | -------------------------- |
| **Host**      | Run on host machine | `nopo <script> [targets]`     | Fast, uses local tools     |
| **Container** | Run in containers   | `nopo run <script> [targets]` | Isolated, builds if needed |

---

## Command Details

### `build`

```bash
nopo build [targets...] [options]
```

**Targets**: `backend`, `web`, `api` (discovered from `apps/*/Dockerfile`)
**Special**: `root` - Build root image only

| Option            | Description                   |
| ----------------- | ----------------------------- |
| `--no-cache`      | Build without cache           |
| `--output <path>` | Write build info to JSON file |

**Examples**:

```bash
nopo build                    # All targets
nopo build backend web         # Specific targets
nopo build root               # Root image only
nopo build --no-cache        # Without cache
nopo build --output info.json   # Export metadata
```

### `up`

```bash
nopo up [targets...] [options]
```

| Option       | Description                       |
| ------------ | --------------------------------- |
| `--build`    | Build images before starting      |
| `--no-cache` | Build without cache when building |
| `--detach`   | Run in background (default)       |

**Examples**:

```bash
nopo up                      # All services
nopo up backend               # Specific service
nopo up --build              # Build first
```

### `down`

```bash
nopo down [targets...] [options]
```

| Option             | Description                |
| ------------------ | -------------------------- |
| `--volumes` / `-v` | Remove associated volumes  |
| `--remove-orphans` | Remove orphaned containers |

**Examples**:

```bash
nopo down                    # All services
nopo down backend web         # Specific services
nopo down --volumes          # Remove volumes
```

### `list`

```bash
nopo list [options]
```

| Option                          | Description                    |
| ------------------------------- | ------------------------------ |
| `--format <fmt>` / `-f <fmt>`   | Output: `text`, `json`, `csv`  |
| `--json` / `-j`                 | Shortcut for `--format json`   |
| `--csv`                         | Shortcut for `--format csv`    |
| `--filter <expr>` / `-F <expr>` | Filter services                |
| `--jq <filter>`                 | Apply jq filter to JSON output |
| `--validate` / `-v`             | Validate configuration         |

**Filter Expressions**:
| Expression | Description | Example |
|-----------|-------------|---------|
| `buildable` | Buildable services | `--filter buildable` |
| `fieldname` | Field exists | `--filter image` |
| `!fieldname` | Field doesn't exist | `--filter !image` |
| `field=value` | Field equals value | `--filter infrastructure.cpu=1` |

**Examples**:

```bash
nopo list                           # Table view
nopo list --json                     # JSON output
nopo list --filter buildable          # Buildable only
nopo list --jq '.services | keys'   # Service names only
nopo list --validate                # Check config
```

### `status`

```bash
nopo status [options]
```

| Option              | Description          |
| ------------------- | -------------------- |
| `--json` / `-j`     | JSON output          |
| `--detailed` / `-d` | Detailed information |

### `env`

```bash
nopo env [options]
```

| Option           | Description        |
| ---------------- | ------------------ |
| `--force` / `-f` | Force regeneration |
| `--diff` / `-d`  | Show changes       |

### Arbitrary Commands

#### Host Execution (`nopo <script>`)

```bash
nopo lint web          # Lint web on host
nopo test backend      # Test backend on host
nopo typecheck         # Type check all on host
```

#### Container Execution (`nopo run <script>`)

```bash
nopo run lint web      # Lint web in container
nopo run test backend   # Test backend in container
nopo run migrate       # Run migrations in container
```

---

## Environment Variables

### Core Variables

| Variable         | Description           | Default        | Example      |
| ---------------- | --------------------- | -------------- | ------------ |
| `ENV_FILE`       | Environment file path | `.env`         | `prod.env`   |
| `DOCKER_BUILDER` | Buildx builder name   | `nopo-builder` | `my-builder` |

### Docker Tags

#### Complete Tag Override

| Variable     | Description           | Example                   |
| ------------ | --------------------- | ------------------------- |
| `DOCKER_TAG` | Complete tag override | `registry.com/app:v1.0.0` |

**Format**: `[registry/]image[:version][@sha256:digest]`

#### Component Override

| Variable          | Description   | Example                |
| ----------------- | ------------- | ---------------------- |
| `DOCKER_REGISTRY` | Registry URL  | `registry.example.com` |
| `DOCKER_IMAGE`    | Image name    | `myapp`                |
| `DOCKER_VERSION`  | Version/tag   | `v1.0.0`               |
| `DOCKER_DIGEST`   | SHA256 digest | `sha256:abc123...`     |

**Priority**: `DOCKER_TAG` → Components → `.env` → Defaults

### Build Configuration

| Variable                | Description               | Default       | Example                   |
| ----------------------- | ------------------------- | ------------- | ------------------------- |
| `DOCKER_BUILD`          | Force building vs pulling | Empty         | `true`                    |
| `DOCKER_PUSH`           | Push after build          | `false`       | `true`                    |
| `DOCKER_TARGET`         | Build target stage        | `development` | `production`              |
| `DOCKER_BUILDKIT_CACHE` | Cache configuration       | Default       | `type=registry,ref=cache` |

### Git Information (Auto-detected)

| Variable     | Description    | Fallback  |
| ------------ | -------------- | --------- |
| `GIT_REPO`   | Repository URL | `unknown` |
| `GIT_BRANCH` | Current branch | `unknown` |
| `GIT_COMMIT` | Commit hash    | `unknown` |

### Debug & Logging

| Variable    | Description         | Values                           |
| ----------- | ------------------- | -------------------------------- |
| `DEBUG`     | Enable debug output | `1`, `build,cache,deps`          |
| `LOG_LEVEL` | Log verbosity       | `debug`, `info`, `warn`, `error` |
| `NO_COLOR`  | Disable colors      | `1`, `true`                      |

### Service-Specific

| Pattern           | Description            | Example                           |
| ----------------- | ---------------------- | --------------------------------- |
| `<SERVICE>_IMAGE` | Service-specific image | `WEB_IMAGE=registry.com/web:v1.0` |

---

## Exit Codes

| Code | Meaning             | Common Causes          |
| ---- | ------------------- | ---------------------- |
| `0`  | Success             | -                      |
| `1`  | General error       | Command failed         |
| `2`  | Command not found   | Invalid command name   |
| `3`  | Invalid arguments   | Bad options/arguments  |
| `4`  | Configuration error | Invalid nopo.yml       |
| `5`  | Docker error        | Build/container failed |
| `6`  | Network error       | Registry/pull failed   |
| `7`  | Permission error    | File/Docker access     |

---

## Usage Patterns

### Development Workflow

```bash
# 1. Quick status check
nopo status

# 2. List buildable services
nopo list --filter buildable

# 3. Fast linting (host)
nopo lint web

# 4. Test in container
nopo run test backend

# 5. Start services
nopo up
```

### CI/CD Pipeline

```bash
# 1. Validate configuration
nopo list --validate

# 2. Build images
DOCKER_PUSH=true nopo build --no-cache

# 3. Quality checks
nopo lint
nopo run test

# 4. Deploy
nopo up production
```

### Environment Setup

```bash
# Development
NODE_ENV=development DOCKER_TAG=myapp:dev nopo up

# Production
NODE_ENV=production DOCKER_REGISTRY=registry.com DOCKER_PUSH=true nopo build

# Local registry
DOCKER_REGISTRY=localhost:5000 DOCKER_VERSION=local nopo build
```

---

## Common Issues

| Problem            | Quick Fix       | Command                                        |
| ------------------ | --------------- | ---------------------------------------------- |
| Command not found  | Check spelling  | `nopo help`                                    |
| Target not found   | List available  | `nopo list`                                    |
| Docker daemon down | Start Docker    | `docker --version`                             |
| Permission denied  | Fix permissions | `sudo chown $USER:docker /var/run/docker.sock` |

---

## Global Options

| Option       | Short | Description                                                  |
| ------------ | ----- | ------------------------------------------------------------ |
| `--help`     | `-h`  | Show help                                                    |
| `--version`  | `-V`  | Show version                                                 |
| `--verbose`  | `-v`  | Verbose output                                               |
| `--quiet`    | `-q`  | Quiet mode                                                   |
| `--no-color` |       | Disable colors                                               |
| `--print`    |       | Resolve the execution plan and print it instead of running   |
| `--json`     |       | Force JSON output of the `--print` plan (see below)          |

### `--print` and `--json`

Most script-class commands (`build`, `up`, `down`, `pull`, `list`, etc.) accept
`--print`, which short-circuits execution and writes the resolved plan (final
targets, dependency edges, active filters, plugin set, etc.) to stdout as a
single-line JSON document. CI workflows consume it with `jq`:

```bash
nopo build --print | jq -r '.services | join(" ")'
```

`--json` is a sibling flag. Today both forms emit the same JSON document:

```bash
nopo build --print           # JSON resolution snapshot (current default)
nopo build --print --json    # Same JSON, explicit opt-in
```

A later milestone will flip `--print` alone to render the DAG in human-readable
form; `--json` will remain the explicit opt-in for the JSON-shaped snapshot. CI
pipelines that depend on parseable output should pass `--print --json` to lock
in the JSON contract before the default flips.

---

## See Also

- [Quick Start Guide](../quick-start.md) - Get started quickly
- [Configuration Guide](../guides/configuration.md) - Advanced setup
- [Troubleshooting Guide](../guides/troubleshooting.md) - Common issues
