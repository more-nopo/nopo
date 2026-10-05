# Decisions

Nopo exposes one typed, optional decision service to core commands and plugins through `runner.decisions` and `context.decisions`. Configuration selects a System One compatible provider and model; consumers own the question and what to do with its answer.

```yaml
# Root nopo.yml
decisions:
  protocol: system-one
  baseUrl: https://openrouter.ai/api
  model: jev-1.13
  tokenEnv: OPENROUTER_API_KEY
```

The HTTP endpoint is `baseUrl + /v1/systemone`, authenticated with a Bearer token. This implements the documented [OpenRouter System One protocol](https://openrouter.ai/docs/guides/community/typesafe-sdk); it does not assume arbitrary OpenAI chat endpoints accept typed decisions.

To use an encrypted Nopo runtime secret instead of the environment:

```yaml
decisions:
  baseUrl: https://openrouter.ai/api
  model: jev-1.13
  secret:
    target: nopo
    runtime: default
    key: OPENROUTER_API_KEY
```

Set the secret using `nopo secret set` and configure Nopo's usual age identity. An environment token takes precedence over the secret reference, allowing GitHub Actions to supply `OPENROUTER_API_KEY`. Credentials are resolved lazily and excluded from reports.

```ts
const result = await context.decisions.evaluate({
  state: { changedFiles: ["src/tax.ts"] },
  questions: {
    relevant: {
      type: "noul",
      instructions: "Does checkout exercise the changed tax calculation?",
      criteria: { true: "Affected behavior", false: "Independent behavior" },
    },
  },
});
if (result.status === "ok" && result.answers.relevant?.type === "noul") {
  // The consumer decides how to use the probability.
  console.log(result.answers.relevant.noul);
}
```

Questions support `noul` (probability), `choice` (named criteria and probability distribution), and `score` (ordered rubric, weighted score and distribution). Core validates JSON requests, question limits, exact answer IDs, matching types, probability ranges, distribution keys and sums, and score bounds. Results are either `ok` with typed answers, model, source, request hash and optional usage, or `unavailable` with a stable reason. Absence of configuration returns `disabled`. API failures never decide command success; each consumer owns fallback behavior.

Default invocation limits: 10-second timeout, 32 requests, 2 concurrent requests, and 128 KB per HTTP request/response. Configure `timeoutMs`, `maxRequests`, and `maxConcurrency` when needed. There are no automatic retries. Requests exceeding concurrency return `busy`; callers may choose whether to retry. `mockResponses` points to an exact-request replay file, with the same answer validation and no credentials or network.

## Test relevance

Both runner plugins expose the same opt-in target setting:

```yaml
commands:
  test:
    plugin: vitest
plugins:
  vitest:
    test:
      relevance: observe
```

For Bun, delegate with `plugin: bun`, `command: test`, and put `relevance: observe` under `plugins.bun.test`. Root plugin policy can supply the default; target policy can override it with `off`.

Observation uses the resolved runner invocation, bounded Git diff, Nopo dependency graph and test excerpts to ask typed relevance questions. It runs every selected test and preserves native flags, profiles, quarantine and exit codes. No automatic filtering, reordering or AI-controlled execution is enabled. Vitest discovers scope through its native list command; Bun uses advisory discovery and declines unsupported options. Combined Vitest runs observe only opted-in target scopes.

Reports go to `.nopo/relevance`, or `NOPO_RELEVANCE_REPORT_DIR`. `NOPO_RELEVANCE_BASE` selects the comparison ref (default `HEAD`, which covers working changes; use an explicit base ref for committed CI changes). Reports include scores, unknown scores, discovery scope, bounded evidence status, timings and validated responses suitable for replay. At most 128 candidates are scored in batches of 32; remaining candidates are reported as unknown. Observation errors keep full execution intact.

Opting in sends the bounded diff, dependency graph and candidate test excerpts to the configured provider. This is separate from the synthetic [quality evaluation](../evaluations/decisions/README.md). Evaluate suitability and latency before using rankings to change execution.
