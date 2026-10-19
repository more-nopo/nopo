# Step-Level Result Cache

The nopo CLI includes a step-level result cache that prevents identical work from running twice across PR, merge-queue, and main CI runs (or locally). This can significantly reduce CI time when the same tests or build steps have already passed for identical inputs.

## Overview

When enabled, the cache:

1. **Computes a cache key** for each plan step based on its inputs
2. **Looks up** the key in the configured store before execution
3. **Skips** steps whose inputs match a previous passing result
4. **Records** passing results for future runs

**Only passing results are cached.** Failures always rerun to ensure environmental issues don't persist.

## Cache Key

A step's cache key is a SHA-256 hash of:

- **Target tree hashes**: Git tree hash of the target and all its dependencies (transitive)
- **Root config hashes**: SHA-256 of root-level config files (tsconfig*.json, eslint.config.*, .nvmrc, etc.)
- **Lockfile hashes**: SHA-256 of all lockfiles (bun.lock, package-lock.json, yarn.lock, pnpm-lock.yaml)
- **Plugin source hashes**: For plugin hooks, SHA-256 of the plugin's source file (path-referenced plugins; package plugins are covered by the lockfile hash)
- **Runtime version**: Node.js/Bun version
- **nopo version**: The nopo package version
- **Command/handler**: The command being executed
- **Payload**: Command arguments and configuration
- **Declared env inputs**: Values of environment variables that affect the step (default: NODE_ENV; plus `cache.env` from the service and from the command)
- **Extra input hashes**: SHA-256 of files matched by `cache.inputs` on the service and on the command

The key design is hierarchical:

- **Plan key** = hash of all step keys (for future whole-plan caching)
- **Step key** = hash of step inputs (current implementation)
- **Per-file key** = future extension for file-level caching

## Enabling the Cache

The cache is **opt-in** at two levels, and both must be on:

1. **Per command** in `nopo.yml`: only commands that declare `cache:` are ever cached.
2. **Per run**: `--cache` or `NOPO_CACHE=1` turns lookups on for an invocation.

### Opting a command in

```yaml
# packages/api/nopo.yml
commands:
  test:
    command: vitest run
    cache: true
  lint:
    plugin: eslint
    cache:
      env: [LINT_STRICT]          # values of these vars join the key
      inputs: [".generated/**"]   # globs relative to the service root; must stay inside the repo
```

Even with `cache:`, a step is never cached when it runs in container context or its
command or delegated args contain a write-mode flag (`--fix`, `-u`, `--write`, ...).

### Via CLI Flag

```bash
# Enable cache for this invocation
nopo test --cache

# Force full run even if cache is enabled via env
nopo test --no-cache
```

### Via Environment Variable

```bash
# Enable cache globally
export NOPO_CACHE=1

# Or per-command
NOPO_CACHE=1 nopo test
```

### Cache Write Control

Cache writes are **off by default**. Enable them only on trusted jobs (push to main, merge queue) with `NOPO_CACHE_WRITE=1`. PR jobs, laptops and agents stay read-only, so they cannot poison the cache.

```bash
# Trusted CI job
NOPO_CACHE_WRITE=1 nopo test --cache

# Everyone else: read-only (default)
nopo test --cache
```

In read-only mode, the cache still provides hits but won't record new passes. This is useful for laptops and agents that should benefit from CI-populated cache without writing to it.

## Store Configuration

The cache supports two storage backends:

### 1. Filesystem Store (Default)

Stores cache entries as JSON files locally. Ideal for local development.

```bash
# Default location: ~/.nopo/cache
# Custom location:
export NOPO_CACHE_DIR=/path/to/cache
```

### 2. S3-Compatible Store

For CI environments, use S3 or Cloudflare R2 for shared cache across runners.

```bash
# For Cloudflare R2
export NOPO_CACHE_STORE=s3
export NOPO_CACHE_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
export NOPO_CACHE_S3_BUCKET=nopo-cache

# Credentials (or use AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)
export NOPO_CACHE_S3_ACCESS_KEY_ID=your-access-key
export NOPO_CACHE_S3_SECRET_ACCESS_KEY=your-secret-key

# Optional
export NOPO_CACHE_S3_PREFIX=cache
export NOPO_CACHE_S3_REGION=auto
```

