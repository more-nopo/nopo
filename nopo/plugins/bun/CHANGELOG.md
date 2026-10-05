# @more-nopo/nopo-plugin-bun

## 0.3.2

### Patch Changes

- a2496f2: Use registry-compatible internal dependency ranges so published test plugins install outside this workspace. Support runner-scoped relevance environment opt-in for CI jobs containing multiple test runners; explicit CLI flags take precedence.
- Updated dependencies [a2496f2]
  - @more-nopo/nopo-test-relevance@0.0.3

## 0.3.1

### Patch Changes

- Updated dependencies [d870c71]
  - @more-nopo/nopo@0.3.0
  - @more-nopo/nopo-test-relevance@0.0.2

## 0.3.0

### Minor Changes

- 7bb536e: Expose a bounded System One decision client to core commands and plugins, including lazy credentials, typed question/answer validation and exact-request replay. Add opt-in test relevance observation to Vitest and Bun through a shared implementation while retaining native full-suite execution.

  Print per-test relevance scores in runner logs and publish readable CI evaluation tables with mode provenance, mutation outcomes, timings and counterfactual selection counts.

  Add explicit dry and select relevance modes with configurable inclusive thresholds, CLI overrides, native file selection, and full-suite fallback. Preserve mandatory quarantine audit execution. Relevance remains disabled by default.

### Patch Changes

- Updated dependencies [7bb536e]
  - @more-nopo/nopo@0.2.0
  - @more-nopo/nopo-test-relevance@0.0.1

## 0.2.0

### Minor Changes

- Own test execution policies: Vitest quarantine auditing and safe sharding; Bun scoped test profiles, explicit-file replacement, and guarded clean-summary shutdown handling. Consumers can remove their runner wrapper scripts.

## 0.1.1

### Patch Changes

- bb5328d: Publish a registry-resolvable core dependency instead of a workspace-only reference.
  Run single-target Vitest commands in their native working directory and config,
  preserving coverage thresholds, reporters, and per-command config overrides.
  Multi-target Vitest execution continues to use native projects.

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

### Patch Changes

- Updated dependencies [7e3dcc4]
  - @more-nopo/nopo@0.1.0
