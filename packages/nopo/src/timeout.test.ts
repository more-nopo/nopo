import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIMEOUT_MS,
  formatTimeout,
  parseDuration,
  resolveTimeoutMs,
} from "./timeout.ts";

describe("parseDuration", () => {
  it("treats a bare number as seconds", () => {
    expect(parseDuration(300)).toBe(300_000);
    expect(parseDuration(90)).toBe(90_000);
  });

  it("treats a bare numeric string as seconds", () => {
    expect(parseDuration("300")).toBe(300_000);
  });

  it("parses suffixed durations", () => {
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("1.5m")).toBe(90_000);
  });

  it("is case-insensitive and trims", () => {
    expect(parseDuration("  10M ")).toBe(600_000);
  });

  it("returns null (disabled) for 0 and disable words", () => {
    for (const v of [0, "0", "off", "none", "never", "false", "no"]) {
      expect(parseDuration(v)).toBeNull();
    }
  });

  it("returns undefined for absent / unparseable / boolean values", () => {
    expect(parseDuration(undefined)).toBeUndefined();
    expect(parseDuration(true)).toBeUndefined(); // `--timeout` with no value
    expect(parseDuration("")).toBeUndefined();
    expect(parseDuration("abc")).toBeUndefined();
    expect(parseDuration("5x")).toBeUndefined();
    expect(parseDuration(-5)).toBeUndefined();
  });
});

describe("resolveTimeoutMs", () => {
  it("defaults to 5 minutes with no sources", () => {
    expect(resolveTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBe(300_000);
  });

  it("CLI wins over env and script default", () => {
    expect(resolveTimeoutMs({ cli: "10m", env: "5m", scriptMs: 60_000 })).toBe(
      600_000,
    );
  });

  it("env wins over the script default when no CLI value", () => {
    expect(resolveTimeoutMs({ env: "120", scriptMs: 60_000 })).toBe(120_000);
  });

  it("falls back to the script default when no CLI/env", () => {
    expect(resolveTimeoutMs({ scriptMs: 1_800_000 })).toBe(1_800_000);
  });

  it("an unparseable CLI value falls through to the next source", () => {
    expect(resolveTimeoutMs({ cli: true, env: "5m" })).toBe(300_000);
  });

  it("CLI can disable the timeout (null) and short-circuit", () => {
    expect(
      resolveTimeoutMs({ cli: "off", env: "5m", scriptMs: 60_000 }),
    ).toBeNull();
    expect(resolveTimeoutMs({ cli: 0 })).toBeNull();
  });

  it("a non-positive script default means disabled", () => {
    expect(resolveTimeoutMs({ scriptMs: 0 })).toBeNull();
  });

  it("honors a null fallback (CI: no implicit timeout) when no source resolves", () => {
    expect(resolveTimeoutMs({}, { fallbackMs: null })).toBeNull();
    // scriptMs is skipped by the caller under CI, so only cli/env can impose one.
    expect(resolveTimeoutMs({ cli: "10m" }, { fallbackMs: null })).toBe(
      600_000,
    );
    expect(resolveTimeoutMs({ env: "30" }, { fallbackMs: null })).toBe(30_000);
  });
});

describe("formatTimeout", () => {
  it("renders the largest whole unit", () => {
    expect(formatTimeout(300_000)).toBe("5m");
    expect(formatTimeout(7_200_000)).toBe("2h");
    expect(formatTimeout(90_000)).toBe("90s");
    expect(formatTimeout(500)).toBe("500ms");
  });
});
