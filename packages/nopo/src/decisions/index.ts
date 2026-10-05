import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const decisionConfigSchema = z
  .object({
    protocol: z.literal("system-one").default("system-one"),
    baseUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, "Use an HTTP API base URL without credentials, query or fragment"),
    model: z.string().min(1),
    tokenEnv: z.string().min(1).default("OPENROUTER_API_KEY"),
    secret: z
      .object({
        target: z.string().min(1),
        runtime: z.string().default("default"),
        key: z.string().min(1),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(1).max(60000).default(10000),
    maxRequests: z.number().int().min(1).max(1000).default(32),
    maxConcurrency: z.number().int().min(1).max(16).default(2),
    mockResponses: z.string().min(1).optional(),
  })
  .strict();
export type DecisionConfig = z.infer<typeof decisionConfigSchema>;
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Question =
  | { type: "noul"; instructions: Json; criteria?: { true: Json; false: Json } }
  | { type: "choice"; instructions: Json; criteria: Record<string, Json> }
  | { type: "score"; instructions: Json; criteria: Json[] };
export type Answer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      probabilities: Record<string, number>;
      confidence: number;
      legend: Record<string, string>;
    };
export interface DecisionRequest {
  state: Json;
  questions: Record<string, Question>;
}
export type DecisionResult =
  | {
      status: "ok";
      answers: Record<string, Answer>;
      model: string;
      source: "live" | "mock";
      requestHash: string;
      usage?: { input_tokens: number; output_tokens: number; cost?: number };
    }
  | {
      status: "unavailable";
      reason:
        | "disabled"
        | "credentials"
        | "budget"
        | "busy"
        | "request"
        | "response"
        | "network"
        | "timeout"
        | "mock-miss";
      httpStatus?: number;
    };
export interface DecisionClient {
  evaluate(request: DecisionRequest): Promise<DecisionResult>;
}

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonSchema),
    z.record(jsonSchema),
  ]),
);
const requestSchema = z
  .object({
    state: jsonSchema,
    questions: z
      .record(
        z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("noul"),
              instructions: jsonSchema,
              criteria: z
                .object({ true: jsonSchema, false: jsonSchema })
                .strict()
                .optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("choice"),
              instructions: jsonSchema,
              criteria: z
                .record(jsonSchema)
                .refine(
                  (value) =>
                    Object.keys(value).length >= 1 &&
                    Object.keys(value).length <= 255,
                ),
            })
            .strict(),
          z
            .object({
              type: z.literal("score"),
              instructions: jsonSchema,
              criteria: z.array(jsonSchema).min(2).max(10),
            })
            .strict(),
        ]),
      )
      .refine(
        (value) =>
          Object.keys(value).length >= 1 && Object.keys(value).length <= 128,
      ),
  })
  .strict();

const probability = z.number().finite().min(0).max(1);
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(probability),
    confidence: probability,
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().finite(),
    probabilities: z.record(probability),
    confidence: probability,
    legend: z.record(z.string()),
  }),
]);
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(answerSchema),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cost: z.number().finite().nonnegative().optional(),
    })
    .optional(),
});

/** Stable replay identity includes the model, complete input and question rubrics. */
export function decisionRequestHash(
  model: string,
  request: DecisionRequest,
): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, sorted(item)]),
      );
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(sorted({ model, ...request })))
    .digest("hex");
}

function validateAnswers(request: DecisionRequest, raw: unknown) {
  const response = responseSchema.parse(raw);
  const keys = Object.keys(request.questions);
  if (
    Object.keys(response.answers).length !== keys.length ||
    Object.keys(response.answers).some(
      (key) => !Object.hasOwn(request.questions, key),
    )
  )
    throw new Error("answer-ids");
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers[id];
    if (!answer || answer.type !== question.type)
      throw new Error("answer-type");
    if (answer.type === "noul") continue;
    const options =
      question.type === "choice"
        ? Object.keys(question.criteria)
        : question.type === "score"
          ? question.criteria.map((_, i) => String(i))
          : [];
    if (
      Object.keys(answer.probabilities).length !== options.length ||
      options.some((option) => !Object.hasOwn(answer.probabilities, option))
    )
      throw new Error("probability-ids");
    if (
      Math.abs(
        Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1,
      ) > 0.001
    )
      throw new Error("probability-sum");
    if (answer.type === "choice" && !options.includes(answer.choice))
      throw new Error("choice");
    if (
      answer.type === "score" &&
      (answer.score < 0 ||
        answer.score > options.length - 1 ||
        Object.keys(answer.legend).length !== options.length ||
        options.some((option) => !Object.hasOwn(answer.legend, option)))
    )
      throw new Error("score");
  }
  return response;
}
const MAX_BYTES = 128000;
async function boundedResponse(response: Response) {
  if (Number(response.headers.get("content-length")) > MAX_BYTES)
    throw new Error("response-size");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response-body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) throw new Error("response-size");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** No network or credential lookup until evaluate. One instance owns the invocation budget. */
