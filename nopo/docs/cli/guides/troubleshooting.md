# Troubleshooting

Quick fixes for common nopo issues.

## Quick Diagnosis

```bash
nopo --version              # Installation check
nopo list --validate         # Configuration check
nopo status                  # System status
nopo env                     # Environment setup
```

## Installation & Setup

| Issue                 | Quick Fix                                          |
| --------------------- | -------------------------------------------------- |
| **CLI not found**     | `which nopo` → reinstall with `pnpm link --global` |
| **Permission denied** | `chmod +x ./bin.js` or use `npx nopo`              |
| **Version conflict**  | `npm uninstall -g nopo && pnpm link --global`      |

### Permission Errors

**Problem**: `EACCES: permission denied` or similar permission errors

**Causes**:

- Global installation without proper permissions
- Binary not executable

**Solutions**:

```bash
# Fix permissions on binary
chmod +x ./packages/nopo/bin.js

# Use npx to run without global installation
npx nopo --version

# Install with sudo (last resort)
sudo npm install -g nopo

# Or use a Node version manager (recommended)
# nvm, fnm, or volta handle permissions correctly
```

### Version Conflicts

**Problem**: Multiple nopo versions or outdated version

**Causes**:

- Local and global versions conflict
- Incomplete update

**Solutions**:

```bash
# Check all installed versions
npm list -g nopo
pnpm list -g nopo
npm ls nopo

# Remove all versions and reinstall
npm uninstall -g nopo
pnpm uninstall -g nopo
npm rm nopo

# Clean reinstall
cd packages/nopo
pnpm install --ignore-workspace
pnpm clean && pnpm build
pnpm link --global

# Verify clean installation
nopo --version
```

## Configuration Issues

### Invalid nopo.yml

**Problem**: Configuration validation errors

**Causes**:

- Syntax errors in YAML
- Missing required fields
- Invalid field values

**Common Errors**:

```bash
Error: Invalid configuration: Missing required field 'name'
Error: Invalid configuration: 'dockerfile' must be a string
Error: Invalid configuration: 'infrastructure.cpu' must be a string
```

**Solutions**:

```bash
# Validate configuration
nopo list --validate

# Check YAML syntax
# Install yamllint for better error messages
npm install -g yamllint
yamllint apps/*/nopo.yml
yamllint nopo.yml

# Verify required fields
cat apps/backend/nopo.yml | grep -E "^(name|dockerfile):"

# Check against reference configuration
# Compare with working service configuration
```

### Service Not Discovered

**Problem**: Service not showing up in `nopo list`

**Causes**:

- Missing Dockerfile
- Invalid service directory structure
- nopo.yml not found

**Solutions**:

```bash
# Check directory structure
ls -la apps/
ls -la apps/backend/

# Verify required files
test -f apps/backend/Dockerfile && echo "✓ Dockerfile exists"
test -f apps/backend/nopo.yml && echo "✓ nopo.yml exists"

# Check permissions
ls -la apps/backend/Dockerfile
ls -la apps/backend/nopo.yml

# Validate service configuration
nopo list --filter name=backend
nopo list --json | jq '.services.backend'
```

### Missing Required Fields

**Problem**: Validation errors for missing fields

**Common Required Fields**:

- `name` (service name)
- `dockerfile` (Dockerfile path)

**Solutions**:

```bash
# Check service configuration
cat apps/backend/nopo.yml

# Add missing fields
name: backend
description: Backend service
dockerfile: Dockerfile

# Minimal working configuration
name: myservice
description: My service description
dockerfile: Dockerfile
runtime:
  cpu: "1"
  memory: "256Mi"
  port: 3000
```

## Docker Issues

| Problem                   | Quick Fix                                             |
| ------------------------- | ----------------------------------------------------- |
| **Docker not running**    | Start Docker Desktop or `sudo systemctl start docker` |
| **Build fails**           | `nopo build --no-cache` + check Dockerfile syntax     |
| **Container won't start** | `nopo status` + `lsof -i :3000` for port conflicts    |
| **Permission denied**     | `sudo usermod -aG docker $USER` (Linux)               |

### Common Docker Fixes

```bash
# Clear Docker cache
docker builder prune -f && docker system prune -f

# Check Docker status
docker --version && docker compose ps

# Debug container issues
docker compose logs backend
```

---

## See Also

- [Reference](../reference.md) - Complete command reference
- [Debugging](./debugging.md) - Advanced debugging techniques

# Check Dockerfile syntax

docker build -t test-build .
docker build --no-cache -t test-build .

# Verify build context

ls -la apps/backend/
docker build apps/backend/

# Check available disk space

df -h
docker system df

# Clear Docker cache if needed

