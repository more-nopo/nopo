import type { NormalizedService } from "@more-nopo/nopo/config";
import { describe, expect, it } from "vitest";

import { isDeployableWorkload } from "./index.ts";

/** `isDeployableWorkload` only reads `build` and `image`, so a minimal stub is enough. Regression guard
 * for the release break where a CLI-only control-plane service (infrastructure/stripe-tf) with neither
 * a Dockerfile nor an upstream image got a Deployment that ImagePullBackOff'd on a nonexistent
 * `nopo-stripe-tf` image.
 */
function svc(fields: { build?: unknown; image?: string }): NormalizedService {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: only build/image are read
  return fields as NormalizedService;
}

describe("isDeployableWorkload", () => {
  it("is true for a service with its own Dockerfile (build)", () => {
    expect(isDeployableWorkload(svc({ build: { context: "." } }))).toBe(true);
  });

  it("is true for a service pinning an upstream image", () => {
    expect(isDeployableWorkload(svc({ image: "postgres:16" }))).toBe(true);
  });

  it("is false for a CLI-only control plane (no build, no image)", () => {
    expect(isDeployableWorkload(svc({}))).toBe(false);
  });
});
