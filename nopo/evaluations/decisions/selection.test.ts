import { it, expect } from "vitest";
import {
  relevanceArgs,
  relevanceOptions,
  relevanceSchema,
} from "../../plugins/test-relevance/src/options.ts";
it("defaults to off without configuration and threshold alone does not activate selection", () => {
  expect(relevanceOptions().mode).toBe("off");
  expect(relevanceArgs(["one.test.ts"]).relevance).toBeUndefined();
  expect(() => relevanceArgs(["--relevance-threshold=.7"])).toThrow(
    "enabled relevance mode",
  );
});
it("rejects invalid thresholds and removes plugin flags from native argv", () => {
  for (const threshold of [-0.1, 1.1, NaN, Infinity])
    expect(
      relevanceSchema.safeParse({ mode: "select", threshold }).success,
    ).toBe(false);
  expect(
    relevanceArgs([
      "--relevance=dry",
      "--relevance-threshold",
      "0.7",
      "one.test.ts",
    ]),
  ).toEqual({
    args: ["one.test.ts"],
    relevance: { mode: "dry", threshold: 0.7 },
  });
  expect(relevanceSchema.parse({ threshold: 0.7 })).toEqual({
    mode: "dry",
    threshold: 0.7,
  });
});

it("supports runner-only environment opt-in with CLI taking precedence", () => {
  const env = { NOPO_RELEVANCE_MODE: "dry", NOPO_RELEVANCE_THRESHOLD: ".7" };
  expect(relevanceArgs(["file.test.ts"], undefined, env)).toEqual({
    args: ["file.test.ts"],
    relevance: { mode: "dry", threshold: 0.7 },
  });
  expect(relevanceArgs(["--relevance=off"], undefined, env).relevance).toBe(
    "off",
  );
  expect(
    relevanceArgs([], { mode: "select", threshold: 0.2 }, env).relevance,
  ).toEqual({ mode: "dry", threshold: 0.7 });
  expect(() =>
    relevanceArgs([], undefined, { NOPO_RELEVANCE_THRESHOLD: ".7" }),
  ).toThrow();
  expect(() =>
    relevanceArgs([], undefined, { ...env, NOPO_RELEVANCE_THRESHOLD: "NaN" }),
  ).toThrow();
});
