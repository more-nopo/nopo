---
"@more-nopo/nopo-plugin-vitest": patch
"@more-nopo/nopo-plugin-bun": patch
"@more-nopo/nopo-test-relevance": patch
---

Use registry-compatible internal dependency ranges so published test plugins install outside this workspace. Support runner-scoped relevance environment opt-in for CI jobs containing multiple test runners; explicit CLI flags take precedence.
