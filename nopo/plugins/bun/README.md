# Bun plugin

Run Bun tests, scripts, and builds in nopo targets using the installed `bun` on
PATH. Register `@more-nopo/nopo-plugin-bun` in the root nopo.yml:

```yaml
plugins:
  - name: bun
```

The plugin's default is `run`. Delegate without repeating the target's name:

```yaml
# Target nopo.yml
commands:
  test:
    plugin: bun
    command: test
  lint:
    plugin: bun
    args: [lint]
  bundle:
    plugin: bun
    command: build
    args: ["./src/index.ts", "--outdir=dist"]
```

Bun handles native configuration, test discovery, preloads, script execution,
reporting and failure status. Core passes the command's target, merged environment
and working directory. Invocation failures fail their DAG node and prevent its
dependents from running. No shutdown failure codes are suppressed.

## Unit and integration commands

Keep suites in the existing command tree and use native Bun path filters:

```yaml
commands:
  test:
    env:
      APP_ENV: test
    commands:
      unit:
        plugin: bun
        command: test
        args: ["./src/", "--timeout=30000"]
      integration:
        plugin: bun
        command: test
        args: ["./test/", "--timeout=30000"]
```

```sh
nopo test:unit api
nopo test:integration api -- --test-name-pattern authentication
nopo test:-integration api
```

YAML args are an argv array, without shell expansion. Core appends CLI arguments
after `--`; no additional separator is needed in YAML. Native Bun path filters
are not glob patterns. `dir` can choose another working directory; Bun interprets
its own forwarded options.

## Direct execution

```sh
nopo bun test api -- ./test/ --timeout=30000
nopo bun run api -- lint
nopo bun build ui -- ./src/index.ts --outdir=dist
nopo bun test --print
```

No target names discovers targets with a delegated Bun command or an explicit
`plugins.bun` opt-in. Named targets can invoke Bun without prior opt-in. Set
`plugins.bun: false` to disable a target. Discovery does not infer a test runner
from the use of Bun as a package manager.

Each target uses its own working directory and Bun process. Multiple direct targets
run sequentially and stop on failure; normal delegated commands use nopo's DAG
scheduler. Bun's per-invocation preloads/environment are not combined across
independent targets. No dependencies are automatically built or started by a
direct plugin call.

## Environment and scope

Root plugin `config` and target `plugins.bun` accept `env`:

```yaml
plugins:
  bun:
    env:
      TZ: UTC
```

Environment precedence is inherited process → service/command environment →
`NODE_ENV=test` for the test command → root plugin env → target plugin env. Values
support nopo's `$VAR` expansion. Bun can additionally load its native dotenv files.
Direct calls do not infer a particular target command's environment.

Delegation currently requires host context. The plugin does not download Bun or
replace nopo's existing `package_managers.bun` install/sync behavior. The three
commands have distinct meanings: `test` runs tests, `run` runs a script/file, and
`build` invokes Bun's bundler.
