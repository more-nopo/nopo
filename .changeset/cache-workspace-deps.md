---
"@more-nopo/nopo": patch
---

Cache keys cover workspace packages and work with bucket-scoped R2 tokens

- Every workspace package a target's `package.json` depends on (transitively, resolved through `node_modules` links) now feeds its cache key and dirty check, so a change to a shared package invalidates its consumers.
- `cache.inputs` globs skip `node_modules`.
- The S3 store probes availability with an object HEAD instead of HeadBucket, so bucket-scoped R2 object tokens work. A 401/403 disables the cache with a warning.
