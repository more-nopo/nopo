import type { BuildableService, NormalizedService } from "@more-nopo/nopo/config";
import type { PlanNode } from "@more-nopo/nopo/plan";
import type { BatchSpec, CompactionContext } from "@more-nopo/nopo/plan-compact";
import { describe, expect, it, vi } from "vitest";

import dockerPlugin, {
  bakeContextPath,
  buildServiceBakeTarget,
  isDockerBakeTarget,
  resolveGitSha,
  type ServiceBakeInput,
} from "./index.ts";

function makeService(
  overrides: Partial<Omit<BuildableService, "build">> & {
    build: Partial<BuildableService["build"]>;
  },
): BuildableService {
  return {
    id: overrides.id ?? "test-service",
    name: overrides.name ?? "test-service",
    description: "",
    image: undefined,
    staticPath: "",
    tags: [],
    secrets: [],
    type: "service",
    env: undefined,
    runtime: undefined,
    pluginData: undefined,
    paths: overrides.paths ?? {
      root: "/project/products/my-service",
      context: "/project/products/my-service",
    },
    configPath: "/project/products/my-service/nopo.yml",
    packageManagers: [],
    build: { deps: [], ...overrides.build },
    commands: {},
    buildDeps: [],
    runtimeDeps: [],
    systemDeps: [],
  };
}

function makeInput(
  overrides: Partial<ServiceBakeInput> & {
    service: BuildableService;
  },
): ServiceBakeInput {
  return {
    target: overrides.target ?? "test-service",
    contextPath: overrides.contextPath ?? "products/my-service",
    rootName: overrides.rootName ?? "root",
    configRoot: overrides.configRoot ?? "/project",
    tags: overrides.tags ?? ["org/repo-test-service:sha-abc123"],
    gitSha: overrides.gitSha ?? "shatest1234567",
    service: overrides.service,
    output: overrides.output,
    platforms: overrides.platforms,
    cache: overrides.cache,
  };
}

const mockInlineGenerator = vi.fn(
  () => "FROM root AS test-service\nRUN echo ok",
);

