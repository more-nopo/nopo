# list

List discovered services with filtering and multiple output formats.

## Usage

```bash
nopo list [options]
```

## Options

| Option              | Short         | Description                                                | Default        |
| ------------------- | ------------- | ---------------------------------------------------------- | -------------- |
| `--format <format>` | `-f <format>` | Output format: `text`, `json`, or `csv`                    | `text`         |
| `--json`            | `-j`          | Shortcut for `--format json`                               | N/A            |
| `--csv`             | N/A           | Shortcut for `--format csv`                                | N/A            |
| `--filter <expr>`   | `-F <expr>`   | Filter services by expression (can be used multiple times) | None           |
| `--since <ref>`     | N/A           | Git reference for `changed` filter (branch, tag, commit)   | default branch |
| `--tags <tags>`     | N/A           | Filter services by tags (comma-separated; match any)       | None           |
| `--jq <filter>`     | N/A           | Apply jq filter to JSON output (requires `--json`)         | None           |
| `--validate`        | `-v`          | Validate configuration and show summary                    | `false`        |

## Output Formats

### Text Format (default)

A formatted table showing key service information:

```
SERVICE      CPU     MEMORY    PORT    MIN    MAX    DB          MIGRATE
----------  ------  --------  ------  -----  -----  -----------  ----------
backend     1       512Mi     3000    0      10     yes         yes
web         1       256Mi     3000    0      10     no          no
nginx       1       256Mi     80      0      10     no          no

Total: 3 service(s)
```

### JSON Format

Complete service configuration in JSON format:

```bash
nopo list --format json
```

Output structure:

```json
{
  "config": {
    "name": "Nopo Project",
    "services_dir": "./apps"
  },
  "services": {
    "backend": {
      "description": "Django application that powers API.",
      "cpu": "1",
      "memory": "512Mi",
      "port": 3000,
      "min_instances": 0,
      "max_instances": 10,
      "has_database": true,
      "run_migrations": true,
      "static_path": "build"
    },
    "web": {
      "description": "React Router front-end for Nopo.",
      "cpu": "1",
      "memory": "256Mi",
      "port": 3000,
      "min_instances": 0,
      "max_instances": 10,
      "has_database": false,
      "run_migrations": false,
      "static_path": "build/client"
    }
  }
}
```

### CSV Format

Comma-separated list of service names:

```bash
nopo list --format csv
```

Output:

```
backend,web,nginx
```

## Filtering

The `--filter` option supports powerful filtering expressions to narrow down the services displayed.

### Filter Expressions

| Type         | Format        | Example                           |
| ------------ | ------------- | --------------------------------- |
| Preset       | `buildable`   | `--filter buildable`              |
| Preset       | `changed`     | `--filter changed`                |
| Field exists | `fieldname`   | `--filter has_database`           |
| Field absent | `!fieldname`  | `--filter !has_database`          |
| Field equals | `field=value` | `--filter "infrastructure.cpu=1"` |

**Nested fields**: Use dot notation (`infrastructure.min_instances=0`)

**Combine filters**: Multiple `--filter` options (AND logic)

### Preset Filters

**Buildable services** are those that:

- Have a `dockerfile` specified
- Are not external dependencies
- Can be built using Docker Buildx

**Changed services** are those with files modified since a git reference:

