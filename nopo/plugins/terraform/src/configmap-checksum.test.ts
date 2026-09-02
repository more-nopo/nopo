import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  NormalizedProcess,
  NormalizedService,
  ResolvedRuntime,
} from "@more-nopo/nopo/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  computeConfigChecksum,
  type ServiceManifest,
  yamlDeployment,
} from "./index.ts";

/** Regression for the nginx-stale-config bug observed in prod (apps/sonar shipped — /sonar block landed
 * in apps/nginx/templates/, ConfigMap on cluster picked it up, but the running nginx pod kept 404'ing
 * /sonar because its container never reloaded.
 */

function makeProcess(o: Partial<NormalizedProcess> = {}): NormalizedProcess {
  return {
    name: "default",
    cpu: "0.5",
    memory: "128Mi",
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
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: only the runtime fields the YAML emitter reads matter
  return {
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
    runtime: {
      processes,
      command: primary.command,
      cpu: primary.cpu,
      memory: primary.memory,
      port: primary.port ?? 80,
      deps: primary.deps,
    },
  } as unknown as NormalizedService;
}

function makeNginxManifest(id = "nginx"): ServiceManifest {
  const processes = {
    default: makeProcess({ port: 80, cpu: "0.5", memory: "128Mi" }),
  };
  return {
    id,
    service: makeService(id, processes),
    image: "nginx:latest",
    port: 80,
    env: { SONAR_URL: "http://sonar:9000" },
    secrets: [],
    isInfra: true,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal overlay stub for test
    overlay: {
      name: "default",
      cpu: "0.5",
      memory: "128Mi",
      port: 80,
      replicas: 1,
      deps: [],
      envs: { env: {}, secrets: {}, effective: {} },
    } as unknown as ResolvedRuntime,
  };
}

describe("computeConfigChecksum", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmchk-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no CMs are emitted", () => {
    expect(
      computeConfigChecksum({ nginxTemplatePath: null, configMounts: [] }),
    ).toBeNull();
  });

  it("hashes nginx template files deterministically", () => {
    const td = path.join(tmp, "templates");
    fs.mkdirSync(td);
    fs.writeFileSync(path.join(td, "default.conf.template"), "server { ... }");
    const a = computeConfigChecksum({
      nginxTemplatePath: td,
      configMounts: [],
    });
    const b = computeConfigChecksum({
      nginxTemplatePath: td,
      configMounts: [],
    });
    expect(a).toBe(b); // deterministic
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when a template file's content changes", () => {
    const td = path.join(tmp, "templates");
    fs.mkdirSync(td);
    const f = path.join(td, "default.conf.template");
    fs.writeFileSync(f, "server { location /a {} }");
    const before = computeConfigChecksum({
      nginxTemplatePath: td,
      configMounts: [],
    });
    fs.writeFileSync(f, "server { location /a {} location /b {} }");
    const after = computeConfigChecksum({
      nginxTemplatePath: td,
      configMounts: [],
    });
    expect(before).not.toBe(after);
  });

  it("changes when a new template file is added", () => {
    const td = path.join(tmp, "templates");
    fs.mkdirSync(td);
    fs.writeFileSync(path.join(td, "default.conf.template"), "server {}");
    const before = computeConfigChecksum({
      nginxTemplatePath: td,
      configMounts: [],
    });
    fs.writeFileSync(path.join(td, "snippet.conf"), "location /x {}");
    const after = computeConfigChecksum({
      nginxTemplatePath: td,
      configMounts: [],
    });
    expect(before).not.toBe(after);
  });

  it("hashes generic configMounts (one CM per mount)", () => {
    const md = path.join(tmp, "mount-a");
    fs.mkdirSync(md);
    fs.writeFileSync(path.join(md, "x.conf"), "abc");
    const a = computeConfigChecksum({
      nginxTemplatePath: null,
      configMounts: [
        { sourceDir: md, target: "/etc/x", configMapName: "svc-cfg-0" },
      ],
    });
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns null when the template dir exists but is empty (no files to mount)", () => {
    const td = path.join(tmp, "empty");
    fs.mkdirSync(td);
    expect(
      computeConfigChecksum({ nginxTemplatePath: td, configMounts: [] }),
    ).toBeNull();
  });

  /** Regression: a service whose only mounted ConfigMap comes from a source-mode `runtime.volumes:` entry
   * (apps/db's migrations) used to get a null checksum — no annotation — so adding a new migration never
   * rolled the pod and its postStart hook never re-ran. The grafana consumer role was never created in
   * prod as a result.
   */
  it("hashes source-mode runtime.volumes (db migrations) and flips when a file is added", () => {
    const vol = path.join(tmp, "migrations");
    fs.mkdirSync(vol);
    fs.writeFileSync(path.join(vol, "01_consumer_sonar.sh"), "echo sonar");
    const before = computeConfigChecksum({
      nginxTemplatePath: null,
      configMounts: [],
      sourceVolumes: [{ name: "migrations", sourceDir: vol }],
    });
    expect(before).toMatch(/^[a-f0-9]{64}$/); // non-null → annotation emitted
    fs.writeFileSync(path.join(vol, "02_consumer_grafana.sh"), "echo grafana");
    const after = computeConfigChecksum({
      nginxTemplatePath: null,
      configMounts: [],
      sourceVolumes: [{ name: "migrations", sourceDir: vol }],
    });
    expect(after).not.toBe(before); // adding a migration rolls the Deployment
  });
});

