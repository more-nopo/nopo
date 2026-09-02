import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  BuildableService,
  NormalizedCommand,
  PackageManagerConfig,
} from "@more-nopo/nopo/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCacheConfig,
  collectInstallTimeFiles,
  generateBuildRunLines,
  generatePackageManagerInstalls,
  generateRuntimeCopyLines,
  generateRuntimeInstallLines,
  groupInstallTimeFilesByDir,
  pushImageOutput,
} from "./index.ts";

const ROOT_DIR = "/project";

function pm(
  overrides: Partial<PackageManagerConfig> = {},
): PackageManagerConfig {
  return {
    name: "bun",
    lockfile: `${ROOT_DIR}/bun.lock`,
    manifest: [`${ROOT_DIR}/package.json`],
    install: { dev: "bun install --frozen-lockfile" },
    sync: "bun install",
    modules: "node_modules",
    cwd: ROOT_DIR,
    requires_source: false,
    ...overrides,
  };
}

function makeService(
  overrides: Partial<BuildableService> & {
    build?: Partial<BuildableService["build"]>;
    commands?: Record<string, NormalizedCommand>;
    packageManagers?: PackageManagerConfig[];
  } = {},
): BuildableService {
  return {
    id: overrides.id ?? "svc",
    name: overrides.name ?? "svc",
    description: "",
    image: undefined,
    staticPath: "",
    tags: [],
    type: "service",
    secrets: [],
    env: undefined,
    runtime: undefined,
    pluginData: undefined,
    paths: {
      root: `${ROOT_DIR}/services/svc`,
      context: `${ROOT_DIR}/services/svc`,
    },
    configPath: `${ROOT_DIR}/services/svc/nopo.yml`,
    build: {
      deps: [],
      ...(overrides.build ?? {}),
    },
    commands: overrides.commands ?? {},
    buildDeps: [],
    runtimeDeps: [],
    systemDeps: [],
    packageManagers: overrides.packageManagers ?? [],
  };
}

