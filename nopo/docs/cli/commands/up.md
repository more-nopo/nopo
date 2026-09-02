# up

Start the services with automatic dependency management.

## Overview

The `up` command is the primary command for starting the development environment. It automatically handles environment setup, image building or pulling, dependency synchronization, and service startup. This is typically the only command you need to run to get the full development environment up and running.

## Usage

```bash
nopo up [targets...]
```

## Arguments

| Argument  | Description                                                       |
| --------- | ----------------------------------------------------------------- |
| `targets` | Optional list of targets to start. If omitted, starts all targets |

### Available Targets

Targets are discovered from `nopo.yml` service metadata under `services.dirs` (e.g., `backend`, `web`, `af-api`).

## Options

| Option                          | Description                                               | Default        |
| ------------------------------- | --------------------------------------------------------- | -------------- |
| `--filter <expr>` / `-F <expr>` | Filter targets by expression (can be used multiple times) | None           |
| `--since <ref>`                 | Git reference for `changed` filter                        | default branch |

### Filtering

You can filter which services to start using expressions:

```bash
# Start only services with changes since main branch
nopo up --filter changed

# Start services with database
nopo up --filter infrastructure.hasDatabase=true

# Start only buildable services that have changed
nopo up --filter buildable --filter changed
```

See [`list`](./list.md) for full filter expression documentation.

## Environment Variables

| Variable                    | Description                                                                                                                                | Default          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `DOCKER_BUILD`              | Force local build instead of pull                                                                                                          | `false`          |
| `DOCKER_VERSION`            | Image version                                                                                                                              | `local`          |
| `DOCKER_TAG`                | Complete Docker image tag                                                                                                                  | From `.env`      |
| `DOCKER_TARGET`             | Build target (`development` or `production`)                                                                                               | Based on version |
| `DOCKER_PORT`               | Port for the main service                                                                                                                  | Random free port |
| `NOPO_AGE_IDENTITY_COMMAND` | Shell command that emits the operator's age identity. Required when any service has runtime-overlay `secrets:` set; see [`secret`](./secret.md) | None             |

## Secrets and the `--print` flag

Services declare encrypted secrets under `runtime.<name>.secrets:` in their `nopo.yml` (each value is an `ENC[...]` envelope produced by [`nopo secret set`](./secret.md)). At `nopo up` time the docker-compose plugin:

1. Loads your age identity by spawning `NOPO_AGE_IDENTITY_COMMAND` (e.g. `op read 'op://Vault/nopo/age-identity'`). The identity command is invoked at most once per `up` invocation.
2. Decrypts each `ENC[...]` value into the service's compose `environment:` block.
3. Pipes the resulting compose document to `docker compose -f -` over stdin and starts the services.

**Decrypted plaintext lives only in memory and the `docker compose` subprocess** — `nopo up` does not write the resolved compose document to `.nopo/docker-compose/docker-compose.yml` or anywhere else on disk. If `NOPO_AGE_IDENTITY_COMMAND` is unset (or the command fails) and any service has runtime secrets, `nopo up` errors out before starting anything; services without secrets are unaffected.

Pass `--print` to inspect the generated compose document without starting services. The redacted form is written to `.nopo/docker-compose/docker-compose.yml`:

```bash
nopo up --print
```

In `--print` output:

- Every value sourced from a `runtime.<name>.secrets:` block is replaced with `[REDACTED]`.
- `runtime.<name>.env:` values pass through verbatim.
- `--print` never spawns `NOPO_AGE_IDENTITY_COMMAND`, so the redacted document is safe to share, attach to a bug report, or commit alongside an issue without leaking secrets.

The terraform plugin follows the same model when deploying to k8s — decrypted plaintext lands in the per-service `<svc>-secrets` Secret manifest's `data:` (base64) and is piped to `kubectl apply -f -` over stdin, never written to a manifest file under the project tree.

## Dependencies

The `up` command automatically runs dependencies based on conditions:

| Command               | Condition                                          |
| --------------------- | -------------------------------------------------- |
| [`env`](./env.md)     | Always (sets up environment variables)             |
| [`build`](./build.md) | When `DOCKER_VERSION=local` or `DOCKER_BUILD=true` |
| [`pull`](./pull.md)   | When using a remote image version                  |

