---
"@more-nopo/nopo": minor
"@more-nopo/nopo-plugin-vitest": minor
---

Pool Vitest DAG commands through an invocation-scoped Node coordinator with a shared native worker limit. Preserve native configuration and task results, reuse compatible instances, and clean up workers on failures or shutdown. Add tracked IPC channels and Runner disposal for plugin-owned resources. Configure `workers` (default two) or `execution: isolated` on the Vitest plugin.
