---
"@more-nopo/nopo-plugin-eslint": patch
---

Stop lintBatch from validating top-level `nopo check` plan flags (`--skip-missing`, `--no-fail-fast`) as ESLint options by passing an empty `argv` into executeEslint.
