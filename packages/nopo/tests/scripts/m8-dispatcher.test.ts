import { describe, expect, it, vi } from "vitest";

import { BaseScript, LegacyScript, Runner, Script } from "../../src/lib.ts";
import { Environment } from "../../src/parse-env.ts";
import { createTestConfig, createTmpEnv } from "../utils.ts";

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

function makeRunner(_script: typeof BaseScript) {
  const config = createTestConfig({ envFile: createTmpEnv(), silent: true });
  const environment = new Environment(config);
  /* eslint-disable @typescript-eslint/consistent-type-assertions -- test stub: anonymous class shape-matches Runner's logger; cast through unknown to its parameter slot */
  const logger = new (class {
    log() {}
    error() {}
    chalk: Record<string, (s: string) => string> = new Proxy(
      {},
      { get: () => (s: string) => s },
    );
  })() as unknown as ConstructorParameters<typeof Runner>[3];
  /* eslint-enable @typescript-eslint/consistent-type-assertions */
  return new Runner(config, environment, [], logger);
}

describe("M8 Runner.run() collapse", () => {
  it("throws the spec's verbatim error for scripts missing static plan()", async () => {
    class NoPlanScript extends Script {
      static override name = "no-plan";
      static override description = "missing plan()";
    }
    const runner = makeRunner(NoPlanScript);
    await expect(runner.run(NoPlanScript)).rejects.toThrow(
      `Script "no-plan" must implement static plan() — fn() is no longer supported on built-in scripts`,
    );
  });

  it("LegacyScript routes through executePlan via its default plan()", async () => {
    let fnCalled = false;
    class MyLegacyScript extends LegacyScript {
      static override name = "my-legacy";
      static override description = "legacy script";

      override async fn(): Promise<void> {
        fnCalled = true;
      }
    }
    const runner = makeRunner(MyLegacyScript);
    await runner.run(MyLegacyScript);
    expect(fnCalled).toBe(true);
  });

  it("LegacyScript.plan() returns a single legacy:fn node", () => {
    class MyLegacyScript extends LegacyScript {
      static override name = "my-legacy-2";
      static override description = "legacy script";

      override async fn(): Promise<void> {}
    }
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions -- accessing static plan helper directly */
    const plan = (MyLegacyScript as any).plan({}, {});
    expect(plan.nodes.size).toBe(1);
    const node = plan.nodes.get("legacy");
    expect(node?.handler).toMatchObject({ kind: "builtin", name: "legacy:fn" });
  });

  it("LegacyScript subclass that throws in fn() surfaces the error from runViaPlan", async () => {
    class FailingLegacyScript extends LegacyScript {
      static override name = "failing-legacy";
      static override description = "throws";

      override async fn(): Promise<void> {
        throw new Error("legacy fn boom");
      }
    }
    const runner = makeRunner(FailingLegacyScript);
    await expect(runner.run(FailingLegacyScript)).rejects.toThrow(
      "legacy fn boom",
    );
  });
});
