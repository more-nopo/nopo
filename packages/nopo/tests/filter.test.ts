import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NormalizedService } from "../src/config/index.ts";
import {
  applyFilters,
  applyFiltersToNames,
  type FilterContext,
  type FilterExpression,
  getFieldValue,
  matchesFilter,
  parseFilterExpression,
  parseSinceArg,
} from "../src/filter.ts";

// Mock the GitInfo module
vi.mock("../src/git-info.ts", () => ({
  GitInfo: {
    getDefaultBranch: vi.fn(() => "main"),
    getChangedFiles: vi.fn(() => ["apps/backend/src/index.ts"]),
    getCommitTimestamp: vi.fn(() => 1_700_000_000),
  },
}));

import { GitInfo } from "../src/git-info.ts";

// Helper to create a minimal NormalizedService for testing
function createMockService(
  overrides: Partial<NormalizedService> = {},
): NormalizedService {
  return {
    id: "test",
    name: "Test Service",
    description: "",
    staticPath: "build",
    tags: [],
    secrets: [],
    type: "service",
    runtime: {
      cpu: "1",
      memory: "512Mi",
      port: 3000,
      deps: [],
    },
    configPath: "/path/to/nopo.yml",
    buildDeps: [],
    runtimeDeps: [],
    systemDeps: [],
    commands: {},
    build: {
      command: "pnpm build",
      deps: [],
    },
    paths: {
      root: "/project/apps/test",
      context: "/project",
    },
    packageManagers: [],
    ...overrides,
  };
}

describe("parseFilterExpression", () => {
  it("parses buildable preset", () => {
    const result = parseFilterExpression("buildable");
    expect(result).toEqual({ type: "preset", field: "buildable" });
  });

  it("parses changed preset", () => {
    const result = parseFilterExpression("changed");
    expect(result).toEqual({ type: "preset", field: "changed" });
  });

  it("parses package preset", () => {
    const result = parseFilterExpression("package");
    expect(result).toEqual({ type: "preset", field: "package" });
  });

  it("parses service preset", () => {
    const result = parseFilterExpression("service");
    expect(result).toEqual({ type: "preset", field: "service" });
  });

  it("parses negation expression", () => {
    const result = parseFilterExpression("!image");
    expect(result).toEqual({ type: "not_exists", field: "image" });
  });

  it("parses equality expression", () => {
    const result = parseFilterExpression("runtime.cpu=2");
    expect(result).toEqual({
      type: "equals",
      field: "runtime.cpu",
      value: "2",
    });
  });

  it("parses equality with multiple equals signs", () => {
    const result = parseFilterExpression("field=value=with=equals");
    expect(result).toEqual({
      type: "equals",
      field: "field",
      value: "value=with=equals",
    });
  });

  it("parses field existence check", () => {
    const result = parseFilterExpression("image");
    expect(result).toEqual({ type: "exists", field: "image" });
  });
});

describe("getFieldValue", () => {
  const service = createMockService({
    runtime: {
      cpu: "2",
      memory: "1Gi",
      port: 8080,
      deps: [],
    },
  });

  it("gets top-level field", () => {
    expect(getFieldValue(service, "name")).toBe("Test Service");
  });

  it("gets nested field with dot notation", () => {
    expect(getFieldValue(service, "runtime.cpu")).toBe("2");
    expect(getFieldValue(service, "runtime.memory")).toBe("1Gi");
  });

  it("returns undefined for non-existent field", () => {
    expect(getFieldValue(service, "nonexistent")).toBeUndefined();
    expect(getFieldValue(service, "runtime.nonexistent")).toBeUndefined();
  });

  it("returns undefined for invalid path on non-object", () => {
    expect(getFieldValue(service, "name.nested")).toBeUndefined();
  });
});