### Dependency Logic

The command determines whether to build or pull based on:

```typescript
function isBuild(runner): boolean {
  const forceBuild = !!config.processEnv.DOCKER_BUILD;
  const localVersion = environment.env.DOCKER_VERSION === "local";
  return forceBuild || localVersion;
}
```

## Examples

### Start all targets (default)

```bash
nopo up
```

### Start specific targets

```bash
nopo up backend web
```

### Force local build

```bash
DOCKER_BUILD=true nopo up
```

### Start with pre-built image

```bash
DOCKER_VERSION=v1.0.0 nopo up
```

### Start production mode locally

```bash
DOCKER_TARGET=production nopo up
```

## How It Works

1. **Environment Setup**: Runs the `env` command to configure environment variables
2. **Image Preparation**: Either builds locally or pulls from registry
3. **Dependency Sync**: Syncs Node.js and Python dependencies in parallel
4. **Container Cleanup**: Brings down any existing containers that need rebuilding
5. **Image Pull**: Pulls any additional images (databases, etc.)
6. **Service Startup**: Starts all services in detached mode
7. **Health Wait**: Waits for all services to be healthy
8. **Success Message**: Displays the URL to access the application

### Parallel Operations

The following operations run in parallel for faster startup:

- **UV Sync**: Python dependencies (`uv sync --locked --active`)
- **pnpm Sync**: Node.js dependencies (`pnpm install --frozen-lockfile`)
- **Down Services**: Stops containers using the old image
- **Pull Images**: Pulls supporting images (databases, etc.)

### Offline-First Strategy

Both dependency managers try offline mode first:

1. **UV (Python)**: Tries `--offline` flag first, falls back to online
2. **pnpm (Node)**: Tries `--offline` flag first, falls back to online

This makes subsequent starts faster when caches are warm.

### Production Mode

When `DOCKER_TARGET=production`:

```bash
# Builds all packages before starting
pnpm -r build
```

This ensures all packages are compiled for production.

## Output

The command outputs progress for each step:

```plaintext
======================================
env: Set up environment variables
======================================
Updated: /path/to/project/.env
...

======================================
build: Build base image and service images
======================================
Building targets: all
...

[sync_uv] Resolved 45 packages
[sync_pnpm] Packages are up to date
[down] Stopping containers...
[up] Starting services...

🚀 Services are up! Visit: http://localhost:8080
```

## Service Configuration

Services are discovered from:

- **Compose Files**: `apps/*/docker-compose.yml`
- **Root Compose**: `docker-compose.yml` (aggregates via `include`)

### Container Options

Services start with these Docker Compose options:

| Option             | Description                           |
| ------------------ | ------------------------------------- |
| `--remove-orphans` | Remove containers not in compose file |
| `-d`               | Detached mode (run in background)     |
| `--no-build`       | Don't rebuild images (already built)  |
| `--wait`           | Wait for services to be healthy       |

## Error Handling

### Failed Health Checks

If services fail to start or become healthy:

```plaintext
[log:backend] Error: Connection refused...
Error: Failed to start services
```

The command automatically retrieves logs from all services to help debug.

### Missing Docker Tag

```plaintext
Error: DOCKER_TAG is required but was empty
```

Solution: Run `nopo env` first or set `DOCKER_TAG`.

### Dependency Sync Failures

If UV or pnpm fail to sync:

```plaintext
Offline uv sync failed, falling back to online sync...
```

The command automatically retries with online mode.

## Use Cases

### Daily Development

```bash
# Start your day
nopo up

# Work on code (changes hot-reload)
# ...

# End of day
nopo down
```

### Clean Start

```bash
# Remove everything and start fresh
nopo down
nopo up
```

### Using Production Images

```bash
# Pull and run production images locally
DOCKER_VERSION=v1.0.0 nopo up
```

### CI/CD Pipeline

```bash
# Build and test
nopo up
nopo run test
nopo down
```

## Port Access

After successful startup, access the application at:

