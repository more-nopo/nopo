import { describe, expect, it, vi } from "vitest";

import { Runner } from "../../src/lib.ts";
import BuildScript from "../../src/scripts/build.ts";
import UpScript from "../../src/scripts/up.ts";
import {
  createTestConfig,
  createTmpEnv,
  HAS_PRODUCT_GRAPH,
  runScript,
} from "../utils.ts";

vi.mock("../../src/scripts/build", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/scripts/build.ts")>();
  // Stub the static `plan` so the M8 dispatcher contract is satisfied (every script must
  // return a real {@link Plan}) without invoking the real builder. Tests assert against this
  const planSpy = vi.fn(() => ({ nodes: new Map() }));
  // Subclass keeps the real BuildScript intact for everything else
  // (dependencies wiring, enabled-checks, etc.).
  class StubBuildScript extends mod.default {
    static override plan = planSpy;
  }
  return {
    ...mod,
    default: StubBuildScript,
  };
});

vi.mock("../../src/lib.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/lib.ts")>();
  return {
    ...mod,
    exec: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/git-info", () => ({
  GitInfo: {
    exists: () => false,
    parse: vi.fn(() => ({
      repo: "unknown",
      branch: "unknown",
      commit: "unknown",
    })),
  },
}));

vi.mock("node:net", () => ({
  default: {
    createServer: vi.fn().mockImplementation(() => ({
      listen: vi.fn(),
      address: vi.fn().mockReturnValue({ port: 80 }),
      close: vi.fn(),
    })),
  },
}));

describe.skipIf(!HAS_PRODUCT_GRAPH)("up", () => {
  it("targets the runtime-map's plugin (and surfaces it by name on dispatch failure)", async () => {
    // The root nopo.yml `runtimes: { default: docker-compose, ... }` makes
    // resolveRuntimePlugin() pick "docker-compose" and fireOverride targets that plugin
    const config = createTestConfig({
      envFile: createTmpEnv(),
      silent: true,
    });
    await expect(runScript(UpScript, config)).rejects.toThrow(
      /Plugin "docker-compose" not registered/,
    );
  });

  describe("dependencies", () => {
    it("has build dependency enabled for local images", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv(),
        processEnv: {
          DOCKER_TAG: "local",
        },
        silent: true,
      });
      await runScript(UpScript, config).catch(() => {});
      // After the M8 dispatcher collapse, BuildScript executes via its `static plan()` rather
      // than `fn()`. Auto-mocked plan is what Runner.run() reaches for when the build dependency
      expect(BuildScript.plan).toHaveBeenCalled();
    });

    it("enables build when DOCKER_BUILD is set", () => {
      const buildDep = UpScript.dependencies.find(
        (dep) => dep.class === BuildScript,
      );

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial Runner for testing dependency enabled check
      const forceBuilderRunner = {
        config: {
          processEnv: { DOCKER_BUILD: "true" },
        },
        environment: { env: { DOCKER_VERSION: "1.0.0" } },
      } as unknown as Runner;

      if (buildDep && typeof buildDep.enabled === "function") {
        expect(buildDep.enabled(forceBuilderRunner)).toBe(true);
      }
    });
  });
});
