import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { yamlPodDisruptionBudget } from "./index.ts";

/** A PDB keeps a node drain from taking every replica of a Deployment at once. It is emitted ONLY for
 * `replicas >= 2` — a PDB with `maxUnavailable: 1` over a single replica makes that pod undrainable,
 * so `kubectl drain` (and any Talos node upgrade) blocks forever.
 */

describe("yamlPodDisruptionBudget", () => {
  it("emits maxUnavailable: 1 with a selector matching the Deployment's app label", () => {
    const yaml = yamlPodDisruptionBudget("api-web", "nopo-prod", 2);
    expect(yaml).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- yaml parse returns unknown
    const doc = parse(yaml!) as Record<string, unknown>;

    expect(doc).toMatchObject({
      apiVersion: "policy/v1",
      kind: "PodDisruptionBudget",
      metadata: {
        name: "api-web",
        namespace: "nopo-prod",
        labels: { "app.kubernetes.io/managed-by": "nopo" },
      },
      spec: {
        maxUnavailable: 1,
        selector: { matchLabels: { app: "api-web" } },
      },
    });
  });

  it("emits nothing for a single-replica Deployment", () => {
    expect(yamlPodDisruptionBudget("db", "nopo-prod", 1)).toBeNull();
  });

  it("emits nothing for a zero-replica Deployment", () => {
    expect(yamlPodDisruptionBudget("scaled-down", "nopo-prod", 0)).toBeNull();
  });

  it("emits for replica counts above two", () => {
    expect(yamlPodDisruptionBudget("web", "nopo-prod", 5)).toContain(
      "maxUnavailable: 1",
    );
  });
});
