# Decision API evaluation

Run `bun nopo/evaluations/decisions/run.ts`. The default `mock` mode verifies integration without credentials; it does not measure model quality.

For real evaluation:

```sh
NOPO_DECISION_EVAL_MODE=live bun nopo/evaluations/decisions/run.ts
```

Supply `OPENROUTER_API_KEY` through the environment. CI reads the repository secret of that name. Missing credentials fail the quality job; there is no mock fallback. Only synthetic fixture source is transmitted by this evaluation.

The eleven scenarios exercise Noul, Choice and Score and run four controlled changes through both native runners. Each fixture first passes without the change. The evaluation then checks actual failing tests against expected failures, confirms every test still executes, and assesses relevance:

- Tax regression: the affected checkout test must score at least 0.65 and outrank unrelated login and tax-label tests. The label is a deliberate keyword decoy.
- Shared dependency regression: both dependent tests must score at least 0.65; an independent authentication test must score at most 0.4.
- Shared test harness regression: every affected test must score at least 0.65.
- Documentation-only change: every independent test must score at most 0.4.

These are smoke-level quality gates, not a calibrated accuracy estimate or evidence that skipping low-ranked tests is safe. Production execution remains unchanged. Artifacts contain native baseline/mutation logs, scores, observed failures, API usage and timing. API errors or missing scores fail the evaluation, while ordinary plugin observation fails open and preserves native execution.

The `decision-evaluation` CI artifact includes `responses.json`, a replay file matched by a SHA-256 hash of the complete request and model. The committed `responses.json` was captured from a successful real OpenRouter CI evaluation on 2026-10-05 and verified in offline replay. CI now defaults to replay. Set repository variable `NOPO_DECISION_EVAL_MODE` to `live` to refresh quality evidence, or select `live`, `mock` or `replay` when dispatching the workflow. Replay never sends requests or reads credentials, and changed input fails with `mock-miss` rather than using an unrelated answer.

```sh
NOPO_DECISION_EVAL_MODE=replay \
NOPO_DECISION_REPLAY_FILE=/path/to/responses.json \
bun nopo/evaluations/decisions/run.ts
```

`NOPO_DECISION_EVAL_DIR` selects the artifact directory (default `/tmp/nopo-decision-eval`). Do not treat hand-authored mock probabilities as live evidence.

## Initial live evidence

[CI run 37248815680, attempt 2](https://github.com/more-nopo/nopo/actions/runs/37248815680/attempts/2) passed all nine scenarios with `typesafe/jev-1.13-20260917`. A second live run also passed. The first recording scored affected tests at 0.93–0.97 and independent tests at 0.02–0.05; scoring took 163–259 ms per runner scenario in CI. All 24 tests in mutated fixture runs were retained, including the 12 expected mutation failures. These numbers describe this small synthetic evaluation only. Replayed probabilities are fixed regression fixtures, not new accuracy measurements.

## Reading CI output

Both the main `ci` job (mock integration) and `decision-quality` job (recorded live answers by default) print a table for each scenario. The same tables appear in the Actions job summary and `summary.md` artifact. Each row shows the returned relevance score, the fixture's expected relationship to the change, and whether that test actually failed after the mutation. A scenario passes only when native execution and score quality gates both hold; expected mutation failures are successful evaluation evidence.

The output names the mode and model, lists changed files, shows scoring and native execution time, and illustrates which files a threshold of 0.65 would select and how many observed failures that would miss. This is a counterfactual count, not filtering or a measured speedup. Replay timing measures replay overhead, not API latency. Native runner logs also print individual scores when observation is enabled. Full JSON and native logs remain available in `decision-evaluation` (quality) and `mock-decision-evaluation` (integration) artifacts.


## 100-test dependency gradient

Both runners now execute the same 100-file fixture, with a mutation in the middle `money` module. Ten interleaved cohorts cover direct assertions, immediate wrappers, deep wrappers, mixed aggregation, enabled/bypassed conditional paths, overlapping invariant assertions, unchanged exports, keyword decoys, and unrelated authentication. Fifty tests are known to fail under the mutation; fifty still pass. The baseline runs all 100 before mutation, and observation runs all 100 afterward.

Each scoring request contains the complete candidate set, diff, nopo target graph, and a bounded advisory file graph with imported module excerpts. Four batches ask for 32/32/32/4 scores without hiding the other candidates. Relative imports and re-exports are followed to eight levels; alias/package/unresolved edges and truncation remain explicit. This is not a native resolver or a claim of complete static analysis.

Mock answers span 0.99 to 0.01 to verify graded plumbing and multi-batch completeness; those values are never used as model-quality evidence. Live/replay summaries show every score, cohort min/median/max, ten-bin histogram, and top-K mutation recall at K=10/25/50/75/100. No cohort labels or expected scores are sent to the API. Correctness gates require all files scored, actual mutation ground truth preserved, affected files scoring at least 0.5, direct files at least 0.8, and unrelated files at most 0.2. Distance is not itself a lower relevance label: a deep wrapper asserting the changed numeric value can be just as relevant as a direct test. The observed distribution shows whether Jev actually gives useful gradation rather than fabricating one.


### Expanded live evidence

[Live CI run 37254413314](https://github.com/more-nopo/nopo/actions/runs/37254413314) passed all eleven scenarios, including 100 scored/executed files per runner and four scoring batches per 100-file run. Both runners returned 28 distinct relevance scores. Direct/immediate tests clustered around 0.95, deep/aggregate/enabled conditional tests around 0.91–0.93, invariant overlap around 0.70–0.75, bypassed paths around 0.12–0.13, unaffected exports/keyword decoys around 0.08–0.10, and unrelated tests around 0.04. All 50 mutation failures per runner were in the top 50. This is a measured distribution, not an imposed smooth gradient; deep exact-value assertions correctly stayed highly relevant. The committed recordings now cover the expanded module context and 100-file candidate universe.
