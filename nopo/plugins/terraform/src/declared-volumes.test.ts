import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  NormalizedProcess,
  NormalizedService,
  ResolvedRuntime,
} from "@more-nopo/nopo/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  declaredVolumesForService,
  type ServiceManifest,
  SOURCE_CONFIGMAP_SIZE_LIMIT_BYTES,
  yamlDeclaredPvc,
  yamlDeployment,
  yamlSourceConfigMap,
} from "./index.ts";

/** yamlDeclaredPvc emits a service-scoped PVC named `${serviceId}-${name}` with the declared size + RWO
 * access mode. yamlDeployment emits one volumeMount + one pod-level volume per entry on `proc.volumes`
 * and references the PVC by claimName. The Recreate rollout strategy is now triggered by any RWO PVC,
 * not just the isDb-gated db service.
 */

function makeProcess(o: Partial<NormalizedProcess> = {}): NormalizedProcess {
  return {
    name: "default",
    cpu: "1",
    memory: "512Mi",
    minInstances: 1,
    maxInstances: 1,
    deps: [],
    ...o,
  };
}

function makeService(
  id: string,
  processes: Record<string, NormalizedProcess>,
): NormalizedService {
  const primary = processes.default ?? Object.values(processes)[0]!;
  const svc: Partial<NormalizedService> = {
    id,
    name: id,
    description: "",
    staticPath: "",
    tags: [],
    secrets: [],
    type: "service",
    buildDeps: [],
    runtimeDeps: [],
    commands: {},
    paths: { root: `/proj/${id}`, context: `/proj/${id}` },
    packageManagers: [],
    configPath: `/proj/${id}/nopo.yml`,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
    runtime: {
      processes,
      command: primary.command,
      cpu: primary.cpu,
      memory: primary.memory,
      port: primary.port ?? 3000,
      deps: primary.deps,
    } as NormalizedService["runtime"],
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub
  return svc as NormalizedService;
}

function makeManifest(
  id: string,
  processes: Record<string, NormalizedProcess>,
  opts: { image?: string } = {},
): ServiceManifest {
  const primary = processes.default ?? Object.values(processes)[0]!;
  return {
    id,
    service: makeService(id, processes),
    image: opts.image ?? `local/${id}:test`,
    port: primary.port ?? 3000,
    env: { SERVICE_NAME: id, NODE_ENV: "production" },
    secrets: [],
    isInfra: false,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal overlay
    overlay: {
      name: "default",
      cpu: primary.cpu,
      memory: primary.memory,
      port: primary.port ?? 3000,
      replicas: primary.minInstances,
      deps: primary.deps,
      volumes: primary.volumes,
      envs: { env: {}, secrets: {}, effective: {} },
    } as unknown as ResolvedRuntime,
  };
}

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- yaml parse returns unknown
const parseDoc = (src: string) => parse(src) as Record<string, unknown>;

describe("yamlDeclaredPvc", () => {
  it("emits a PVC named ${serviceId}-${volumeName} with the declared size", () => {
    const yaml = yamlDeclaredPvc("sonar", "data", "5Gi", "nopo-prod");
    const doc = parseDoc(yaml);
    expect(doc).toMatchObject({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: "sonar-data",
        namespace: "nopo-prod",
        labels: {
          app: "sonar",
          "app.kubernetes.io/managed-by": "nopo",
        },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "5Gi" } },
      },
    });
  });

  it("scopes the PVC name by service so two services can declare the same volume name", () => {
    const a = parseDoc(yamlDeclaredPvc("sonar", "data", "5Gi", "ns"));
    const b = parseDoc(yamlDeclaredPvc("other", "data", "5Gi", "ns"));
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime-shaped YAML
    const aMeta = a.metadata as { name: string };
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime-shaped YAML
    const bMeta = b.metadata as { name: string };
    expect(aMeta.name).toBe("sonar-data");
    expect(bMeta.name).toBe("other-data");
  });
});

