---
"@more-nopo/nopo": minor
"@more-nopo/nopo-plugin-eslint": minor
---

Plugin hooks are cacheable only when the plugin declares them

- Replace the hard-coded hook allowlist with `cacheableHooks` on the plugin definition. Undeclared hooks always run.
- A declared hook is reused only when every target it serves opted in with `cache:` on its command; plan compaction records each claimed command's declaration in `meta.cacheOptIn`.
- `perTarget: true` keys each batch target separately. A changed target re-runs alone; the hook receives only the missed targets.
- Command-level `cache: { env, inputs }` now feeds the key, and batch keys include every claimed target's declarations, not only the first.
- Write-mode flags in delegated args (`--fix`, `-u`, ...) make a step uncacheable; extra inputs outside the repo make it uncacheable.
- eslint: `lintBatch` is cacheable per target.
