# Decision API evaluation

Run `bun nopo/evaluations/decisions/run.ts`. The default `mock` mode verifies integration without credentials; it does not measure model quality.

For real evaluation:

```sh
NOPO_DECISION_EVAL_MODE=live bun nopo/evaluations/decisions/run.ts
```

Supply `OPENROUTER_API_KEY` through the environment. CI reads the repository secret of that name. Missing credentials fail the quality job; there is no mock fallback. Only synthetic fixture source is transmitted by this evaluation.

The nine scenarios exercise Noul, Choice and Score and run four controlled changes through both native runners. Each fixture first passes without the change. The evaluation then checks actual failing tests against expected failures, confirms every test still executes, and assesses relevance:

- Tax regression: the affected checkout test must score at least 0.65 and outrank unrelated login and tax-label tests. The label is a deliberate keyword decoy.
- Shared dependency regression: both dependent tests must score at least 0.65; an independent authentication test must score at most 0.4.
- Shared test harness regression: every affected test must score at least 0.65.
- Documentation-only change: every independent test must score at most 0.4.

These are smoke-level quality gates, not a calibrated accuracy estimate or evidence that skipping low-ranked tests is safe. Production execution remains unchanged. Artifacts contain native baseline/mutation logs, scores, observed failures, API usage and timing. API errors or missing scores fail the evaluation, while ordinary plugin observation fails open and preserves native execution.

The `decision-evaluation` CI artifact includes `responses.json`, a replay file matched by a SHA-256 hash of the complete request and model. After a successful live run, review and copy that file to `nopo/evaluations/decisions/responses.json`, then set repository variable `NOPO_DECISION_EVAL_MODE` to `replay`. Alternatively select `live`, `mock` or `replay` when dispatching the workflow. Replay never sends requests or reads credentials, and changed input fails with `mock-miss` rather than using an unrelated answer.

```sh
NOPO_DECISION_EVAL_MODE=replay \
NOPO_DECISION_REPLAY_FILE=/path/to/responses.json \
bun nopo/evaluations/decisions/run.ts
```

`NOPO_DECISION_EVAL_DIR` selects the artifact directory (default `/tmp/nopo-decision-eval`). Do not treat hand-authored mock probabilities as live evidence.
