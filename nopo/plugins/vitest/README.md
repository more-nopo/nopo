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

Each delegated command remains its own DAG node with its own result. By default,
all Vitest tasks in one nopo invocation share a Node coordinator and a worker
limit of two per native Vitest pool. Ready tasks queue through that coordinator; each native run still
parallelizes its files within that limit. Configured lower worker limits remain
lower. Matching configurations reuse the native instance; changing working
directory, environment, installation or options closes it before creating another.
Target coverage, environments, failures and dependency ordering remain scoped to
their commands. This reduces process fan-out at the cost of running target requests in sequence.
A native run mixing pool types (such as forks and threads) can use both pools;
`workers` is a limit per pool, not a total OS-process count.

Configure the invocation budget, or opt into independent native processes:

```yaml
plugins:
  - name: vitest
    config:
      workers: 2
      execution: shared # default; isolated restores separate invocations
```

Interactive watch/UI invocations use native processes. A crashed shared coordinator
fails its active task, kills its workers, and restarts for queued independent tasks.
The coordinator closes when nopo finishes, including failed runs. Direct
`nopo vitest run web ui` still combines targets into one native project run.

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

A single target runs Vitest in its own working directory using its native config.
This preserves coverage thresholds, reporters, config-time environment, and relative
paths. A command can pass `args: ["--config", "vitest.integration.config.ts"]` to
select another config. Native config settings keep their normal Vitest semantics.

When multiple targets are selected, each becomes a native project named after its nopo target ID.
Its config supplies aliases, Vite plugins, test environment, setup, and test-file
patterns. `--project=ui` can further filter the selected projects. Important native
project semantics:

- In a multi-target run, `process.cwd()` is the nopo project root. Resolve target-local paths
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

`--config` can be forwarded for single-target runs. Multi-target runs reject it.
`--root`, `--workspace`, and `--projects` cannot be forwarded because nopo owns
the target mapping. Native options such as `--project`, reporters, file/name
filters, coverage, and sharding can be forwarded.

Native project reference: https://vitest.dev/guide/projects

## Consumer migration and future selection

This version provides native discovery and execution. It makes no Jev calls and
runs the full selected scope unless the caller supplies Vitest filters. This is
the runner boundary where opt-in relevance selection is applied.

## Test execution policy

Targets can opt into runner-owned policy without a wrapper script:

```yaml
plugins:
  vitest:
    test:
      quarantine: test/quarantine.json
      sharding: clamp
commands:
  test:
    plugin: vitest
```

`quarantine` reads `{ "files": { "test/example.test.ts": "reason" } }`. Missing
or outside-target entries fail before running tests. The plugin excludes those
files from the gate, then audits the selected quarantined files: they must execute
and still fail. A passing quarantined file fails the command until its entry is
removed. Native path/name/changed filters remain active in both passes. The audit
runs only on the original first shard and does not itself shard. Native configs
need no quarantine environment switch; the plugin applies a temporary overlay.

`sharding: clamp` counts the effective native selection before sharding. It clamps
an oversized shard total to that count; excess shards report no work. Zero-file
selections retain Vitest's native no-tests policy. Discovery failure fails the
command instead of pretending there is no work. The default is `native`.

These policies currently require a single target and a single native project
config. Multi-target policy runs fail preflight explicitly; independent delegated
commands retain their DAG execution. Configs, reporters and coverage remain native.
Root plugin `config.test` can supply shared defaults, overridden by target `test`.
Pass `--quarantine=off` after `--` to diagnose a quarantined test without the gate/audit policy.

## Decision observation

Set `test.relevance: observe` in the plugin policy and configure root `decisions` to rank the resolved test scope through the shared core decision service. Execution retains every test and native exit behavior. See [decision configuration](../../docs/decisions.md) and the [behavioral evaluation](../../evaluations/decisions/README.md).


## Relevance modes and thresholds

Relevance is off unless enabled in configuration or CLI arguments. Configuring the core `decisions` provider alone does not score tests. `observe` remains an alias for dry reporting.

```yaml
plugins:
  vitest: # use bun for Bun
    test:
      relevance:
        mode: dry # run everything and report the proposed selection
        threshold: 0.7
```

Use `mode: select` to apply the threshold. Scores equal to the threshold are included; it must be between 0 and 1 and defaults to 0.65. Reports include every score, `wouldInclude`, `wouldExclude`, actual skipped count, threshold, mode, and native result. An empty selection succeeds without running test files. The command's original native scope, file filters, profiles and options still apply.

```sh
nopo test ui -- --relevance=dry --relevance-threshold=0.7
nopo test ui -- --relevance=select --relevance-threshold=0.7
nopo test ui -- --relevance=off
```

For direct plugin commands, place these flags after the native `--` separator too. A threshold alone does not activate relevance. Missing/invalid scores, unavailable credentials/API, failed discovery, or truncated evidence retain full native execution. Vitest quarantine audits always run their complete required scope. Bun's inventory remains advisory, with unsupported discovery arguments falling back to the full suite. Reports and logs identify the actual execution decision; dry reporting never skips files.

CI can set `NOPO_RELEVANCE_MODE=dry` and `NOPO_RELEVANCE_THRESHOLD=0.7`
to enable reports only in that job. These variables affect the Vitest/Bun test
plugins; other command runners receive no extra arguments. Environment settings
override configuration; explicit relevance CLI flags override the environment.
