/** Service-discovery env vars: `SVC_<DEP>_HOST` and `SVC_<DEP>_PORT`. This is a core
 * runtime feature, not a plugin concern: nopo's dependency graph already knows what each
 * service depends on and what port each dep listens on. Exposing that as env vars gives
 * services a stable way to declare their own URL requirements in their own `nopo.yml`
 */

import type { NormalizedProjectConfig } from "./config/index.ts";
import { resolveRuntime } from "./config/index.ts";

const DEFAULT_PROCESS_NAME = "default";

/** One process-instance, addressable by its DNS name. */
export interface ServiceInstance {
  /** For single-process services this equals the service id; for multi-process, the `default`
   * process keeps the bare service id and other processes are suffixed
   * `${serviceId}-${processName}`.
   */
  host: string;
  /** Port the process listens on, or `undefined` for port-less workers. */
  port?: number;
}

/** Map of `instanceId → ServiceInstance` covering every process across the project. */
export type ServiceRegistry = Map<string, ServiceInstance>;

/**
 * Stable instance id for a `(serviceId, processName)` pair. Mirrors the
 * `deploymentName` (terraform) and `composeServiceName` (compose) helpers
 * so cross-references resolve to the same DNS name.
 */
export function instanceId(serviceId: string, processName: string): string {
  return processName === DEFAULT_PROCESS_NAME
    ? serviceId
    : `${serviceId}-${processName}`;
}

/** Plugins supply the iterator because process expansion + dev-mode port overrides are
 * plugin-specific (terraform forces port 80 for built services in dev mode; compose
 * mirrors that via `DOCKER_TARGET=development`).
 */
export function buildServiceRegistry(
  processes: Iterable<{
    serviceId: string;
    processName: string;
    port: number | undefined;
  }>,
): ServiceRegistry {
  const registry: ServiceRegistry = new Map();
  for (const { serviceId, processName, port } of processes) {
    const id = instanceId(serviceId, processName);
    registry.set(id, { host: id, port });
  }
  return registry;
}

/** Convert a service id to its SVC env-var infix (dashes → underscores, upper). */
export function serviceEnvKey(serviceId: string): string {
  return serviceId.replaceAll("-", "_").toUpperCase();
}

/** Today the only knob is the dev-mode port collapse for built services (legacy dev CMDs
 * bake `:80` instead of honouring `${PORT}`); when every dev CMD is updated to honour PORT
 * the option can disappear. TODO(deploy-gap): drop `devCollapseToPort80` once the dev CMDs
 * and healthchecks across the repo all honour `${PORT}`. See the matching comment
 */
interface ServiceRegistryOptions {
  /** If true and a service has a `build:` block, override its declared port to 80 in the
   * registry. Mirrors the same dev-mode hack in the terraform plugin so SVC_*_PORT matches
   * the port the container actually listens on.
   */
  devCollapseToPort80?: boolean;
}

/** Build the project-wide ServiceRegistry for a given runtime overlay. Walks every service
 * in the project, expands its processes, and resolves each port through
 * `resolveRuntime(svc.runtimes, runtimeName)` so the registry matches what the plugins
 * will actually deploy. Plugins call this once per `nopo up` / `nopo deploy` invocation;
 */
export function projectServiceRegistry(
  project: NormalizedProjectConfig,
  runtimeName: string,
  options: ServiceRegistryOptions = {},
): ServiceRegistry {
  const processes: {
    serviceId: string;
    processName: string;
    port: number | undefined;
  }[] = [];
  for (const [serviceId, svc] of Object.entries(project.services.entries)) {
    if (!svc.runtimes) continue;
    const overlay = resolveRuntime(svc.runtimes, runtimeName);
    // Multi-process services expand their processes block; single-process
    // services synthesize a `default` process with the service-level port.
    const procEntries: { name: string; port: number | undefined }[] =
      svc.runtime?.processes && Object.keys(svc.runtime.processes).length > 0
        ? Object.values(svc.runtime.processes).map((p) => ({
            name: p.name,
            port: p.port,
          }))
        : [{ name: DEFAULT_PROCESS_NAME, port: overlay.port }];
    for (const proc of procEntries) {
      const port =
        options.devCollapseToPort80 && svc.build && proc.port !== undefined
          ? 80
          : proc.port;
      processes.push({
        serviceId,
        processName: proc.name,
        port,
      });
    }
  }
  return buildServiceRegistry(processes);
}

/** Build `SVC_<DEP>_HOST` / `SVC_<DEP>_PORT` env vars for a service's deps. Deps not in the
 * registry (typo, removed service) are silently skipped — the consumer will see empty
 * `${SVC_FOO_HOST}` substitutions when they try to use them, which surfaces the misconfig
 * at the right layer.
 */
export function svcDepEnvVars(
  deps: readonly string[],
  registry: ServiceRegistry,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const depId of deps) {
    const inst = registry.get(depId);
    if (!inst) continue;
    const key = serviceEnvKey(depId);
    env[`SVC_${key}_HOST`] = inst.host;
    if (inst.port !== undefined) {
      env[`SVC_${key}_PORT`] = String(inst.port);
    }
  }
  return env;
}