describe("matchesFilter", () => {
  const context: FilterContext = {
    projectRoot: "/project",
  };

  describe("preset filters", () => {
    it("matches buildable preset for services with build command", () => {
      const service = createMockService();
      const filter: FilterExpression = { type: "preset", field: "buildable" };
      expect(matchesFilter(service, filter, context)).toBe(true);
    });

    it("does not match buildable preset for services without build command", () => {
      const service = createMockService({
        image: "postgres:16",
        build: undefined,
        paths: {
          root: "/project/apps/db",
          context: "/project",
        },
      });
      const filter: FilterExpression = { type: "preset", field: "buildable" };
      expect(matchesFilter(service, filter, context)).toBe(false);
    });

    it("matches changed preset for services with changed files", () => {
      const service = createMockService({
        paths: {
          root: "/project/apps/backend",

          context: "/project",
        },
      });
      const filter: FilterExpression = { type: "preset", field: "changed" };
      expect(matchesFilter(service, filter, context)).toBe(true);
    });

    it("does not match changed preset for services without changed files", () => {
      const service = createMockService({
        paths: {
          root: "/project/apps/web",

          context: "/project",
        },
      });
      const filter: FilterExpression = { type: "preset", field: "changed" };
      expect(matchesFilter(service, filter, context)).toBe(false);
    });

    it("matches package preset for packages (type=package)", () => {
      const pkg = createMockService({ type: "package", runtime: undefined });
      const filter: FilterExpression = { type: "preset", field: "package" };
      expect(matchesFilter(pkg, filter, context)).toBe(true);
    });

    it("does not match package preset for services (type=service)", () => {
      const service = createMockService({ type: "service" });
      const filter: FilterExpression = { type: "preset", field: "package" };
      expect(matchesFilter(service, filter, context)).toBe(false);
    });

    it("matches service preset for services (type=service)", () => {
      const service = createMockService({ type: "service" });
      const filter: FilterExpression = { type: "preset", field: "service" };
      expect(matchesFilter(service, filter, context)).toBe(true);
    });

    it("does not match service preset for packages (type=package)", () => {
      const pkg = createMockService({ type: "package", runtime: undefined });
      const filter: FilterExpression = { type: "preset", field: "service" };
      expect(matchesFilter(pkg, filter, context)).toBe(false);
    });
  });

  describe("exists filter", () => {
    it("matches when field exists", () => {
      const service = createMockService({ image: "postgres:16" });
      const filter: FilterExpression = { type: "exists", field: "image" };
      expect(matchesFilter(service, filter, context)).toBe(true);
    });

    it("does not match when field is undefined", () => {
      const service = createMockService();
      const filter: FilterExpression = { type: "exists", field: "image" };
      expect(matchesFilter(service, filter, context)).toBe(false);
    });
  });

  describe("not_exists filter", () => {
    it("matches when field does not exist", () => {
      const service = createMockService();
      const filter: FilterExpression = { type: "not_exists", field: "image" };
      expect(matchesFilter(service, filter, context)).toBe(true);
    });

    it("does not match when field exists", () => {
      const service = createMockService({ image: "postgres:16" });
      const filter: FilterExpression = { type: "not_exists", field: "image" };
      expect(matchesFilter(service, filter, context)).toBe(false);
    });
  });

  describe("equals filter", () => {
    it("matches when field equals value", () => {
      const service = createMockService();
      const filter: FilterExpression = {
        type: "equals",
        field: "runtime.cpu",
        value: "1",
      };
      expect(matchesFilter(service, filter, context)).toBe(true);
    });

    it("does not match when field has different value", () => {
      const service = createMockService();
      const filter: FilterExpression = {
        type: "equals",
        field: "runtime.cpu",
        value: "2",
      };
      expect(matchesFilter(service, filter, context)).toBe(false);
    });

    it("does not match when field does not exist", () => {
      const service = createMockService();
      const filter: FilterExpression = {
        type: "equals",
        field: "nonexistent",
        value: "value",
      };
      expect(matchesFilter(service, filter, context)).toBe(false);
    });

    it("converts non-string values for comparison", () => {
      const service = createMockService();
      const filter: FilterExpression = {
        type: "equals",
        field: "runtime.port",
        value: "3000",
      };
      expect(matchesFilter(service, filter, context)).toBe(true);
    });
  });
});

describe("applyFilters", () => {
  const context: FilterContext = { projectRoot: "/project" };

  const services: NormalizedService[] = [
    createMockService({
      id: "backend",
      paths: {
        root: "/project/apps/backend",

        context: "/project",
      },
    }),
    createMockService({
      id: "web",
      paths: {
        root: "/project/apps/web",

        context: "/project",
      },
    }),
    createMockService({
      id: "db",
      image: "postgres:16",
      build: undefined,
      paths: {
        root: "/project/apps/db",
        context: "/project",
      },
    }),
  ];

  it("returns all services when no filters", () => {
    const result = applyFilters(services, [], context);
    expect(result).toHaveLength(3);
  });

  it("filters by single expression", () => {
    const filters: FilterExpression[] = [
      { type: "preset", field: "buildable" },
    ];
    const result = applyFilters(services, filters, context);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(["backend", "web"]);
  });

  it("applies multiple filters with AND logic", () => {
    const filters: FilterExpression[] = [
      { type: "preset", field: "buildable" },
      { type: "preset", field: "changed" },
    ];
    const result = applyFilters(services, filters, context);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("backend");
  });
});

