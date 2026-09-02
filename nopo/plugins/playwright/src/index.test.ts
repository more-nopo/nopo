import type { NormalizedService } from "@more-nopo/nopo/config";
import { ScriptArgs } from "@more-nopo/nopo/script-args";
import { beforeEach, describe, expect, it } from "vitest";

import type { PlaywrightConfig } from "./index.ts";
import {
  getServicePlaywrightConfig,
  hasPlaywrightTests,
  resolveTestDir,
  resolveUrl,
} from "./index.ts";

function makeArgs(values: Record<string, unknown> = {}): ScriptArgs {
  const args = new ScriptArgs({
    url: {
      type: "string",
      description: "url",
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test default
      default: undefined as unknown as string,
    },
    print: { type: "boolean", description: "print", default: false },
    "no-fail-fast": {
      type: "boolean",
      description: "no fail fast",
      default: false,
    },
  });
  for (const [k, v] of Object.entries(values)) {
    args.set(k, v);
  }
  return args;
}

function makeService(
  overrides: Partial<NormalizedService> = {},
): NormalizedService {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal test fixture
  return {
    id: "test-service",
    name: "Test",
    description: "",
    staticPath: "",
    tags: [],
    secrets: [],
    type: "service",
    build: undefined,
    runtime: undefined,
    configPath: "",
    image: undefined,
    dependencies: [],
    commands: {},
    paths: {
      root: "/project/test-service",
      context: "/project",
    },
    pluginData: undefined,
    packageManagers: [],
    ...overrides,
  } as unknown as NormalizedService;
}

describe("resolveUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.URL;
  });

  it("uses --url CLI arg first", () => {
    const args = makeArgs({ url: "https://cli.example.com" });
    const config: PlaywrightConfig = { url: "https://config.example.com" };
    expect(resolveUrl(args, config)).toBe("https://cli.example.com");
  });

  it("uses URL env var second", () => {
    process.env.URL = "https://env.example.com";
    const args = makeArgs();
    const config: PlaywrightConfig = { url: "https://config.example.com" };
    expect(resolveUrl(args, config)).toBe("https://env.example.com");
  });

  it("uses plugin config third", () => {
    const args = makeArgs();
    const config: PlaywrightConfig = { url: "https://config.example.com" };
    expect(resolveUrl(args, config)).toBe("https://config.example.com");
  });

  it("falls back to localhost default", () => {
    const args = makeArgs();
    const config: PlaywrightConfig = {};
    expect(resolveUrl(args, config)).toBe("http://localhost:3000");
  });
});

describe("resolveTestDir", () => {
  it("uses config testDir when provided", () => {
    const result = resolveTestDir("/project/web", { testDir: "e2e-tests" });
    expect(result).toBe("/project/web/e2e-tests");
  });

  it("defaults to playwright directory", () => {
    const result = resolveTestDir("/project/web", {});
    expect(result).toBe("/project/web/playwright");
  });
});

describe("getServicePlaywrightConfig", () => {
  it("returns empty config when pluginData is missing", () => {
    const service = makeService();
    expect(getServicePlaywrightConfig(service)).toEqual({
      url: undefined,
      testDir: undefined,
      configFile: undefined,
      project: undefined,
    });
  });

  it("extracts url and testDir from pluginData", () => {
    const service = makeService({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test fixture
      pluginData: {
        playwright: { url: "http://test.example.com", testDir: "e2e" },
      } as Record<string, unknown>,
    });
    expect(getServicePlaywrightConfig(service)).toEqual({
      url: "http://test.example.com",
      testDir: "e2e",
      configFile: undefined,
      project: undefined,
    });
  });

  it("extracts configFile and project from pluginData", () => {
    const service = makeService({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test fixture
      pluginData: {
        playwright: {
          configFile: "playwright.config.ts",
          project: "smoke",
        },
      } as Record<string, unknown>,
    });
    expect(getServicePlaywrightConfig(service)).toEqual({
      url: undefined,
      testDir: undefined,
      configFile: "playwright.config.ts",
      project: "smoke",
    });
  });

  it("ignores non-string values on known fields", () => {
    const service = makeService({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test fixture
      pluginData: {
        playwright: { url: 42, project: null, testDir: [] },
      } as Record<string, unknown>,
    });
    expect(getServicePlaywrightConfig(service)).toEqual({
      url: undefined,
      testDir: undefined,
      configFile: undefined,
      project: undefined,
    });
  });
});

describe("hasPlaywrightTests", () => {
  it("returns true when pluginData.playwright is set", () => {
    const service = makeService({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test fixture
      pluginData: { playwright: {} } as Record<string, unknown>,
    });
    expect(hasPlaywrightTests(service)).toBe(true);
  });

  it("returns false when pluginData is missing and no config file exists", () => {
    const service = makeService({
      paths: { root: "/nonexistent/path", context: "/" },
    });
    expect(hasPlaywrightTests(service)).toBe(false);
  });
});
