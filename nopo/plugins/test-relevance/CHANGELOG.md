# @more-nopo/nopo-test-relevance

## 0.0.3

### Patch Changes

- a2496f2: Use registry-compatible internal dependency ranges so published test plugins install outside this workspace. Support runner-scoped relevance environment opt-in for CI jobs containing multiple test runners; explicit CLI flags take precedence.

## 0.0.2

### Patch Changes

- Updated dependencies [d870c71]
  - @more-nopo/nopo@0.3.0

## 0.0.1

### Patch Changes

- 7bb536e: Expose a bounded System One decision client to core commands and plugins, including lazy credentials, typed question/answer validation and exact-request replay. Add opt-in test relevance observation to Vitest and Bun through a shared implementation while retaining native full-suite execution.

  Print per-test relevance scores in runner logs and publish readable CI evaluation tables with mode provenance, mutation outcomes, timings and counterfactual selection counts.

  Add explicit dry and select relevance modes with configurable inclusive thresholds, CLI overrides, native file selection, and full-suite fallback. Preserve mandatory quarantine audit execution. Relevance remains disabled by default.

- Updated dependencies [7bb536e]
  - @more-nopo/nopo@0.2.0
