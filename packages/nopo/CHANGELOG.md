# @more-nopo/nopo

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
