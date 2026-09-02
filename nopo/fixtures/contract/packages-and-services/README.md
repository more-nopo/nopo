# contract/packages-and-services

**Axis:** target type — `package` vs `service`. The presence of `runtime:` is
what classifies a target as a service; packages omit it and are build-only.

| Target  | Type    | Build deps |
|---------|---------|------------|
| shared  | package | (none)     |
| utils   | package | shared     |
| api     | service | shared     |
| web     | service | utils      |

`api -> shared` and `web -> utils` are cross-type edges (service depending on
a package), which is the common monorepo shape (apps consuming libs).

Contract tests will use this fixture to exercise:

- `nopo list --type=package` returns only shared + utils
- `nopo list --type=service` returns only api + web
- `nopo up` only operates on services (packages have no runtime to start)
- `nopo build api` pulls shared in via build-deps even though it's a different
  type
- buildable filter: every target has a `build:` block, so all four are buildable
