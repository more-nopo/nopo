# Debugging

Diagnose and troubleshoot nopo issues with internal debugging features.

## Quick Debug Commands

```bash
# Enable all debugging
DEBUG=1 nopo <command>

# Debug specific areas
DEBUG=build,cache nopo build
DEBUG=deps nopo run build
DEBUG=env nopo env
```

## Debug Areas

| Area              | Variables | What It Shows                            |
| ----------------- | --------- | ---------------------------------------- |
| **Build**         | `build`   | Docker build steps, cache hits/misses    |
| **Cache**         | `cache`   | Cache operations and decisions           |
| **Dependencies**  | `deps`    | Dependency resolution and execution plan |
| **Environment**   | `env`     | Variable resolution and precedence       |
| **Configuration** | `config`  | Service discovery and validation         |
| **Timing**        | `timing`  | Execution time for each phase            |

## Common Debug Scenarios

### Build Issues

```bash
# Debug build failures
DEBUG=build nopo build --no-cache

# Check Docker daemon
docker info
docker version

# Manual build test
docker build -t test apps/backend/
```

### Configuration Problems

```bash
# Validate configuration
nopo list --validate

# Debug config loading
DEBUG=config nopo list

# Check service files
ls -la apps/backend/nopo.yml
test -f apps/backend/Dockerfile
```

### Dependency Resolution

```bash
# Debug dependency chains
DEBUG=deps nopo run build web

# Show execution plan
# Output: Stage 1: [shared:build], Stage 2: [web:build]
```

### Container Issues

```bash
# Debug container startup
DEBUG=container nopo up backend

# Check container status
nopo status --json

# Manual container inspection
docker compose logs backend
docker inspect nopo_backend
```

## Environment Debugging

### Resolution Issues

```bash
# Show variable resolution
DEBUG=env nopo env

# Check current environment
env | grep DOCKER_
env | grep GIT_

# Force regeneration
nopo env --force
```

### Docker Tag Problems

```bash
# Debug tag parsing
DEBUG=docker-tag nopo build

# Test tag format
echo "registry.com/app:v1.0.0" | nopo parse-tag  # If available
```

## Performance Debugging

### Slow Operations

```bash
# Time operations
time nopo build
time nopo up

# Profile with timing debug
DEBUG=timing nopo build

# Check system resources
docker stats
df -h
```

### Cache Problems

```bash
# Debug cache behavior
DEBUG=cache nopo build

# Clear cache if needed
docker builder prune -f
nopo build --no-cache

# Check cache volume
docker volume ls | grep nopo
```

## Development Debugging

### CLI Development

```bash
# Test local changes
cd packages/nopo
pnpm build --watch
pnpm link --global

# Debug command routing
DEBUG=route nopo lint web

# Validate all configurations
nopo list --validate
```

### Service State

```bash
# Service state debugging
DEBUG=service:backend nopo up backend

# Container inspection
docker compose ps
docker compose logs --tail=50 backend
```

## Error Patterns

### Common Issues & Fixes

| Error                   | Debug Command            | Fix                                     |
| ----------------------- | ------------------------ | --------------------------------------- | ------------------- |
| **Build fails**         | `DEBUG=build nopo build` | Check Dockerfile, clear cache           |
| **Service not found**   | `DEBUG=config nopo list` | Verify Dockerfile exists                |
| **Environment missing** | `DEBUG=env nopo env`     | Check .env file, run `nopo env --force` |
| **Permission denied**   | Check Docker access      | Add user to docker group                |
| **Port conflicts**      | `netstat -tulpn          | grep :3000`                             | Change service port |

## Debug Recipes

### Full System Check

```bash
# Comprehensive diagnostic
echo "=== System ==="
docker --version
nopo --version

echo "=== Configuration ==="
nopo list --validate

echo "=== Environment ==="
DEBUG=env nopo env

echo "=== Services ==="
nopo status --json
```

### Build Session

```bash
# Complete build debug
DEBUG=build,cache,timing nopo build --no-cache
time nopo build
```

### Container Session

```bash
# Service startup debug
DEBUG=container,timing nopo up backend
docker compose logs backend
```

### CI Debug

```bash
# Pipeline debugging
DEBUG=build,deps,env nopo build
nopo list --validate --json
```

## Internal Features

### Verbose Mode

```bash
# Show all internal operations
DEBUG=1 nopo <command>

# Selective verbose
DEBUG=build nopo build      # Only build verbosity
DEBUG=deps nopo run build   # Only dependency resolution
```

### Silent Mode

Automatic for machine-readable output:

- `nopo list --json` - No colored output
- `nopo list --csv` - Clean CSV output

### Exit Code Debugging

| Code | Meaning             | Common Cause          |
| ---- | ------------------- | --------------------- |
| `0`  | Success             | -                     |
| `1`  | General error       | Command failed        |
| `4`  | Configuration error | Invalid nopo.yml      |
| `5`  | Docker error        | Build/container issue |

---

**See Also**: [Troubleshooting](./troubleshooting.md) - Common issues and solutions