describe("yamlDeployment — runtime.volumes integration", () => {
  it("emits one volumeMount + one pod-level volume per declared volume", () => {
    const proc = makeProcess({
      command: "sleep infinity",
      port: 9000,
      volumes: [
        { name: "data", mountPath: "/opt/sonarqube/data", size: "5Gi" },
        {
          name: "extensions",
          mountPath: "/opt/sonarqube/extensions",
          size: "5Gi",
        },
      ],
    });
    const m = makeManifest("sonar", { default: proc });
    const yaml = yamlDeployment(m, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 9000,
    });
    const doc = parseDoc(yaml);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const spec = (doc.spec as Record<string, unknown>).template as Record<
      string,
      unknown
    >;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const podSpec = spec.spec as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const container = (podSpec.containers as Record<string, unknown>[])[0]!;

    expect(container.volumeMounts).toEqual([
      { name: "data", mountPath: "/opt/sonarqube/data" },
      { name: "extensions", mountPath: "/opt/sonarqube/extensions" },
    ]);
    expect(podSpec.volumes).toEqual([
      {
        name: "data",
        persistentVolumeClaim: { claimName: "sonar-data" },
      },
      {
        name: "extensions",
        persistentVolumeClaim: { claimName: "sonar-extensions" },
      },
    ]);
  });

  it("triggers Recreate strategy for any service with runtime.volumes (not just isDb)", () => {
    /** The Recreate guard generalizes from the legacy isDb-only check to any service mounting an RWO PVC —
     * including declared `runtime.volumes:`. Without this, sonar would try to RollingUpdate, the new pod
     * would block on MultiAttachError for the RWO PVC, and the old pod would hold the rollout forever.
     */
    const proc = makeProcess({
      command: "sleep infinity",
      port: 9000,
      volumes: [{ name: "data", mountPath: "/data", size: "5Gi" }],
    });
    const m = makeManifest("sonar", { default: proc });
    const yaml = yamlDeployment(m, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 9000,
    });
    const doc = parseDoc(yaml);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const spec = doc.spec as Record<string, unknown>;
    expect(spec.strategy).toEqual({ type: "Recreate" });
  });

  it("does NOT emit Recreate when neither isDb nor volumes are present", () => {
    const proc = makeProcess({ command: "sleep infinity", port: 3000 });
    const m = makeManifest("noop", { default: proc });
    const yaml = yamlDeployment(m, "nopo-prod", {
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
    const doc = parseDoc(yaml);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const spec = doc.spec as Record<string, unknown>;
    expect(spec.strategy).toBeUndefined();
  });

  it("emits Recreate for preview Deployments (nopo-preview PriorityClass)", () => {
    // Preview ResourceQuota is 3 CPU — RollingUpdate create-before-delete
    // deadlocks when prior pods still hold default-sized requests.
    const proc = makeProcess({ command: "bun run src/index.ts", port: 3001 });
    const m = makeManifest("api", { default: proc });
    const yaml = yamlDeployment(m, "nopo-prev", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 3001,
      priorityClassName: "nopo-preview",
    });
    const doc = parseDoc(yaml);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const spec = doc.spec as Record<string, unknown>;
    expect(spec.strategy).toEqual({ type: "Recreate" });
  });
});

