import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NormalizedService } from "@more-nopo/nopo/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyDefaults,
  findDuplicateProjectKeys,
  generateProperties,
  getServiceSonarData,
  parsePluginConfig,
  parseScannerExtraArgs,
  type ResolvedSonar,
  resolveScannerPath,
  type SonarPluginData,
} from "./index.ts";

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
      root: "/project/apps/test-service",
      context: "/project",
    },
    pluginData: undefined,
    packageManagers: [],
    ...overrides,
  } as unknown as NormalizedService;
}

describe("parsePluginConfig", () => {
  it("applies defaults when fields are missing", () => {
    expect(parsePluginConfig(undefined)).toEqual({
      url: "http://localhost/sonar",
      scannerVersion: "6.2.1.4610",
    });
  });

  it("uses provided url + scannerVersion", () => {
    expect(
      parsePluginConfig({ url: "http://x", scannerVersion: "7.0" }),
    ).toEqual({ url: "http://x", scannerVersion: "7.0" });
  });
});

describe("getServiceSonarData", () => {
  it("returns null when no opt-in", () => {
    expect(getServiceSonarData(makeService())).toBeNull();
  });

  it("parses sources + exclusions", () => {
    const svc = makeService({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test fixture
      pluginData: {
        sonar: { sources: ["src"], exclusions: ["**/dist/**"] },
      } as Record<string, unknown>,
    });
    const data = getServiceSonarData(svc);
    expect(data).toEqual({ sources: ["src"], exclusions: ["**/dist/**"] });
  });

  it("parses optional fields", () => {
    const svc = makeService({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test fixture
      pluginData: {
        sonar: {
          sources: ["src"],
          exclusions: ["**/dist/**"],
          projectKey: "custom-key",
          projectName: "custom name",
          projectVersion: "2.0",
          tests: ["test"],
          testInclusions: ["**/*.test.ts"],
          coverage: { format: "lcov", path: "coverage/lcov.info" },
          properties: { "sonar.python.version": "3.12" },
        },
      } as Record<string, unknown>,
    });
    expect(getServiceSonarData(svc)).toEqual({
      sources: ["src"],
      exclusions: ["**/dist/**"],
      projectKey: "custom-key",
      projectName: "custom name",
      projectVersion: "2.0",
      tests: ["test"],
      testInclusions: ["**/*.test.ts"],
      coverage: { format: "lcov", path: "coverage/lcov.info" },
      properties: { "sonar.python.version": "3.12" },
    });
  });

  it("throws when required fields missing", () => {
    const svc = makeService({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test fixture
      pluginData: { sonar: { sources: ["src"] } } as Record<string, unknown>,
    });
    expect(() => getServiceSonarData(svc)).toThrow(/required/i);
  });
});

describe("applyDefaults", () => {
  it("derives projectKey / projectName / projectVersion from service id + path", () => {
    const svc = makeService({
      id: "grafana",
      paths: {
        root: "/project/apps/observability/grafana",
        context: "/project",
      },
    });
    const resolved = applyDefaults(
      { sources: ["src"], exclusions: ["**/dist/**"] },
      svc,
      "/project",
    );
    expect(resolved.projectKey).toBe("nopo-grafana");
    expect(resolved.projectName).toBe("nopo / apps/observability/grafana");
    expect(resolved.projectVersion).toBe("1.0");
    expect(resolved.relativePath).toBe("apps/observability/grafana");
  });

  it("respects overrides", () => {
    const svc = makeService({
      id: "nopo",
      paths: { root: "/project/packages/nopo", context: "/project" },
    });
    const resolved = applyDefaults(
      {
        sources: ["src"],
        exclusions: ["**/dist/**"],
        projectKey: "nopo-cli",
        projectName: "custom",
        projectVersion: "2.0",
      },
      svc,
      "/project",
    );
    expect(resolved.projectKey).toBe("nopo-cli");
    expect(resolved.projectName).toBe("custom");
    expect(resolved.projectVersion).toBe("2.0");
  });
});