describe("buildServiceBakeTarget", () => {
  describe("custom Dockerfile (build.dockerfile)", () => {
    it("uses dockerfile field instead of dockerfile-inline", () => {
      const service = makeService({
        build: { dockerfile: "Dockerfile" },
        paths: {
          root: "/project/products/agent-run",
          context: "/project/products/agent-run",
        },
      });

      const result = buildServiceBakeTarget(
        makeInput({ service, contextPath: "products/agent-run" }),
        mockInlineGenerator,
      );

      expect(result.dockerfile).toBe("products/agent-run/Dockerfile");
      expect(result["dockerfile-inline"]).toBeUndefined();
    });

    it("does not include root context (standalone image)", () => {
      const service = makeService({
        build: { dockerfile: "Dockerfile.custom" },
      });

      const result = buildServiceBakeTarget(
        makeInput({ service }),
        mockInlineGenerator,
      );

      expect(result.contexts).toBeUndefined();
    });

    it("does not call inline generator", () => {
      const generator = vi.fn();
      const service = makeService({
        build: { dockerfile: "Dockerfile" },
      });

      buildServiceBakeTarget(makeInput({ service }), generator);

      expect(generator).not.toHaveBeenCalled();
    });

    it("resolves dockerfile path relative to config root", () => {
      const service = makeService({
        build: { dockerfile: "docker/Dockerfile.prod" },
        paths: {
          root: "/project/services/api",
          context: "/project/services/api",
        },
      });

      const result = buildServiceBakeTarget(
        makeInput({
          service,
          configRoot: "/project",
          contextPath: "services/api",
        }),
        mockInlineGenerator,
      );

      expect(result.dockerfile).toBe("services/api/docker/Dockerfile.prod");
    });

    it("includes tags, SERVICE_NAME and NOPO_GIT_SHA args", () => {
      const service = makeService({
        build: { dockerfile: "Dockerfile" },
      });

      const result = buildServiceBakeTarget(
        makeInput({
          service,
          target: "af-run",
          tags: ["registry/af-run:v1"],
          gitSha: "deadbeefcafe",
        }),
        mockInlineGenerator,
      );

      expect(result.tags).toEqual(["registry/af-run:v1"]);
      expect(result.args).toEqual({
        SERVICE_NAME: "af-run",
        NOPO_GIT_SHA: "deadbeefcafe",
      });
    });

    it("stamps the OCI revision label with the git sha", () => {
      const service = makeService({
        build: { dockerfile: "Dockerfile" },
      });

      const result = buildServiceBakeTarget(
        makeInput({ service, gitSha: "deadbeefcafe" }),
        mockInlineGenerator,
      );

      expect(result.labels).toEqual({
        "org.opencontainers.image.revision": "deadbeefcafe",
      });
    });
  });

  describe("inline Dockerfile (build.command)", () => {
    it("uses dockerfile-inline instead of dockerfile", () => {
      const service = makeService({
        build: { command: "bun build" },
      });

      const result = buildServiceBakeTarget(
        makeInput({ service }),
        mockInlineGenerator,
      );

      expect(result["dockerfile-inline"]).toBeDefined();
      expect(result.dockerfile).toBeUndefined();
    });

    it("includes root context for base image inheritance", () => {
      const service = makeService({
        build: { command: "bun build" },
      });

      const result = buildServiceBakeTarget(
        makeInput({ service, rootName: "my-root" }),
        mockInlineGenerator,
      );

      expect(result.contexts).toEqual({
        "my-root": "target:my-root",
        // /build-info.json arrives via its own context so the per-commit
        // layer stays out of the base image every build stage derives from.
        "root-info": "target:root-info",
      });
    });

    it("calls inline generator with correct args", () => {
      const generator = vi.fn(() => "FROM root");
      const service = makeService({
        build: { command: "echo build" },
        paths: {
          root: "/project/apps/web",
          context: "/project/apps/web",
        },
      });

      buildServiceBakeTarget(
        makeInput({ service, rootName: "base", configRoot: "/project" }),
        generator,
      );

      expect(generator).toHaveBeenCalledWith(service, "base", "apps/web");
    });

    it("includes SERVICE_NAME and NOPO_GIT_SHA args plus the OCI revision label", () => {
      const service = makeService({
        build: { command: "bun build" },
      });

      const result = buildServiceBakeTarget(
        makeInput({ service, target: "web", gitSha: "deadbeefcafe" }),
        mockInlineGenerator,
      );

      expect(result.args).toEqual({
        SERVICE_NAME: "web",
        NOPO_GIT_SHA: "deadbeefcafe",
      });
      expect(result.labels).toEqual({
        "org.opencontainers.image.revision": "deadbeefcafe",
      });
    });
  });

  describe("shared behavior", () => {
    it("passes output options through", () => {
      const service = makeService({ build: { dockerfile: "Dockerfile" } });

      const result = buildServiceBakeTarget(
        makeInput({ service, output: { output: ["type=docker"] } }),
        mockInlineGenerator,
      );

      expect(result.output).toEqual(["type=docker"]);
    });

    it("passes platforms through", () => {
      const service = makeService({ build: { command: "build" } });

      const result = buildServiceBakeTarget(
        makeInput({ service, platforms: ["linux/amd64"] }),
        mockInlineGenerator,
      );

      expect(result.platforms).toEqual(["linux/amd64"]);
    });

    it("passes cache config through to inline-Dockerfile services", () => {
      const service = makeService({ build: { command: "build" } });
      const cache = {
        "cache-from": ["type=registry,ref=ghcr.io/me/svc:buildcache"],
        "cache-to": ["type=registry,ref=ghcr.io/me/svc:buildcache,mode=max"],
      };

      const result = buildServiceBakeTarget(
        makeInput({ service, cache }),
        mockInlineGenerator,
      );

      expect(result["cache-from"]).toEqual(cache["cache-from"]);
      expect(result["cache-to"]).toEqual(cache["cache-to"]);
    });

    it("passes cache config through to custom-Dockerfile services", () => {
      const service = makeService({ build: { dockerfile: "Dockerfile" } });
      const cache = {
        "cache-from": ["type=local,src=/tmp/x"],
        "cache-to": ["type=local,dest=/tmp/x,mode=max"],
      };

      const result = buildServiceBakeTarget(
        makeInput({ service, cache }),
        mockInlineGenerator,
      );

      expect(result["cache-from"]).toEqual(cache["cache-from"]);
      expect(result["cache-to"]).toEqual(cache["cache-to"]);
    });
  });
});