describe("applyFiltersToNames", () => {
  const context: FilterContext = { projectRoot: "/project" };

  const services: Record<string, NormalizedService> = {
    backend: createMockService({
      id: "backend",
      paths: {
        root: "/project/apps/backend",

        context: "/project",
      },
    }),
    web: createMockService({
      id: "web",
      paths: {
        root: "/project/apps/web",

        context: "/project",
      },
    }),
    db: createMockService({
      id: "db",
      image: "postgres:16",
      build: undefined,
      paths: {
        root: "/project/apps/db",
        context: "/project",
      },
    }),
  };

  const serviceNames = ["backend", "web", "db"];

  it("returns all names when no filters", () => {
    const result = applyFiltersToNames(serviceNames, services, [], context);
    expect(result).toEqual(serviceNames);
  });

  it("filters names by expression", () => {
    const filters: FilterExpression[] = [
      { type: "preset", field: "buildable" },
    ];
    const result = applyFiltersToNames(
      serviceNames,
      services,
      filters,
      context,
    );
    expect(result).toEqual(["backend", "web"]);
  });

  it("handles unknown service names gracefully", () => {
    const filters: FilterExpression[] = [
      { type: "preset", field: "buildable" },
    ];
    const result = applyFiltersToNames(
      ["backend", "unknown"],
      services,
      filters,
      context,
    );
    expect(result).toEqual(["backend"]);
  });
});

describe("parseSinceArg", () => {
  it("returns empty object for undefined", () => {
    expect(parseSinceArg(undefined)).toEqual({});
  });

  it("returns plain since for a git ref string", () => {
    expect(parseSinceArg("abc123")).toEqual({ since: "abc123" });
  });

  it("returns plain since for origin/main", () => {
    expect(parseSinceArg("origin/main")).toEqual({ since: "origin/main" });
  });

  it("parses JSON object into sinceMap", () => {
    const input = '{"backend":"abc123","api":"def456"}';
    expect(parseSinceArg(input)).toEqual({
      sinceMap: { backend: "abc123", "api": "def456" },
    });
  });

  it("returns plain since for invalid JSON starting with {", () => {
    expect(parseSinceArg("{not-json")).toEqual({ since: "{not-json" });
  });

  it("returns plain since for JSON array", () => {
    expect(parseSinceArg('["abc"]')).toEqual({ since: '["abc"]' });
  });

  it("returns empty sinceMap for empty JSON object", () => {
    expect(parseSinceArg("{}")).toEqual({ sinceMap: {} });
  });
});

