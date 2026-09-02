import type { NormalizedService } from "./config/index.ts";

type DepType = "build" | "runtime" | "all";

/** Get the concrete dependency list for forward walks: "what do I need to start / build /
 * run?". Used by `withDependencies` and `withTransitiveDependencies`. Returns only real
 * build/runtime edges — `systemDeps` are deliberately NOT included here, because they
 * aren't things a service literally needs at startup or build
 */
function getDeps(service: NormalizedService, depType: DepType): string[] {
  switch (depType) {
    case "build":
      return service.buildDeps;
    case "runtime":
      return service.runtimeDeps;
    case "all":
      return [...new Set([...service.buildDeps, ...service.runtimeDeps])];
  }
}

/** Get the dependency list for the reverse walk: "who is affected when I change?". Used by
 * `withDependants`. INCLUDES `systemDeps` because the whole point of system_deps is
 * change-cascade — a change to nopo or root should propagate to every consumer for
 * `--changed with-dependants` discovery.
 */
function getDepsForDependantsWalk(
  service: NormalizedService,
  depType: DepType,
): string[] {
  return [...new Set([...getDeps(service, depType), ...service.systemDeps])];
}

/**
 * Build a reverse-dependency lookup: for each service, which services depend on it.
 */
function buildDependantsMap(
  entries: Record<string, NormalizedService>,
  depType: DepType = "all",
): Map<string, string[]> {
  const dependants = new Map<string, string[]>();

  for (const [id, service] of Object.entries(entries)) {
    for (const dep of getDepsForDependantsWalk(service, depType)) {
      let list = dependants.get(dep);
      if (!list) {
        list = [];
        dependants.set(dep, list);
      }
      list.push(id);
    }
  }

  return dependants;
}

/** Expand a filtered set of services to include their transitive dependencies (dependencies
 * of dependencies, etc.). This mirrors build/test execution requirements: if A depends on
 * B and B depends on C, selecting A should also include C.
 */
export function withDependencies(
  filteredServices: string[],
  entries: Record<string, NormalizedService>,
  allServices: string[],
  depType: DepType = "all",
): string[] {
  const allSet = new Set(allServices);
  const result = new Set(filteredServices);

  // BFS to include all transitive dependencies.
  const queue = [...filteredServices];
  while (queue.length > 0) {
    const serviceName = queue.shift()!;
    const service = entries[serviceName];
    if (!service) continue;

    for (const dep of getDeps(service, depType)) {
      if (allSet.has(dep) && !result.has(dep)) {
        result.add(dep);
        queue.push(dep);
      }
    }
  }

  return allServices.filter((s) => result.has(s));
}

/** Expand a set of services to include their transitive dependencies (services they depend
 * on, and services those depend on, etc.). This is the downward graph walk — if web
 * depends on api and api depends on db, expanding web yields [web, api,
 * db].
 */
export function withTransitiveDependencies(
  filteredServices: string[],
  entries: Record<string, NormalizedService>,
  allServices: string[],
  depType: DepType = "all",
): string[] {
  const allSet = new Set(allServices);
  const result = new Set(filteredServices);

  // BFS to find all transitive dependencies
  const queue = [...filteredServices];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const service = entries[current];
    if (!service) continue;

    for (const dep of getDeps(service, depType)) {
      if (allSet.has(dep) && !result.has(dep)) {
        result.add(dep);
        queue.push(dep);
      }
    }
  }

  return allServices.filter((s) => result.has(s));
}

/** Expand a filtered set of services to include their transitive dependants (services that
 * depend on them, and services that depend on those, etc.). Transitive on the dependant
 * path because a change at the bottom can ripple up through the entire consumer chain. If
 * banana changed and ui depends on banana and web depends on ui, web
 */
export function withDependants(
  filteredServices: string[],
  entries: Record<string, NormalizedService>,
  allServices: string[],
  depType: DepType = "all",
): string[] {
  const allSet = new Set(allServices);
  const result = new Set(filteredServices);
  const dependantsMap = buildDependantsMap(entries, depType);

  // BFS to find all transitive dependants
  const queue = [...filteredServices];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const dependants = dependantsMap.get(current);
    if (!dependants) continue;

    for (const dep of dependants) {
      if (allSet.has(dep) && !result.has(dep)) {
        result.add(dep);
        queue.push(dep);
      }
    }
  }

  return allServices.filter((s) => result.has(s));
}