function makeNormalizedService(
  overrides: Partial<NormalizedService> = {},
): NormalizedService {
  return {
    id: overrides.id ?? "test-service",
    name: overrides.name ?? "test-service",
    description: "",
    image: undefined,
    staticPath: "",
    tags: [],
    secrets: [],
    type: "service",
    env: undefined,
    runtime: undefined,
    pluginData: undefined,
    paths: overrides.paths ?? {
      root: "/project/products/my-service",
      context: "/project/products/my-service",
    },
    configPath: "/project/products/my-service/nopo.yml",
    packageManagers: [],
    commands: {},
    buildDeps: [],
    runtimeDeps: [],
    systemDeps: [],
    ...overrides,
  };
}

describe("bakeContextPath", () => {
  it("returns '.' for the project root itself", () => {
    expect(bakeContextPath("/project", "/project")).toBe(".");
  });

  it("returns a root-relative path for contexts inside the root", () => {
    expect(bakeContextPath("/project", "/project/products/my-service")).toBe(
      "products/my-service",
    );
  });

  it("returns an absolute path for isolated temp contexts outside the root", () => {
    /** Regression guard: these used to be emitted relative to the project
     * root (`../../../../../tmp/nopo-ctx-…`), which buildx resolves against
     * its *cwd* — correct only by coincidence of directory depth, and
     * flagged by buildx as an fs entitlement escape.
     */
    expect(
      bakeContextPath("/home/runner/_work/nopo/nopo", "/tmp/nopo-ctx-abc123"),
    ).toBe("/tmp/nopo-ctx-abc123");
  });
});

describe("resolveGitSha", () => {
  it("prefers GITHUB_SHA from the process env (CI)", () => {
    expect(
      resolveGitSha(
        { GITHUB_SHA: "ci-sha-1234" },
        { GIT_COMMIT: "local-sha-5678" },
      ),
    ).toBe("ci-sha-1234");
  });

  it("falls back to the environment's resolved GIT_COMMIT", () => {
    expect(resolveGitSha({}, { GIT_COMMIT: "local-sha-5678" })).toBe(
      "local-sha-5678",
    );
  });

  it("returns 'unknown' when no sha source is available", () => {
    expect(resolveGitSha({}, {})).toBe("unknown");
  });
});

describe("isDockerBakeTarget", () => {
  it("returns true for a service with plugins.docker AND a build.command", () => {
    const service = makeNormalizedService({
      build: { deps: [], command: "bun build" },
      pluginData: { docker: {} },
    });

    expect(isDockerBakeTarget(service)).toBe(true);
  });

  it("returns true for a service with plugins.docker AND build.dockerfile (no runtime)", () => {
    // Mirrors act: build-only image, opted into docker baking.
    const service = makeNormalizedService({
      type: "package",
      runtime: undefined,
      build: { deps: [], dockerfile: "Dockerfile" },
      pluginData: { docker: {} },
    });

    expect(isDockerBakeTarget(service)).toBe(true);
  });

  it("returns false for a service with build.command but NO plugins.docker", () => {
    // Both predicate halves are required — declaring a build alone is not
    // enough; the service must opt in via the plugin declaration.
    const service = makeNormalizedService({
      build: { deps: [], command: "bun build" },
      pluginData: undefined,
    });

    expect(isDockerBakeTarget(service)).toBe(false);
  });

  it("returns false for a service with plugins.docker but NO build", () => {
    /** Empty plugin declaration without anything to build produces no bake
     * target. Prevents image-only services (`image: redis:7` with no build)
     * from accidentally entering the bake set.
     */
    const service = makeNormalizedService({
      build: undefined,
      pluginData: { docker: {} },
    });

    expect(isDockerBakeTarget(service)).toBe(false);
  });

  it("returns false when pluginData has other plugins but not docker", () => {
    // docker-compose presence alone does not imply docker baking.
    const service = makeNormalizedService({
      build: { deps: [], command: "bun build" },
      pluginData: { "docker-compose": { ports: ["8080:80"] } },
    });

    expect(isDockerBakeTarget(service)).toBe(false);
  });
});

describe("dockerPlugin factory shape", () => {
  const definition = dockerPlugin({});

  it("exposes a buildBatch hook and no build override", () => {
    expect(definition.hooks?.buildBatch).toBeTypeOf("function");
    expect(definition.overrides?.build).toBeUndefined();
    expect(definition.overrides ?? {}).toEqual({});
  });

  it("declares a single BatchSpec", () => {
    expect(definition.batches).toBeDefined();
    expect(definition.batches).toHaveLength(1);
  });
});

