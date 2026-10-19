---
"@more-nopo/nopo": patch
---

The typed command selector (`test` vs `test:-integration,-cards`) no longer feeds the cache key; the resolved leaf does, so PR and merge-queue runs of the same leaf share results.
