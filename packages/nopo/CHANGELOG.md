# @more-nopo/nopo

## 0.5.0

### Minor Changes

- a626c85: Plugin hooks are cacheable only when the plugin declares them

  - Replace the hard-coded hook allowlist with `cacheableHooks` on the plugin definition. Undeclared hooks always run.
  - A declared hook is reused only when every target it serves opted in with `cache:` on its command; plan compaction records each claimed command's declaration in `meta.cacheOptIn`.
  - `perTarget: true` keys each batch target separately. A changed target re-runs alone; the hook receives only the missed targets.
  - Command-level `cache: { env, inputs }` now feeds the key, and batch keys include every claimed target's declarations, not only the first.
  - Write-mode flags in delegated args (`--fix`, `-u`, ...) make a step uncacheable; extra inputs outside the repo make it uncacheable.
  - eslint: `lintBatch` is cacheable per target.

### Patch Changes

- 1a945c3: The typed command selector (`test` vs `test:-integration,-cards`) no longer feeds the cache key; the resolved leaf does, so PR and merge-queue runs of the same leaf share results.
- 97c1cd1: Cache keys cover workspace packages and work with bucket-scoped R2 tokens

  - Every workspace package a target's `package.json` depends on (transitively, resolved through `node_modules` links) now feeds its cache key and dirty check, so a change to a shared package invalidates its consumers.
  - `cache.inputs` globs skip `node_modules`.
  - The S3 store probes availability with an object HEAD instead of HeadBucket, so bucket-scoped R2 object tokens work. A 401/403 disables the cache with a warning.

## 0.4.0

### Minor Changes

- ce50121: Add step-level result cache to prevent identical work from running twice across CI runs

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

## 0.3.0

### Minor Changes

- d870c71: Pool Vitest DAG commands through an invocation-scoped Node coordinator with a shared native worker limit. Preserve native configuration and task results, reuse compatible instances, and clean up workers on failures or shutdown. Add tracked IPC channels and Runner disposal for plugin-owned resources. Configure `workers` (default two) or `execution: isolated` on the Vitest plugin.

## 0.2.0

### Minor Changes

- 7bb536e: Expose a bounded System One decision client to core commands and plugins, including lazy credentials, typed question/answer validation and exact-request replay. Add opt-in test relevance observation to Vitest and Bun through a shared implementation while retaining native full-suite execution.

  Print per-test relevance scores in runner logs and publish readable CI evaluation tables with mode provenance, mutation outcomes, timings and counterfactual selection counts.

  Add explicit dry and select relevance modes with configurable inclusive thresholds, CLI overrides, native file selection, and full-suite fallback. Preserve mandatory quarantine audit execution. Relevance remains disabled by default.

## 0.1.1

### Patch Changes

- Preserve signal termination as a nonzero subprocess exit status instead of reporting successful completion. Runner shutdown policy cannot accept cancellation or OOM as clean tests.

## 0.1.0

### Minor Changes

- 7e3dcc4: Add target command delegation with `plugin`, an optional named `command`, and
  argument arrays. Plugins may declare an explicit `defaultCommand`; plugin loading
  validates defaults and planning rejects unresolved references before any work runs.
  Delegated commands retain target scope, dependencies, environment, and directory.

  Add Vitest run/list commands and Bun test/run/build commands. Vitest defaults to
  run and supports a single native invocation across selected targets; Bun defaults
  to run and preserves each target's native working directory and configuration.

  Plugin contexts expose raw argv and forwarded arguments. Boolean and equals-style
  plugin options preserve following targets.

## 0.0.2

### Patch Changes

- 40bf835: Add optional runtime policies for reserved Kubernetes namespaces. Preserve the namespace shell during deployment and cleanup, set pod priority, and require explicit service overlays. Add `inherit_secrets: false` to exclude default credentials from an independent runtime.

## 0.0.1

### Patch Changes

- 41c2fc9: First public CLI plus hosted CI.
