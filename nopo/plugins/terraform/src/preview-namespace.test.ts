import type { NormalizedProjectConfig, NormalizedService } from "@more-nopo/nopo/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  optsIntoPreview,
  PREVIEW_DOWN_RESOURCE_KINDS,
  resolveNamespace,
} from "./index.ts";

/** Minimal project fixture — resolveRuntimeNamespace only reads
 * `project.runtimes[name].namespace`. `preview` binds a namespace; `prod`
 * declares none (so CI's NOPO_NAMESPACE=nopo-ci-* passes through).
 */
const projectStub = {
  runtimes: {
    preview: { plugin: "terraform", namespace: "nopo-prev" },
    prod: { plugin: "terraform" },
  },
};
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub; resolveRuntimeNamespace only reads project.runtimes
const project = projectStub as unknown as NormalizedProjectConfig;

describe("resolveNamespace — runtime→namespace binding", () => {
  const saved = process.env.NOPO_NAMESPACE;
  beforeEach(() => {
    delete process.env.NOPO_NAMESPACE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NOPO_NAMESPACE;
    else process.env.NOPO_NAMESPACE = saved;
  });

  it("derives the bound namespace from the runtime when no env is set", () => {
    expect(resolveNamespace(project, "preview")).toBe("nopo-prev");
  });

  it("HARD-ERRORS when NOPO_NAMESPACE conflicts with the runtime-derived namespace", () => {
    process.env.NOPO_NAMESPACE = "nopo-prod";
    expect(() => resolveNamespace(project, "preview")).toThrow(
      /Namespace conflict/,
    );
  });

  it("allows a matching NOPO_NAMESPACE (no throw)", () => {
    process.env.NOPO_NAMESPACE = "nopo-prev";
    expect(resolveNamespace(project, "preview")).toBe("nopo-prev");
  });

  it("passes NOPO_NAMESPACE through for a runtime with no bound namespace (CI nopo-ci-*)", () => {
    process.env.NOPO_NAMESPACE = "nopo-ci-abc123";
    expect(resolveNamespace(project, "prod")).toBe("nopo-ci-abc123");
  });

  it("falls back to nopo-dev when neither env nor a runtime namespace is set", () => {
    expect(resolveNamespace(project, "prod")).toBe("nopo-dev");
  });
});

describe("optsIntoPreview — product-plane opt-in filter", () => {
  const svc = (runtimeKeys: string[]): NormalizedService => {
    const runtimes = Object.fromEntries(runtimeKeys.map((k) => [k, {}]));
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal stub; optsIntoPreview only checks the runtimes keys
    return { runtimes } as unknown as NormalizedService;
  };

  it("includes services that declare a runtime.preview overlay", () => {
    expect(optsIntoPreview(svc(["default", "preview", "prod"]))).toBe(true);
  });

  it("excludes platform services with no preview overlay (db/llm-proxy/otel)", () => {
    expect(optsIntoPreview(svc(["default", "prod"]))).toBe(false);
  });

  it("excludes a service with no runtimes at all", () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- stub
    expect(optsIntoPreview({} as unknown as NormalizedService)).toBe(false);
  });
});

describe("PREVIEW_DOWN_RESOURCE_KINDS — workload-only teardown safety", () => {
  /** A preview teardown must delete workloads but NEVER the namespace shell
   * (namespace/RBAC/quota/priorityclass). Deleting the namespace was the
   * 2026-07-04 incident. Guard the list against ever regaining a shell kind.
   */
  it("never includes namespace-level shell resources", () => {
    const forbidden = [
      "namespace",
      "ns",
      "role",
      "rolebinding",
      "clusterrole",
      "clusterrolebinding",
      "resourcequota",
      "quota",
      "priorityclass",
      "serviceaccount",
    ];
    for (const kind of PREVIEW_DOWN_RESOURCE_KINDS) {
      expect(forbidden).not.toContain(kind);
    }
  });

  it("deletes exactly the ephemeral workload kinds", () => {
    expect([...PREVIEW_DOWN_RESOURCE_KINDS]).toEqual([
      "deployment",
      "service",
      "secret",
      "configmap",
      "pvc",
      // PDBs are emitted per multi-replica Deployment, so teardown owns them
      // too — a leaked PDB outlives the pods it was written for.
      "poddisruptionbudget",
    ]);
  });
});
