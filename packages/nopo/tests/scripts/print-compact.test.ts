/** MT3 — `--print` reflects the post-compaction plan. These tests verify that `nopo build
 * --print` serializes the plan that actually runs (the post-compaction plan), and that
 * `--print=raw` opts back into the pre-compaction plan emitted by `static plan()`. The
 * harness injects a synthetic plugin with a `BatchSpec` onto the loaded
 */

/* eslint-disable @typescript-eslint/consistent-type-assertions -- JSON.parse + LoadedPlugin stub assembly in tests */
import process from "node:process";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Logger, Runner } from "../../src/lib.ts";
import { Environment } from "../../src/parse-env.ts";
import type { PlanNode, SerializedPlan } from "../../src/plan.ts";
import type { BatchSpec } from "../../src/plan-compact.ts";
import type { LoadedPlugin } from "../../src/plugin.ts";
import type { DryRunOutput } from "../../src/print.ts";
import BuildScript from "../../src/scripts/build.ts";
import { createFixtureConfig, createTmpEnv } from "../utils.ts";

// Mock exec to prevent side effects when scripts try to spawn (--print
// short-circuits before exec, but the mock makes the test path total).
vi.mock("../../src/lib.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib.ts")>();
  return {
    ...original,
    exec: vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        combined: "",
        signal: null,
      }),
    ),
  };
});