function makeBuildExecNode(
  target: string,
  overrides: Partial<PlanNode> = {},
): PlanNode {
  return {
    id: `build:${target}`,
    handler: { kind: "builtin", name: "build:exec" },
    needs: ["pre_build"],
    target,
    payload: { target, noCache: false },
    ...overrides,
  };
}

function makeCtx(
  services: Record<string, NormalizedService>,
): CompactionContext {
  /* eslint-disable @typescript-eslint/consistent-type-assertions -- test stub of CompactionContext; spec only reads `services` */
  return {
    services,
    project: { plugins: [] } as unknown as CompactionContext["project"],
    env: {},
    args: {} as unknown as CompactionContext["args"],
  };
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
}

describe("dockerPlugin BatchSpec.claims", () => {
  const definition = dockerPlugin({});
  const spec = definition.batches![0]!;

  it("claims a build:exec node whose target is docker-eligible", () => {
    const svc = makeNormalizedService({
      build: { deps: [], command: "bun build" },
      pluginData: { docker: {} },
    });
    const node = makeBuildExecNode("svc");
    expect(spec.claims(node, makeCtx({ svc }))).toBe(true);
  });

  it("does NOT claim a build:exec node for a non-docker service", () => {
    const svc = makeNormalizedService({
      build: { deps: [], command: "bun build" },
      pluginData: undefined,
    });
    const node = makeBuildExecNode("svc");
    expect(spec.claims(node, makeCtx({ svc }))).toBe(false);
  });

  it("does NOT claim a pre_build node (builtin name mismatch)", () => {
    const svc = makeNormalizedService({
      build: { deps: [], command: "bun build" },
      pluginData: { docker: {} },
    });
    const node: PlanNode = {
      id: "pre_build",
      handler: { kind: "builtin", name: "build:pre" },
      needs: [],
    };
    expect(spec.claims(node, makeCtx({ svc }))).toBe(false);
  });

  it("does NOT claim a plugin-hook node (kind mismatch)", () => {
    const svc = makeNormalizedService({
      build: { deps: [], command: "bun build" },
      pluginData: { docker: {} },
    });
    const node: PlanNode = {
      id: "build:bake",
      handler: { kind: "plugin-hook", plugin: "docker", hook: "buildBatch" },
      needs: [],
      target: "svc",
    };
    expect(spec.claims(node, makeCtx({ svc }))).toBe(false);
  });

  it("does NOT claim a node with no target (no service to check eligibility on)", () => {
    const node: PlanNode = {
      id: "build:exec",
      handler: { kind: "builtin", name: "build:exec" },
      needs: [],
    };
    expect(spec.claims(node, makeCtx({}))).toBe(false);
  });
});

describe("dockerPlugin BatchSpec.coalesce", () => {
  const definition = dockerPlugin({});
  const spec: BatchSpec = definition.batches![0]!;
  const ctx = makeCtx({});

  it("coalesces multiple build:exec nodes into a single build:bake plugin-hook node", () => {
    const claimed = [
      makeBuildExecNode("a"),
      makeBuildExecNode("b"),
      makeBuildExecNode("c"),
    ];
    const out = spec.coalesce(claimed, ctx);
    expect(out.id).toBe("build:bake");
    expect(out.handler).toEqual({
      kind: "plugin-hook",
      plugin: "docker",
      hook: "buildBatch",
    });
    expect(out.payload).toEqual({
      targets: ["a", "b", "c"],
      noCache: false,
    });
    expect(out.meta).toEqual({
      batchOf: ["build:a", "build:b", "build:c"],
    });
  });

  it("lifts noCache / output / registries off the first claimed payload", () => {
    const claimed = [
      makeBuildExecNode("a", {
        payload: {
          target: "a",
          noCache: true,
          output: "/tmp/info.json",
          registries: "ghcr.io/owner,docker.io/owner",
        },
      }),
      makeBuildExecNode("b", {
        payload: {
          target: "b",
          noCache: true,
          output: "/tmp/info.json",
          registries: "ghcr.io/owner,docker.io/owner",
        },
      }),
    ];
    const out = spec.coalesce(claimed, ctx);
    expect(out.payload).toEqual({
      targets: ["a", "b"],
      noCache: true,
      output: "/tmp/info.json",
      registries: "ghcr.io/owner,docker.io/owner",
    });
  });

  it("defaults flags when claimed payload is missing or malformed", () => {
    const claimed = [makeBuildExecNode("a", { payload: undefined })];
    const out = spec.coalesce(claimed, ctx);
    expect(out.payload).toEqual({ targets: ["a"], noCache: false });
  });
});
