import { describe, expect, it } from "vitest";

import { serviceFromPodLabels } from "./index.ts";

/** `deployed-sha` keys its SHA map by SERVICE so the keys match `nopo build --changed --since`'s
 * service ids. Multi-process services label pods `<service>-<process>` (api-web/worker/admin);
 * keying by that raw `app` label left them absent from the map and falling back to the fleet baseline,
 * which intermittently SKIPPED their deploy — the deploy-gap that left admin-only api changes
 */
describe("serviceFromPodLabels", () => {
  it("strips the process suffix for multi-process services", () => {
    expect(serviceFromPodLabels("api-web", "web")).toBe("api");
    expect(serviceFromPodLabels("api-worker", "worker")).toBe("api");
    expect(serviceFromPodLabels("api-admin", "admin")).toBe("api");
  });

  it("passes single-process services through unchanged", () => {
    // No `nopo.process` label (empty) or the `default` process — `app` is
    // already the service id.
    expect(serviceFromPodLabels("db", "")).toBe("db");
    expect(serviceFromPodLabels("db", "default")).toBe("db");
    expect(serviceFromPodLabels("nginx", "")).toBe("nginx");
  });

  it("does not strip when the app label doesn't end with the process suffix", () => {
    // Defensive: a mismatched/legacy label must not get mangled.
    expect(serviceFromPodLabels("api", "web")).toBe("api");
    expect(serviceFromPodLabels("grafana", "server")).toBe("grafana");
  });

  it("handles a hyphenated process name correctly", () => {
    expect(serviceFromPodLabels("svc-pre-command", "pre-command")).toBe("svc");
  });
});
