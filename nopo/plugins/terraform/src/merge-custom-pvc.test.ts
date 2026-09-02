import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { mergeCustomPvcManifest } from "./index.ts";

// Test helper — captures log messages so we can assert on the warnings.
function captureLogs(): [(msg: string) => void, string[]] {
  const logs: string[] = [];
  return [(msg: string) => logs.push(msg), logs];
}

// Strip ANSI color codes so warning-content assertions stay stable across
// environments where chalk may or may not emit color.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const SRC = "apps/db/pvc.yaml";

describe("mergeCustomPvcManifest", () => {
  it("fills in identity on a minimal user file", () => {
    const [log, logs] = captureLogs();
    const input = `
apiVersion: v1
kind: PersistentVolumeClaim
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: longhorn
  resources:
    requests:
      storage: 5Gi
`;
    const out = parse(mergeCustomPvcManifest(input, SRC, "db", log));
    expect(out.metadata.name).toBe("db-data");
    expect(out.metadata.namespace).toBeUndefined();
    expect(out.metadata.labels).toEqual({
      app: "db",
      "app.kubernetes.io/managed-by": "nopo",
    });
    expect(out.spec.storageClassName).toBe("longhorn");
    expect(out.spec.resources.requests.storage).toBe("5Gi");
    expect(logs).toEqual([]);
  });

  it("preserves user labels and annotations alongside plugin identity", () => {
    const [log, logs] = captureLogs();
    const input = `
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  labels:
    team: infra
    cost-center: eng-platform
  annotations:
    owner: kevin
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 2Gi
`;
    const out = parse(mergeCustomPvcManifest(input, SRC, "db", log));
    expect(out.metadata.labels).toEqual({
      team: "infra",
      "cost-center": "eng-platform",
      app: "db",
      "app.kubernetes.io/managed-by": "nopo",
    });
    expect(out.metadata.annotations).toEqual({ owner: "kevin" });
    expect(logs).toEqual([]);
  });

  it("warns and overrides when user sets a wrong metadata.name", () => {
    const [log, logs] = captureLogs();
    const input = `
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-fun-pvc
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
`;
    const out = parse(mergeCustomPvcManifest(input, SRC, "db", log));
    expect(out.metadata.name).toBe("db-data");
    expect(logs).toHaveLength(1);
    const [log0] = logs;
    if (!log0) throw new Error("expected one log entry");
    expect(stripAnsi(log0)).toMatch(
      /metadata\.name=my-fun-pvc ignored.*forcing to db-data/,
    );
  });

  it("accepts a correctly-set metadata.name silently", () => {
    const [log, logs] = captureLogs();
    const input = `
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: db-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
`;
    const out = parse(mergeCustomPvcManifest(input, SRC, "db", log));
    expect(out.metadata.name).toBe("db-data");
    expect(logs).toEqual([]);
  });

  it("warns and strips when user sets metadata.namespace", () => {
    const [log, logs] = captureLogs();
    const input = `
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  namespace: nopo-prod
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
`;
    const out = parse(mergeCustomPvcManifest(input, SRC, "db", log));
    expect(out.metadata.namespace).toBeUndefined();
    expect(logs).toHaveLength(1);
    const [log0] = logs;
    if (!log0) throw new Error("expected one log entry");
    expect(stripAnsi(log0)).toMatch(/metadata\.namespace=nopo-prod ignored/);
  });

  it("warns and overrides when user sets a wrong labels.app", () => {
    const [log, logs] = captureLogs();
    const input = `
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  labels:
    app: frontend
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
`;
    const out = parse(mergeCustomPvcManifest(input, SRC, "db", log));
    expect(out.metadata.labels.app).toBe("db");
    expect(logs).toHaveLength(1);
    const [log0] = logs;
    if (!log0) throw new Error("expected one log entry");
    expect(stripAnsi(log0)).toMatch(
      /metadata\.labels\.app=frontend ignored.*forcing to db/,
    );
  });

  it("warns and overrides when user sets a wrong managed-by label", () => {
    const [log, logs] = captureLogs();
    const input = `
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  labels:
    app.kubernetes.io/managed-by: helm
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
`;
    const out = parse(mergeCustomPvcManifest(input, SRC, "db", log));
    expect(out.metadata.labels["app.kubernetes.io/managed-by"]).toBe("nopo");
    expect(logs).toHaveLength(1);
    const [log0] = logs;
    if (!log0) throw new Error("expected one log entry");
    expect(stripAnsi(log0)).toMatch(
      /metadata\.labels\['app\.kubernetes\.io\/managed-by'\]=helm ignored/,
    );
  });

  it("stacks warnings when the user sets multiple plugin-owned fields wrong", () => {
    const [log, logs] = captureLogs();
    const input = `
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nope
  namespace: nope-ns
  labels:
    app: nope-app
    app.kubernetes.io/managed-by: nope-tool
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
`;
    mergeCustomPvcManifest(input, SRC, "db", log);
    expect(logs).toHaveLength(4);
  });

  it("throws on multi-document files (kind=PVC but second doc present)", () => {
    const [log] = captureLogs();
    const input = `
apiVersion: v1
kind: PersistentVolumeClaim
spec: {}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: extra
`;
    expect(() => mergeCustomPvcManifest(input, SRC, "db", log)).toThrow(
      /got 2 documents/,
    );
  });

  it("throws when kind is not PersistentVolumeClaim", () => {
    const [log] = captureLogs();
    const input = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: nope
`;
    expect(() => mergeCustomPvcManifest(input, SRC, "db", log)).toThrow(
      /expected kind=PersistentVolumeClaim, got kind=ConfigMap/,
    );
  });

  it("throws when kind is missing", () => {
    const [log] = captureLogs();
    const input = `
apiVersion: v1
spec:
  accessModes: ["ReadWriteOnce"]
`;
    expect(() => mergeCustomPvcManifest(input, SRC, "db", log)).toThrow(
      /got kind=\(unset\)/,
    );
  });

  it("works for service IDs other than 'db'", () => {
    const [log] = captureLogs();
    const input = `
apiVersion: v1
kind: PersistentVolumeClaim
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 10Gi
`;
    const out = parse(
      mergeCustomPvcManifest(input, "apps/postgres/pvc.yaml", "postgres", log),
    );
    expect(out.metadata.name).toBe("postgres-data");
    expect(out.metadata.labels.app).toBe("postgres");
  });
});
