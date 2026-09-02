/** Guards service-level `env:` values that MUST survive into the prod k8s env. THE BUG:
 * `runtime.default.env` is not compose-only. The terraform plugin layers
 * `resolveRuntime(service.runtimes, ctx.runtime).envs.env` over service-level `env:`
 * (nopo/plugins/terraform/src/index.ts), and `resolveRuntime` seeds every named runtime
 */
import { describe, expect, it } from "vitest";

import { loadProjectConfig, resolveRuntime } from "../src/config/index.ts";
import { HAS_PRODUCT_GRAPH, PROJECT_ROOT } from "./utils.ts";

describe.skipIf(!HAS_PRODUCT_GRAPH)("prod env overlay", () => {
  it("keeps grafana's absolute root_url in the prod runtime", () => {
    const project = loadProjectConfig(PROJECT_ROOT);
    const grafana = project.services.entries.grafana!;

    expect(grafana.env?.GF_SERVER_ROOT_URL).toBeTruthy();

    // `default` must not shadow it — otherwise prod inherits the override.
    const prod = resolveRuntime(grafana.runtimes!, "prod");
    expect(prod.envs.env.GF_SERVER_ROOT_URL).toBeUndefined();
  });

  it("no service lets runtime.default.env shadow a service-level env key", () => {
    const project = loadProjectConfig(PROJECT_ROOT);
    const collisions: string[] = [];

    for (const [id, service] of Object.entries(project.services.entries)) {
      const serviceEnv = service.env;
      const defaultEnv = service.runtimes?.default?.env;
      if (!serviceEnv || !defaultEnv) continue;

      for (const key of Object.keys(defaultEnv)) {
        if (key in serviceEnv) collisions.push(`${id}.${key}`);
      }
    }

    expect(collisions).toEqual([]);
  });
});
