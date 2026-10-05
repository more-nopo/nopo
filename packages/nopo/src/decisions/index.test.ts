import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  createDecisionClient,
  decisionConfigSchema,
  decisionRequestHash,
  type DecisionRequest,
} from "./index.ts";
const config = { baseUrl: "https://openrouter.ai/api", model: "jev-1.13" };
const request: DecisionRequest = {
  state: { diff: "tax = .2" },
  questions: {
    relevant: {
      type: "noul",
      instructions: "Does the tax test cover this change?",
    },
  },
};
const response = {
  model: "typesafe/jev-1.13",
  answers: { relevant: { type: "noul", noul: 0.9 } },
};
const env = { OPENROUTER_API_KEY: "fixture-token" };
describe("decision service", () => {
  it("is disabled without configuration and does not fetch without credentials", async () => {
    const fetcher = vi.fn();
    expect(
      await createDecisionClient(undefined, { fetch: fetcher }).evaluate(
        request,
      ),
    ).toMatchObject({ reason: "disabled" });
    expect(
      await createDecisionClient(config, { fetch: fetcher }).evaluate(request),
    ).toMatchObject({ reason: "credentials" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses the documented System One protocol without forwarding redirects", async () => {
    const fetcher = vi.fn(async (url, init) => {
      expect(url).toBe("https://openrouter.ai/api/v1/systemone");
      expect(init.redirect).toBe("error");
      expect(init.headers.Authorization).toBe("Bearer fixture-token");
      expect(JSON.parse(init.body)).toEqual({
        model: config.model,
        ...request,
      });
      return Response.json(response);
    });
    const result = await createDecisionClient(config, {
      env,
      fetch: fetcher,
    }).evaluate(request);
    expect(result).toMatchObject({
      status: "ok",
      source: "live",
      answers: response.answers,
    });
  });
  it("decrypts a configured secret lazily and prefers the CI environment key", async () => {
    const secret = vi.fn(async () => "encrypted-fixture-token");
    const configured = {
      ...config,
      secret: { target: "nopo", key: "OPENROUTER_API_KEY" },
    };
    const fetcher = vi.fn(async (_url, init) => {
      expect((init!.headers as Record<string, string>).Authorization).toBe(
        "Bearer encrypted-fixture-token",
      );
      return Response.json(response);
    });
    const client = createDecisionClient(configured, { secret, fetch: fetcher });
    expect(secret).not.toHaveBeenCalled();
    expect(await client.evaluate(request)).toMatchObject({ status: "ok" });
    expect(secret).toHaveBeenCalledWith({
      target: "nopo",
      runtime: "default",
      key: "OPENROUTER_API_KEY",
    });
    await createDecisionClient(configured, {
      env,
      secret,
      fetch: async () => Response.json(response),
    }).evaluate(request);
    expect(secret).toHaveBeenCalledTimes(1);
  });
  it.each([
    { answers: {} },
    { answers: { relevant: { type: "noul", noul: 2 } } },
    {
      answers: {
        relevant: { type: "noul", noul: 0.9 },
        invented: { type: "noul", noul: 0.8 },
      },
    },
    {
      answers: {
        relevant: {
          type: "choice",
          choice: "yes",
          probabilities: { yes: 1 },
          confidence: 1,
        },
      },
    },
  ])(
    "rejects invalid, missing, unknown or mismatched answers %j",
    async (body) => {
      expect(
        await createDecisionClient(config, {
          env,
          fetch: async () => Response.json({ model: "jev", ...body }),
        }).evaluate(request),
      ).toMatchObject({ status: "unavailable", reason: "response" });
    },
  );
  it("validates choice and score distributions against the caller's criteria", async () => {
    const input: DecisionRequest = {
      state: "refund",
      questions: {
        route: {
          type: "choice",
          instructions: "Which team?",
          criteria: { billing: "refund", support: "support" },
        },
        urgency: {
          type: "score",
          instructions: "How urgent?",
          criteria: ["low", "high"],
        },
      },
    };
    const body = {
      model: "jev",
      answers: {
        route: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.9, support: 0.1 },
          confidence: 0.8,
        },
        urgency: {
          type: "score",
          score: 0.7,
          probabilities: { "0": 0.3, "1": 0.7 },
          confidence: 0.4,
          legend: { "0": "low", "1": "high" },
        },
      },
    };
    expect(
      await createDecisionClient(config, {
        env,
        fetch: async () => Response.json(body),
      }).evaluate(input),
    ).toMatchObject({ status: "ok" });
    body.answers.route.probabilities.billing = 0.2;
    expect(
      await createDecisionClient(config, {
        env,
        fetch: async () => Response.json(body),
      }).evaluate(input),
    ).toMatchObject({ reason: "response" });
  });
  it("bounds request size, response size, concurrency, timeout and invocation calls", async () => {
    const fetcher = vi.fn(async () => Response.json(response));
    const client = createDecisionClient(
      { ...config, maxRequests: 1 },
      { env, fetch: fetcher },
    );
    expect(
      await client.evaluate({ ...request, state: "x".repeat(128000) }),
    ).toMatchObject({ reason: "request" });
    expect(await client.evaluate(request)).toMatchObject({ status: "ok" });
    expect(await client.evaluate(request)).toMatchObject({ reason: "budget" });
    const slow = createDecisionClient(
      { ...config, timeoutMs: 10, maxConcurrency: 1 },
      { env, fetch: () => new Promise(() => {}) },
    );
    const running = slow.evaluate(request);
    expect(await slow.evaluate(request)).toMatchObject({ reason: "busy" });
    expect(await running).toMatchObject({ reason: "timeout" });
    expect(
      await createDecisionClient(config, {
        env,
        fetch: async () => new Response("x".repeat(128001)),
      }).evaluate(request),
    ).toMatchObject({ reason: "response" });
  });
  it("reports HTTP failures without including credentials or remote bodies", async () => {
    const result = await createDecisionClient(config, {
      env,
      fetch: async () =>
        new Response("fixture-token sensitive", { status: 429 }),
    }).evaluate(request);
    expect(result).toEqual({
      status: "unavailable",
      reason: "network",
      httpStatus: 429,
    });
  });
  it("replays exact recorded inputs offline and rejects changed evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "decision-replay-"));
    const fetcher = vi.fn();
    try {
      writeFileSync(
        path.join(root, "responses.json"),
        JSON.stringify({
          schemaVersion: 1,
          responses: { [decisionRequestHash(config.model, request)]: response },
        }),
      );
      const client = createDecisionClient(
        { ...config, mockResponses: "responses.json" },
        { root, fetch: fetcher },
      );
      expect(await client.evaluate(request)).toMatchObject({
        status: "ok",
        source: "mock",
      });
      expect(
        await client.evaluate({ ...request, state: "different diff" }),
      ).toMatchObject({ reason: "mock-miss" });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("fails config validation for unknown protocols and URLs with embedded credentials", () => {
    expect(() =>
      decisionConfigSchema.parse({ ...config, protocol: "guess" }),
    ).toThrow();
    expect(() =>
      decisionConfigSchema.parse({ ...config, baseUrl: "https://token@host" }),
    ).toThrow();
  });
});

it.each([
  { state: undefined, questions: request.questions },
  { state: { invalid: () => true }, questions: request.questions },
  {
    state: null,
    questions: { q: { type: "choice", instructions: "choose", criteria: {} } },
  },
  {
    state: null,
    questions: {
      q: { type: "score", instructions: "score", criteria: ["one"] },
    },
  },
  {
    state: null,
    questions: {
      q: { type: "noul", instructions: "decide", criteria: { yes: "yes" } },
    },
  },
])("rejects invalid input before network I/O: %j", async (input) => {
  const fetcher = vi.fn();
  expect(
    await createDecisionClient(config, { env, fetch: fetcher }).evaluate(
      input as DecisionRequest,
    ),
  ).toMatchObject({ status: "unavailable", reason: "request" });
  expect(fetcher).not.toHaveBeenCalled();
});
