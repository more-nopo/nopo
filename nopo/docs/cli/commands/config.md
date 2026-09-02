# Command Configuration

Commands can be defined in service `nopo.yml` files to specify how the service should execute specific operations. This allows for powerful dependency resolution and parallelization.

## Overview

All commands must be defined in `nopo.yml` files. There is no fallback to `package.json` scripts.

When running a command like `nopo check backend`, nopo will:

1. Look for a `check` command in the backend service's `nopo.yml`
2. Validate that all target services have the command defined
3. Build a dependency graph and execution plan
4. Execute commands in parallel stages

## Command Definition

Commands are defined in the `commands` section of a service's `nopo.yml`.

### Shorthand Syntax

For simple commands, use the shorthand syntax:

```yaml
commands:
  lint: eslint .
  build: npm run build
  test: npm run test
```

### Full Object Syntax

For more control, use the full object syntax:

```yaml
commands:
  build:
    command: npm run build
    env:
      NODE_ENV: production
    dir: ./src
```

### Command Properties

| Property | Type | Description |
|----------|------|-------------|
| `command` | string | The command to execute |
| `dependencies` | array \| object | Dependencies to run before this command |
| `env` | object | Environment variables to set when running the command |
| `dir` | string | Working directory: "root", absolute path, or relative to service |
| `commands` | object | Nested subcommands (cannot be used with `command`) |

### Environment Variables

Set environment variables for a command:

```yaml
commands:
  build:
    command: npm run build
    env:
      NODE_ENV: production
      DEBUG: "true"
```

Environment variables are merged with the base environment, with command-specific values taking precedence.

### Working Directory

By default, commands run from the service's root directory (e.g., `./apps/web`).

Override this with the `dir` field:

```yaml
commands:
  # Run from project root
  lint:
    command: eslint .
    dir: root

  # Run from absolute path
  deploy:
    command: ./deploy.sh
    dir: /opt/deploy

  # Run from path relative to service
  test:
    command: pytest
    dir: ./tests
```

### Subcommands

Commands can define nested subcommands instead of a direct command. Subcommands run in parallel as siblings:

```yaml
commands:
  check:
    commands:
      types:
        command: tsc --noEmit
      lint:
        command: eslint .
      format:
        command: prettier --check .
```

Shorthand syntax also works for subcommands:

```yaml
commands:
  fix:
    commands:
      py: ruff format
      js: eslint --fix
```

#### Running Subcommands

The CLI supports flexible subcommand targeting:

```bash
nopo check web        # Run all check subcommands on web (types, lint, format in parallel)
nopo check:types web  # Run only check:types on web
nopo check:types      # Run check:types on all services
nopo check            # Run all check subcommands on all services
```

The CLI automatically distinguishes between subcommand names and service names:

- If an argument matches a known subcommand, it's treated as a subcommand filter
- Otherwise, it's treated as a service target

#### Nested Subcommands

Subcommands support up to 3 levels of nesting:

```yaml
commands:
  check:
    commands:
      lint:
        commands:
          ts: tsc --noEmit
          js: eslint .
```

**Important**: Subcommands cannot define their own dependencies. Dependencies are only allowed at the top-level command.

## Service-Level Dependencies

Services can declare dependencies on other services that apply to all commands:

```yaml
name: web
dockerfile: Dockerfile
dependencies:
  - backend
  - shared
commands:
  build: npm run build
```

When running `nopo build web`, the `build` command will first run on `backend` and `shared` (if they have a `build` command defined).

## Command-Level Dependencies

Commands can override service-level dependencies with their own dependency specification:

### Empty Dependencies (No Dependencies)

Override service-level dependencies to run independently:

```yaml
name: web
dockerfile: Dockerfile
dependencies:
  - backend
commands:
  lint:
    # Running lint ignores service-level dependencies
    dependencies: {}
    command: eslint .
```

### Simple Array Dependencies

Run the same command on multiple services first:

```yaml
name: web
dockerfile: Dockerfile
commands:
  build:
    # Run build on backend and worker first
    dependencies:
      - backend
      - worker
    command: npm run build
```

### Complex Dependencies with Different Commands

Run specific commands on dependencies:

```yaml
name: web
dockerfile: Dockerfile
commands:
  run:
    # Run 'run' on web, then 'build' and 'clean' on backend
    dependencies:
      web:
        - run
      backend:
        - build
        - clean
    command: npm start
```

## Execution Behavior

### Command Resolution

When running `nopo lint web backend`:

1. **Validate** - Check all top-level targets have the `lint` command defined
2. **Resolve Dependencies** - Build dependency graph from service and command dependencies
3. **Build Execution Plan** - Group independent commands into parallel stages
4. **Execute** - Run commands in stage order, parallelizing within each stage

### Dependency Requirements

- **Top-level targets** MUST have the requested command defined
- **Dependencies** MUST also have the command defined (error if missing)

### Parallelization

Commands are automatically parallelized when possible:

```
nopo build web api
```

If both `web` and `api` depend on `shared`:

```
Stage 1: [shared:build]     (run first)
Stage 2: [web:build, api:build]  (run in parallel)
```

### Circular Dependency Detection

Nopo detects circular dependencies and throws an error:

```yaml
# web depends on api
name: web
dependencies:
  - api

# api depends on web - CIRCULAR!
name: api
dependencies:
  - web
```

Running any command on these services will fail with a clear error message.

## Example Configuration

Here's a complete example:

```yaml
# apps/backend/nopo.yml
name: backend
description: Django application
dockerfile: Dockerfile

commands:
  # Shorthand for simple commands
  clean: rm -rf __pycache__ .ruff_cache node_modules
  test: uv run python manage.py test src
  start: uv run gunicorn app.wsgi:application
  
  # Full syntax with env
  build:
    command: npm run build
    env:
      NODE_ENV: production
  
  # Subcommands for grouped operations
  fix:
    commands:
      py: uv tool run ruff format
      js: eslint --fix
  
  check:
    commands:
      py: uv tool run ruff check
      js: eslint
      types:
        commands:
          py: uv run mypy .
          js: tsc --noEmit
```

## API Reference

### Types

```typescript
interface ResolvedCommand {
  service: string;
  command: string;
  executable: string;
  env?: Record<string, string>;
  dir?: string;
}

interface ExecutionPlan {
  stages: ResolvedCommand[][];
}

type CommandDependencies =
  | string[]                      // ["backend", "worker"]
  | Record<string, string[]>      // { backend: ["build", "clean"] }
  | undefined;                    // use service-level deps
```
