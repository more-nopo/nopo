---
"@more-nopo/nopo-plugin-eslint": patch
---

Preserve each target's global ignores in batched (multi-target) lint runs. The meta config used to add a `files` glob to every config entry, which turned global-ignore entries (only `ignores`, e.g. `includeIgnoreFile(".gitignore")`) into no-op local ignores, so a root target linted `dist/` output and every nested workspace it ignores. Global ignores now stay global, rebased onto the target's root and ordered shallowest target first, with negations that re-include deeper targets' roots so a root ignore can't hide another selected target. A target's rule entries also skip the roots of deeper targets, which lint with their own config as they would in a standalone run. A config-less target nested in a selected target whose config ESLint would find for it now lints with that config (and its ignores) instead of a bare rule-less entry.
