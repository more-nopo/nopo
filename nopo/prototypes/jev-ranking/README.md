# Jev ranking inside runner plugins

This opt-in experiment decorates the existing Vitest and Bun plugins. Nopo supplies
the diff and target dependency graph; the runner plugin supplies candidate tests;
Jev scores those candidates. Every original test invocation still executes with
its original arguments and exit status. No core hook DTO, file selectors, or
command configuration changes are required.

This is a prototype, not a released plugin feature. Mock scores demonstrate the
plumbing; they do not measure relevance or predict test failures.

## Try it

In a disposable consumer checkout, temporarily add a local `path` to each existing
runner registration, using the absolute path to this repository:

```yaml
plugins:
  - name: vitest
    path: /absolute/path/to/nopo/nopo/prototypes/jev-ranking/vitest.ts
  - name: bun
    path: /absolute/path/to/nopo/nopo/prototypes/jev-ranking/bun.ts
```

Existing target commands remain `plugin: vitest` or `plugin: bun, command: test`.
Run a normal target command:

```sh
NOPO_JEV_REPORT_DIR=/tmp/nopo-rankings \
NOPO_JEV_PROVIDER=mock \
NOPO_JEV_BASE=origin/main \
nopo test my-target
```

Without `NOPO_JEV_REPORT_DIR`, the decorator immediately delegates to the original
plugin. The default comparison base is `HEAD`; choose a PR base explicitly for
committed changes. Reports use unique filenames so concurrent targets do not
overwrite each other. Remove the temporary plugin paths after experimenting.

`NOPO_JEV_PROVIDER=jev` uses `TYPESAFE_API_KEY` from the environment and sends
bounded diff and test excerpts, file paths, and the target graph to Typesafe's
API. Mock mode makes no API requests. No live Jev request was used to validate
this prototype. Reports contain paths and scores, not source excerpts or keys.

## What the report means

Each row has `file`, `probability`, and `changed`. The question is whether that
test exercises behavior the change could regress, not whether the test will
fail. Missing scores are `null`, never zero. `provider: mock` uses a repeatable
hash-derived number and has no predictive meaning.

The report records `mode: observe`, `execution: unchanged`, `skippedFiles: 0`,
discovery method, context fingerprint, and any unavailable scoring. Model/network,
context, discovery, or report-write failure still allows the original command to
run. The fingerprint is diagnostic, not a reusable cache key.

## Runner boundaries

| Runner path                            | Candidate inventory                                                | Limits                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Delegated Vitest `run`                 | Native `vitest list --filesOnly --json`, same config and arguments | Loads config a second time; unsupported listing arguments fail open                         |
| Delegated Bun `test`                   | Bun filename patterns under the target's `bunfig.toml` test root   | Advisory only: does not reproduce argv filters, sharding, name filters, or config overrides |
| Bun `run`, wrappers, direct plugin CLI | Not instrumented                                                   | Existing execution is unchanged                                                             |

Vitest owns its eligible files. Bun has no native listing command, so its inventory
cannot justify exclusion. The consumer's af-api shutdown wrapper, af-web quarantine
audit, and austin-piano shard wrapper remain their policy owners; integrating
ranking into those paths needs an explicit adapter before their native test run.
This prototype does not yet cover the large af-api integration workload.

Evidence includes tracked changes since the merge base, untracked filenames, and
Nopo's target dependencies. It does not contain a file-level import graph or
untracked file contents. Diff text is capped at 16,000 characters and test excerpts
at 1,200 characters. Live scoring handles at most 128 files in batches of 16 with
a five-second overall request budget, no retries, and no result cache. Remaining
files are unknown. IDs, response types, and probability bounds are validated.

## Proposed product shape

If the experiment is useful, keep the feature inside each runner plugin and add
one opt-in plugin config field, `relevance: observe`. This is a proposal, not a
supported option. The plugins can share an internal evidence/scoring library;
core continues to own only command delegation and execution context. No command
needs to interpret model output or template a file list.

Before considering filtering, collect runner duration, ranking overhead, and
scores alongside full-suite outcomes. Replay known regressions or use mutation
tests: mostly green PRs cannot establish that excluded tests would catch failures.
Evaluate missed regressions on held-out changes and calibrate scores for this
repository. Changes to harnesses, manifests, configs, missing evidence, and changed
tests need conservative full-run rules. Selection would have to precede sharding
and preserve wrapper policy. This experiment claims no CI time savings.

## Files and checks

- `vitest.ts`, `bun.ts`: decorate the actual plugin factories.
- `plugin.ts`: runner discovery, reports, unchanged execution.
- `evidence.ts`: bounded diff, target graph, candidate excerpts.
- `score.ts`: mock provider and validated Jev API adapter.
- `smoke.test.ts`: real CLI/runner fixtures plus API contract validation.

From the repository root after installing workspace dependencies:

```sh
nopo/plugins/vitest/node_modules/.bin/vitest run --config nopo/prototypes/jev-ranking/vitest.config.ts
nopo/plugins/vitest/node_modules/.bin/tsc --project nopo/prototypes/jev-ranking/tsconfig.json
```

The smoke tests verify that both runners execute every file with mock scores,
missing credentials retain full execution and test failures, and malformed Jev
responses are rejected.

## References

- [Jev API](https://docs.typesafe.ai/api) and [noul probability primitive](https://docs.typesafe.ai/primitives/noul).
- [Bun test discovery](https://bun.com/docs/test/discovery).
- [jev-test-impact](https://github.com/holasoymalva/jev-test-impact), the related experiment that prompted this exploration.
