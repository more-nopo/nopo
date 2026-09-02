import { describe, expect, it } from "vitest";

import type { NormalizedService } from "../src/config/index.ts";
import {
  withDependants,
  withDependencies,
  withTransitiveDependencies,
} from "../src/dependency-graph.ts";

/**
 * Make a minimal NormalizedService stub for graph tests. Only the fields
 * the dependency-graph walker reads are populated — buildDeps,
 * runtimeDeps, systemDeps, plus identity.
 */
function svc(
  id: string,
  partial: {
    buildDeps?: string[];
    runtimeDeps?: string[];
    systemDeps?: string[];
  } = {},
): NormalizedService {
  return {
    id,
    name: id,
    description: "",
    staticPath: "",
    tags: [],
    secrets: [],
    env: undefined,
    type: "service",
    build: undefined,
    runtime: undefined,
    runtimes: undefined,
    configPath: `/project/${id}/nopo.yml`,
    image: undefined,
    buildDeps: partial.buildDeps ?? [],
    runtimeDeps: partial.runtimeDeps ?? [],
    systemDeps: partial.systemDeps ?? [],
    commands: {},
    paths: { root: `/project/${id}`, context: "/project" },
    pluginData: undefined,
    packageManagers: [],
  };
}

describe("dependency-graph systemDeps semantics", () => {
  // Setup mirrors the real-world shape the bug exposed: nginx is a service, nopo + root
  // are project-level system deps that other services inherit but are NOT runnable
  const entries: Record<string, NormalizedService> = {
    nopo: svc("nopo"),
    root: svc("root"),
    db: svc("db"),
    "nginx": svc("nginx", {
      runtimeDeps: ["api"],
      systemDeps: ["nopo", "root"],
    }),
    "api": svc("api", {
      runtimeDeps: ["db"],
      systemDeps: ["nopo", "root"],
    }),
  };
  const all = Object.keys(entries);

  it("withDependencies (forward walk: 'what do I need?') ignores systemDeps", () => {
    // nginx needs api, which needs db. nopo + root are NOT
    // required to start nginx — they're discovery-only edges.
    const result = withDependencies(["nginx"], entries, all);
    expect(result.sort()).toEqual(["api", "db", "nginx"]);
    expect(result).not.toContain("nopo");
    expect(result).not.toContain("root");
  });

  it("withTransitiveDependencies forward walk also ignores systemDeps", () => {
    const result = withTransitiveDependencies(["nginx"], entries, all);
    expect(result.sort()).toEqual(["api", "db", "nginx"]);
    expect(result).not.toContain("nopo");
    expect(result).not.toContain("root");
  });

  it("withDependants (reverse walk: 'who is affected by my change?') DOES cascade through systemDeps", () => {
    // A change to nopo affects every service that lists it as a system dep. This is the whole
    // point of the field — change-detection discovery (`--changed --with-dependants`).
    const result = withDependants(["nopo"], entries, all);
    expect(result.sort()).toEqual(["api", "nginx", "nopo"]);
  });

  it("withDependants cascades through systemDeps even when the dep is not a runtime/build dep anywhere", () => {
    // Without systemDeps it would have zero dependants. With systemDeps wired into the reverse
    // walk, every consumer surfaces.
    const result = withDependants(["root"], entries, all);
    expect(result.sort()).toEqual(["api", "nginx", "root"]);
  });

  it("withDependants on a regular service walks normal runtime/build edges transitively", () => {
    // The reverse walk should reach nginx via that chain regardless of systemDeps wiring.
    const result = withDependants(["db"], entries, all);
    expect(result.sort()).toEqual(["api", "db", "nginx"]);
  });

  it("withDependants does NOT cascade through root when root is not a systemDep", () => {
    // which combined with filter.ts's `serviceRoot === ""` catch-all (marks root changed on
    // EVERY PR with any file edit) made `--changed --with-dependants` fan out to every service
    const entriesWithoutRootSystemDep: Record<string, NormalizedService> = {
      nopo: svc("nopo"),
      root: svc("root"),
      db: svc("db"),
      "nginx": svc("nginx", {
        runtimeDeps: ["api"],
        systemDeps: ["nopo"],
      }),
      "api": svc("api", {
        runtimeDeps: ["db"],
        systemDeps: ["nopo"],
      }),
    };
    const allEntries = Object.keys(entriesWithoutRootSystemDep);
    const result = withDependants(
      ["root"],
      entriesWithoutRootSystemDep,
      allEntries,
    );
    expect(result).toEqual(["root"]);
  });
});
