---
"@more-nopo/nopo": minor
---

Add step-level result cache to prevent identical work from running twice across CI runs

**Key features:**
- Granular caching at the plan step level (target × command)
- Cache key = hash of target tree hashes, lockfile, runtime version, command/args, and declared env inputs
- Hierarchical key design for future plan-level and file-level caching
- Pluggable storage: filesystem (local) and S3-compatible (Cloudflare R2) stores
- Composable with `--changed`/`--since` filters
- Only passes are cached; failures always rerun
- Optional random sampling to verify cache correctness
- Configurable TTL (default: 7 days)

**Usage:**
```bash
# Enable via flag
nopo test --cache

# Enable via environment
NOPO_CACHE=1 nopo test

# Force full run
nopo test --no-cache

# Verify cache correctness via sampling
nopo test --cache --cache-sampling=5
```

**S3/R2 configuration:**
```bash
export NOPO_CACHE_STORE=s3
export NOPO_CACHE_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
export NOPO_CACHE_S3_BUCKET=nopo-ci-cache
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
```

**Known limitations:**
- Undeclared inputs (files/env outside the target tree) can cause false hits
- Only caches pass/fail status, not build artifacts
- System dependencies (OS packages) are not tracked

See `docs/cache.md` for complete documentation.
