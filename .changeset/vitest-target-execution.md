---
"@more-nopo/nopo": minor
"@more-nopo/nopo-plugin-vitest": minor
"@more-nopo/nopo-plugin-bun": minor
---

Add target command delegation with `plugin`, an optional named `command`, and
argument arrays. Plugins may declare an explicit `defaultCommand`; plugin loading
validates defaults and planning rejects unresolved references before any work runs.
Delegated commands retain target scope, dependencies, environment, and directory.

Add Vitest run/list commands and Bun test/run/build commands. Vitest defaults to
run and supports a single native invocation across selected targets; Bun defaults
to run and preserves each target's native working directory and configuration.

Plugin contexts expose raw argv and forwarded arguments. Boolean and equals-style
plugin options preserve following targets.
