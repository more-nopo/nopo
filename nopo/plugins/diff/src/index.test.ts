import type { NormalizedService } from "@more-nopo/nopo/config";
import { describe, expect, it } from "vitest";

import type { DiffPluginConfig } from "./index.ts";
import { classifyServiceFiles, getServiceDiffConfig } from "./index.ts";

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
    buildDeps: [],
    runtimeDeps: [],
    systemDeps: [],
    commands: {},
    paths: { root: "/project/test-service", context: "/project" },
    pluginData: undefined,
    packageManagers: [],
    ...overrides,
  } as unknown as NormalizedService;
}

describe("getServiceDiffConfig", () => {
  it("returns empty record when pluginData is missing", () => {
    expect(getServiceDiffConfig(makeService())).toEqual({});
  });

  it("returns empty record when pluginData.diff is missing", () => {
    const service = makeService({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test fixture
      pluginData: { other: { foo: "bar" } } as Record<string, unknown>,
    });
    expect(getServiceDiffConfig(service)).toEqual({});
  });

  it("extracts groups → globs from pluginData.diff", () => {
    const service = makeService({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test fixture
      pluginData: {
        diff: {
          migrations: ["drizzle/**", "drizzle.config.ts"],
          configs: ["tsconfig.json"],
        },
      } as Record<string, unknown>,
    });
    expect(getServiceDiffConfig(service)).toEqual({
      migrations: ["drizzle/**", "drizzle.config.ts"],
      configs: ["tsconfig.json"],
    });
  });

  it("ignores non-array values", () => {
    const service = makeService({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test fixture
      pluginData: {
        diff: {
          migrations: ["drizzle/**"],
          bogus: "not-an-array",
          numeric: 42,
          nested: { foo: ["bar"] },
        },
      } as Record<string, unknown>,
    });
    expect(getServiceDiffConfig(service)).toEqual({
      migrations: ["drizzle/**"],
    });
  });

  it("ignores arrays containing non-string entries", () => {
    const service = makeService({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test fixture
      pluginData: {
        diff: {
          ok: ["a", "b"],
          mixed: ["a", 1, "b"],
          objects: [{ glob: "x" }],
        },
      } as Record<string, unknown>,
    });
    expect(getServiceDiffConfig(service)).toEqual({ ok: ["a", "b"] });
  });
});

