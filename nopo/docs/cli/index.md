# Nopo CLI

A TypeScript-based CLI tool for managing Docker-based development environments with automatic dependency resolution and environment configuration.

## Overview

The `nopo` CLI is designed to streamline the development workflow for monorepo projects that use Docker containers. It provides a unified interface for building images, managing environments, and running services with intelligent dependency resolution.

### Key Features

- **TypeScript-first**: Fully typed codebase with strict type checking
- **Vite-based build**: Single executable output for fast startup
- **Dependency resolution**: Automatic script dependency management between commands
- **Environment management**: Automated Docker tag parsing with digest support
- **Docker integration**: Built-in support for Docker Buildx Bake, Compose, and registry operations
- **Target discovery**: Automatically discovers targets with Dockerfiles in `apps/`
- **Advanced filtering**: Powerful service filtering and multiple output formats
- **Performance optimization**: Offline-first sync and parallel execution
- **Machine-readable output**: JSON/CSV formats for automation and CI/CD

## Installation

### Prerequisites

- Node.js 20+
- pnpm (recommended) or npm
- Docker and Docker Compose v2.20+

### Method 1: Using pnpm link (Recommended)

1. Navigate to the scripts directory and create a global link:

   ```bash
   cd packages/nopo
   pnpm install --ignore-workspace
   pnpm build
   pnpm link --global
   ```

2. In the root project directory, link the package:

   ```bash
   cd /path/to/your/project
   pnpm link --global nopo
   ```

3. Verify the installation:

   ```bash
   nopo --help
   ```

### Method 2: Using npm link

1. In the scripts directory:

   ```bash
   cd packages/nopo
   npm install
   npm run build
   npm link
   ```

2. In the root project directory:

   ```bash
   cd /path/to/your/project
   npm link nopo
   ```

### Method 3: Direct Installation

1. Build the package:

   ```bash
   cd packages/nopo
   npm run build
   ```

2. Install globally:

   ```bash
   npm install -g .
   ```

### Method 4: Using pnpm workspace (monorepo)

Add to your root `package.json`:

```json
{
  "dependencies": {
    "nopo": "workspace:*"
  }
}
```

Then run:

```bash
pnpm install
```

## Getting Started

- **[Quick Start](./quick-start.md)** - Get up and running in 5 minutes
- [Essentials](./commands/essentials.md) - Core commands for 80% of tasks

## Detailed Documentation

- **[Reference](./reference.md)** - Complete command and environment reference
- [Architecture](./architecture.md) - System architecture and algorithms
- [Commands](./commands/) - Individual command documentation
  - [Arbitrary Commands](./commands/arbitrary.md) - Running pnpm scripts
  - [Command Configuration](./commands/config.md) - Defining commands in nopo.yml

## Guides

- **[Configuration](./guides/configuration.md)** - Setup and optimization
- \*\*[Troubleshooting](./guides/troubleshooting.md) - Quick fixes for common issues

### Guides

- [Advanced Configuration](./guides/advanced-configuration.md) - Docker tags, build options, and environment variables
- [Performance Optimization](./guides/performance-optimization.md) - Offline-first sync and parallel execution
- [Development & Debugging](./guides/development-debugging.md) - Internal features and debugging
- [CI/CD Integration](./guides/cicd-integration.md) - Pipeline examples and best practices
- [Troubleshooting](./guides/troubleshooting.md) - Common issues and solutions

### Reference

- [Environment Variables](./reference/environment-variables.md) - Complete environment variables reference
- [Command Options](./reference/command-options.md) - All command options and arguments

## Commands

### Script Classes

| Command                          | Description                                                         |
| -------------------------------- | ------------------------------------------------------------------- |
| [`build`](./commands/build.md)   | Build base image and target images using Docker Buildx Bake         |
| [`down`](./commands/down.md)     | Bring down the containers and clean up resources                    |
| [`env`](./commands/env.md)       | Set up environment variables and generate `.env` file               |
| [`list`](./commands/list.md)     | List discovered services with filtering and multiple output formats |
| [`pull`](./commands/pull.md)     | Pull the base image or target images from the registry              |
| [`status`](./commands/status.md) | Check the status of the targets and system information              |
| [`up`](./commands/up.md)         | Start the targets with automatic dependency management              |

### Arbitrary Commands

