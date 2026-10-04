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
plugin. The default provider is `mock`; live API use requires explicit `jev`. The default comparison base is `HEAD`; choose a PR base explicitly for
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

The prototype intercepts the resolved subprocess through Nopo's existing IO
interface. This is experiment wiring, not a new public hook or plugin protocol.
Both delegated target commands and direct plugin commands are covered. `--print`,
Bun `run`/`build`, and Vitest `list` do not trigger ranking.

| Runner       | Inventory                                                                                | Limits                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Vitest `run` | Native `list --filesOnly --json` with the resolved config, including quarantine overlays | Pre-shard files, not individual test cases; loads config again; discovery timeout 10 seconds                             |
| Bun `test`   | Pattern inventory after profiles and `--files` resolve, with path filters                | Advisory: test names, custom loaders and inherited configuration may differ; unfamiliar options make ranking unavailable |

The released plugins own shutdown, quarantine and shard policies. Gate and audit
invocations get separate reports; the audit remains mandatory. An empty clamped
shard does not spawn tests and produces no report. The prototype preserves the
native exit result, including `nothrow` calls whose results the runner policy then
interprets. Reports record native exits, not final policy outcomes: an audit exit
of 1 can be expected and a passing quarantined test can still fail the command.

Each report measures discovery, context gathering, scoring and native execution
wall time. Observation runs before execution. `observationMs` is added work,
excluding report writing, not saved time. Discovery failure, invalid scores,
missing credentials and report-write failures retain the original execution.
The report never estimates time saved from file counts or mock probabilities.

Evidence includes tracked changes since the merge base, untracked filenames, and
Nopo's target dependencies. It does not contain a file-level import graph or
untracked file contents. Diff text is capped at 16,000 characters and test excerpts
at 1,200 characters. Live scoring handles at most 128 files in batches of 16 with
a five-second overall request budget, no retries, and no result cache. Remaining
files are unknown. IDs, response types, and probability bounds are validated.

## Proposed product shape

Use one shared internal relevance library and a small adapter in each runner
plugin. Do not introduce a separately registered plugin for plugins. The shared
library owns diff/graph evidence, bounded provider calls, score validation and
fallbacks. The runner owns candidate discovery, protected tests, native file
selection and execution. Jev is one provider, not the command interface.

A future internal contract can stay small:

```ts
type Relevance = {
  status: "ranked" | "unavailable";
  tests: Array<{ file: string; probability: number | null }>;
};
// Runner supplies its eligible candidates; this function never executes tests.
rankTests(evidence, candidates): Promise<Relevance>;
```

If the experiment proves useful, configure it once in each runner registration:

```yaml
plugins:
  - name: vitest
    config:
      test:
        relevance: observe
  - name: bun
    config:
      test:
        relevance: observe
```

**This YAML is a proposal, not a supported option.** Target commands stay as they
are. For distribution, both plugins can depend on the same internal package;
Nopo core needs no new hook result DTO, template syntax or file-scope API.

Before filtering, record real scores, per-file durations and full-suite failures
for representative changes. Replay known regressions or mutation tests; mostly
green PRs cannot establish that excluded tests would catch failures. Compare
against runner-native affected tests and a full-suite baseline. Account for the
CI DAG's critical path: skipping cheap files in a parallel job may save no wall
time, while extra discovery and scoring always cost something.

A future selection policy should run before sharding, retain changed/unknown and
protected tests, retain full suites for harness/config/manifest changes, and
leave quarantine audits mandatory. Native candidate identity and exact filtering
must be established for each runner before that runner can exclude tests. This
prototype only ranks, and claims no predictive accuracy or CI time savings.

## Files and checks

- `vitest.ts`, `bun.ts`: decorate the actual plugin factories.
- `plugin.ts`: observe resolved native invocations without changing execution.
- `discovery.ts`: runner-specific inventory adapters.
- `observe.ts`: shared ranking/report pipeline and timing measurements.
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
responses are rejected. They also cover Bun profiles and explicit replacement,
Vitest quarantine with clamped shards, direct commands, print-only commands,
disabled observation and unsupported Bun discovery options.

## References

- [Jev API](https://docs.typesafe.ai/api) and [noul probability primitive](https://docs.typesafe.ai/primitives/noul).
- [Vitest CLI and native listing](https://vitest.dev/guide/cli.html).
- [Bun test discovery](https://bun.com/docs/test/discovery).
- [jev-test-impact](https://github.com/holasoymalva/jev-test-impact), the related experiment that prompted this exploration.