describe("generatePackageManagerInstalls", () => {
  it("returns [] when service has no package managers", () => {
    const service = makeService({ packageManagers: [] });
    expect(
      generatePackageManagerInstalls(service, ROOT_DIR, {
        requiresSource: false,
        phase: "build",
        serviceDir: "services/svc",
      }),
    ).toEqual([]);
  });

  it("emits a single RUN for a root-cwd manifest-only PM (requiresSource:false)", () => {
    const service = makeService({
      packageManagers: [pm({ cwd: ROOT_DIR, requires_source: false })],
    });
    expect(
      generatePackageManagerInstalls(service, ROOT_DIR, {
        requiresSource: false,
        phase: "build",
        serviceDir: "services/svc",
      }),
    ).toEqual([`RUN cd $\${APP} && bun install --frozen-lockfile`]);
  });

  it("translates absolute host cwd to a container path under ${APP}", () => {
    const service = makeService({
      packageManagers: [
        pm({ cwd: `${ROOT_DIR}/services/svc`, requires_source: false }),
      ],
    });
    expect(
      generatePackageManagerInstalls(service, ROOT_DIR, {
        requiresSource: false,
        phase: "build",
        serviceDir: "services/svc",
      }),
    ).toEqual([
      `RUN cd $\${APP}/services/svc && bun install --frozen-lockfile`,
    ]);
  });

  it("deletes the PM download cache in the SAME layer as the install", () => {
    /** Measured: bun's cache is 146,775 dirents, 47% of a large install
     * layer, and the copy/export path is inode-bound. It must go in the
     * install RUN, not a later one, or the layer still carries it.
     */
    const service = makeService({
      packageManagers: [
        pm({ cwd: ROOT_DIR, cache_dir: "${HOME}/.bun/install/cache" }),
      ],
    });
    expect(
      generatePackageManagerInstalls(service, ROOT_DIR, {
        requiresSource: false,
        phase: "build",
        serviceDir: "services/svc",
      }),
    ).toEqual([
      // `$${HOME}`, not `${HOME}` — a bare one is parsed as a BAKE variable
      // and fails the entire bake before any build starts.
      `RUN cd $\${APP} && bun install --frozen-lockfile && rm -rf $\${HOME}/.bun/install/cache`,
    ]);
  });

  it("emits no cleanup when the PM declares no cache_dir", () => {
    const service = makeService({ packageManagers: [pm({ cwd: ROOT_DIR })] });
    const lines = generatePackageManagerInstalls(service, ROOT_DIR, {
      requiresSource: false,
      phase: "build",
      serviceDir: "services/svc",
    });
    expect(lines[0]).not.toContain("rm -rf");
  });

  it("filters PMs by requires_source (manifest-only pass)", () => {
    const service = makeService({
      packageManagers: [
        pm({
          name: "bun",
          install: { dev: "bun install" },
          cwd: ROOT_DIR,
          requires_source: false,
        }),
        pm({
          name: "uv",
          install: { dev: "uv sync" },
          cwd: `${ROOT_DIR}/apps/py`,
          requires_source: true,
        }),
      ],
    });
    const manifestOnly = generatePackageManagerInstalls(service, ROOT_DIR, {
      requiresSource: false,
      phase: "build",
      serviceDir: "services/svc",
    });
    expect(manifestOnly).toEqual([`RUN cd $\${APP} && bun install`]);
  });

  it("filters PMs by requires_source (source-required pass)", () => {
    const service = makeService({
      packageManagers: [
        pm({
          name: "bun",
          install: { dev: "bun install" },
          cwd: ROOT_DIR,
          requires_source: false,
        }),
        pm({
          name: "uv",
          install: { dev: "uv sync" },
          cwd: `${ROOT_DIR}/apps/py`,
          requires_source: true,
        }),
      ],
    });
    const sourceRequired = generatePackageManagerInstalls(service, ROOT_DIR, {
      requiresSource: true,
      phase: "build",
      serviceDir: "services/svc",
    });
    expect(sourceRequired).toEqual([`RUN cd $\${APP}/apps/py && uv sync`]);
  });
});

describe("generateBuildRunLines — legacy string build.command", () => {
  it("emits a single-line RUN when build.command is a one-liner", () => {
    const service = makeService({
      build: { deps: [], command: "make all" },
    });
    expect(generateBuildRunLines(service)).toEqual(["RUN make all"]);
  });

  it("emits a heredoc RUN when build.command is multi-line", () => {
    const service = makeService({
      build: { deps: [], command: "echo one\necho two" },
    });
    expect(generateBuildRunLines(service)).toEqual([
      "RUN <<'EOF'",
      "set -e",
      "echo one\necho two",
      "EOF",
    ]);
  });

  it("emits nothing when build.command is undefined", () => {
    const service = makeService({
      build: { deps: [], command: undefined },
      packageManagers: [pm({ cwd: ROOT_DIR })],
    });
    // Installs are emitted separately by generatePackageManagerInstalls;
    // generateBuildRunLines only handles the build RUN itself.
    expect(generateBuildRunLines(service)).toEqual([]);
  });
});