describe("yamlDeployment: checksum/config annotation", () => {
  it("emits the annotation when configChecksum is set", () => {
    const svc = makeNginxManifest();
    const yaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: true,
      isDev: false,
      isCI: true,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      configChecksum: "abcd1234".repeat(8),
      process: svc.service.runtime.processes.default!,
      port: 80,
    });
    const doc = parse(yaml);
    expect(doc.spec.template.metadata.annotations?.["checksum/config"]).toBe(
      "abcd1234".repeat(8),
    );
  });

  it("OMITS the annotation block when configChecksum is null (back-compat)", () => {
    const svc = makeNginxManifest("db");
    const yaml = yamlDeployment(svc, "nopo-prod", {
      isDb: true,
      isNginx: false,
      isDev: false,
      isCI: true,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      configChecksum: null,
      process: svc.service.runtime.processes.default!,
      port: 80,
    });
    const doc = parse(yaml);
    // metadata.annotations either missing entirely OR doesn't include checksum/config
    expect(
      doc.spec.template.metadata.annotations?.["checksum/config"],
    ).toBeUndefined();
    // Belt-and-braces: the literal string isn't anywhere in the YAML
    expect(yaml).not.toContain("checksum/config");
  });

  it("OMITS the annotation when configChecksum is undefined (existing-call-site back-compat)", () => {
    const svc = makeNginxManifest("redis");
    const yaml = yamlDeployment(svc, "nopo-prod", {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: true,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      // configChecksum intentionally omitted — proves the field is optional
      process: svc.service.runtime.processes.default!,
      port: 80,
    });
    expect(yaml).not.toContain("checksum/config");
  });

  it("annotation value flips when template content changes (end-to-end against computeConfigChecksum)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
    try {
      const td = path.join(tmp, "templates");
      fs.mkdirSync(td);
      const f = path.join(td, "default.conf.template");

      // First state: pre-sonar template
      fs.writeFileSync(
        f,
        "server { listen 80; location /grafana/ { proxy_pass http://grafana:3000; } }",
      );
      const c1 = computeConfigChecksum({
        nginxTemplatePath: td,
        configMounts: [],
      });

      // Second state: same template + /sonar block (the actual prod
      // change that triggered this bug)
      fs.writeFileSync(
        f,
        "server { listen 80; location /grafana/ { proxy_pass http://grafana:3000; } location /sonar/ { proxy_pass http://sonar:9000; } }",
      );
      const c2 = computeConfigChecksum({
        nginxTemplatePath: td,
        configMounts: [],
      });

      expect(c1).not.toBe(c2);

      const svc = makeNginxManifest();
      const y1 = yamlDeployment(svc, "nopo-prod", {
        isDb: false,
        isNginx: true,
        isDev: false,
        isCI: true,
        projectRoot: "/proj",
        nginxTemplatePath: td,
        secretName: null,
        configMounts: [],
        configChecksum: c1,
        process: svc.service.runtime.processes.default!,
        port: 80,
      });
      const y2 = yamlDeployment(svc, "nopo-prod", {
        isDb: false,
        isNginx: true,
        isDev: false,
        isCI: true,
        projectRoot: "/proj",
        nginxTemplatePath: td,
        secretName: null,
        configMounts: [],
        configChecksum: c2,
        process: svc.service.runtime.processes.default!,
        port: 80,
      });
      // The Deployment YAML differs — that's the whole point. K8s now
      // rolls the Deployment when the template changes.
      expect(y1).not.toBe(y2);
      expect(
        parse(y1).spec.template.metadata.annotations["checksum/config"],
      ).toBe(c1);
      expect(
        parse(y2).spec.template.metadata.annotations["checksum/config"],
      ).toBe(c2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
