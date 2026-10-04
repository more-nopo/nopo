---
"@more-nopo/nopo-plugin-bun": patch
"@more-nopo/nopo-plugin-vitest": patch
---

Publish a registry-resolvable core dependency instead of a workspace-only reference.
Run single-target Vitest commands in their native working directory and config,
preserving coverage thresholds, reporters, and per-command config overrides.
Multi-target Vitest execution continues to use native projects.