describe("yamlDeployment — post_command → lifecycle.postStart", () => {
  /** post_command on a NormalizedProcess emits as `lifecycle.postStart.exec.command`
   * on the matching container. Mirrors how pre_command emits as an
   * initContainer. Wrapped in `sh -c` so authors can write idiomatic
   * shell pipelines (matches the pre_command shape).
   */

  it("emits lifecycle.postStart.exec for a process declaring post_command", () => {
    const proc = makeProcess({
      command: "sleep infinity",
      port: 9000,
      postCommand: "curl -s http://localhost/bootstrap",
    });
    const m = makeManifest("sonar", { default: proc });
    const yaml = yamlDeployment(m, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 9000,
    });
    const doc = parseDoc(yaml);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const tmpl = (doc.spec as Record<string, unknown>).template as Record<
      string,
      unknown
    >;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const podSpec = tmpl.spec as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const container = (podSpec.containers as Record<string, unknown>[])[0]!;
    // postStart and preStop share ONE lifecycle key — two keys is invalid.
    expect(container.lifecycle).toEqual({
      postStart: {
        exec: {
          command: ["sh", "-c", "curl -s http://localhost/bootstrap"],
        },
      },
      preStop: { exec: { command: ["sh", "-c", "sleep 5"] } },
    });
  });

  it("preserves newlines in a multi-line post_command", () => {
    /** Regression: an earlier emit used a YAML flow-style quoted scalar (`command: ["sh", "-c", "..."]`)
     * which folds embedded newlines into single spaces. A `do … done` block collapsed into `do sleep 1
     * done`, and `sh -c` errored out before the script ran. The hook fired ~6 times in a kubelet backoff
     * loop and wedged db's rollout in prod. The emit must use a block scalar so newlines survive YAML
     */
    const script = [
      "until pg_isready -U nopo -d nopo; do",
      "  sleep 1",
      "done",
      "for f in /docker-entrypoint-initdb.d/*.sh; do",
      '  bash "$f"',
      "done",
    ].join("\n");
    const proc = makeProcess({
      command: "postgres",
      port: 5432,
      postCommand: script,
    });
    const m = makeManifest("db", { default: proc });
    const yaml = yamlDeployment(m, "nopo-prod", {
      isDb: true,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 5432,
    });
    const doc = parseDoc(yaml);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const tmpl = (doc.spec as Record<string, unknown>).template as Record<
      string,
      unknown
    >;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const podSpec = tmpl.spec as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const container = (podSpec.containers as Record<string, unknown>[])[0]!;
    expect(container.lifecycle).toEqual({
      postStart: {
        exec: {
          command: ["sh", "-c", script],
        },
      },
      preStop: { exec: { command: ["sh", "-c", "sleep 5"] } },
    });
  });

  it("does not emit a postStart hook when post_command is absent", () => {
    const proc = makeProcess({ command: "sleep infinity", port: 9000 });
    const m = makeManifest("sonar", { default: proc });
    const yaml = yamlDeployment(m, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 9000,
    });
    // The lifecycle key still carries the preStop drain hook, but nothing else.
    expect(yaml).not.toMatch(/postStart/);
    expect(yaml.match(/lifecycle:/g)).toHaveLength(1);
  });
});

describe("declaredVolumesForService — service-scoped PVC dedupe", () => {
  /** PVCs are service-scoped: a multi-process service whose two processes
   * inherit the same block-level volumes list must NOT emit two PVCs for
   * the same volume name. The helper dedupes by name.
   */

  it("dedupes a volume that every process inherits from the runtime block", () => {
    const sharedVol = {
      name: "data",
      mountPath: "/data",
      size: "5Gi",
    } as const;
    const processes = {
      default: makeProcess({
        command: "web",
        port: 9000,
        volumes: [sharedVol],
      }),
      worker: makeProcess({
        name: "worker",
        command: "worker",
        volumes: [sharedVol],
      }),
    };
    const m = makeManifest("svc", processes);
    const vols = declaredVolumesForService(m);
    expect(vols).toHaveLength(1);
    expect(vols[0]).toMatchObject({ name: "data" });
  });

  it("throws on conflicting volume definitions across processes (same name, different shape)", () => {
    const processes = {
      default: makeProcess({
        command: "web",
        port: 9000,
        volumes: [{ name: "data", mountPath: "/a", size: "5Gi" }],
      }),
      worker: makeProcess({
        name: "worker",
        command: "worker",
        volumes: [{ name: "data", mountPath: "/b", size: "10Gi" }],
      }),
    };
    const m = makeManifest("svc", processes);
    expect(() => declaredVolumesForService(m)).toThrowError(
      /conflicting shape/,
    );
  });

  it("returns the overlay volumes when no processes map is set", () => {
    // Single-process services that come through with a synthesized default
    // process still expose volumes on the overlay; this is the fallback path.
    const proc = makeProcess({
      command: "sleep",
      port: 9000,
      volumes: [{ name: "data", mountPath: "/data", size: "5Gi" }],
    });
    const m = makeManifest("sonar", { default: proc });
    // Drop processes (back-compat when overlay is source of truth).
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test mutation
    (m.service.runtime as { processes?: unknown }).processes = undefined;
    const vols = declaredVolumesForService(m);
    expect(vols).toHaveLength(1);
    expect(vols[0]).toMatchObject({ name: "data" });
  });
});

