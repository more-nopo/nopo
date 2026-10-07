# ESLint plugin

Lint selected nopo targets in **one ESLint invocation**. The plugin discovers
opted-in targets, builds a temporary meta-config that scopes each target's
flat config, and runs a single coordinator process — not one shell per target.

Install `@more-nopo/nopo-plugin-eslint` alongside nopo and register it:

```yaml
# Project nopo.yml
plugins:
  - name: eslint
```

Selected targets must resolve to one shared ESLint installation (flat config /
ESLint 9+). The plugin uses that installation and never downloads a runner.

```sh
nopo eslint run                         # all eligible targets
nopo eslint run api ui                  # exactly these targets
nopo eslint run api -- src/index.ts     # native file/path filters
nopo eslint run --print                 # inspect target selection without executing
```

## Target opt-in

Delegate a target command, or place a native flat config at the target root:

```yaml
# Target nopo.yml
commands:
  lint:
    plugin: eslint
```

A native `eslint.config.{js,mjs,cjs,ts,mts,cts}` also opts a target in. Use
`plugins.eslint: {}` for discovery without a delegated command, or
`plugins.eslint: false` to opt out.

```yaml
plugins:
  eslint:
    config: eslint.custom.config.mjs
    env:
      NODE_ENV: production
```

## Multi-target collapse

When multiple targets are selected, each becomes a scoped block in one temporary
flat config (named after its nopo target ID for diagnostics). ESLint runs once
from the nopo project root. Lint messages are attributed back to targets by file
path prefix; a non-zero exit reports which targets failed.

`--config` / `-c` can be forwarded for single-target runs. Multi-target runs
reject them because nopo owns the meta-config. `--print` emits the resolved
target/config mapping without loading configs or exposing environment values.

## Project plugin config

```yaml
plugins:
  - name: eslint
    config:
      args: ["--max-warnings=0"]
      env:
        TZ: UTC
```

CLI passthrough arguments follow configured `args`. Put target IDs and `--print`
before `--`; put ESLint options and file filters after it.