| Pattern                          | Description                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `nopo <script> [targets...]`     | Run pnpm script on host (see [Arbitrary Commands](./commands/arbitrary.md))       |
| `nopo run <script> [targets...]` | Run pnpm script in containers (see [Arbitrary Commands](./commands/arbitrary.md)) |

**Note**: The legacy `run` command is being replaced by the arbitrary command pattern. See [Arbitrary Commands](./commands/arbitrary.md) for details.

## Usage

### Basic Usage

```bash
# Show available commands (general help)
nopo
nopo help
nopo --help

# Show help for specific command (recursive help)
nopo build help
nopo build --help
nopo up help
nopo lint help

# Run a script class command
nopo <script-class> [targets...] [options]

# Run an arbitrary pnpm script on host
nopo <pnpm-script> [targets...] [options]

# Run an arbitrary pnpm script in containers
nopo run <pnpm-script> [targets...] [options]
```

### Command Types

The CLI supports two types of commands:

1. **Script Classes**: Built-in commands like `build`, `up`, `down`, `pull`, `status`, `env`, `list`
2. **Arbitrary Commands**: Any pnpm script from your `package.json` files (e.g., `lint`, `test`, `dev`)

### Script Class Commands

Built-in commands that manage Docker containers and images:

```bash
# Build all targets (default)
nopo build

# Build specific targets
nopo build backend web

# Build with options
nopo build backend web --no-cache

# Start all targets
nopo up

# Start specific targets
nopo up backend

# Stop all targets
nopo down

# Stop specific targets
nopo down backend web

# Pull base image (default)
nopo pull

# Pull specific target images
nopo pull backend web

# Check status
nopo status

# List services
nopo list

# List services with filtering
nopo list --filter buildable

# List services in JSON format
nopo list --json
```

### Arbitrary Commands

Run any pnpm script from your `package.json` files. These can execute on the **host** or in **containers**.

#### Host Execution

Run pnpm scripts directly on your host machine:

```bash
# Run lint on all targets (or root if no targets)
nopo lint

# Run lint on specific target
nopo lint web

# Run lint on multiple targets
nopo lint backend web

# Run test on a target
nopo test backend

# Run any pnpm script
nopo dev web
nopo typecheck backend
```

**How it works**: Uses `pnpm --filter @more/{target} run {script}` for each target, or `pnpm run {script}` at root if no targets specified.

#### Container Execution

Run pnpm scripts inside Docker containers using the `run` prefix:

```bash
# Run lint in container (all targets)
nopo run lint

# Run lint in specific container
nopo run lint web

# Run lint in multiple containers
nopo run lint backend web

# Run test in container
nopo run test backend
```

**How it works**: Uses `docker compose run --rm {target} pnpm run {script}` for each target. Containers are automatically removed after execution.

**Key Difference**: Container execution includes full dependency resolution (build/pull images if needed), while host execution only ensures environment variables are set.

### Universal Target Pattern

All commands (script classes and arbitrary) support targeting specific services using positional arguments:

```bash
# Script class with targets
nopo build backend web
nopo up backend
nopo down backend web

# Arbitrary command with targets (host)
nopo lint web
nopo test backend web

# Arbitrary command with targets (container)
nopo run lint web
nopo run test backend web
```

**Target Discovery**: Targets are automatically discovered from `apps/*/Dockerfile`. Each directory in `apps/` that contains a `Dockerfile` is considered a target (e.g., `backend`, `web`).

**Special Cases**:

- The `build` command also supports a special `base` target for the base image
- When no targets are specified:
  - **Script classes**: Operate on all discovered targets
  - **Host execution**: Run at root level (no filter)
  - **Container execution**: Run in all target containers sequentially

### Global Environment Variables

These environment variables can be set to customize the behavior of all commands:

| Variable         | Description                         | Default        |
| ---------------- | ----------------------------------- | -------------- |
| `ENV_FILE`       | Path to the environment file        | `.env`         |
| `DOCKER_BUILDER` | Custom Docker Buildx builder name   | `nopo-builder` |
| `DOCKER_PUSH`    | Push images to registry after build | `false`        |

For a complete reference, see [Environment Variables Reference](./reference/environment-variables.md).

## Advanced Features

### Service Discovery and Filtering

The `list` command provides powerful service discovery capabilities:

```bash
# List all services
nopo list

# Filter buildable services
nopo list --filter buildable

# Filter by infrastructure properties
nopo list --filter "infrastructure.cpu=1"
nopo list --filter has_database

# Output in machine-readable formats
nopo list --json
nopo list --csv
nopo list --json --jq '.services | keys'
```