describe("sinceMap filtering", () => {
  beforeEach(() => {
    vi.mocked(GitInfo.getChangedFiles).mockReset();
    vi.mocked(GitInfo.getDefaultBranch).mockReturnValue("main");
  });

  it("uses service-specific SHA from sinceMap", () => {
    const backendSha = "1111111111111111111111111111111111111111";
    const webSha = "2222222222222222222222222222222222222222";
    vi.mocked(GitInfo.getChangedFiles).mockImplementation((ref: string) => {
      if (ref === backendSha) return ["apps/backend/src/index.ts"];
      if (ref === webSha) return [];
      return [];
    });

    const context: FilterContext = {
      projectRoot: "/project",
      sinceMap: { backend: backendSha, web: webSha },
    };

    const backendService = createMockService({
      id: "backend",
      paths: { root: "/project/apps/backend", context: "/project" },
    });
    const webService = createMockService({
      id: "web",
      paths: { root: "/project/apps/web", context: "/project" },
    });

    const changedFilter: FilterExpression = {
      type: "preset",
      field: "changed",
    };
    expect(matchesFilter(backendService, changedFilter, context)).toBe(true);
    expect(matchesFilter(webService, changedFilter, context)).toBe(false);
  });

  it("treats services missing from sinceMap as changed without a git diff", () => {
    // See filter.ts
    vi.mocked(GitInfo.getChangedFiles).mockReturnValue([]);
    vi.mocked(GitInfo.getDefaultBranch).mockReturnValue("main");

    const context: FilterContext = {
      projectRoot: "/project",
      sinceMap: { "api": "sha-api" },
    };

    const backendService = createMockService({
      id: "backend",
      paths: { root: "/project/apps/backend", context: "/project" },
    });

    const changedFilter: FilterExpression = {
      type: "preset",
      field: "changed",
    };
    expect(matchesFilter(backendService, changedFilter, context)).toBe(true);
    // Short-circuited — no git diff needed.
    expect(GitInfo.getChangedFiles).not.toHaveBeenCalled();
  });

  it("flags infra service when image matches but service dir drifted from fleet baseline", () => {
    // grafana's pinned image ref hasn't moved, but provisioning files under its service dir
    // changed since the fleet's oldest git sha. Those file diffs must still trigger a redeploy
    vi.mocked(GitInfo.getChangedFiles).mockImplementation((ref: string) => {
      if (ref === "abc1230") {
        return [
          "apps/metrics/grafana/provisioning/dashboards/cluster-health.json",
        ];
      }
      return [];
    });
    vi.mocked(GitInfo.getCommitTimestamp).mockImplementation((sha: string) => {
      if (sha === "abc1230") return 1_700_000_000;
      if (sha === "def4560") return 1_700_000_500;
      return null;
    });

    const context: FilterContext = {
      projectRoot: "/project",
      sinceMap: {
        backend: "abc1230",
        web: "def4560",
        grafana: "grafana/grafana-oss:11.5.0",
      },
    };

    const grafanaService = createMockService({
      id: "grafana",
      type: "service",
      image: "grafana/grafana-oss:11.5.0",
      build: undefined,
      paths: {
        root: "/project/apps/metrics/grafana",
        context: "/project",
      },
    });

    const changedFilter: FilterExpression = {
      type: "preset",
      field: "changed",
    };
    expect(matchesFilter(grafanaService, changedFilter, context)).toBe(true);
    expect(GitInfo.getChangedFiles).toHaveBeenCalledWith("abc1230");
  });

  it("skips infra service when image matches and service dir is untouched", () => {
    // victoria-logs: image pinned, no dir changes since fleet baseline →
    // no need to redeploy.
    vi.mocked(GitInfo.getChangedFiles).mockReturnValue([
      "apps/metrics/grafana/nopo.yml",
    ]);
    vi.mocked(GitInfo.getCommitTimestamp).mockReturnValue(1_700_000_000);

    const context: FilterContext = {
      projectRoot: "/project",
      sinceMap: {
        backend: "abc1230",
        "victoria-logs": "victoriametrics/victoria-logs:v0.42.0",
      },
    };

    const vlService = createMockService({
      id: "victoria-logs",
      type: "service",
      image: "victoriametrics/victoria-logs:v0.42.0",
      build: undefined,
      paths: {
        root: "/project/apps/metrics/logs",
        context: "/project",
      },
    });

    const changedFilter: FilterExpression = {
      type: "preset",
      field: "changed",
    };
    expect(matchesFilter(vlService, changedFilter, context)).toBe(false);
  });

  it("rebuilds a built service whose sinceMap value is still an upstream image ref", () => {
    // example-nginx in prod: was running `nginx:latest` (image-only), then gained a `build:`
    // block. The deployed-sha map still reports the upstream image ref. Without this branch
    vi.mocked(GitInfo.getChangedFiles).mockReturnValue([]);

    const context: FilterContext = {
      projectRoot: "/project",
      sinceMap: {
        backend: "abc1230abc1230abc1230abc1230abc1230abc12",
        "example-nginx": "nginx:latest",
      },
    };

    const exampleNginxService = createMockService({
      id: "example-nginx",
      type: "service",
      paths: {
        root: "/project/products/example/example-nginx",
        context: "/project",
      },
    });

    const changedFilter: FilterExpression = {
      type: "preset",
      field: "changed",
    };
    expect(matchesFilter(exampleNginxService, changedFilter, context)).toBe(
      true,
    );
    // Short-circuited — never feeds the bogus image ref to git.
    expect(GitInfo.getChangedFiles).not.toHaveBeenCalledWith("nginx:latest");
  });

  it("caches changed files per ref", () => {
    vi.mocked(GitInfo.getChangedFiles).mockReturnValue([]);

    const sameSha = "3333333333333333333333333333333333333333";
    const differentSha = "4444444444444444444444444444444444444444";
    const context: FilterContext = {
      projectRoot: "/project",
      sinceMap: {
        backend: sameSha,
        web: sameSha,
        "api": differentSha,
      },
    };

    const services = [
      createMockService({
        id: "backend",
        paths: { root: "/project/apps/backend", context: "/project" },
      }),
      createMockService({
        id: "web",
        paths: { root: "/project/apps/web", context: "/project" },
      }),
      createMockService({
        id: "api",
        paths: { root: "/project/apps/api", context: "/project" },
      }),
    ];

    const changedFilter: FilterExpression = {
      type: "preset",
      field: "changed",
    };
    for (const svc of services) {
      matchesFilter(svc, changedFilter, context);
    }

    // sameSha should only be called once (cached), differentSha once
    expect(GitInfo.getChangedFiles).toHaveBeenCalledTimes(2);
    expect(GitInfo.getChangedFiles).toHaveBeenCalledWith(sameSha);
    expect(GitInfo.getChangedFiles).toHaveBeenCalledWith(differentSha);
  });
});

