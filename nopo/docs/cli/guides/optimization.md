# Performance

Optimize nopo workflows with caching, parallel execution, and resource management.

## Quick Wins

```bash
# 1. Enable offline sync (automatic)
nopo up  # First run online, subsequent runs offline

# 2. Use host execution for fast checks
nopo lint web           # vs nopo run lint web (faster)

# 3. Build only what you need
nopo build backend       # vs nopo build (all)

# 4. Use parallel builds
nopo build backend web   # Services build in parallel
```

## Offline-First Sync

### How It Works

1. **Try offline sync first** (fast)
2. **Fall back to online** if cache empty (slower)
3. **Cache dependencies** for next run

### Benefits

- **5-10x faster** on subsequent runs
- **Network independent** once cached
- **Consistent dependencies** across environments

### Cache Management

```bash
# Warm up cache (one-time)
nopo build
nopo up

# Clear if needed
docker volume rm nopo_base_cache

# Rebuild fresh cache
nopo build --no-cache
```

## Parallel Execution

### Dependency Stages

```
Stage 1: [shared:build]           # No dependencies
Stage 2: [backend:build, api:build]  # Parallel (both depend on shared)
Stage 3: [web:build]              # After backend
```

### Optimize for Parallelism

```yaml
# Good: Minimal dependencies
name: web
dependencies: []

name: api
dependencies: []

# Avoid: Deep dependency chains
name: frontend
dependencies: [backend]    # backend depends on shared
name: backend
dependencies: [shared]     # frontend waits for backend -> shared
```

### Cross-Session Worker Queue

A single `nopo` invocation already caps its own fan-out to the host's
CPU **and memory** budget (auto-detected, overridable with `NOPO_CONCURRENCY`).
The memory cap is the lesser of "how many cores" and "how many per-worker heaps
fit in RAM" — it applies on every host, not just inside a cgroup: under a
container it reads `memory.max`, and on bare metal or macOS (no cgroup at all)
it budgets a fraction of host RAM. But when several invocations run at once —
multiple terminals, multiple git worktrees, multiple Claude sessions — each one
fans out independently, so the *sum* of their workers can far exceed the machine
and the laptop thrashes.

To coordinate them, commands share one **machine-wide worker budget** brokered
over a unix socket:

- The first queued command auto-spawns a tiny background broker (no daemon to
  install or manage; it self-terminates after ~30s idle).
- Each queued command asks the broker for worker slots and **waits in a FIFO
  queue** if the budget is exhausted, then fans out to exactly the granted
  width (published as `NOPO_CONCURRENCY`). Total workers across every session
  never exceed the budget.
- A slot is held for as long as the command's process lives. If a session is
  killed or crashes, the kernel closes its socket and the broker reclaims its
  slots immediately — no stale locks.