describe("generateBuildRunLines — deps-form build.command", () => {
  it("resolves the DAG and emits a heredoc with serialized subshell steps", () => {
    const commands: Record<string, NormalizedCommand> = {
      schema: { command: "bun run schema" },
      codegen: { command: "bunx graphql-codegen", deps: ["schema"] },
      "admin-build": {
        command: "cd admin && bunx vite build",
        deps: ["codegen"],
      },
    };
    const service = makeService({
      build: { deps: [], command: { deps: ["admin-build"] } },
      commands,
    });

    expect(generateBuildRunLines(service)).toEqual([
      "RUN <<'EOF'",
      "set -e",
      [
        `( bun run schema )`,
        `( bunx graphql-codegen )`,
        `( cd admin && bunx vite build )`,
      ].join("\n"),
      "EOF",
    ]);
  });

  it("forces heredoc even when the DAG resolves to a single leaf", () => {
    const service = makeService({
      build: { deps: [], command: { deps: ["solo"] } },
      commands: { solo: { command: "echo solo" } },
    });
    expect(generateBuildRunLines(service)).toEqual([
      "RUN <<'EOF'",
      "set -e",
      `( echo solo )`,
      "EOF",
    ]);
  });

  it("propagates DAG validation errors (missing ref)", () => {
    const service = makeService({
      build: { deps: [], command: { deps: ["missing"] } },
      commands: {},
    });
    expect(() => generateBuildRunLines(service)).toThrowError(
      /references unknown command "missing"/,
    );
  });

  it("propagates DAG validation errors (cycle)", () => {
    const commands: Record<string, NormalizedCommand> = {
      a: { command: "a", deps: ["b"] },
      b: { command: "b", deps: ["a"] },
    };
    const service = makeService({
      build: { deps: [], command: { deps: ["a"] } },
      commands,
    });
    expect(() => generateBuildRunLines(service)).toThrowError(/cycle/);
  });

  it("rejects container-context commands at emission time", () => {
    const commands: Record<string, NormalizedCommand> = {
      run: { command: "x", context: "container" },
    };
    const service = makeService({
      build: { deps: [], command: { deps: ["run"] } },
      commands,
    });
    expect(() => generateBuildRunLines(service)).toThrowError(
      /context: container/,
    );
  });
});

