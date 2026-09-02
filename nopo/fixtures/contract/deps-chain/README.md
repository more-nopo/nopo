# contract/deps-chain

**Axis:** dependency graph resolution — build edges, runtime edges, transitive
expansion, topological order.

```
build deps:        runtime deps:
  core             web <-- worker
   ^
   |
  lib
   ^
   |
  web
```

Four services. The `core -> lib -> web` chain is a three-hop **build** edge.
`worker -> web` is a separate **runtime** edge. The two graphs intentionally
disagree so contract tests can prove the resolver tracks them independently.

Contract tests will use this fixture to exercise:

- target resolution: `nopo build web` must include core + lib + web (transitive)
- topological order: build emits core, then lib, then web
- `--with-dependants` from core expands forward to lib + web
- runtime graph is independent: `nopo up worker` pulls in web (runtime dep)
  but does not pull in core or lib (those are build-only)
- `--print` walk that proves the printed order matches topological order
