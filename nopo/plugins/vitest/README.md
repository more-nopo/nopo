# Vitest plugin

Run tests from selected nopo targets as projects in **one Vitest invocation**.
Vitest owns file discovery, scheduling, worker pools, reporting, and exit status.

Install `@more-nopo/nopo-plugin-vitest` alongside nopo and register it:

```yaml
# Project nopo.yml
plugins:
  - name: vitest
```

Selected targets must resolve to one shared Vitest installation, version 3.2 or
newer. The plugin uses that installation and never downloads a runner. Execution
is on the host, with Node.js on PATH.

```sh
nopo vitest run                         # all eligible targets
nopo vitest run af-web ui               # exactly these targets
nopo vitest run af-web -- auth.test.ts  # native file filter
nopo vitest run af-web ui -- --shard=1/3 --maxWorkers=2
nopo vitest list af-web ui -- --filesOnly --json
nopo vitest run --print                 # inspect target selection without executing
```

Target selection follows the Playwright plugin: no targets means discover all;
explicit targets narrow the set. Dependencies and dependants are not implicitly
added, built, or started. Multiple selected targets share one Vitest run, including
one reporter/coverage configuration and worker budget. Vitest may use worker
processes internally.

Put target IDs and `--print` before `--`; put Vitest options/file filters after it.
The CLI preserves forwarded arguments verbatim. Vitest controls the meaning of
file filters and no-tests behavior, including `--passWithNoTests` when requested.

## Target commands

Delegate a target command directly; Vitest declares `run` as its default:

```yaml
# Target nopo.yml
commands:
  test:
    plugin: vitest
```

This opts the target into Vitest even without a config file. A native
`vitest.config.{ts,mts,cts,js,mjs,cjs}` also opts a target in. Use
`plugins.vitest: {}` for discovery without a delegated command, or
`plugins.vitest: false` to opt out.

Arguments are native Vitest argv, with CLI passthrough appended:

```yaml
commands:
  test:
    plugin: vitest
    args: ["--maxWorkers=2"]
  list-tests:
    plugin: vitest
    command: list
    args: ["--filesOnly", "--json"]
```

```sh
nopo test ui -- auth.test.ts --shard=1/3
nopo list-tests ui
```

Core passes the owning target, merged command environment and resolved `dir`
directly to the plugin. No target ID or separator is required in YAML. `dir`, if
set, determines that invocation's config discovery and project root. Existing
`deps`, `dependencies`, nested command selectors and failure handling still apply.
Delegation currently requires host context.

A custom config and target plugin environment can be set separately:

```yaml
plugins:
  vitest:
    config: vitest.integration.config.ts
    env:
      FEATURE_MODE: test
```

Each delegated command is its own DAG node and Vitest invocation. To share one
Vitest run across targets, invoke `nopo vitest run web ui` directly. Core does not
coalesce independently configured commands or combine their environments.

An explicitly requested unknown, disabled, or unconfigured target is an error.
Direct `--print` emits the resolved target/config mapping without loading configs
or exposing environment values. Direct `list -- --filesOnly --json` produces
native Vitest JSON; plugin diagnostics go to stderr. Ordinary `nopo list-tests`
can additionally print core command progress.

## Configuration and project boundaries

Project plugin `config` accepts shared `args` and `env`:

```yaml
plugins:
  - name: vitest
    config:
      args: ["--maxWorkers=2"]
      env:
        TZ: UTC
```

CLI runner arguments follow configured arguments. Run-wide options such as
reporters, coverage, and worker limits belong here or on the CLI. Per-target
settings stay in the native Vitest config.

Each selected target becomes a native project named after its nopo target ID.
Its config supplies aliases, Vite plugins, test environment, setup, and test-file
patterns. `--project=ui` can further filter the selected projects. Important native
project semantics:

- `process.cwd()` is always the nopo project root. Resolve target-local paths
  relative to config/test files or their project root.
- Projects support a subset of root configuration. Root-only reporter/coverage
  settings in target configs are not shared-run settings; move them into the
  project plugin args or CLI. Nested `test.projects`/`test.workspace` configs are
  rejected; point `plugins.vitest.config` at a single project config.
- Config loading shares the inherited nopo process environment, with
  `NODE_ENV=test` and project plugin env overrides. Target environment and target
  plugin env are passed through each native project's `test.env`, isolating them
  between tests. They are not available during config loading.
- Per-project environment precedence is target service env → `NODE_ENV=test` →
  project plugin env → target plugin env. These explicit overrides merge over
  native `test.env`; other native test env entries remain. Values support nopo's
  `$VAR`/`${VAR}` expansion. Delegated commands inherit their already resolved
  command environment in the child process, including during config loading;
  native `test.env` can override that inherited environment. Direct plugin calls
  use service env and do not infer a particular command's environment.
- Sharding partitions the combined selected run, rather than independently
  sharding each target. Project order does not imply test execution order.

`--config`, `--root`, `--workspace`, and `--projects` cannot be forwarded because
nopo owns that mapping. Native options such as `--project`, reporters, file/name
filters, coverage, and sharding can be forwarded.

Native project reference: https://vitest.dev/guide/projects

## Consumer migration and future selection

This version provides native discovery and execution. It makes no Jev calls and
runs the full selected scope unless the caller supplies Vitest filters. This is
the runner boundary where relevance-based selection can later be integrated.

Keep existing wrapper behavior until explicitly migrated. For example, af-web's
wrapper also audits quarantined tests and verifies that they still fail. Replacing
it with a plain Vitest invocation would drop that audit. The plugin is not a
drop-in replacement for that two-pass policy yet.