describe("yamlSourceConfigMap — host-mount mode (ConfigMap from a source dir)", () => {
  /** The terraform plugin emits one ConfigMap per source-mode `runtime.volumes:` entry. Files in the
   * source directory map directly to ConfigMap data keys (filename → contents). The ConfigMap is named
   * `${serviceId}-${volumeName}`, mirroring the size-mode PVC naming. Subdirectories are NOT recursed —
   * k8s ConfigMaps are flat.
   */

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-cm-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits a ConfigMap named ${serviceId}-${volumeName} with one data entry per file", () => {
    fs.writeFileSync(path.join(tmpDir, "01_init.sh"), "#!/bin/sh\necho hi\n");
    fs.writeFileSync(
      path.join(tmpDir, "02_grants.sh"),
      "psql -c 'GRANT ALL'\n",
    );

    const yaml = yamlSourceConfigMap("nopo-prod", "db", "migrations", tmpDir);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- yaml is unknown
    const doc = parse(yaml) as {
      apiVersion: string;
      kind: string;
      metadata: {
        name: string;
        namespace: string;
        labels: Record<string, string>;
      };
      data: Record<string, string>;
    };
    expect(doc.apiVersion).toBe("v1");
    expect(doc.kind).toBe("ConfigMap");
    expect(doc.metadata.name).toBe("db-migrations");
    expect(doc.metadata.namespace).toBe("nopo-prod");
    expect(doc.metadata.labels).toMatchObject({
      app: "db",
      "app.kubernetes.io/managed-by": "nopo",
    });
    expect(Object.keys(doc.data).sort()).toEqual([
      "01_init.sh",
      "02_grants.sh",
    ]);
    expect(doc.data["01_init.sh"]).toContain("echo hi");
  });

  it("does NOT recurse into subdirectories (direct children only)", () => {
    fs.writeFileSync(path.join(tmpDir, "01_init.sh"), "#!/bin/sh\n");
    fs.mkdirSync(path.join(tmpDir, "nested"));
    fs.writeFileSync(path.join(tmpDir, "nested", "hidden.sh"), "should-skip\n");

    const yaml = yamlSourceConfigMap("ns", "svc", "vol", tmpDir);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- yaml is unknown
    const doc = parse(yaml) as { data: Record<string, string> };
    expect(Object.keys(doc.data)).toEqual(["01_init.sh"]);
  });

  it("throws a clear error when the source directory does not exist", () => {
    const missing = path.join(tmpDir, "no-such-dir");
    expect(() => yamlSourceConfigMap("ns", "svc", "vol", missing)).toThrowError(
      /does not exist/i,
    );
  });

  it("throws when the source path is a file (not a directory)", () => {
    const filePath = path.join(tmpDir, "single-file");
    fs.writeFileSync(filePath, "x");
    expect(() =>
      yamlSourceConfigMap("ns", "svc", "vol", filePath),
    ).toThrowError(/not a directory/i);
  });

  it("throws when the combined file size exceeds the ConfigMap soft limit", () => {
    /** Generate two files that together exceed the soft limit. Single-file
     * overruns are also rejected — using two so the test also documents
     * the aggregate-size semantic.
     */
    const halfLimit = Math.floor(SOURCE_CONFIGMAP_SIZE_LIMIT_BYTES / 2);
    fs.writeFileSync(path.join(tmpDir, "a.sh"), "a".repeat(halfLimit + 1024));
    fs.writeFileSync(path.join(tmpDir, "b.sh"), "b".repeat(halfLimit + 1024));
    expect(() => yamlSourceConfigMap("ns", "svc", "big", tmpDir)).toThrowError(
      /exceeds the ConfigMap soft limit/i,
    );
  });
});

