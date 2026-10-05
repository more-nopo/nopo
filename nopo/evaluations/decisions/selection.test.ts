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