docker builder prune -f
docker system prune -f
nopo build --no-cache

````

### Container Start Failures

**Problem**: Containers fail to start

**Common Causes**:

- Port conflicts
- Resource limits
- Volume mount issues
- Configuration errors

**Solutions**:

```bash
# Check container status
nopo status
docker compose ps
docker compose logs

# Debug specific service
DEBUG=container nopo up backend
docker compose up backend
docker compose logs backend

# Check port conflicts
netstat -tulpn | grep :3000
lsof -i :3000

# Check resource usage
docker stats
docker inspect nopo_backend

# Try manual container start
docker compose run --rm backend sh
````

### Permission Denied (Docker)

**Problem**: Docker permission errors

**Symptoms**:

- `permission denied while trying to connect to the Docker daemon`
- `Got permission denied`

**Solutions**:

```bash
# Add user to docker group (Linux)
sudo usermod -aG docker $USER
# Log out and log back in for changes to take effect

# Or use sudo (not recommended for development)
sudo nopo build

# Check current groups
groups
grep docker /etc/group

# Verify Docker daemon permissions
ls -la /var/run/docker.sock
```

## Environment & Registry

| Problem                  | Quick Fix                                          |
| ------------------------ | -------------------------------------------------- |
| **Missing DOCKER_TAG**   | `nopo env --force` to regenerate .env              |
| **Git info unknown**     | `git init && git add . && git commit -m "initial"` |
| **Registry auth failed** | `docker login registry.example.com`                |

### Environment Fixes

```bash
# Regenerate environment
nopo env --force

# Check current env
nopo env | grep DOCKER_

# Manual setup
export DOCKER_TAG="myapp:local"
```

### Git Information Issues

**Problem**: Git not available or not in repository

**Symptoms**:

- `GIT_REPO=unknown`
- `GIT_BRANCH=unknown`
- `GIT_COMMIT=unknown`

**Solutions**:

```bash
# Check Git installation
git --version
which git

# Check if in Git repository
git status
git rev-parse --is-inside-work-tree

# Initialize Git repository if needed
git init
git add .
git commit -m "Initial commit"

# Configure Git remote if needed
git remote add origin https://github.com/user/repo.git
git push -u origin main

# Verify Git information
git config --get remote.origin.url
git branch --show-current
git rev-parse HEAD
```

### Registry Authentication

**Problem**: Cannot push/pull from registry

**Symptoms**:

- `failed to solve: access denied`
- `unauthorized: authentication required`
- `no basic auth credentials`

**Solutions**:

```bash
# Check registry configuration
echo $DOCKER_REGISTRY
nopo env | grep DOCKER_REGISTRY

# Login to registry
docker login registry.example.com
docker login  # For Docker Hub

# Check current login status
docker info | grep -i registry

# Test registry access
docker pull registry.example.com/myapp:latest

# Configure credentials in CI
# GitHub Actions: use secrets
# GitLab CI: use CI/CD variables
# AWS ECR: use AWS credentials
```

## Command & Performance

| Problem              | Quick Fix                                       |
| -------------------- | ----------------------------------------------- |
| **Unknown command**  | `nopo help` - check spelling                    |
| **Unknown target**   | `nopo list` - verify service names              |
| **Script not found** | Check `package.json` scripts section            |
| **Slow builds**      | `nopo build --no-cache` + optimize Dockerfile   |
| **Slow sync**        | First run populates cache, subsequent runs fast |
| **High memory**      | Adjust `infrastructure.memory` in nopo.yml      |
| **Port conflicts**   | `lsof -i :3000` and kill process or change port |

### Unknown Target

**Problem**: Service target not found

**Symptoms**:

- `Error: Unknown target 'invalid'`
- `Available targets: backend, web`

**Solutions**:

```bash
# List available targets
nopo list
nopo list --csv

# Check target spelling
nopo build backend  # not "bakend"
nopo up web        # not "wbe"

# Verify service files
ls -la apps/
test -f apps/backend/Dockerfile

# Rebuild target discovery
nopo list --validate
```

### Script Not Found

**Problem**: pnpm script doesn't exist

**Symptoms**:

- `ERR_PNPM_NO_SCRIPT Missing script: /^lint.*/`
- Script execution fails

**Solutions**:

```bash
# Check available scripts
nopo list --json | jq '.services.backend.commands | keys[]'
cat apps/backend/package.json | jq '.scripts'

# Add missing script to package.json
{
  "scripts": {
    "lint": "eslint .",
    "test": "jest",
    "build": "npm run build"
  }
}

# Use correct script name
nopo lint      # not "npm run lint"
nopo run lint   # for container execution
```

## Performance Issues

### Slow Builds

**Problem**: Docker builds taking too long

**Causes**:

- No build caching
- Large Docker context
- Network downloads
- Resource constraints

**Solutions**:

```bash
# Profile build time
time nopo build
DEBUG=timing nopo build