```plaintext
http://localhost:<DOCKER_PORT>
```

The port is displayed in the success message and stored in `.env`.

## Secrets (terraform plugin)

When `nopo up` dispatches to the terraform plugin (e.g. `nopo up --runtime prod`), the plugin generates a per-service Kubernetes Secret from each service's `runtime.<runtime>.secrets:` block.

### What happens

1. The plugin loads the operator's age identity once via `NOPO_AGE_IDENTITY_COMMAND` (see [`secret`](./secret.md)).
2. For each service with secrets, it walks `resolveRuntime(svc.runtimes, ctx.runtime).envs.secrets` — the `ENC[...]` envelopes that survived runtime resolution.
3. Each envelope is decrypted in-process to plaintext.
4. Plaintext is assembled into a Kubernetes `Secret` manifest's `stringData:` map.
5. The manifest is **piped via stdin** to `kubectl apply -f -`.
6. The Deployment's `envFrom: secretRef:` injects those values into every container — including each process container in a multi-process service (all processes in a service share the runtime's effective env+secrets).

### Plaintext containment

Decrypted secret values live only in:

- The `nopo` process memory (until the manifest is piped out and garbage-collected).
- The `kubectl` subprocess (briefly, while it transmits the manifest).
- The Kubernetes API server (over the cluster's own TLS-protected API).

Plaintext **never lands on local disk**. The non-secret manifests (Deployment, Service, ConfigMap, PVC) still go through a tmp manifest directory at `${TMPDIR}/nopo-k8s-XXXX/manifests.yaml`, but Secret manifests bypass that path entirely.

The plugin no longer:

- Reads `process.env.<KEY>` to populate Secret values. nopo.yml is the single source of truth for runtime secrets.
- Falls back to a pre-existing in-cluster Secret. Every `nopo up` regenerates the Secret from nopo.yml.

If the operator wants a value from a runner-side env var (e.g. an ephemeral CI token not committed to nopo.yml), they should put it in nopo.yml under `runtime.<name>.secrets:` first using `nopo secret set`.

### `--print` mode

`nopo up --runtime prod --print` emits all generated manifests to stdout for review/diffing without applying them. Secret manifests render with every value replaced by `[REDACTED]`. Other manifest kinds (Deployment, Service, ConfigMap, PVC) emit verbatim — they don't carry sensitive data.

`--print` does **not** decrypt — it builds the redacted Secret skeleton from the runtime's declared keys, so the operator doesn't need `NOPO_AGE_IDENTITY_COMMAND` set just to preview a deploy.

### CI / production setup

The CI runner (or production deploy box) MUST set `NOPO_AGE_IDENTITY_COMMAND` before `nopo up --runtime prod` runs. Recommended pattern: mount a runner-side keystore file and `cat` it.

```yaml
# .github/workflows/deploy.yml — sketch
- name: Mount age identity
  run: echo "$AGE_IDENTITY" > /run/secrets/nopo-age-identity && chmod 600 /run/secrets/nopo-age-identity
  env:
    AGE_IDENTITY: ${{ secrets.NOPO_AGE_IDENTITY }}
- name: Deploy
  env:
    NOPO_AGE_IDENTITY_COMMAND: cat /run/secrets/nopo-age-identity
  run: nopo up --runtime prod
```

Avoid `NOPO_AGE_IDENTITY_COMMAND="echo $RAW_KEY"` — putting the raw key on the command line leaks it to `ps`, /proc/self/environ, and any audit-log scraper. Use a file or a secret-manager command (`op read ...`, `gcloud secrets versions access ...`, etc.) instead.

If `NOPO_AGE_IDENTITY_COMMAND` is unset on a deploy runner, `nopo up` errors out before contacting the cluster — no half-baked rollouts with stale Secrets.

## See Also

- [`down`](./down.md) - Stop the services
- [`build`](./build.md) - Build images manually
- [`pull`](./pull.md) - Pull images manually
- [`status`](./status.md) - Check service status
- [`env`](./env.md) - Set up environment variables
- [`secret`](./secret.md) - Manage encrypted runtime secrets