vi.mock("../../src/git-info.ts", () => ({
  GitInfo: {
    exists: () => false,
    parse: vi.fn(() => ({
      repo: "unknown",
      branch: "unknown",
      commit: "unknown",
    })),
    getChangedFiles: vi.fn(() => [] as string[]),
    getDefaultBranch: vi.fn(() => "main"),
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

function captureStdout(): {
  output: () => string;
  restore: () => void;
} {
  let captured = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    captured += chunk;
    return true;
  });
  return {
    output: () => captured,
    restore: () => spy.mockRestore(),
  };
}

/** Build a `BatchSpec` that claims every `build:exec` node and folds them into a single
 * `build:bake` coalesced node. Mirrors the shape the real docker plugin uses (see
 * `nopo/plugins/docker/src/index.ts` `batches:` array) — small enough to fit in the test,
 * faithful enough to exercise the same code path.
 */
function buildBakeBatchSpec(): BatchSpec {
  return {
    claims: (node: PlanNode) =>
      node.handler.kind === "builtin" && node.handler.name === "build:exec",
    coalesce: () => ({
      id: "build:bake",
      handler: { kind: "plugin-hook", plugin: "docker", hook: "bake" },
    }),
  };
}

function batchPlugin(): LoadedPlugin {
  return {
    definition: {
      name: "docker-stub",
      batches: [buildBakeBatchSpec()],
    },
    serviceConfigs: {},
  };
}

/** Drive the build script with `--print --json` through a Runner whose `project.plugins`
 * has been swapped for the supplied list. Returns the parsed `DryRunOutput`. We do NOT use
 * the shared `runScript` helper because we need to mutate `config.project.plugins` AFTER
 * `createFixtureConfig` (the fixture has zero plugins on disk).
 */
async function runWithPlugins(
  argv: string[],
  plugins: LoadedPlugin[],
): Promise<DryRunOutput> {
  const config = createFixtureConfig({
    envFile: createTmpEnv(),
    silent: true,
  });
  config.project.plugins = plugins;

  // The CLI accepts both bare `--print` and `--print=<mode>` forms. We need `--json`
  // whenever ANY `--print*` flag is present so the runner takes the JSON branch
  const hasPrint = argv.some(
    (a) => a === "--print" || a.startsWith("--print="),
  );
  const finalArgv =
    hasPrint && !argv.includes("--json") ? [...argv, "--json"] : argv;

  const stdout = captureStdout();
  try {
    const logger = new Logger(config);
    const environment = new Environment(config);
    const runner = new Runner(config, environment, finalArgv, logger);
    await runner.run(BuildScript);
    return JSON.parse(stdout.output().trim()) as DryRunOutput;
  } finally {
    stdout.restore();
  }
}

describe("--print reflects post-compaction plan (MT3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("default --print serializes the compacted plan", async () => {
    // The shared fixture root has every service/package under
    // `nopo/fixtures/{services,packages}` with a `build:` block as a buildable target
    const out = await runWithPlugins(["build", "--print"], [batchPlugin()]);

    const plan = out.plan!;
    const ids = plan.nodes.map((n) => n.id);
    // Compaction folded every per-target build node (`build:<target>`, emitted by
    // BuildScript.plan via a `build:exec` handler) into one batch node. The handler kind is
    expect(ids).toContain("build:bake");
    // None of the per-target build nodes (build:minimal/complex/shared/…) should remain — they
    // all folded into the batch node. Slot nodes (`pre_build`, `post_build`) survive.
    const slots = new Set(["pre_build", "post_build", "build:bake"]);
    const survivors = ids.filter(
      (id) => !slots.has(id) && id.startsWith("build:"),
    );
    expect(survivors).toEqual([]);

    const bake = plan.nodes.find((n) => n.id === "build:bake")!;
    expect(bake.handler).toEqual({
      kind: "plugin-hook",
      plugin: "docker",
      hook: "bake",
    });
    // The renderer-facing contract — meta.batchOf lists every original
    // node id that folded into this batch.
    expect(bake.meta?.batchOf).toEqual(
      expect.arrayContaining([
        "build:complex",
        "build:minimal",
        "build:shared",
      ]),
    );
  });

  it("--print=raw serializes the pre-compaction plan", async () => {
    const out = await runWithPlugins(["build", "--print=raw"], [batchPlugin()]);

    const plan = out.plan!;
    const ids = plan.nodes.map((n) => n.id);
    // Raw mode: the per-target build nodes are preserved and the synthetic build:bake batch
    // node is NOT present. BuildScript names these `build:<target>`; the BatchSpec keys off
    expect(ids).toContain("build:minimal");
    expect(ids).toContain("build:complex");
    expect(ids).toContain("build:shared");
    expect(ids).not.toContain("build:bake");

    // No `meta.batchOf` should appear in the raw plan — that field is
    // exclusively a compaction-pass output.
    for (const n of plan.nodes) {
      expect(n.meta?.batchOf).toBeUndefined();
    }
  });

  it("no plugin batches → compacted plan equals raw plan", async () => {
    // Sanity: when nothing declares batches, `--print` and
    // `--print=raw` produce identical plans (deep-equal).
    const compacted = await runWithPlugins(["build", "--print"], []);
    const raw = await runWithPlugins(["build", "--print=raw"], []);
    expect(compacted.plan).toEqual(raw.plan);
  });

  it("--print snapshot for a multi-service docker build (compacted)", async () => {
    // Snapshot the post-compaction plan so any future drift in compaction wiring (lib.ts →
    // collectDryRunInfo → compactPlan) shows up as a snapshot diff. The shared fixture root
    const out = await runWithPlugins(["build", "--print"], [batchPlugin()]);

    // (cwd-dependent file paths, env diffs etc) so the snapshot is deterministic across
    // machines. Keep just the structural shape of the plan + the resolved targets.
    const normalized = {
      command: out.command,
      finalTargets: [...out.finalTargets].sort(),
      plan: normalizePlanForSnapshot(out.plan),
    };
    expect(normalized).toMatchSnapshot();
  });
});

/** Strip payload-level fields that aren't load-bearing for the MT3 acceptance criterion
 * (compaction visibility) so the snapshot stays stable across unrelated payload churn.
 * Keeps `id`, `handler`, `needs`, `target`, and `meta.batchOf` — exactly the fields the
 * renderer + spec call out.
 */
function normalizePlanForSnapshot(plan: SerializedPlan | null): unknown {
  if (plan === null) return null;
  return {
    nodes: plan.nodes.map((n) => {
      const out: Record<string, unknown> = {
        id: n.id,
        handler: n.handler,
        needs: [...n.needs].sort(),
      };
      if (n.target !== undefined) out.target = n.target;
      const batchOf = n.meta?.batchOf;
      if (Array.isArray(batchOf)) {
        out.batchOf = [...batchOf].sort();
      }
      return out;
    }),
  };
}
