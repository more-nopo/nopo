# contract/multi-runtime

**Axis:** `--runtime` dispatch + per-runtime overlay merge.

## Runtime map

| Runtime  | Plugin       | Trigger                        |
|----------|--------------|--------------------------------|
| default  | dev-plugin   | `nopo up` (no flag)            |
| prod     | prod-plugin  | `nopo up --runtime prod`       |
| (other)  | —            | fail-fast: unknown runtime     |

## Services

| Service | Runtime shape | Overlay behaviour                                    |
|---------|---------------|------------------------------------------------------|
| api     | flat          | identical config for every runtime                   |
| web     | map           | prod overrides cpu/memory + env (LOG_LEVEL, MODE)    |
| worker  | map           | prod overrides port only; everything else inherited  |

The plugins are inline `.ts` no-op stubs (`./plugins/dev-plugin.ts`,
`./plugins/prod-plugin.ts`) so the fixture has no runtime coupling to the real
workspace plugins.

Contract tests will use this fixture to exercise:

- default dispatch: `nopo up` calls dev-plugin
- named dispatch: `nopo up --runtime prod` calls prod-plugin
- unknown runtime: `nopo up --runtime nope` fails fast with a helpful message
- overlay resolution: `web` resolved with `--runtime prod` yields `cpu=2`,
  `memory=1Gi`, `LOG_LEVEL=warn` while `default` yields `cpu=0.5`,
  `memory=256Mi`, `LOG_LEVEL=debug`
- partial overlay: `worker` prod overlay only sets `port`; `command`, `cpu`,
  `memory` all inherit from default
- flat-shape compatibility: `api` (no map) resolves identically for every
  runtime name
