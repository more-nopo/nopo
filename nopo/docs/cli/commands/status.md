# status

Check the status of the services and system information.

## Overview

The `status` command displays the current state of Docker Compose services along with system information. It provides a quick overview of the development environment health and service availability.

## Usage

```bash
nopo status
```

## Arguments

This command does not accept any arguments.

## Options

This command does not accept any options.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENV_FILE` | Path to the environment file | `.env` |

## Dependencies

The `status` command automatically runs the following commands first:

| Command | Condition |
|---------|-----------|
| [`env`](./env.md) | Always (ensures environment is loaded) |

## Examples

### Check status

```bash
nopo status
```

### With custom environment file

```bash
ENV_FILE=.env.staging nopo status
```

## Output

The command outputs JSON with system and service information:

```json
{
  "platform": "darwin arm64",
  "node": "v20.10.0",
  "pnpm": "9.0.0",
  "compose": {
    "nopo-backend-1": {
      "name": "nopo-backend-1",
      "state": "running",
      "ports": [
        "0.0.0.0:8000->8000/tcp"
      ]
    },
    "nopo-web-1": {
      "name": "nopo-web-1",
      "state": "running",
      "ports": [
        "0.0.0.0:3000->3000/tcp"
      ]
    },
    "nopo-db-1": {
      "name": "nopo-db-1",
      "state": "running",
      "ports": [
        "0.0.0.0:5432->5432/tcp"
      ]
    }
  }
}
```

### Output Fields

| Field | Description |
|-------|-------------|
| `platform` | Operating system and architecture |
| `node` | Node.js version |
| `pnpm` | pnpm version |
| `compose` | Object containing service states |

### Service Object Fields

| Field | Description |
|-------|-------------|
| `name` | Container name |
| `state` | Container state (e.g., `running`, `exited`, `paused`) |
| `ports` | Array of port mappings |

## How It Works

1. **Environment Setup**: Runs the `env` command to load environment variables
2. **Collect System Info**: Gathers platform, Node.js, and pnpm versions
3. **Query Docker Compose**: Runs `docker compose ps` to get service states
4. **Format Output**: Structures the data as JSON and outputs to console

### System Information Collection

| Information | Command |
|-------------|---------|
| Platform | `process.platform` + `process.arch` |
| Node.js | `node --version` |
| pnpm | `pnpm --version` |

## Use Cases

### Quick Health Check

Verify all services are running before development:

```bash
nopo status
```

### CI/CD Verification

Check service status after deployment:

```bash
nopo status | jq '.compose | to_entries[] | select(.value.state != "running")'
```

### Debugging Port Conflicts

Find which ports are in use:

```bash
nopo status | jq '.compose[].ports'
```

### Script Integration

Parse status in scripts:

```bash
#!/bin/bash
STATUS=$(nopo status)
if echo "$STATUS" | jq -e '.compose["nopo-backend-1"].state == "running"' > /dev/null; then
  echo "Backend is running"
fi
```

## Service States

Common Docker container states:

| State | Description |
|-------|-------------|
| `running` | Container is actively running |
| `exited` | Container has stopped (check exit code) |
| `paused` | Container is paused |
| `restarting` | Container is restarting |
| `created` | Container created but not started |
| `dead` | Container is in an error state |

## Related Information

### Checking Individual Logs

If a service isn't running, check its logs:

```bash
docker compose logs <service>
```

### Viewing Full Docker Status

For more detailed Docker information:

```bash
docker ps -a
docker compose ps --format json
```

## See Also

- [`up`](./up.md) - Start the services
- [`down`](./down.md) - Stop the services
- [`env`](./env.md) - Set up environment variables


