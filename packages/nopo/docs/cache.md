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

- **Target tree hashes**: Git tree hash of the target and all its dependencies
- **Lockfile hash**: SHA-256 of the package manager lockfile
- **Runtime version**: Node.js version
- **Command/handler**: The command being executed
- **Payload**: Command arguments and configuration
- **Declared env inputs**: Values of environment variables that affect the step

The key design is hierarchical:

- **Plan key** = hash of all step keys (for future whole-plan caching)
- **Step key** = hash of step inputs (current implementation)
- **Per-file key** = future extension for file-level caching

## Enabling the Cache

The cache is **opt-in** (disabled by default) to ensure existing behavior is unchanged.

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
- Lockfile content
- `CI` and `NODE_ENV` environment variables

If your step depends on other inputs, declare them in your service's `nopo.yml`:

```yaml
# nopo.yml (future feature)
cache:
  env_inputs:
    - DATABASE_URL
    - API_KEY
  extra_files:
    - ../shared/config.json
```

**Warning**: Undeclared inputs can cause false cache hits. Use `--cache-sampling` to detect these.

## Forcing a Full Run

To bypass the cache completely:

```bash
# Disable cache lookups (results still recorded)
nopo test --no-cache

# Or unset the env var
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

## Known Limitations

1. **Undeclared inputs**: Files or environment variables not captured in the key can cause false hits. Use sampling to detect.

2. **Build output sharing**: The cache only records pass/fail status, not build artifacts. Steps that produce outputs (builds, generated files) still need separate artifact caching.

3. **Container context**: Steps running in containers use the container's runtime version, not the host's.

4. **System dependencies**: OS packages and system tools are not tracked. Changes to system deps may not invalidate cache.

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