describe("classifyServiceFiles", () => {
  const groups: DiffPluginConfig = {
    migrations: ["drizzle/**", "drizzle.config.ts", "src/db/schema.ts"],
    application: ["src/**"],
  };
  const serviceRel = "products/example/api";

  describe("no filters", () => {
    it("emits every declared group plus `other`", () => {
      const result = classifyServiceFiles([], groups, serviceRel, [], []);
      expect(Object.keys(result.groups).sort()).toEqual([
        "application",
        "migrations",
        "other",
      ]);
    });

    it("buckets files into the matching group", () => {
      const files = [
        "drizzle/0042_add_x/migration.sql",
        "drizzle.config.ts",
        "src/handlers/auth.ts",
        "package.json",
      ];
      const result = classifyServiceFiles(files, groups, serviceRel, [], []);
      expect(result.groups.migrations).toEqual({
        changed: true,
        files: [
          `${serviceRel}/drizzle/0042_add_x/migration.sql`,
          `${serviceRel}/drizzle.config.ts`,
        ],
      });
      expect(result.groups.application).toEqual({
        changed: true,
        files: [`${serviceRel}/src/handlers/auth.ts`],
      });
      expect(result.groups.other).toEqual({
        changed: true,
        files: [`${serviceRel}/package.json`],
      });
    });

    it("a file matching multiple groups appears in each (overlap is allowed)", () => {
      // src/db/schema.ts matches both migrations and application
      const overlapping: DiffPluginConfig = {
        migrations: ["src/db/schema.ts"],
        application: ["src/**"],
      };
      const result = classifyServiceFiles(
        ["src/db/schema.ts"],
        overlapping,
        serviceRel,
        [],
        [],
      );
      expect(result.groups.migrations.changed).toBe(true);
      expect(result.groups.application.changed).toBe(true);
      // `other` excludes any file that matched at least one declared group
      expect(result.groups.other.changed).toBe(false);
    });

    it("`other` is empty when every file matches a declared group", () => {
      const result = classifyServiceFiles(
        ["drizzle/x.sql", "src/server.ts"],
        groups,
        serviceRel,
        [],
        [],
      );
      expect(result.groups.other).toEqual({ changed: false, files: [] });
    });

    it("all groups report changed=false when nothing changed", () => {
      const result = classifyServiceFiles([], groups, serviceRel, [], []);
      for (const group of Object.values(result.groups)) {
        expect(group.changed).toBe(false);
        expect(group.files).toEqual([]);
      }
    });
  });

  describe("--include only", () => {
    it("emits only the requested groups", () => {
      const result = classifyServiceFiles(
        ["drizzle/x.sql", "src/y.ts", "package.json"],
        groups,
        serviceRel,
        ["migrations"],
        [],
      );
      expect(Object.keys(result.groups)).toEqual(["migrations"]);
      expect(result.groups.migrations.changed).toBe(true);
    });

    it("silently drops unknown group names", () => {
      const result = classifyServiceFiles(
        ["drizzle/x.sql"],
        groups,
        serviceRel,
        ["migrations", "doesnotexist"],
        [],
      );
      expect(Object.keys(result.groups)).toEqual(["migrations"]);
    });

    it("does not emit `other`", () => {
      const result = classifyServiceFiles(
        ["package.json"],
        groups,
        serviceRel,
        ["migrations"],
        [],
      );
      expect(result.groups.other).toBeUndefined();
    });
  });

  describe("--exclude only", () => {
    it("emits a synthetic not_<name> group containing the complement", () => {
      const files = ["drizzle/x.sql", "src/y.ts", "package.json"];
      const result = classifyServiceFiles(
        files,
        groups,
        serviceRel,
        [],
        ["migrations"],
      );
      expect(Object.keys(result.groups)).toEqual(["not_migrations"]);
      expect(result.groups.not_migrations).toEqual({
        changed: true,
        files: [`${serviceRel}/src/y.ts`, `${serviceRel}/package.json`],
      });
    });

    it("emits the positive group as changed=false when no migration files changed", () => {
      const result = classifyServiceFiles(
        ["src/y.ts"],
        groups,
        serviceRel,
        [],
        ["migrations"],
      );
      expect(result.groups.not_migrations.changed).toBe(true);
    });

    it("silently drops unknown excluded group names", () => {
      const result = classifyServiceFiles(
        ["src/y.ts"],
        groups,
        serviceRel,
        [],
        ["migrations", "doesnotexist"],
      );
      expect(Object.keys(result.groups)).toEqual(["not_migrations"]);
    });

    it("does not emit `other`", () => {
      const result = classifyServiceFiles(
        ["package.json"],
        groups,
        serviceRel,
        [],
        ["migrations"],
      );
      expect(result.groups.other).toBeUndefined();
    });
  });

  describe("--include + --exclude together", () => {
    it("emits both positive and synthetic groups (CI's standard usage)", () => {
      const files = ["drizzle/x.sql", "src/y.ts"];
      const result = classifyServiceFiles(
        files,
        groups,
        serviceRel,
        ["migrations"],
        ["migrations"],
      );
      expect(Object.keys(result.groups).sort()).toEqual([
        "migrations",
        "not_migrations",
      ]);
      expect(result.groups.migrations).toEqual({
        changed: true,
        files: [`${serviceRel}/drizzle/x.sql`],
      });
      expect(result.groups.not_migrations).toEqual({
        changed: true,
        files: [`${serviceRel}/src/y.ts`],
      });
    });

    it("the schema/code/mixed CI policy reads cleanly off the output", () => {
      const onlyMigration = classifyServiceFiles(
        ["drizzle/x.sql"],
        groups,
        serviceRel,
        ["migrations"],
        ["migrations"],
      );
      expect(onlyMigration.groups.migrations.changed).toBe(true);
      expect(onlyMigration.groups.not_migrations.changed).toBe(false);
      // → CI calls this "schema"

      const onlyCode = classifyServiceFiles(
        ["src/y.ts"],
        groups,
        serviceRel,
        ["migrations"],
        ["migrations"],
      );
      expect(onlyCode.groups.migrations.changed).toBe(false);
      expect(onlyCode.groups.not_migrations.changed).toBe(true);
      // → CI calls this "code"

      const mixed = classifyServiceFiles(
        ["drizzle/x.sql", "src/y.ts"],
        groups,
        serviceRel,
        ["migrations"],
        ["migrations"],
      );
      expect(mixed.groups.migrations.changed).toBe(true);
      expect(mixed.groups.not_migrations.changed).toBe(true);
      // → CI calls this "mixed"

      const nothing = classifyServiceFiles(
        [],
        groups,
        serviceRel,
        ["migrations"],
        ["migrations"],
      );
      expect(nothing.groups.migrations.changed).toBe(false);
      expect(nothing.groups.not_migrations.changed).toBe(false);
      // → CI defaults this to "code" (empty PR or doc-only)
    });
  });

  describe("globs", () => {
    it("`**` matches recursively", () => {
      const result = classifyServiceFiles(
        ["drizzle/a.sql", "drizzle/2026/foo/bar.sql"],
        { migrations: ["drizzle/**"] },
        serviceRel,
        ["migrations"],
        [],
      );
      expect(result.groups.migrations.files).toHaveLength(2);
    });

    it("specific file path matches exactly", () => {
      const result = classifyServiceFiles(
        ["drizzle.config.ts", "drizzle.config.bak.ts"],
        { migrations: ["drizzle.config.ts"] },
        serviceRel,
        ["migrations"],
        [],
      );
      expect(result.groups.migrations.files).toEqual([
        `${serviceRel}/drizzle.config.ts`,
      ]);
    });

    it("dot-prefixed files are matched (dot:true is the picomatch default we set)", () => {
      const result = classifyServiceFiles(
        [".env.schema", "src/.hidden/file.ts"],
        { configs: [".env.*"], application: ["src/**"] },
        serviceRel,
        [],
        [],
      );
      expect(result.groups.configs.changed).toBe(true);
      expect(result.groups.application.changed).toBe(true);
    });

    it("Django-style numbered migration glob", () => {
      const djangoGroups: DiffPluginConfig = {
        migrations: ["src/backend/*/migrations/[0-9]*.py"],
      };
      const files = [
        "src/backend/todo/migrations/0001_initial.py",
        "src/backend/todo/migrations/0042_add_x.py",
        "src/backend/todo/migrations/__init__.py",
        "src/backend/todo/views.py",
      ];
      const result = classifyServiceFiles(
        files,
        djangoGroups,
        serviceRel,
        ["migrations"],
        ["migrations"],
      );
      expect(result.groups.migrations.files).toEqual([
        `${serviceRel}/src/backend/todo/migrations/0001_initial.py`,
        `${serviceRel}/src/backend/todo/migrations/0042_add_x.py`,
      ]);
      expect(result.groups.not_migrations.files).toEqual([
        `${serviceRel}/src/backend/todo/migrations/__init__.py`,
        `${serviceRel}/src/backend/todo/views.py`,
      ]);
    });
  });

  describe("path joining", () => {
    it("joins with posix separators regardless of host", () => {
      const result = classifyServiceFiles(
        ["drizzle/x.sql"],
        { migrations: ["drizzle/**"] },
        "products/example/api",
        ["migrations"],
        [],
      );
      expect(result.groups.migrations.files[0]).toBe(
        "products/example/api/drizzle/x.sql",
      );
      expect(result.groups.migrations.files[0]!.includes("\\")).toBe(false);
    });
  });
});