describe("generateProperties", () => {
  function fixture(
    data: SonarPluginData,
    overrides: Partial<ResolvedSonar> = {},
  ): ResolvedSonar {
    return {
      serviceId: "test",
      serviceRoot: "/project/test",
      relativePath: "test",
      data,
      projectKey: "nopo-test",
      projectName: "nopo / test",
      projectVersion: "1.0",
      tsconfigExists: false,
      ...overrides,
    };
  }

  it("minimal opt-in: sources + exclusions only", () => {
    const out = generateProperties(
      fixture({
        sources: ["src"],
        exclusions: ["**/node_modules/**", "**/dist/**"],
      }),
    );
    expect(out).toMatchInlineSnapshot(`
      "sonar.projectKey=nopo-test
      sonar.projectName=nopo / test
      sonar.projectVersion=1.0
      sonar.sources=src
      sonar.exclusions=**/node_modules/**,**/dist/**
      sonar.sourceEncoding=UTF-8
      "
    `);
  });

  it("emits tsconfigPath when tsconfig exists", () => {
    const out = generateProperties(
      fixture(
        { sources: ["src"], exclusions: ["**/dist/**"] },
        { tsconfigExists: true },
      ),
    );
    expect(out).toContain("sonar.typescript.tsconfigPath=tsconfig.json");
  });

  it("emits tests + testInclusions when present", () => {
    const out = generateProperties(
      fixture({
        sources: ["src"],
        exclusions: ["**/dist/**"],
        tests: ["test"],
        testInclusions: ["**/*.test.ts"],
      }),
    );
    expect(out).toContain("sonar.tests=test");
    expect(out).toContain("sonar.test.inclusions=**/*.test.ts");
  });

  it("maps coverage format to the correct sonar key (lcov)", () => {
    const out = generateProperties(
      fixture({
        sources: ["src"],
        exclusions: ["**/dist/**"],
        coverage: { format: "lcov", path: "coverage/lcov.info" },
      }),
    );
    expect(out).toContain(
      "sonar.javascript.lcov.reportPaths=coverage/lcov.info",
    );
  });

  it("maps cobertura → python coverage key", () => {
    const out = generateProperties(
      fixture({
        sources: ["src"],
        exclusions: ["**/dist/**"],
        coverage: { format: "cobertura", path: "coverage.xml" },
      }),
    );
    expect(out).toContain("sonar.python.coverage.reportPaths=coverage.xml");
  });

  it("maps jacoco → jacoco xml key", () => {
    const out = generateProperties(
      fixture({
        sources: ["src"],
        exclusions: ["**/dist/**"],
        coverage: { format: "jacoco", path: "build/reports/jacoco.xml" },
      }),
    );
    expect(out).toContain(
      "sonar.coverage.jacoco.xmlReportPaths=build/reports/jacoco.xml",
    );
  });

  it("applies escape-hatch properties last", () => {
    const out = generateProperties(
      fixture({
        sources: ["src"],
        exclusions: ["**/dist/**"],
        properties: { "sonar.python.version": "3.12" },
      }),
    );
    expect(out).toContain("sonar.python.version=3.12");
  });

  it("multi-source comma-joins", () => {
    const out = generateProperties(
      fixture({
        sources: ["src", "admin/src"],
        exclusions: ["**/dist/**", "**/generated/**"],
      }),
    );
    expect(out).toContain("sonar.sources=src,admin/src");
    expect(out).toContain("sonar.exclusions=**/dist/**,**/generated/**");
  });
});