- Uses `git diff` to detect file changes
- Compares against `--since` value (defaults to repository's default branch)
- Useful for CI pipelines to only build/test affected services

```bash
# Services with changes since main branch
nopo list --filter changed

# Services with changes since a specific branch/tag/commit
nopo list --filter changed --since origin/release-1.0
nopo list --filter changed --since v2.0.0
nopo list --filter changed --since abc123

# Combine with buildable for CI builds
nopo list --filter buildable --filter changed
```

### jq Integration

```bash
nopo list --json --jq '.services | keys'      # Service names only
nopo list --json --jq '.services | length'   # Count services
```

#### Field Existence

```bash
# Show services with database
nopo list --filter has_database

# Show services with static path
nopo list --filter static_path
```

#### Field Non-Existence

```bash
# Show services without database
nopo list --filter "!has_database"

# Show services without migrations
nopo list --filter "!run_migrations"
```

#### Field Equality

```bash
# Show services with 1 CPU
nopo list --filter "infrastructure.cpu=1"

# Show services with specific memory
nopo list --filter "infrastructure.memory=512Mi"

# Show services with specific port
nopo list --filter "infrastructure.port=3000"
```

#### Nested Field Support

Use dot notation for nested fields:

```bash
# Infrastructure fields
nopo list --filter "infrastructure.min_instances=0"
nopo list --filter "infrastructure.max_instances=10"

# Command fields
nopo list --filter "commands.build"
nopo list --filter "commands.check"
```

### Combining Filters

Multiple filters can be combined with repeated `--filter` options. All filters must match (AND logic):

```bash
# Show buildable services with database
nopo list --filter buildable --filter has_database

# Show services with 1 CPU and 256Mi memory
nopo list --filter "infrastructure.cpu=1" --filter "infrastructure.memory=256Mi"
```

## jq Integration

When using JSON output, you can pipe through `jq` for advanced querying:

```bash
# Get just service names
nopo list --json --jq '.services | keys'

# Get services with database
nopo list --json --jq '.services | to_entries[] | select(.value.has_database == true) | .key'

# Get CPU and memory for all services
nopo list --json --jq '.services | to_entries[] | {service: .key, cpu: .value.cpu, memory: .value.memory}'

# Count services
nopo list --json --jq '.services | length'
```

## Configuration Validation

Use `--validate` to check your configuration:

```bash
nopo list --validate
```

Output:

```
✓ Valid nopo.yml: Nopo Project (3 services)
```

The validation checks:

- Project configuration structure
- Service configuration validity
- Required field presence
- Dockerfile existence for buildable services

## Examples

```bash
nopo list                           # Table view
nopo list --json                     # JSON output
nopo list --filter buildable          # Buildable services only
nopo list --filter has_database       # Services with database
nopo list --filter "infrastructure.cpu=1"  # CPU filter
nopo list --jq '.services | keys'   # Service names only
nopo list --validate                # Validate configuration
```

### Service Discovery for Automation

```bash
# Get buildable services for CI pipeline
nopo list --filter buildable --csv | tr ',' '\n'

# Get services that need database setup
nopo list --json --jq '.services | to_entries[] | select(.value.has_database == true) | .key'

# Get all service ports for firewall configuration
nopo list --json --jq '.services | to_entries[] | select(.value.port != 0) | "\(.key):\(.value.port)"'
```

## Machine-Readable Output

The command automatically runs in silent mode when using machine-readable formats:

```bash
# No colored output or extra text with JSON/CSV
nopo list --json    # Clean JSON output
nopo list --csv     # Clean CSV output
```

This makes the output suitable for:

- CI/CD pipelines
- Shell scripting
- Programmatic consumption
- Configuration generation

## Output Fields

The following fields are available for filtering and in JSON output:

| Field                | Type    | Description             | Example              |
| -------------------- | ------- | ----------------------- | -------------------- |
| `description`        | string  | Service description     | "Django application" |
| `cpu`                | string  | CPU allocation          | "1"                  |
| `memory`             | string  | Memory allocation       | "512Mi"              |
| `port`               | number  | Service port            | 3000                 |
| `min_instances`      | number  | Minimum instances       | 0                    |
| `max_instances`      | number  | Maximum instances       | 10                   |
| `has_database`       | boolean | Has database connection | true                 |
| `run_migrations`     | boolean | Runs migrations         | true                 |
| `static_path`        | string  | Static files path       | "build"              |
| `infrastructure.cpu` | string  | Nested CPU field        | "1"                  |

## Use Cases

```bash
# CI pipeline - get buildable targets
BUILDABLE=$(nopo list --filter buildable --csv)

# Service inventory
nopo list --json > services.json

# Port documentation
nopo list --jq '.services | to_entries[] | select(.value.port != 0) | {service: .key, port: .value.port}'
```

## See Also

- [Reference](../reference.md) - Complete command reference
- [Configuration](../guides/configuration.md) - Service setup details