## TTL Configuration

Cache entries expire after a configurable TTL (default: 7 days).

```bash
# Set TTL to 24 hours (in seconds)
export NOPO_CACHE_TTL=86400
```

## Verification Sampling

To detect false cache hits from undeclared inputs, enable random sampling:

```bash
# Re-run 5% of cache hits for verification
export NOPO_CACHE_SAMPLING=5

# Or via CLI
nopo test --cache --cache-sampling=5
```

When sampling triggers, the step runs normally and compares the result. If a "cached pass" actually fails, you have an undeclared input.

## CI Configuration Example

### GitHub Actions

```yaml
name: CI

env:
  NOPO_CACHE: "1"
  NOPO_CACHE_STORE: s3
  NOPO_CACHE_S3_ENDPOINT: ${{ secrets.R2_ENDPOINT }}
  NOPO_CACHE_S3_BUCKET: nopo-ci-cache
  NOPO_CACHE_S3_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
  NOPO_CACHE_S3_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: nopo test
```

The cache automatically detects GitHub Actions and includes the run URL in cache metadata.

## Composing with --changed/--since

The cache composes with target filtering:

```bash
# Only test changed services, skip unchanged + cache hits
nopo test --changed --cache

# Test services changed since a specific commit
nopo test --since abc123 --cache
```

Filters select candidate steps; the cache then skips any candidate whose exact key already has a recorded pass.

## Declaring Extra Inputs

By default, the cache considers:

- Target directory files (via git tree hash)
- All lockfiles in repo root
- Root-level config files (tsconfig*.json, eslint.config.*, etc.)
- The `NODE_ENV` environment variable

If your step depends on other inputs, declare them on the command (see above) or for every command of a service in its `nopo.yml`:

```yaml
# packages/api/nopo.yml
cache:
  # Additional environment variables that affect this service's cache key
  env:
    - DATABASE_URL
    - API_KEY
  # Extra input file globs relative to service root
  # IMPORTANT: gitignored files must be declared here to be included in the key
  inputs:
    - ../shared/config.json
    - "generated/**/*.json"
```

**Warning**: Undeclared inputs can cause false cache hits. Use `--cache-sampling` to detect these.

**Important**: Files matched by `.gitignore` are not tracked by git tree hashes. If your step depends on gitignored files, you must declare them in `cache.inputs` for the cache to work correctly.

## Ed25519 Signing for Cache Integrity

Writers sign entries with a private key; readers verify with the public key. When
`NOPO_CACHE_SIGNING_PUBLIC_KEY` is set, unsigned or badly signed entries are rejected, and
a writer without `NOPO_CACHE_SIGNING_PRIVATE_KEY` skips the write.

```bash
openssl genpkey -algorithm Ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

Keys are PEM, or base64 DER (PKCS8 private, SPKI public).

```yaml
# GitHub Actions: every job reads and verifies; only trusted events write
env:
  NOPO_CACHE: "1"
  NOPO_CACHE_SIGNING_PUBLIC_KEY: ${{ vars.NOPO_CACHE_SIGNING_PUBLIC_KEY }}
jobs:
  test:
    env:
      NOPO_CACHE_WRITE: ${{ (github.event_name == 'push' || github.event_name == 'merge_group') && '1' || '0' }}
      NOPO_CACHE_SIGNING_PRIVATE_KEY: ${{ (github.event_name == 'push' || github.event_name == 'merge_group') && secrets.NOPO_CACHE_SIGNING_PRIVATE_KEY || '' }}