### Docker Tag Support with Digests

Advanced Docker tag parsing supports content-addressable images:

```bash
# Standard tag
DOCKER_TAG=myimage:v1.0.0

# With digest for content addressing
DOCKER_TAG=myimage:v1.0.0@sha256:abc123def456...
```

### Performance Optimization

Offline-first sync and parallel execution for faster workflows:

```bash
# Offline-first sync (falls back to online if needed)
nopo up

# Parallel builds with dependency resolution
nopo build backend web
```

### Machine-Readable Output

Commands support JSON/CSV output for automation:

```bash
# Service inventory in JSON
nopo list --json > services.json

# Build output for CI
nopo build --output build-info.json

# Status for monitoring
nopo status --json
```

### Configuration Validation

Validate your nopo.yml configuration:

```bash
nopo list --validate
```

## See Also

- [Advanced Configuration Guide](./guides/advanced-configuration.md) - Docker tags, build options, and environment variables
- [Performance Optimization Guide](./guides/performance-optimization.md) - Offline-first sync and parallel execution
- [CI/CD Integration Guide](./guides/cicd-integration.md) - Pipeline examples and automation
- [Environment Variables Reference](./reference/environment-variables.md) - Complete environment variables reference

## Command Routing

The CLI uses intelligent routing to determine how to execute commands:

1. **Help**:
   - `nopo` or `nopo help` → Print general help
   - `nopo <command> help` or `nopo <command> --help` → Print command-specific help
2. **Script Class**: If first argument matches a built-in command → Execute script class
3. **Container Mode**: If first argument is `run` → Execute arbitrary command in containers
4. **Host Mode**: Otherwise → Execute arbitrary command on host

See [Architecture Documentation](./architecture.md) for detailed flow diagrams and algorithms.

### Recursive Help

Help works recursively for all commands:

```bash
nopo help              # General help showing all commands
nopo build help        # Detailed help for build command
nopo up help           # Detailed help for up command
nopo lint help         # Help for arbitrary commands
```

## Architecture

### Core Components

- **Script**: Base class for all commands with dependency resolution
- **Runner**: Orchestrates script execution and dependency management
- **HostScript**: Handles arbitrary pnpm script execution on host (`nopo <script> ...`)
- **IndexScript**: Handles arbitrary pnpm script execution in containers (`nopo run <script> ...`)
- **Environment**: Handles environment variable parsing and validation
- **Logger**: Configurable logging with color support
- **DockerTag**: Docker tag parsing and manipulation utilities

### Shared Algorithms

All commands (script classes and arbitrary) use shared algorithms:

- **Target Resolution**: Extracts and validates targets from positional arguments
- **Dependency Resolution**: Resolves and executes prerequisites before main command

See [Architecture Documentation](./architecture.md) for detailed explanations and diagrams.

### Dependency System

Commands can declare dependencies that are automatically resolved before execution. Dependencies can be conditionally enabled based on the current environment:

```typescript
export default class UpScript extends Script {
  static dependencies = [
    {
      class: EnvScript,
      enabled: true, // Always run env first
    },
    {
      class: BuildScript,
      enabled: (runner) => runner.environment.env.DOCKER_VERSION === "local",
    },
  ];
}
```

**Dependency Behavior**:

- **Script Classes**: Full dependency resolution (env, build, pull as needed)
- **Host Execution**: Only `EnvScript` (environment variables)
- **Container Execution**: Full dependency resolution (env, build/pull if service down)

### Environment Resolution

The tool follows this precedence for configuration:

1. Command line environment variables
2. Process environment variables
3. `.env` file values
4. Computed defaults (git info, free ports, etc.)

## Troubleshooting

### Build Errors

- Ensure all dependencies are installed: `pnpm install`
- Check TypeScript errors: `nopo check root -- types`
- Clear build cache: `nopo clean root && nopo compile root`

### CLI Not Found After Installation

- Verify the package is properly linked: `pnpm ls -g nopo`
- Check your PATH includes pnpm/npm global bin directory
- Try rebuilding: `nopo compile root -- nopo`

### Permission Errors

- On Unix systems, ensure the binary is executable: `chmod +x ./bin.js`
- For global installation, you may need sudo: `sudo npm install -g .`