# Enable build caching
# Local cache (automatic)
nopo build

# CI cache
CI=true nopo build

# Custom registry cache
DOCKER_BUILDKIT_CACHE=type=registry,ref=mycache nopo build

# Optimize Dockerfile
# Use multi-stage builds
# Order layers from least to most likely to change
# Use .dockerignore

# Clean build
nopo build --no-cache  # One time to clear issues
docker builder prune -f
```

### Slow Sync

**Problem**: Package synchronization is slow

**Causes**:

- No offline cache
- Network bandwidth
- Large dependency trees

**Solutions**:

```bash
# Check sync performance
time nopo up
DEBUG=sync nopo up

# Ensure offline cache is populated
# First run will be slow (online)
# Subsequent runs should be fast (offline)

# Manually warm up cache
nopo build
nopo up

# Check cache volume
docker volume ls | grep nopo
docker volume inspect nopo_base_cache

# Clear and rebuild cache if needed
docker volume rm nopo_base_cache
nopo up  # Will repopulate
```

### High Memory Usage

**Problem**: Containers using too much memory

**Solutions**:

```bash
# Check memory usage
docker stats
nopo status

# Adjust service limits
# Edit nopo.yml
infrastructure:
  memory: "256Mi"  # Reduce from 512Mi

# Clean up unused containers
docker compose down --remove-orphans
docker system prune -f

# Monitor memory trends
docker stats --format "table {{.Container}}\t{{.MemUsage}}"
```

## Network Issues

### Port Conflicts

**Problem**: Services can't bind to ports

**Symptoms**:

- `Port already in use`
- `bind: address already in use`

**Solutions**:

```bash
# Find process using port
netstat -tulpn | grep :3000
lsof -i :3000

# Kill conflicting process
kill -9 <PID>

# Change service port
# Edit nopo.yml
infrastructure:
  port: 3001  # Change from 3000

# Use different ports per service
backend: port 3000
web: port 3001
api: port 3002
```

### Registry Connection Issues

**Problem**: Cannot connect to Docker registry

**Solutions**:

```bash
# Test network connectivity
ping registry.example.com
curl -I https://registry.example.com/v2/

# Check DNS
nslookup registry.example.com
dig registry.example.com

# Test Docker registry
docker pull registry.example.com/hello-world

# Configure proxy if needed
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080

# Use different registry
export DOCKER_REGISTRY=mirror.gcr.io
nopo pull
```

## Dependency Issues

### Circular Dependencies

**Problem**: Services depend on each other

**Symptoms**:

- `Error: Circular dependency detected`
- Execution plan fails

**Example**:

```yaml
# apps/web/nopo.yml
dependencies:
  - api

# apps/api/nopo.yml
dependencies:
  - web  # CIRCULAR!
```

**Solutions**:

```bash
# Debug dependency resolution
DEBUG=deps nopo run build web

# Identify circular dependency
# Look in error message for dependency chain

# Fix by:
# 1. Removing one dependency
# 2. Using shared service
# 3. Restructuring services

# Correct structure
dependencies:
  - shared  # Both depend on shared
```

### Missing Dependencies

**Problem**: Service dependencies not found

**Symptoms**:

- `Error: Unknown dependency 'missing-service'`
- Command validation fails

**Solutions**:

```bash
# Check available services
nopo list

# Verify dependency exists
nopo list --filter name=shared

# Fix service configuration
dependencies:
  - backend  # Ensure correct spelling
  - web      # Ensure service exists

# Remove non-existent dependencies
dependencies: []  # No dependencies
```

## Deploy reported success but the cluster stayed on a stale image

**Problem**: CI `nopo up` prints `Deploying N service(s)` then exits 0. The next step fails with `deploy was a no-op`.

**Cause**: Bun 1.3 can exit 0 when no I/O handles remain, even if `main()` is still pending. The old `bin.js` used a floating `import("./bin.ts")`. The death window is secret decrypt after `loadIdentity()`'s `cat` child closes.

**Solutions**:

- Confirm the CLI entry awaits `main()`: `packages/nopo/bin.js` must `await import("./bin.ts")`.
- Re-run the Release deploy. The verify gate must see the new image tag on `af-api-*` / `af-web` / `af-nginx`.

## Quick Fixes

```bash
# System check
nopo --version && nopo list --validate

# Common fixes
nopo env --force              # Regenerate environment
docker system prune -f          # Clean Docker cache
nopo build --no-cache           # Fresh build
```

---

**See Also**: [Reference](../reference.md) - Complete command reference
