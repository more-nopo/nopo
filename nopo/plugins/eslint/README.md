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

Each file belongs to the deepest selected target whose root contains it, matching
what a standalone run in that workspace would lint:

- A target's global ignores (config objects with only `ignores`, such as
  `includeIgnoreFile(".gitignore")`) stay global, rebased onto the target's root.
  They are applied shallowest target first, and re-include the roots of deeper
  selected targets, so a root ignore of `products/*` or `**/dist/` never hides
  another selected target.
- A target's other config objects are scoped to its root with `files` and skip
  the roots of deeper selected targets.
- A target without its own config (e.g. opted in via `plugin: eslint`) is linted
  by the selected target whose config ESLint would find walking up from its root,
  so it sees that config's rules and ignores, just like a standalone run.

`--config` / `-c` can be forwarded for single-target runs. Multi-target runs
reject them because nopo owns the meta-config. `--print` emits the resolved
target/config mapping without loading configs or exposing environment values.


## Plan batches (`nopo check:lint` / `nopo lint`)

When targets declare `commands.*.plugin: eslint`, CommandScript would otherwise
emit one `command:exec` node per target. This plugin registers a plan
`batches` spec (same compaction contract as docker bake) that claims those
nodes and coalesces them into a single `eslint:batch` → `lintBatch` hook, so
`nopo check:lint --print` (and live runs) show **one** coordinator node instead
of N shells.

Opt-in remains the same: delegated `plugin: eslint` commands, `eslint.config.*`,
or `plugins.eslint: {}`. Shell lint commands without `plugin: eslint` are not
claimed and stay as ordinary `command:exec` nodes.

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