describe("resolveScannerPath", () => {
  const cacheRoot = "/cache";
  const version = "6.2.1.4610";

  it("linux x64 → linux-x64", () => {
    const loc = resolveScannerPath("linux", "x64", cacheRoot, version);
    expect(loc.archSuffix).toBe("linux-x64");
    expect(loc.url).toContain("sonar-scanner-cli-6.2.1.4610-linux-x64.zip");
    expect(loc.binPath).toBe(
      path.join(
        cacheRoot,
        "6.2.1.4610",
        "sonar-scanner-6.2.1.4610-linux-x64",
        "bin",
        "sonar-scanner",
      ),
    );
  });

  it("linux arm64 → linux-aarch64", () => {
    const loc = resolveScannerPath("linux", "arm64", cacheRoot, version);
    expect(loc.archSuffix).toBe("linux-aarch64");
  });

  it("darwin x64 → macosx-x64", () => {
    const loc = resolveScannerPath("darwin", "x64", cacheRoot, version);
    expect(loc.archSuffix).toBe("macosx-x64");
  });

  it("darwin arm64 → macosx-aarch64", () => {
    const loc = resolveScannerPath("darwin", "arm64", cacheRoot, version);
    expect(loc.archSuffix).toBe("macosx-aarch64");
  });

  it("throws on unsupported platform", () => {
    expect(() =>
      resolveScannerPath("win32", "x64", cacheRoot, version),
    ).toThrow(/Unsupported platform/);
  });

  it("throws on unsupported arch", () => {
    expect(() =>
      resolveScannerPath("linux", "mips", cacheRoot, version),
    ).toThrow(/Unsupported Linux arch/);
  });
});

describe("findDuplicateProjectKeys", () => {
  function fixture(serviceId: string, projectKey: string): ResolvedSonar {
    return {
      serviceId,
      serviceRoot: `/project/${serviceId}`,
      relativePath: serviceId,
      data: { sources: ["src"], exclusions: [] },
      projectKey,
      projectName: serviceId,
      projectVersion: "1.0",
      tsconfigExists: false,
    };
  }

  it("returns empty map when all unique", () => {
    const dupes = findDuplicateProjectKeys([
      fixture("a", "nopo-a"),
      fixture("b", "nopo-b"),
    ]);
    expect(dupes.size).toBe(0);
  });

  it("groups services by duplicate key", () => {
    const dupes = findDuplicateProjectKeys([
      fixture("a", "nopo-shared"),
      fixture("b", "nopo-shared"),
      fixture("c", "nopo-c"),
    ]);
    expect(dupes.get("nopo-shared")).toEqual(["a", "b"]);
    expect(dupes.has("nopo-c")).toBe(false);
  });
});

describe("applyDefaults tsconfig detection", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sonar-plugin-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("sets tsconfigExists true when file exists", () => {
    fs.writeFileSync(path.join(tmp, "tsconfig.json"), "{}");
    const svc = makeService({
      paths: { root: tmp, context: path.dirname(tmp) },
    });
    const r = applyDefaults(
      { sources: ["src"], exclusions: [] },
      svc,
      path.dirname(tmp),
    );
    expect(r.tsconfigExists).toBe(true);
  });

  it("sets tsconfigExists false when file missing", () => {
    const svc = makeService({
      paths: { root: tmp, context: path.dirname(tmp) },
    });
    const r = applyDefaults(
      { sources: ["src"], exclusions: [] },
      svc,
      path.dirname(tmp),
    );
    expect(r.tsconfigExists).toBe(false);
  });
});

describe("parseScannerExtraArgs", () => {
  it("returns [] when the env var is unset", () => {
    expect(parseScannerExtraArgs(undefined)).toEqual([]);
  });

  it("returns [] when the env var is empty / whitespace-only", () => {
    expect(parseScannerExtraArgs("")).toEqual([]);
    expect(parseScannerExtraArgs("   \t\n  ")).toEqual([]);
  });

  it("splits a single flag through unchanged", () => {
    expect(parseScannerExtraArgs("-Dsonar.scm.disabled=true")).toEqual([
      "-Dsonar.scm.disabled=true",
    ]);
  });

  it("splits multiple flags on whitespace", () => {
    expect(
      parseScannerExtraArgs("-Dsonar.scm.disabled=true -Dsonar.verbose=true"),
    ).toEqual(["-Dsonar.scm.disabled=true", "-Dsonar.verbose=true"]);
  });

  it("collapses leading/trailing/multiple spaces", () => {
    expect(parseScannerExtraArgs("  -Da=1   -Db=2  ")).toEqual([
      "-Da=1",
      "-Db=2",
    ]);
  });
});
