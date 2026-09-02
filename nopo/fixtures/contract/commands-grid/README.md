# contract/commands-grid

**Axis:** the command DAG. Tests `--concurrency`, `--no-fail-fast`,
command-on-command edges, command context (`host` vs `container`), and
sparse command-presence (not every service implements every command).

## Command grid

|              | core    | api          | web          |
|--------------|---------|--------------|--------------|
| lint         | host    | container    | host         |
| format       | host    | host         | —            |
| test         | host    | container    | container    |
| test:integration | —   | container    | container    |

Empty cells (`—`) are intentional — `web` has no `format`, `core` has no
`test:integration`. Tests assert that running `nopo format` skips `web`
gracefully and that `nopo test:integration` skips `core`.

## Command-on-command edges

- `api.test:integration` depends on `api.build` (intra-service)
- `web.test:integration` depends on `api.test:integration` (cross-service)

## What contract tests will assert

- `nopo lint` runs all three services, no inter-service order constraint
- `nopo lint --concurrency=1` serializes; `--concurrency=3` parallelizes
- `nopo lint --no-fail-fast`: a failure in one service doesn't cancel the
  others (each service's lint is independent)
- `nopo test:integration web` walks the command-on-command edge: api.build
  runs first, then api.test:integration, then web.test:integration
- `nopo format` runs core + api, skips web (no command), succeeds
- container-context commands route through the runtime plugin's `run`
  override; host-context commands run on the host directly
