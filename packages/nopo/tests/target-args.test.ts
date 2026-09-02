import { describe, expect, it } from "vitest";

import type { NormalizedService } from "../src/config/index.ts";
import { parseTargetArgs, validateTargets } from "../src/target-args.ts";

function minimalServiceWithTags(tags: string[]): NormalizedService {
  return {
    id: "x",
    name: "x",
    description: "",
    staticPath: "",
    tags: [...tags],
    secrets: [],
    type: "service",
    configPath: "/nopo.yml",
    buildDeps: [],
    runtimeDeps: [],
    systemDeps: [],
    commands: {},
    paths: { root: "/", context: "/" },
    packageManagers: [],
  };
}

describe("parseTargetArgs", () => {
  const availableTargets = ["backend", "web", "api"];

  it("parses targets from positionals", () => {
    const argv = ["backend", "web"];
    const result = parseTargetArgs("build", argv, availableTargets);

    expect(result.targets).toEqual(["backend", "web"]);
    expect(result.leadingArgs).toEqual([]);
    expect(result.options).toEqual({});
  });

  it("returns empty targets when none specified", () => {
    const argv: string[] = [];
    const result = parseTargetArgs("build", argv, availableTargets);

    expect(result.targets).toEqual([]);
    expect(result.leadingArgs).toEqual([]);
    expect(result.options).toEqual({});
  });

  it("handles leadingPositionals option for run command", () => {
    const argv = ["test", "backend", "web"];
    const result = parseTargetArgs("run", argv, availableTargets, {
      leadingPositionals: 1,
    });

    expect(result.leadingArgs).toEqual(["test"]);
    expect(result.targets).toEqual(["backend", "web"]);
  });

  it("validates targets against available list", () => {
    const argv = ["backend", "invalid"];
    expect(() => {
      parseTargetArgs("build", argv, availableTargets);
    }).toThrow("Unknown target 'invalid'");
  });

  it("throws for unknown target names", () => {
    const argv = ["unknown-service"];
    expect(() => {
      parseTargetArgs("build", argv, availableTargets);
    }).toThrow("Unknown target 'unknown-service'");
  });

  it("handles options mixed with targets", () => {
    const argv = ["backend", "--no-cache", "web", "--output", "build.json"];
    const result = parseTargetArgs("build", argv, availableTargets, {
      boolean: ["no-cache"],
      string: ["output"],
    });

    expect(result.targets).toEqual(["backend", "web"]);
    expect(result.options["no-cache"]).toBe(true);
    expect(result.options["output"]).toBe("build.json");
  });

  it("handles case-insensitive targets", () => {
    const argv = ["BACKEND", "Web"];
    const result = parseTargetArgs("build", argv, availableTargets);

    expect(result.targets).toEqual(["backend", "web"]);
  });

  it("handles multiple unknown targets in error message", () => {
    const argv = ["unknown1", "unknown2"];
    expect(() => {
      parseTargetArgs("build", argv, availableTargets);
    }).toThrow("Unknown targets 'unknown1', 'unknown2'");
  });

  describe("--tags filter", () => {
    const servicesWithTags: Record<string, NormalizedService> = {
      backend: minimalServiceWithTags([]),
      web: minimalServiceWithTags(["github-actions", "frontend"]),
      api: minimalServiceWithTags(["github-actions"]),
    };
    const availableTargetsWithTags = ["backend", "web", "api"];
    const projectRoot = "/project";

    it("filters to targets that have any of the requested tags", () => {
      const argv = ["--tags", "github-actions"];
      const result = parseTargetArgs("build", argv, availableTargetsWithTags, {
        supportsFilter: true,
        services: servicesWithTags,
        projectRoot,
      });

      expect(result.targets).toContain("web");
      expect(result.targets).toContain("api");
      expect(result.targets).not.toContain("backend");
      expect(result.targets).toHaveLength(2);
    });

    it("with comma-separated tags matches any tag", () => {
      const argv = ["--tags", "frontend,github-actions"];
      const result = parseTargetArgs("build", argv, availableTargetsWithTags, {
        supportsFilter: true,
        services: servicesWithTags,
        projectRoot,
      });

      expect(result.targets).toContain("web");
      expect(result.targets).toContain("api");
      expect(result.targets).not.toContain("backend");
    });

    it("throws when --tags is empty", () => {
      const argv = ["--tags", ""];
      expect(() => {
        parseTargetArgs("build", argv, availableTargetsWithTags, {
          supportsFilter: true,
          services: servicesWithTags,
          projectRoot,
        });
      }).toThrow("--tags requires at least one non-empty tag");
    });

    it("excludes explicit targets that do not have the tag", () => {
      const argv = ["backend", "web", "--tags", "github-actions"];
      const result = parseTargetArgs("build", argv, availableTargetsWithTags, {
        supportsFilter: true,
        services: servicesWithTags,
        projectRoot,
      });

      expect(result.targets).toEqual(["web"]);
    });
  });
});

describe("validateTargets", () => {
  const availableTargets = ["backend", "web", "api"];

  it("passes validation for valid targets", () => {
    expect(() => {
      validateTargets(["backend", "web"], availableTargets);
    }).not.toThrow();
  });

  it("throws for unknown targets", () => {
    expect(() => {
      validateTargets(["unknown"], availableTargets);
    }).toThrow("Unknown target 'unknown'");
  });

  it("throws for multiple unknown targets", () => {
    expect(() => {
      validateTargets(["unknown1", "unknown2"], availableTargets);
    }).toThrow("Unknown targets 'unknown1', 'unknown2'");
  });

  it("handles empty target list", () => {
    expect(() => {
      validateTargets([], availableTargets);
    }).not.toThrow();
  });
});