describe("build.include extends change detection", () => {
  const changedFilter: FilterExpression = { type: "preset", field: "changed" };
  // Fresh per test — FilterContext memoizes changed files per ref in
  // `_changedFilesCache`, so a shared object would leak results between tests.
  let context: FilterContext;

  beforeEach(() => {
    context = { projectRoot: "/project" };
    vi.mocked(GitInfo.getChangedFiles).mockReset();
    vi.mocked(GitInfo.getDefaultBranch).mockReturnValue("main");
  });

  // web bundles shared packages and declares them in build.include. A change to a
  // declared input must mark the consumer changed — otherwise its tests never run on the PR
  const afWeb = () =>
    createMockService({
      id: "web",
      paths: {
        root: "/project/products/example/web",
        context: "/project",
      },
      build: {
        command: "build",
        deps: [],
        include: [
          "products/example/web",
          "packages/ui",
          "packages/configs",
        ],
      },
    });

  it("marks a consumer changed when an included shared package changes", () => {
    vi.mocked(GitInfo.getChangedFiles).mockReturnValue([
      "packages/ui/src/button.tsx",
    ]);
    expect(matchesFilter(afWeb(), changedFilter, context)).toBe(true);
  });

  it("still honors the service's own root when build.include is set", () => {
    vi.mocked(GitInfo.getChangedFiles).mockReturnValue([
      "products/example/web/app/root.tsx",
    ]);
    expect(matchesFilter(afWeb(), changedFilter, context)).toBe(true);
  });

  it("does not mark a consumer changed for a path it does not include", () => {
    // web does NOT include the api source, so an api-only change must
    // leave it unchanged (no spurious fan-out).
    vi.mocked(GitInfo.getChangedFiles).mockReturnValue([
      "products/example/api/src/index.ts",
    ]);
    expect(matchesFilter(afWeb(), changedFilter, context)).toBe(false);
  });

  it("matches a file-level include exactly (e.g. uv.lock)", () => {
    const backend = createMockService({
      id: "backend",
      paths: {
        root: "/project/products/example/backend",
        context: "/project",
      },
      build: {
        command: "build",
        deps: [],
        include: ["products/example/backend", "uv.lock", "pyproject.toml"],
      },
    });
    vi.mocked(GitInfo.getChangedFiles).mockReturnValue(["uv.lock"]);
    expect(matchesFilter(backend, changedFilter, context)).toBe(true);
  });

  // No build.include → fall back to the service's own root (unchanged behavior).
  const leaf = () =>
    createMockService({
      id: "leaf",
      paths: { root: "/project/apps/leaf", context: "/project" },
      build: { command: "build", deps: [] },
    });

  it("falls back to the service root (own dir changed) when include is absent", () => {
    vi.mocked(GitInfo.getChangedFiles).mockReturnValue([
      "apps/leaf/src/index.ts",
    ]);
    expect(matchesFilter(leaf(), changedFilter, context)).toBe(true);
  });

  it("falls back to the service root (unrelated change) when include is absent", () => {
    vi.mocked(GitInfo.getChangedFiles).mockReturnValue([
      "packages/ui/src/button.tsx",
    ]);
    expect(matchesFilter(leaf(), changedFilter, context)).toBe(false);
  });
});