export function createDecisionClient(
  raw: unknown,
  options: {
    env?: NodeJS.ProcessEnv;
    root?: string;
    secret?: (
      reference: NonNullable<DecisionConfig["secret"]>,
    ) => Promise<string | undefined>;
    fetch?: typeof fetch;
  } = {},
): DecisionClient {
  const config =
    raw === undefined ? undefined : decisionConfigSchema.parse(raw);
  let requests = 0;
  let active = 0;
  return {
    async evaluate(request) {
      if (!config) return { status: "unavailable", reason: "disabled" };
      let body: string;
      let requestHash: string;
      try {
        request = requestSchema.parse(request);
        body = JSON.stringify({
          model: config.model,
          state: request.state,
          questions: request.questions,
        });
        if (Buffer.byteLength(body) > MAX_BYTES)
          throw new Error("request-size");
        requestHash = decisionRequestHash(config.model, request);
      } catch {
        return { status: "unavailable", reason: "request" };
      }
      if (requests >= config.maxRequests)
        return { status: "unavailable", reason: "budget" };
      if (active >= config.maxConcurrency)
        return { status: "unavailable", reason: "busy" };
      requests++;
      active++;
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const work = async (): Promise<DecisionResult> => {
        if (config.mockResponses) {
          try {
            const fixture = JSON.parse(
              readFileSync(
                path.resolve(options.root ?? ".", config.mockResponses),
                "utf8",
              ),
            ) as {
              schemaVersion?: number;
              responses?: Record<string, unknown>;
            };
            if (
              fixture.schemaVersion !== 1 ||
              !fixture.responses ||
              !Object.hasOwn(fixture.responses, requestHash)
            )
              return { status: "unavailable", reason: "mock-miss" };
            const response = validateAnswers(
              request,
              fixture.responses[requestHash],
            );
            return { status: "ok", ...response, source: "mock", requestHash };
          } catch {
            return { status: "unavailable", reason: "response" };
          }
        }
        let token = options.env?.[config.tokenEnv];
        if (!token && config.secret && options.secret) {
          try {
            token = await options.secret(config.secret);
          } catch {
            return { status: "unavailable", reason: "credentials" };
          }
        }
        if (!token) return { status: "unavailable", reason: "credentials" };
        if (controller.signal.aborted)
          return { status: "unavailable", reason: "timeout" };
        let response: Response;
        try {
          response = await (options.fetch ?? fetch)(
            `${config.baseUrl.replace(/\/$/, "")}/v1/systemone`,
            {
              method: "POST",
              signal: controller.signal,
              // Never forward a token to an HTTP redirect destination.
              redirect: "error",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body,
            },
          );
        } catch {
          return {
            status: "unavailable",
            reason: controller.signal.aborted ? "timeout" : "network",
          };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return {
            status: "unavailable",
            reason: "network",
            httpStatus: response.status,
          };
        }
        try {
          return {
            status: "ok",
            ...validateAnswers(request, await boundedResponse(response)),
            source: "live",
            requestHash,
          };
        } catch {
          return { status: "unavailable", reason: "response" };
        }
      };
      try {
        return await Promise.race([
          work(),
          new Promise<DecisionResult>((resolve) => {
            timeout = setTimeout(() => {
              controller.abort();
              resolve({ status: "unavailable", reason: "timeout" });
            }, config.timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        active--;
      }
    },
  };
}