It fails open: if the broker can't be reached, the command runs unthrottled
(today's behavior) rather than breaking.

**What queues.** Everything, by default — including every arbitrary
`nopo <cmd>`. Core never decides participation from a command-name string; a
command opts out only by being one of a few built-in core scripts that set
`skipQueue` on their `Script` class:

- **Instant, read-only** — `status`, `list`, `env`, `secret`: waiting is
  pointless.
- **Long-lived service lifecycle** — `up`, `down`, `act`: these would hold a
  slot for their entire runtime and starve the queue.

Everything else — `build`, `install`, `sync`, and every service/`Command`
invocation (`nopo test backend`, `nopo check`, `nopo compile ui`, …) — queues.

| Control | Purpose | Default |
| --- | --- | --- |
| `NOPO_QUEUE_BUDGET` | Total worker slots shared across all sessions | `min(cores − 2, RAM budget ÷ per-worker)` |
| `NOPO_MEM_PER_WORKER_MB` | Memory a single worker is assumed to need; the divisor for the memory-bound cap | `1024` |
| `NOPO_QUEUE_SOCKET` | Broker socket path — the budget is shared by everything pointing at the same path | `$TMPDIR/nopo-queue-<uid>.sock` |
| `NOPO_NO_QUEUE` | Env bypass — skip the queue for this invocation | unset |
| `--skip-queue` | Per-command flag bypass (escape hatch) | off |

**Tuning for memory, not just cores.** The default budget caps both CPU
(`cores − 2`) and memory (`0.75 × host RAM ÷ per-worker`). At the default
`1024` MB/worker, cores usually win on a roomy machine — but a real
`tsc`/`eslint`/`vitest` Node heap is comfortably 1–2 GB. If the fan is railing
and you suspect memory pressure (swap/compressor), raise the per-worker estimate
so fan-out backs off:

```bash
# Assume each worker needs ~2 GB; on a 16 GB Mac that caps the budget at ~6
export NOPO_MEM_PER_WORKER_MB=2048
```

**Scope.** By default the socket path is per-user and machine-global, so
**all worktrees and all repos** for that user share one broker and one budget
— the host's CPU/memory is the real constraint, and it doesn't care which
checkout a command runs in. The first queued command spawns the broker and
fixes the budget; later commands from any checkout just connect to it. Point
`NOPO_QUEUE_SOCKET` at a per-repo path if you deliberately want separate
pools (each path gets its own broker and its own budget).

```bash
# Limit the whole machine to 6 worker slots across every nopo session
export NOPO_QUEUE_BUDGET=6

# Opt a one-off command out of the queue
nopo check --skip-queue
NOPO_NO_QUEUE=1 nopo check
```

The budget is decided by the first invocation that spawns the broker and is a
machine-wide constant for the broker's lifetime; `NOPO_CONCURRENCY` still
overrides a single invocation's fan-out width.

**Inspecting the queue.** `nopo queue` shows what's currently running and what's
waiting, across every session/worktree:

```bash
nopo queue          # human-readable table
nopo queue --json   # machine-readable snapshot
```

```
Worker queue — budget 8, 6/8 in use

RUNNING (1)
  ▶ check lint root      4 slots  wt-bridge-cse  pid 4242  1m20s

PENDING (2)
  #1 build backend web   want 4   wt-feature-x   pid 4343  waiting 8s
  #2 test backend        want 2   wt-hotfix      pid 4444  waiting 3s
```

Each row shows the command, slots, originating worktree, pid (so you can find
or kill it), and how long it's been running/waiting. With no broker running the
queue is empty, and `nopo queue` says so without spawning one.

### Command Timeout

A hung command would hold its worker slot forever and wedge the queue, so every
queued command gets a **wall-clock timeout — 5 minutes by default**. When it
fires, nopo SIGTERMs every in-flight subprocess, frees the slot, and exits
`124`. Long-lived lifecycle commands (`up`/`down`/`act` — the same ones that
skip the queue) are never timed out.

Resolution precedence (first defined wins):

| Source | Example | Notes |
| --- | --- | --- |
| `--timeout <dur>` | `nopo test --timeout 10m` | CLI flag |
| `NOPO_TIMEOUT` | `NOPO_TIMEOUT=600 nopo check` | env |
| `Script.timeoutMs` | `build` ships a 30-min default | per-command default in code |
| default | — | 5 minutes |

Durations accept seconds (`300`), suffixes (`90s`, `5m`, `2h`), and `0`/`off`
to disable:

```bash
nopo test backend --timeout 10m   # this run gets 10 minutes
nopo build --timeout off          # no limit (docker build already defaults 30m)
NOPO_TIMEOUT=2m nopo check         # tighten the default for a session
```

Under **CI** (`CI=true`) the implicit timeout (default + per-command
`Script.timeoutMs`) is disabled — CI jobs are isolated, have their own
`timeout-minutes`, and run legitimately-long full-monorepo commands. Only an
explicit `--timeout`/`NOPO_TIMEOUT` imposes a limit there.

## Build Caching

### Cache Types

| Environment | Cache Strategy       | When to Use         |
| ----------- | -------------------- | ------------------- |
| Development | Local Docker cache   | Local development   |
| CI          | GitHub Actions cache | CI pipelines        |
| Custom      | Registry cache       | Shared environments |

### Cache Configuration

```bash
# GitHub Actions (automatic in CI)
nopo build

# Custom registry cache
DOCKER_BUILDKIT_CACHE=type=registry,ref=mycache \
DOCKER_BUILDKIT_CACHE_TO=type=registry,ref=mycache,mode=max \
nopo build

# Disable cache
nopo build --no-cache
```

### Dockerfile Optimization

```dockerfile
# Good: Layer optimization
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN pnpm install     # Cached if package files unchanged
COPY . .
RUN pnpm build       # Cached if source unchanged

# Bad: Inefficient layering
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN pnpm install && pnpm build  # Runs on any source change
```

## Resource Management

### Target Selection

```bash
# Build only needed services
nopo build backend

# Filter services
nopo list --filter buildable
nopo list --filter has_database
```

### Service Limits

```yaml
infrastructure:
  cpu: "1" # Appropriate allocation
  memory: "256Mi" # Minimal sufficient
  min_instances: 0 # Scale to zero
  max_instances: 10 # Reasonable max
```

### Container Lifecycle

```bash
# Automatic cleanup (built-in)
nopo up  # Removes orphaned containers

# Manual cleanup if needed
docker compose down --remove-orphans
docker system prune -f
```

## Performance Monitoring

### Timing

```bash
# Measure build performance
time nopo build

# Compare online vs offline sync
time nopo up  # First run (online)
time nopo up  # Second run (offline)
```

### Debug Performance

```bash
# Enable timing debug
DEBUG=timing nopo build

# Cache debugging
DEBUG=cache nopo build

# Service debugging
DEBUG=service:backend nopo up backend
```

### System Resources

```bash
# Check Docker resource usage
docker stats

# Monitor disk usage
docker system df

# Service status
nopo status --json
```

## Best Practices

### Development Workflow

```bash
# 1. Fast iteration
nopo lint web        # Quick host checks
nopo up web          # Start single service

# 2. Incremental testing
nopo run test web     # Container testing
nopo up web           # Restart with changes
```

### CI/CD Optimization

```bash
# Pipeline stages (parallel where possible)
- lint: nopo lint           # Fast, no containers
- test: nopo run test       # Parallel with lint
- build: nopo build         # After lint/test pass
```

### Cache Strategy

1. **Local development**: Use automatic local caching
2. **CI pipelines**: Enable GitHub Actions cache
3. **Production**: Consider registry cache for sharing
4. **Regular cleanup**: Clear old cache periodically

---

**See Also**: [Reference](../reference.md) - Performance-related environment variables
