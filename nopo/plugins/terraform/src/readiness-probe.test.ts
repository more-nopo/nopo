import type {
  Healthcheck,
  NormalizedProcess,
  NormalizedService,
  ResolvedRuntime,
} from "@more-nopo/nopo/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { type ServiceManifest, yamlDeployment } from "./index.ts";

/** The single nopo Healthcheck declaration drives both compose `healthcheck:` (docker-compose plugin)
 * and the k8s readinessProbe block (terraform plugin), so litellm and any future production-on-k8s
 * service stops racing rollout-vs-readiness.
 */

interface ParsedYaml {
  [key: string]: ParsedYaml;
}

function parseYaml(src: string): ParsedYaml {
  const result = parse(src);
  if (typeof result !== "object" || result === null) {
    throw new Error("parseYaml: expected an object at document root");
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- yaml parse returns unknown; shape narrowed by the runtime check above
  return result as ParsedYaml;
}

function makeProcess(overrides: Partial<NormalizedProcess>): NormalizedProcess {
  return {
    name: "default",
    cpu: "1",
    memory: "512Mi",
    minInstances: 1,
    maxInstances: 1,
    deps: [],
    ...overrides,
  };
}

function makeManifest(id: string, proc: NormalizedProcess): ServiceManifest {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: only the runtime fields the YAML emitter reads matter
  const svc: NormalizedService = {
    id,
    name: id,
    description: "",
    staticPath: "",
    tags: [],
    secrets: [],
    type: "service",
    buildDeps: [],
    runtimeDeps: [],
    systemDeps: [],
    commands: {},
    paths: { root: `/proj/${id}`, context: `/proj/${id}` },
    packageManagers: [],
    configPath: `/proj/${id}/nopo.yml`,
    runtime: {
      processes: { [proc.name]: proc },
      command: proc.command,
      cpu: proc.cpu,
      memory: proc.memory,
      port: proc.port ?? 3000,
      deps: proc.deps,
    },
  } as unknown as NormalizedService;

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal overlay for test
  const overlay: ResolvedRuntime = {
    name: "default",
    cpu: proc.cpu,
    memory: proc.memory,
    port: proc.port ?? 3000,
    replicas: proc.minInstances,
    deps: proc.deps,
    healthcheck: proc.healthcheck,
    envs: {
      env: { SERVICE_NAME: id, NODE_ENV: "production" },
      secrets: {},
      effective: { SERVICE_NAME: id, NODE_ENV: "production" },
    },
  } as unknown as ResolvedRuntime;

  return {
    id,
    service: svc,
    image: `local/${id}:test`,
    port: proc.port ?? 3000,
    env: { SERVICE_NAME: id, NODE_ENV: "production" },
    secrets: [],
    isInfra: false,
    overlay,
  };
}

const LITELLM_HEALTHCHECK: Healthcheck = {
  type: "exec",
  exec: ["curl", "-f", "http://localhost:4000/health/readiness"],
  interval: "10s",
  timeout: "5s",
  retries: 5,
  delay: "30s",
};

describe("yamlDeployment — readinessProbe emission", () => {
  it("emits a readinessProbe that mirrors the unified healthcheck field-for-field", () => {
    const proc = makeProcess({
      command: "litellm --config /app/config.yaml",
      port: 4000,
      cpu: "0.5",
      memory: "2Gi",
      healthcheck: LITELLM_HEALTHCHECK,
    });
    const svc = makeManifest("litellm", proc);

    const yaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 4000,
    });
    const doc = parseYaml(yaml);
    const probe = doc.spec?.template?.spec?.containers?.[0]?.readinessProbe;

    expect(probe).toMatchObject({
      // Field mapping verified per acceptance criteria — litellm spec values
      // (`initialDelaySeconds: 30`, `periodSeconds: 10`, ...).
      initialDelaySeconds: 30,
      periodSeconds: 10,
      timeoutSeconds: 5,
      failureThreshold: 5,
      exec: {
        command: ["curl", "-f", "http://localhost:4000/health/readiness"],
      },
    });
  });

  it("does NOT emit a livenessProbe", () => {
    /** Compose has no liveness/readiness distinction; mapping to readiness only
     * is the conservative choice. Adding liveness with poor defaults can kill
     * healthy pods. Verify the YAML stays clean — explicit out-of-scope guard.
     */
    const proc = makeProcess({
      command: "node server.js",
      port: 3000,
      healthcheck: LITELLM_HEALTHCHECK,
    });
    const svc = makeManifest("web", proc);

    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 3000,
    });

    expect(yaml).not.toContain("livenessProbe");
  });

  it("omits the readinessProbe block when the service declares no healthcheck (back-compat)", () => {
    /** Services without a unified healthcheck (the vast majority pre-migration)
     * must keep producing the same Deployment YAML they did before — empty
     * readinessProbe means k8s falls back to the "Ready as soon as the
     * container starts" heuristic, which is the legacy behavior.
     */
    const proc = makeProcess({
      command: "node server.js",
      port: 3000,
      // No healthcheck declared.
    });
    const svc = makeManifest("web", proc);

    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 3000,
    });

    expect(yaml).not.toContain("readinessProbe");
  });

  it("omits the readinessProbe on port-less processes (e.g. workers)", () => {
    /** Worker processes have no port and no Service — k8s readinessProbe is
     * meaningless without a port-driven Service to gate routing on. Emit
     * nothing rather than a probe that runs against a process that never
     * listens. Matches the existing containerPorts block guard.
     */
    const proc = makeProcess({
      name: "worker",
      command: "node worker.js",
      // No port. Healthcheck still declared — but the plugin must not emit it.
      healthcheck: LITELLM_HEALTHCHECK,
    });
    const svc = makeManifest("af-api", proc);

    const yaml = yamlDeployment(svc, "nopo-dev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      // port: undefined — port-less process.
    });

    expect(yaml).not.toContain("readinessProbe");
  });

  /** For images without curl/wget (e.g. litellm's upstream python:slim) the `type: http` healthcheck
   * emits `readinessProbe.httpGet:` — k8s runs the probe from the kubelet, not in-container, so image
   * binary inventory is irrelevant. `port` falls back to the runtime port when the healthcheck omits its
   * own.
   */

  const LITELLM_HTTP_HEALTHCHECK: Healthcheck = {
    type: "http",
    path: "/health/readiness",
    port: 4000,
    interval: "10s",
    timeout: "5s",
    retries: 5,
    delay: "30s",
  };

  it("emits httpGet with explicit port for type: http", () => {
    const proc = makeProcess({
      command: "litellm --config /app/config.yaml",
      port: 4000,
      cpu: "0.5",
      memory: "2Gi",
      healthcheck: LITELLM_HTTP_HEALTHCHECK,
    });
    const svc = makeManifest("litellm", proc);

    const yaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 4000,
    });
    const doc = parseYaml(yaml);
    const probe = doc.spec?.template?.spec?.containers?.[0]?.readinessProbe;

    expect(probe).toMatchObject({
      initialDelaySeconds: 30,
      periodSeconds: 10,
      timeoutSeconds: 5,
      failureThreshold: 5,
      httpGet: {
        path: "/health/readiness",
        port: 4000,
      },
    });
    // Must NOT also emit `exec` — discriminated union variants are exclusive.
    expect(probe?.exec).toBeUndefined();
  });

  it("falls back to process port when type: http omits port", () => {
    /** When the healthcheck doesn't declare its own `port:`, the emitter
     * resolves the URL against the active runtime's `process.port`. This
     * is the recommended shape for services that already have a single
     * canonical port — saves declaring it twice.
     */
    const hc: Healthcheck = {
      type: "http",
      path: "/health/readiness",
      interval: "10s",
      timeout: "5s",
      retries: 5,
      delay: "30s",
    };
    const proc = makeProcess({
      command: "litellm --config /app/config.yaml",
      port: 4000,
      healthcheck: hc,
    });
    const svc = makeManifest("litellm", proc);

    const yaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 4000,
    });
    const doc = parseYaml(yaml);
    const probe = doc.spec?.template?.spec?.containers?.[0]?.readinessProbe;

    expect(probe?.httpGet).toMatchObject({
      path: "/health/readiness",
      port: 4000,
    });
  });

  it("type: http with explicit port overrides the process port", () => {
    /** Operator declared a different port on the healthcheck than the
     * runtime's primary port — the healthcheck.port wins (might be a
     * sidecar admin port).
     */
    const hc: Healthcheck = {
      type: "http",
      path: "/admin/health",
      port: 9090,
      interval: "10s",
      timeout: "5s",
      retries: 3,
      delay: "10s",
    };
    const proc = makeProcess({
      command: "node server.js",
      port: 3000,
      healthcheck: hc,
    });
    const svc = makeManifest("web", proc);

    const yaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 3000,
    });
    const doc = parseYaml(yaml);
    const probe = doc.spec?.template?.spec?.containers?.[0]?.readinessProbe;

    expect(probe?.httpGet).toMatchObject({
      path: "/admin/health",
      port: 9090,
    });
  });

  it("translates minutes-suffix durations into integer seconds", () => {
    /** `2m` -> 120 seconds. k8s probes only accept integer seconds, so the
     * schema parser already restricts to whole `Ns` / `Nm` units; the
     * translator just multiplies-by-60 when the unit is `m`.
     */
    const proc = makeProcess({
      command: "java -jar app.jar",
      port: 8080,
      healthcheck: {
        type: "exec",
        exec: ["curl", "-f", "http://localhost:8080/actuator/health"],
        interval: "1m",
        timeout: "30s",
        retries: 3,
        delay: "2m",
      },
    });
    const svc = makeManifest("jvm-app", proc);

    const yaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 8080,
    });
    const doc = parseYaml(yaml);
    const probe = doc.spec?.template?.spec?.containers?.[0]?.readinessProbe;

    expect(probe).toMatchObject({
      initialDelaySeconds: 120,
      periodSeconds: 60,
      timeoutSeconds: 30,
      failureThreshold: 3,
    });
  });
});

describe("no startupProbe is emitted", () => {
  /** Regression, prod 2026-08-19: a startupProbe sized from `healthcheck.delay` KILLED litellm.
   * A failing readinessProbe only holds a pod out of the Service; a failing startupProbe makes
   * kubelet kill the container, so an under-sized budget turns a slow boot into a crash loop.
   * litellm burned 11 restarts before this was reverted. Readiness owns the cold-start budget.
   */
  it("emits only a readinessProbe, never a startupProbe", () => {
    const proc = makeProcess({
      command: "litellm --config /app/config.yaml",
      port: 4000,
      healthcheck: LITELLM_HEALTHCHECK,
    });
    const svc = makeManifest("litellm", proc);
    const yaml = yamlDeployment(svc, "nopo-prod", {
      isNginx: false,
      isDb: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 4000,
    });
    const doc = parseYaml(yaml);
    const container = doc.spec?.template?.spec?.containers?.[0];

    expect(container?.startupProbe).toBeUndefined();
    expect(container?.readinessProbe).toMatchObject({
      initialDelaySeconds: 30,
    });
  });
});