describe("yamlDeployment — host-mount mode volumes", () => {
  /** When a `runtime.volumes:` entry has `source` set, the deployment
   * template references the ConfigMap (not a PVC). `defaultMode: 0755`
   * is set so shell scripts in the mounted directory are executable
   * — matches Postgres' /docker-entrypoint-initdb.d expectation.
   */

  it("emits a configMap pod-volume + volumeMount for a source-mode entry", () => {
    const proc = makeProcess({
      command: "sleep infinity",
      port: 5432,
      volumes: [
        {
          name: "migrations",
          mountPath: "/docker-entrypoint-initdb.d",
          source: "./migrations",
          readOnly: true,
        },
      ],
    });
    const m = makeManifest("db", { default: proc });
    const yaml = yamlDeployment(m, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 5432,
    });
    const doc = parseDoc(yaml);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const tmpl = (doc.spec as Record<string, unknown>).template as Record<
      string,
      unknown
    >;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const podSpec = tmpl.spec as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const container = (podSpec.containers as Record<string, unknown>[])[0]!;

    expect(container.volumeMounts).toEqual([
      {
        name: "migrations",
        mountPath: "/docker-entrypoint-initdb.d",
        readOnly: true,
      },
    ]);
    expect(podSpec.volumes).toEqual([
      {
        name: "migrations",
        // defaultMode encoded as decimal 493 (0o755) to dodge YAML's
        // ambiguous octal handling; k8s reads either form as POSIX mode.
        configMap: { name: "db-migrations", defaultMode: 0o755 },
      },
    ]);
  });

  it("omits readOnly on the volumeMount when readOnly is false", () => {
    const proc = makeProcess({
      command: "sleep infinity",
      port: 5432,
      volumes: [
        {
          name: "migrations",
          mountPath: "/etc/config",
          source: "./config",
          readOnly: false,
        },
      ],
    });
    const m = makeManifest("svc", { default: proc });
    const yaml = yamlDeployment(m, "ns", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 5432,
    });
    const doc = parseDoc(yaml);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const tmpl = (doc.spec as Record<string, unknown>).template as Record<
      string,
      unknown
    >;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const podSpec = tmpl.spec as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const container = (podSpec.containers as Record<string, unknown>[])[0]!;
    expect(container.volumeMounts).toEqual([
      { name: "migrations", mountPath: "/etc/config" },
    ]);
  });

  it("does NOT trigger Recreate strategy when only source-mode volumes are declared", () => {
    /** ConfigMap-backed pod volumes can be safely RollingUpdate'd — no RWO
     * attach conflict like with size-mode PVCs. The Recreate guard must
     * not over-trigger for source-only services.
     */
    const proc = makeProcess({
      command: "sleep infinity",
      port: 5432,
      volumes: [
        {
          name: "migrations",
          mountPath: "/docker-entrypoint-initdb.d",
          source: "./migrations",
          readOnly: true,
        },
      ],
    });
    const m = makeManifest("svc", { default: proc });
    const yaml = yamlDeployment(m, "ns", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 5432,
    });
    const doc = parseDoc(yaml);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime YAML
    const spec = doc.spec as Record<string, unknown>;
    expect(spec.strategy).toBeUndefined();
  });
});
