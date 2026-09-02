import { describe, expect, it } from "vitest";

import type {
  NormalizedProjectConfig,
  NormalizedService,
} from "../src/config/index.ts";
import {
  buildServiceRegistry,
  instanceId,
  projectServiceRegistry,
  serviceEnvKey,
  svcDepEnvVars,
} from "../src/svc-env.ts";

// Minimal NormalizedService shape that satisfies the registry walk. We don't need the full
// type — only the fields read by `projectServiceRegistry`.
function svc(opts: {
  build?: boolean;
  port?: number;
  processes?: { name: string; port: number | undefined }[];
}): NormalizedService {
  const overlay = {
    cpu: "1",
    memory: "256Mi",
    port: opts.port ?? 3000,
    deps: [],
    envs: { env: {}, secrets: {} },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial mock
  return {
    runtimes: { default: overlay },
    runtime: opts.processes
      ? {
          processes: Object.fromEntries(
            opts.processes.map((p) => [
              p.name,
              {
                name: p.name,
                cpu: "1",
                memory: "256Mi",
                port: p.port,
                minInstances: 1,
                maxInstances: 1,
                deps: [],
              },
            ]),
          ),
          port: opts.port ?? 3000,
          cpu: "1",
          memory: "256Mi",
          deps: [],
        }
      : { port: opts.port ?? 3000, cpu: "1", memory: "256Mi", deps: [] },
    build: opts.build ? { command: "build", deps: [] } : undefined,
  } as unknown as NormalizedService;
}

function project(
  services: Record<string, NormalizedService>,
): NormalizedProjectConfig {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- partial mock for registry walk
  return {
    services: { entries: services },
  } as unknown as NormalizedProjectConfig;
}

describe("instanceId", () => {
  it("returns bare service id for the default process", () => {
    expect(instanceId("web", "default")).toBe("web");
    expect(instanceId("api", "default")).toBe("api");
  });

  it("suffixes named processes with -<name>", () => {
    expect(instanceId("api", "web")).toBe("api-web");
    expect(instanceId("api", "worker")).toBe("api-worker");
  });
});

describe("serviceEnvKey", () => {
  it("upper-snake-cases the service id", () => {
    expect(serviceEnvKey("web")).toBe("WEB");
    expect(serviceEnvKey("api-web")).toBe("API_WEB");
    expect(serviceEnvKey("otel-collector")).toBe("OTEL_COLLECTOR");
  });
});

describe("buildServiceRegistry", () => {
  it("registers each (serviceId, processName) under its instance id", () => {
    const reg = buildServiceRegistry([
      { serviceId: "web", processName: "default", port: 3000 },
      { serviceId: "api", processName: "web", port: 3001 },
      { serviceId: "api", processName: "admin", port: 3002 },
      { serviceId: "api", processName: "worker", port: undefined },
    ]);
    expect(reg.get("web")).toEqual({ host: "web", port: 3000 });
    expect(reg.get("api-web")).toEqual({ host: "api-web", port: 3001 });
    expect(reg.get("api-admin")).toEqual({
      host: "api-admin",
      port: 3002,
    });
    expect(reg.get("api-worker")).toEqual({
      host: "api-worker",
      port: undefined,
    });
  });
});

describe("svcDepEnvVars", () => {
  const registry = buildServiceRegistry([
    { serviceId: "web", processName: "default", port: 3000 },
    { serviceId: "backend", processName: "default", port: 3000 },
    { serviceId: "api", processName: "web", port: 3001 },
    { serviceId: "api", processName: "admin", port: 3002 },
    { serviceId: "api", processName: "worker", port: undefined },
  ]);

  it("emits SVC_<DEP>_HOST and SVC_<DEP>_PORT for port-bearing deps", () => {
    expect(svcDepEnvVars(["web", "backend"], registry)).toEqual({
      SVC_WEB_HOST: "web",
      SVC_WEB_PORT: "3000",
      SVC_BACKEND_HOST: "backend",
      SVC_BACKEND_PORT: "3000",
    });
  });

  it("converts dashes to underscores for multi-process dep ids", () => {
    expect(svcDepEnvVars(["api-web", "api-admin"], registry)).toEqual({
      SVC_API_WEB_HOST: "api-web",
      SVC_API_WEB_PORT: "3001",
      SVC_API_ADMIN_HOST: "api-admin",
      SVC_API_ADMIN_PORT: "3002",
    });
  });

  it("omits SVC_*_PORT for port-less processes (workers)", () => {
    expect(svcDepEnvVars(["api-worker"], registry)).toEqual({
      SVC_API_WORKER_HOST: "api-worker",
    });
  });

  it("silently skips deps that aren't in the registry", () => {
    // A deleted/renamed dep should not throw; the consumer sees an empty
    // ${SVC_GONE_HOST} substitution and fails fast at use-time.
    expect(svcDepEnvVars(["gone"], registry)).toEqual({});
  });

  it("returns an empty object when there are no deps", () => {
    expect(svcDepEnvVars([], registry)).toEqual({});
  });
});

describe("projectServiceRegistry", () => {
  it("registers single-process services under the bare service id", () => {
    const reg = projectServiceRegistry(
      project({
        web: svc({ port: 3000, build: true }),
        backend: svc({ port: 3000, build: true }),
      }),
      "default",
    );
    expect(reg.get("web")).toEqual({ host: "web", port: 3000 });
    expect(reg.get("backend")).toEqual({ host: "backend", port: 3000 });
  });

  it("registers each process of a multi-process service under its instance id", () => {
    const reg = projectServiceRegistry(
      project({
        "api": svc({
          build: true,
          processes: [
            { name: "web", port: 3001 },
            { name: "admin", port: 3002 },
            { name: "worker", port: undefined },
          ],
        }),
      }),
      "default",
    );
    expect(reg.get("api-web")).toEqual({ host: "api-web", port: 3001 });
    expect(reg.get("api-admin")).toEqual({
      host: "api-admin",
      port: 3002,
    });
    expect(reg.get("api-worker")).toEqual({
      host: "api-worker",
      port: undefined,
    });
  });

  it("collapses built services to port 80 when devCollapseToPort80 is set", () => {
    // Mirrors the terraform plugin's dev-mode hack: built service CMDs bake :80, regardless of
    // the declared runtime.port. Infra services (no `build:`, e.g. grafana) keep their
    const reg = projectServiceRegistry(
      project({
        web: svc({ port: 3000, build: true }),
        grafana: svc({ port: 3000, build: false }),
      }),
      "default",
      { devCollapseToPort80: true },
    );
    expect(reg.get("web")).toEqual({ host: "web", port: 80 });
    expect(reg.get("grafana")).toEqual({ host: "grafana", port: 3000 });
  });

  it("end-to-end: nginx-style service derives URLs from svcDepEnvVars", () => {
    // Repro of the original example-nginx bug — the assembled URL must resolve to the dep's
    // actual deployment name + port without any service-specific code in the plugin.
    const reg = projectServiceRegistry(
      project({
        "example-nginx": svc({ port: 80, build: true }),
        web: svc({ port: 3000, build: true }),
        backend: svc({ port: 3000, build: true }),
      }),
      "default",
    );
    const env = svcDepEnvVars(["web", "backend"], reg);
    expect(env).toEqual({
      SVC_WEB_HOST: "web",
      SVC_WEB_PORT: "3000",
      SVC_BACKEND_HOST: "backend",
      SVC_BACKEND_PORT: "3000",
    });
  });
});
