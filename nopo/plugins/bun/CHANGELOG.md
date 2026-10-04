# @more-nopo/nopo-plugin-bun

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