```

Secrets are not passed to workflows triggered from forks, so fork PRs can never sign.

## Plugin Hooks

Plugin batch hooks (for example eslint's `lintBatch`, which runs every `plugin: eslint`
command in one coordinator) are **not cacheable unless the plugin declares them**:

```ts
const plugin: NopoPluginFactory = () => ({
  name: "eslint",
  hooks: { lintBatch: async (ctx) => { /* ... */ } },
  cacheableHooks: {
    lintBatch: { perTarget: true },
  },
});
```

A declared hook is still reused only when every target it serves opted in with `cache:`
on its command. Plan compaction records each claimed command's declaration on the batch
node (`meta.cacheOptIn`), and their `env`/`inputs` all feed the key.

Declare a hook only when it is side-effect free and its result depends only on the key
inputs.

### Per-target batch keys

With `perTarget: true`, each target in `payload.targets` gets its own key, covering that
target and its transitive deps. On a run:

- every target hits: the batch is skipped
- some targets hit: the hook runs with `payload.targets` narrowed to the misses
- targets that did not opt in, or whose tree is dirty, always run and are never recorded
- a passing batch records each target it ran; a failing batch records nothing

Without `perTarget`, the batch shares one key and any changed target re-runs all of them.
Set `perTarget` only when the hook accepts any subset of targets and one target's result
does not depend on its batch peers.

## Forcing a Full Run

To bypass the cache completely:

```bash
# Completely disable caching—no lookups and no recording
nopo test --no-cache

# Or disable via env var
NOPO_CACHE=0 nopo test
```

## Cache Output

When steps are skipped via cache, you'll see:

```
[cache] ✓ cmd:0:api:test skipped (key: abc123def456, prev: 4.2s, run: https://github.com/...)
[cache] ✓ cmd:0:web:test skipped (key: 789xyz123abc, prev: 2.1s)
...
[cache] 2/5 steps skipped via cache
```

When verification sampling triggers:

```
[cache] ⚡ cmd:0:api:test re-running for verification (key: abc123def456)
```

## Dirty Working Tree Handling

The cache uses `git ls-tree HEAD` to compute tree hashes, which reflects the **committed** state of files. If you have uncommitted changes in a target directory, its dependencies, or the lockfile, the cache is bypassed for affected steps (no read, no write). This prevents:

- False cache hits from uncommitted changes that would affect execution
- Polluting the cache with results that don't match the committed state

When a step is bypassed due to dirty files, you'll see:

```
[cache] ○ cmd:0:api:test bypassed (uncommitted changes in: packages/api)
```

To get cache hits locally, commit your changes first.

## Container Context Steps

Steps running with `--context container` (kubectl exec) are **never cached**. These steps execute in a different environment where the host's git state doesn't reliably reflect the container's state.

```bash
# This step will always run, never cached
nopo test api --context container
```

## Known Limitations

1. **Undeclared inputs**: Files or environment variables not captured in the key can cause false hits. Use sampling to detect.

2. **Build output sharing**: The cache only records pass/fail status, not build artifacts. Steps that produce outputs (builds, generated files) still need separate artifact caching.

3. **System dependencies**: OS packages and system tools are not tracked. Changes to system deps may not invalidate cache.

4. **Gitignored files**: Files matched by `.gitignore` must be explicitly declared in `cache.inputs` to be included in the cache key.

## Debugging

To see what's in the cache key:

```bash
# Print plan with cache keys (future feature)
nopo test --print --show-cache-keys
```

To inspect the local cache:

```bash
# List recent entries
ls -la ~/.nopo/cache/

# View an entry
cat ~/.nopo/cache/ab/abc123...json
```

## Implementation Details

The cache key computation happens where the plan is built, using:

- `git ls-tree` for tree hashes (works without checkout)
- SHA-256 for content hashes
- JSON serialization for deterministic key generation

The hierarchical key design enables future optimizations:

- Skip entire plans when all step keys match
- Cache at file granularity for incremental builds
- Share cache across branches with common ancestors

## Future: nopo Server Store

The store interface (`ResultStore`) is designed as a transport-agnostic seam for a future hosted nopo server. Today it backs local and S3 caches; tomorrow the same interface can route to:

- **Remote cache service**: A hosted nopo server stores results centrally, removing the need for teams to manage their own S3 buckets and credentials
- **Distributed workers**: Workers execute plan steps and report back through the same get/put protocol, with GitHub status updates for in-progress steps

The interface intentionally uses simple `get`/`put`/`has` semantics with opaque string keys and JSON-serializable entries. No S3-specific types leak through the interface, making it straightforward to add new backends (HTTP API, gRPC, etc.) without changing call sites.
