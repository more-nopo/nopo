# contract/all-plugins

**Axis:** plugin loading + override resolution + additive hook ordering +
override-conflict disambiguation via the `runtimes:` map.

All six built-in plugins are loaded by short name (resolves to the
`@more-nopo/nopo-plugin-<name>` workspace package).

## Override-slot ownership

| Plugin           | Owns overrides                          |
|------------------|-----------------------------------------|
| docker           | `build`, `push`                         |
| docker-compose   | `up`, `down`, `status`, `logs`, `shell`, `run` |
| terraform        | `up`, `down`, `status` (cluster runtime)|
| playwright       | `test` (smoketest / e2e)                |
| diff             | `print`, `list`                         |
| docs             | `docs`                                  |

`docker-compose` and `terraform` both claim `up`/`down`/`status`. The
`runtimes:` map disambiguates by name:

```
runtimes:
  default: docker-compose   # `nopo up`            -> docker-compose
  prod:    terraform        # `nopo up --runtime prod` -> terraform
```

## Services

| Service | Type    | Notes                                        |
|---------|---------|----------------------------------------------|
| api     | service | build + runtime, plain                       |
| web     | service | build + runtime, runtime-deps on api         |
| db      | service | image-only (no build), proves docker skip    |

## What contract tests will assert

- `runner.plugins[]` is in declaration order: docker, docker-compose,
  terraform, playwright, diff, docs
- additive hooks fire in declaration order; reverse for teardown hooks
- `nopo build api` dispatches to docker (no override conflict here)
- `nopo up` dispatches to docker-compose (default runtime)
- `nopo up --runtime prod` dispatches to terraform
- `nopo up --runtime unknown` fails fast (unknown runtime name)
- `nopo build db` is a no-op for the image-only `db` service
- plugin config is forwarded verbatim to each plugin factory (the `docs`
  plugin sees the inline `title`/`url`/etc.)