describe("collectInstallTimeFiles", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-pmfiles-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function touch(rel: string, content: string = "{}") {
    const full = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  function svc(
    overrides: Partial<BuildableService> & {
      packageManagers?: PackageManagerConfig[];
    } = {},
  ): BuildableService {
    return {
      id: "svc",
      name: "svc",
      description: "",
      image: undefined,
      staticPath: "",
      tags: [],
      type: "service",
      secrets: [],
      env: undefined,
      runtime: undefined,
      pluginData: undefined,
      paths: {
        root: path.join(tmpRoot, "apps/svc"),
        context: path.join(tmpRoot, "apps/svc"),
      },
      configPath: path.join(tmpRoot, "apps/svc/nopo.yml"),
      build: { deps: [] },
      commands: {},
      buildDeps: [],
      runtimeDeps: [],
      systemDeps: [],
      packageManagers: overrides.packageManagers ?? [],
      ...overrides,
    };
  }

  it("returns sorted, repo-relative POSIX paths", () => {
    touch("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    touch("bun.lock");
    touch("nopo.yml");
    touch("apps/svc/package.json", JSON.stringify({ name: "svc" }));

    const files = collectInstallTimeFiles(svc(), tmpRoot);
    expect(files).toEqual([
      "apps/svc/package.json",
      "bun.lock",
      "nopo.yml",
      "package.json",
    ]);
  });

  it("includes every workspace's package.json (for workspace resolution)", () => {
    touch(
      "package.json",
      JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
    );
    touch("apps/svc/package.json", JSON.stringify({ name: "svc" }));
    touch("apps/other/package.json", JSON.stringify({ name: "other" }));
    touch("packages/lib/package.json", JSON.stringify({ name: "lib" }));

    const files = collectInstallTimeFiles(svc(), tmpRoot);
    expect(files).toContain("apps/svc/package.json");
    expect(files).toContain("apps/other/package.json");
    expect(files).toContain("packages/lib/package.json");
  });

  it("includes lockfile + manifest paths declared on each PM config", () => {
    touch("package.json", JSON.stringify({ workspaces: [] }));
    touch("apps/svc/package.json", JSON.stringify({ name: "svc" }));
    touch("apps/svc/bun.lock");

    const files = collectInstallTimeFiles(
      svc({
        packageManagers: [
          {
            name: "bun",
            lockfile: path.join(tmpRoot, "apps/svc/bun.lock"),
            manifest: [path.join(tmpRoot, "apps/svc/package.json")],
            install: { dev: "bun install" },
            sync: "bun install",
            modules: "node_modules",
            cwd: path.join(tmpRoot, "apps/svc"),
            requires_source: false,
          },
        ],
      }),
      tmpRoot,
    );
    expect(files).toContain("apps/svc/package.json");
    expect(files).toContain("apps/svc/bun.lock");
  });

  it("includes per-PM manifest at every workspace member dir", () => {
    /** Manifest-only PMs (e.g. a hypothetical PM with `manifest: pyproject.toml`)
     * need every workspace member's manifest to resolve the workspace, the
     * same way bun needs every package.json.
     */
    touch(
      "package.json",
      JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
    );
    touch("pyproject.toml");
    touch("custom.lock");
    touch("apps/svc/package.json", JSON.stringify({ name: "svc" }));
    touch("apps/svc/pyproject.toml");
    touch("packages/lib/package.json", JSON.stringify({ name: "lib" }));
    touch("packages/lib/pyproject.toml");
    touch("packages/js-only/package.json", JSON.stringify({ name: "js" }));
    // packages/js-only has no pyproject.toml — should be skipped silently.

    const files = collectInstallTimeFiles(
      svc({
        packageManagers: [
          {
            name: "custom",
            lockfile: path.join(tmpRoot, "custom.lock"),
            manifest: [path.join(tmpRoot, "pyproject.toml")],
            install: { dev: "echo install" },
            sync: "echo sync",
            modules: ".venv",
            cwd: tmpRoot,
            requires_source: false,
          },
        ],
      }),
      tmpRoot,
    );
    expect(files).toContain("pyproject.toml");
    expect(files).toContain("apps/svc/pyproject.toml");
    expect(files).toContain("packages/lib/pyproject.toml");
    expect(files).not.toContain("packages/js-only/pyproject.toml");
  });

  it("skips source-requiring PMs (their files come via the full source COPY)", () => {
    // uv-style PMs install AFTER the full source COPY, so listing their
    // files in the install-time layer would only churn the cache.
    touch("package.json", JSON.stringify({ workspaces: [] }));
    touch("apps/py/pyproject.toml");
    touch("apps/py/uv.lock");

    const files = collectInstallTimeFiles(
      svc({
        packageManagers: [
          {
            name: "uv",
            lockfile: path.join(tmpRoot, "apps/py/uv.lock"),
            manifest: [path.join(tmpRoot, "apps/py/pyproject.toml")],
            install: { dev: "uv sync" },
            sync: "uv sync",
            modules: ".venv",
            cwd: path.join(tmpRoot, "apps/py"),
            requires_source: true,
          },
        ],
      }),
      tmpRoot,
    );
    expect(files).not.toContain("apps/py/pyproject.toml");
    expect(files).not.toContain("apps/py/uv.lock");
  });

  it("supports multi-manifest PMs (e.g. pip with requirements + pyproject)", () => {
    touch("package.json", JSON.stringify({ workspaces: [] }));
    touch("apps/py/pyproject.toml");
    touch("apps/py/requirements.txt");
    touch("apps/py/requirements-dev.txt");

    const files = collectInstallTimeFiles(
      svc({
        packageManagers: [
          {
            name: "pip",
            lockfile: path.join(tmpRoot, "apps/py/requirements.txt"),
            manifest: [
              path.join(tmpRoot, "apps/py/pyproject.toml"),
              path.join(tmpRoot, "apps/py/requirements.txt"),
              path.join(tmpRoot, "apps/py/requirements-dev.txt"),
            ],
            install: { dev: "pip install -r requirements.txt" },
            sync: "pip install -r requirements.txt",
            modules: ".venv",
            cwd: path.join(tmpRoot, "apps/py"),
            requires_source: false,
          },
        ],
      }),
      tmpRoot,
    );
    expect(files).toContain("apps/py/pyproject.toml");
    expect(files).toContain("apps/py/requirements.txt");
    expect(files).toContain("apps/py/requirements-dev.txt");
  });

  it("skips files that don't exist on disk (no COPY error from missing srcs)", () => {
    touch("package.json", JSON.stringify({ workspaces: [] }));
    const files = collectInstallTimeFiles(
      svc({
        packageManagers: [
          {
            name: "bun",
            lockfile: path.join(tmpRoot, "bun.lock"), // does not exist
            manifest: [path.join(tmpRoot, "package.json")],
            install: { dev: "bun install" },
            sync: "bun install",
            modules: "node_modules",
            cwd: tmpRoot,
            requires_source: false,
          },
        ],
      }),
      tmpRoot,
    );
    expect(files).toEqual(["package.json"]);
    expect(files).not.toContain("bun.lock");
  });

  it("deduplicates when multiple PMs share files", () => {
    touch("package.json", JSON.stringify({ workspaces: [] }));
    touch("bun.lock");

    const files = collectInstallTimeFiles(
      svc({
        packageManagers: [
          {
            name: "bun",
            lockfile: path.join(tmpRoot, "bun.lock"),
            manifest: [path.join(tmpRoot, "package.json")],
            install: { dev: "bun install" },
            sync: "bun install",
            modules: "node_modules",
            cwd: tmpRoot,
            requires_source: false,
          },
          {
            name: "bun",
            lockfile: path.join(tmpRoot, "bun.lock"),
            manifest: [path.join(tmpRoot, "package.json")],
            install: { dev: "bun install --production" },
            sync: "bun install",
            modules: "node_modules",
            cwd: tmpRoot,
            requires_source: false,
          },
        ],
      }),
      tmpRoot,
    );
    expect(new Set(files).size).toBe(files.length);
  });
});

describe("groupInstallTimeFilesByDir", () => {
  it("groups one COPY per parent dir, preserves layout via dest path", () => {
    const groups = groupInstallTimeFilesByDir([
      "package.json",
      "bun.lock",
      "apps/svc/package.json",
      "apps/svc/bun.lock",
      "packages/lib/package.json",
    ]);
    expect(groups).toEqual([
      { dest: "./", files: ["bun.lock", "package.json"] },
      {
        dest: "./apps/svc/",
        files: ["apps/svc/bun.lock", "apps/svc/package.json"],
      },
      {
        dest: "./packages/lib/",
        files: ["packages/lib/package.json"],
      },
    ]);
  });

  it("returns [] for an empty input", () => {
    expect(groupInstallTimeFilesByDir([])).toEqual([]);
  });

  it("handles a single root-level file", () => {
    expect(groupInstallTimeFilesByDir(["package.json"])).toEqual([
      { dest: "./", files: ["package.json"] },
    ]);
  });
});

describe("buildCacheConfig", () => {
  it("returns {} outside CI (no cache config for local dev)", () => {
    expect(
      buildCacheConfig({
        registries: [],
        imageName: "nopo-svc",
        push: false,
        isCI: false,
      }),
    ).toEqual({});
  });

  it("returns {} in CI when no registries are declared (registry-only cache)", () => {
    /** local + gha backends were dropped: local writes to ephemeral
     * /tmp on the runner pod (destroyed on job exit), and gha is
     * throttled + redundant with the registry cache that buildkitd
     * serves over the cluster network.
     */
    expect(
      buildCacheConfig({
        registries: [],
        imageName: "svc",
        push: false,
        isCI: true,
      }),
    ).toEqual({});
  });

  it("does not emit local or gha cache backends", () => {
    const cfg = buildCacheConfig({
      registries: ["ghcr.io/me"],
      imageName: "svc",
      push: true,
      isCI: true,
    });
    const allEntries = [
      ...(cfg["cache-from"] ?? []),
      ...(cfg["cache-to"] ?? []),
    ];
    expect(allEntries.some((s) => s.startsWith("type=local"))).toBe(false);
    expect(allEntries.some((s) => s.startsWith("type=gha"))).toBe(false);
  });

  it("pulls registry cache (cache-from) per declared registry", () => {
    const cfg = buildCacheConfig({
      registries: ["ghcr.io/me", "registry.local:5000"],
      imageName: "svc",
      push: false,
      isCI: true,
    });
    expect(cfg["cache-from"]).toContain(
      "type=registry,ref=ghcr.io/me/svc:buildcache",
    );
    expect(cfg["cache-from"]).toContain(
      "type=registry,ref=registry.local:5000/svc:buildcache",
    );
  });

  it("pushes registry cache (cache-to) only when push:true", () => {
    // Without push, registry is the only backend and there's nothing to
    // write — `cache-to` is omitted entirely (no local/gha to fall back on).
    const noPush = buildCacheConfig({
      registries: ["ghcr.io/me"],
      imageName: "svc",
      push: false,
      isCI: true,
    });
    expect(noPush["cache-to"]).toBeUndefined();

    const withPush = buildCacheConfig({
      registries: ["ghcr.io/me"],
      imageName: "svc",
      push: true,
      isCI: true,
    });
    expect(withPush["cache-to"]).toEqual([
      "type=registry,ref=ghcr.io/me/svc:buildcache,mode=min,image-manifest=true,oci-mediatypes=true",
    ]);
  });

  it("exports mode=min, not mode=max", () => {
    /** max writes every intermediate layer to the registry on every push
     * build. buildkitd's hostPath cache already serves warm builds, so the
     * registry copy only has to cover a cold daemon — and min still covers
     * the final stage, where the expensive runtime COPYs live.
     */
    const cfg = buildCacheConfig({
      registries: ["ghcr.io/me"],
      imageName: "svc",
      push: true,
      isCI: true,
    });
    expect(cfg["cache-to"]?.[0]).toContain("mode=min");
    expect(cfg["cache-to"]?.[0]).not.toContain("mode=max");
  });
});

describe("generateRuntimeCopyLines", () => {
  const base = {
    serviceName: "api",
    relativeServicePath: "products/example/api",
  };

  it("omits --link on the large payloads so BuildKit skips the merge", () => {
    /** The merge hardlinks one file at a time, so its cost tracks file
     * count. On a large node_modules it measured 81.5s per build; a
     * plain COPY drops that to 0.4s.
     */
    const lines = generateRuntimeCopyLines({
      ...base,
      declaredOutputs: ["@app/node_modules", "build"],
      workspaceDepOutputs: ["@app/packages/ui"],
      manifestOutputs: [],
    });

    expect(lines).toEqual([
      "COPY --from=api-build $${APP}/node_modules $${APP}/node_modules",
      "COPY --from=api-build $${APP}/products/example/api/build $${APP}/products/example/api/build",
      "COPY --from=api-build $${APP}/packages/ui $${APP}/packages/ui",
    ]);
    expect(lines.some((l) => l.includes("--link"))).toBe(false);
  });

  it("keeps --link on the manifest fan-out", () => {
    // ~200 KB of tiny package.json files. The merge is negligible there,
    // and --link buys cache reuse across base-image changes.
    const lines = generateRuntimeCopyLines({
      ...base,
      declaredOutputs: ["@app/node_modules"],
      workspaceDepOutputs: [],
      manifestOutputs: ["@app/packages/ui/package.json", "@app/bun.lock"],
    });

    expect(lines).toEqual([
      "COPY --from=api-build $${APP}/node_modules $${APP}/node_modules",
      "COPY --link --from=api-build $${APP}/packages/ui/package.json $${APP}/packages/ui/package.json",
      "COPY --link --from=api-build $${APP}/bun.lock $${APP}/bun.lock",
    ]);
  });

  it("keeps absolute output paths verbatim", () => {
    const lines = generateRuntimeCopyLines({
      ...base,
      declaredOutputs: ["/home/nopoapp/.venv"],
      workspaceDepOutputs: [],
      manifestOutputs: [],
    });

    expect(lines).toEqual([
      "COPY --from=api-build /home/nopoapp/.venv /home/nopoapp/.venv",
    ]);
  });

  it("falls back to the whole /app and /home trees when no output is declared", () => {
    // Largest payload of all, so it skips --link for the same reason.
    const lines = generateRuntimeCopyLines({
      ...base,
      declaredOutputs: [],
      workspaceDepOutputs: ["@app/packages/ui"],
      manifestOutputs: ["@app/bun.lock"],
    });

    expect(lines).toEqual([
      "COPY --from=api-build $${APP} $${APP}",
      "COPY --from=api-build $${HOME} $${HOME}",
    ]);
  });

  it("emits large payloads before manifests so manifests win on conflict", () => {
    // Later COPYs overwrite earlier ones. The manifest fan-out must land
    // last or a stale package.json from the bulk copy would survive.
    const lines = generateRuntimeCopyLines({
      ...base,
      declaredOutputs: ["@app/node_modules"],
      workspaceDepOutputs: ["@app/packages/ui"],
      manifestOutputs: ["@app/packages/ui/package.json"],
    });

    const lastLarge = lines.findIndex((l) => l.includes("packages/ui "));
    const firstManifest = lines.findIndex((l) => l.includes("--link"));
    expect(firstManifest).toBeGreaterThan(lastLarge);
  });
});

describe("generateRuntimeInstallLines", () => {
  const phased = (overrides: Partial<PackageManagerConfig> = {}) =>
    pm({
      install: {
        dev: "bun install",
        build: "bun install --frozen-lockfile --filter './{service_dir}'",
        prod: "bun install --production --filter './{service_dir}'",
      },
      ...overrides,
    });

  it("emits nothing when prod resolves to the same command as build", () => {
    /** The fallback chain means `prod` always resolves to SOMETHING. A PM
     * that declares only a string (uv, cargo) would otherwise re-run an
     * identical install in the runtime stage — a wasted layer that changes
     * nothing on disk.
     */
    const service = makeService({
      packageManagers: [pm({ install: { dev: "uv sync --locked" } })],
    });
    expect(
      generateRuntimeInstallLines(service, ROOT_DIR, "services/svc"),
    ).toEqual([]);
  });

  it("emits nothing when only build is declared", () => {
    const service = makeService({
      packageManagers: [
        pm({ install: { dev: "bun install", build: "bun install --frozen" } }),
      ],
    });
    expect(
      generateRuntimeInstallLines(service, ROOT_DIR, "services/svc"),
    ).toEqual([]);
  });

  it("applies to every service using the PM — no per-service opt-in", () => {
    const service = makeService({ packageManagers: [phased()] });
    expect(
      generateRuntimeInstallLines(service, ROOT_DIR, "services/svc"),
    ).toHaveLength(1);
  });

  it("expands {service_dir} to the service's repo-relative path", () => {
    const service = makeService({ packageManagers: [phased()] });
    expect(
      generateRuntimeInstallLines(
        service,
        ROOT_DIR,
        "products/example/api",
      ),
    ).toEqual([
      "RUN cd $${APP} && bun install --production --filter './products/example/api'",
    ]);
  });

  it("runs at the package manager's own cwd", () => {
    const service = makeService({
      packageManagers: [phased({ cwd: `${ROOT_DIR}/nested/dir` })],
    });
    expect(generateRuntimeInstallLines(service, ROOT_DIR, "svc")).toEqual([
      "RUN cd $${APP}/nested/dir && bun install --production --filter './svc'",
    ]);
  });
});

describe("pushImageOutput", () => {
  it("pushes with zstd layers under OCI media types", () => {
    /** gzip export measured 134.6s of a 141.6s `exporting to image` step,
     * against 6.5s of actual upload. zstd cuts the compression, and
     * oci-mediatypes carries the zstd layer media type to the registry.
     */
    const output = pushImageOutput();
    expect(output).toContain("type=image");
    expect(output).toContain("push=true");
    expect(output).toContain("compression=zstd");
    expect(output).toContain("oci-mediatypes=true");
  });

  it("leaves force-compression off so warm gzip layers are reused", () => {
    // With force-compression=true every cached gzip layer gets rewritten
    // as zstd on the next build — paying the cost this change removes.
    expect(pushImageOutput()).not.toContain("force-compression");
  });
});
