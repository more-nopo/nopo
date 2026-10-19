/* Plugin hooks are cacheable only by explicit plugin declaration plus command opt-in;
 * per-target batches key each target separately. */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compactPlan } from "../plan-compact.ts";
import { planFromNodes, type PlanNode } from "../plan.ts";
import { buildStepKeyInputs, computeStepKey, isHandlerCacheable } from "./cache-key.ts";
import { loadCacheConfig } from "./index.ts";
import { executePlanWithCache } from "./plan-cache.ts";

let repo: string;
let cacheDir: string;
const sh = (c: string) => execSync(c, { cwd: repo, stdio: "pipe" }).toString();
const commit = (m: string) => sh(`git -c user.email=a@b -c user.name=a add -A && git -c user.email=a@b -c user.name=a commit -qm ${m}`);

function svc(root: string, deps: string[] = []) {
  return { paths: { root }, buildDeps: deps, runtimeDeps: [], systemDeps: [], packageManagers: [] };
}
function project(cacheableHooks?: Record<string, { perTarget?: boolean }>, names = ["api", "web"]) {
  const entries = Object.fromEntries(names.map((n) => [n, svc(`${repo}/packages/${n}`)]));
  return {
    services: { entries },
    plugins: [{ definition: { name: "eslint", hooks: {}, ...(cacheableHooks ? { cacheableHooks } : {}) }, serviceConfigs: {} }],
  } as never;
}
function cfg(extra: Record<string, unknown> = {}) {
  return loadCacheConfig({}, {
    enabled: true, writeEnabled: true, samplingPercent: 0,
    store: { type: "filesystem", filesystem: { baseDir: cacheDir } }, ...extra,
  });
}
const batch = (targets: string[], optIn: Record<string, unknown> | undefined, args?: string[]): PlanNode => ({
  id: "eslint:batch",
  handler: { kind: "plugin-hook", plugin: "eslint", hook: "lintBatch" },
  needs: [],
  payload: args ? { targets, args } : { targets },
  ...(optIn ? { meta: { cacheOptIn: optIn } } : {}),
});
const lintExec = (target: string, cache?: unknown): PlanNode => ({
  id: `cmd:0:${target}:lint`,
  handler: { kind: "builtin", name: "command:exec" },
  needs: [],
  target,
  payload: { commandName: "lint", stageIndex: 0, task: { service: target, command: "lint", plugin: "eslint", ...(cache !== undefined ? { cache } : {}) } },
});

function runPlan(p: never, node: PlanNode, seen: string[][], extra: Record<string, unknown> = {}) {
  const io = { env: {}, stdout: { write: () => true }, stderr: { write: () => true } } as never;
  return executePlanWithCache(planFromNodes([node]), {
    io, project: p, repoRoot: repo, cache: cfg(extra),
    dispatch: {
      builtin: async () => {},
      pluginHook: async (n: PlanNode) => { seen.push([...((n.payload as { targets: string[] }).targets)]); },
    },
  } as never);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "popt-"));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "poptc-"));
  for (const d of ["packages/api", "packages/web"]) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
    fs.writeFileSync(path.join(repo, d, "index.ts"), "export const x = 1;\n");
  }
  fs.writeFileSync(path.join(repo, "bun.lock"), "{}\n");
  sh("git init -q");
  commit("init");
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(cacheDir, { recursive: true, force: true }); });

describe("plugin hook cache opt-in", () => {
  it("a hook the plugin does not declare is never cacheable, even if commands opted in", () => {
    const r = isHandlerCacheable(batch(["api"], { api: true }), project());
    expect(r.cacheable).toBe(false);
    expect(r.reason).toBe("plugin eslint does not declare hook lintBatch cacheable");
  });

  it("no project means no plugin hook is cacheable", () => {
    expect(isHandlerCacheable(batch(["api"], { api: true })).cacheable).toBe(false);
  });

  it("a declared hook still needs every served target to opt in", () => {
    const p = project({ lintBatch: {} });
    expect(isHandlerCacheable(batch(["api"], undefined), p).cacheable).toBe(false);
    const partial = isHandlerCacheable(batch(["api", "web"], { api: true, web: null }), p);
    expect(partial.cacheable).toBe(false);
    expect(partial.reason).toContain("web");
    expect(isHandlerCacheable(batch(["api", "web"], { api: true, web: {} }), p).cacheable).toBe(true);
  });

  it("write-mode flags in delegated batch args are never cacheable", () => {
    const p = project({ lintBatch: {} });
    const r = isHandlerCacheable(batch(["api"], { api: true }, ["--fix"]), p);
    expect(r.cacheable).toBe(false);
    expect(r.reason).toContain("--fix");
  });

  it("write-mode flags in a command's delegated args are never cacheable", () => {
    const node = lintExec("api", true);
    (node.payload as { task: { args?: string[] } }).task.args = ["--fix"];
    expect(isHandlerCacheable(node, project()).cacheable).toBe(false);
  });

  it("whole-batch key misses after a committed change to a claimed target", async () => {
    const p = project({ lintBatch: {} });
    const node = batch(["api", "web"], { api: true, web: true });
    const seen: string[][] = [];
    await runPlan(p, node, seen);
    await runPlan(p, node, seen);
    expect(seen).toEqual([["api", "web"]]); // second run fully cached
    fs.writeFileSync(path.join(repo, "packages/api/index.ts"), "var unused = 1;\n");
    commit("api");
    await runPlan(p, node, seen);
    expect(seen).toEqual([["api", "web"], ["api", "web"]]); // whole batch re-runs
  });
});

describe("per-target batch keys", () => {
  it("a changed target re-runs alone; unchanged targets are served from cache", async () => {
    const p = project({ lintBatch: { perTarget: true } });
    const node = batch(["api", "web"], { api: true, web: true });
    const seen: string[][] = [];
    await runPlan(p, node, seen);
    expect(seen).toEqual([["api", "web"]]);

    const second = await runPlan(p, node, seen);
    expect(seen).toHaveLength(1); // fully skipped
    expect(second.cacheHits).toBe(2);
    expect(second.ok).toBe(true);

    fs.writeFileSync(path.join(repo, "packages/web/index.ts"), "export const x = 2;\n");
    commit("web");
    await runPlan(p, node, seen);
    expect(seen[1]).toEqual(["web"]);

    await runPlan(p, node, seen);
    expect(seen).toHaveLength(2);
  });

  it("targets that did not opt in always run and are never recorded", async () => {
    const p = project({ lintBatch: { perTarget: true } });
    const node = batch(["api", "web"], { api: true, web: null });
    const seen: string[][] = [];
    await runPlan(p, node, seen);
    await runPlan(p, node, seen);
    expect(seen).toEqual([["api", "web"], ["web"]]);
  });

  it("a failing batch records nothing", async () => {
    const p = project({ lintBatch: { perTarget: true } });
    const node = batch(["api", "web"], { api: true, web: true });
    const io = { env: {}, stdout: { write: () => true }, stderr: { write: () => true } } as never;
    await executePlanWithCache(planFromNodes([node]), {
      io, project: p, repoRoot: repo, cache: cfg(),
      dispatch: { builtin: async () => {}, pluginHook: async () => { throw new Error("lint failed"); } },
    } as never);
    const seen: string[][] = [];
    await runPlan(p, node, seen);
    expect(seen).toEqual([["api", "web"]]);
  });

  it("a dirty target bypasses only its own slice", async () => {
    const p = project({ lintBatch: { perTarget: true } });
    const node = batch(["api", "web"], { api: true, web: true });
    const seen: string[][] = [];
    await runPlan(p, node, seen);
    fs.writeFileSync(path.join(repo, "packages/api/index.ts"), "uncommitted\n");
    await runPlan(p, node, seen);
    expect(seen[1]).toEqual(["api"]);
  });

  it("per-target key does not depend on which other targets share the batch", () => {
    const p = project({ lintBatch: { perTarget: true } });
    const key = (n: PlanNode) => computeStepKey(buildStepKeyInputs(n, p, repo, [], {}).inputs!).key;
    const solo = { ...batch(["web"], { web: true }), id: "eslint:batch#web" };
    const fromPair = { ...batch(["web"], { web: true }), id: "other" };
    expect(key(solo)).toBe(key(fromPair));
  });
});

describe("command-level cache declarations feed the key", () => {
  it("cache.env values change the key", () => {
    const p = project();
    const node = lintExec("api", { env: ["LINT_STRICT"] });
    (node.handler as { name: string }).name = "command:exec";
    const k = (env: Record<string, string>) => computeStepKey(buildStepKeyInputs(node, p, repo, [], env).inputs!).key;
    expect(k({ LINT_STRICT: "1" })).not.toBe(k({ LINT_STRICT: "0" }));
  });

  it("cache.inputs content changes the key", () => {
    fs.writeFileSync(path.join(repo, "packages/api/.generated.json"), "{}\n");
    const p = project();
    const node = lintExec("api", { inputs: [".generated.json"] });
    const k = () => computeStepKey(buildStepKeyInputs(node, p, repo, [], {}).inputs!).key;
    const before = k();
    fs.writeFileSync(path.join(repo, "packages/api/.generated.json"), '{"a":1}\n');
    expect(k()).not.toBe(before);
  });

  it("cache.inputs resolving outside the repo makes the step uncacheable", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "popt-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "x\n");
    const rel = path.relative(path.join(repo, "packages/api"), path.join(outside, "secret.txt"));
    const r = buildStepKeyInputs(lintExec("api", { inputs: [rel] }), project(), repo, [], {});
    expect(r.inputs).toBeNull();
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("batch keys include every claimed target's declarations, not just the first", () => {
    const p = project({ lintBatch: {} });
    const node = batch(["api", "web"], { api: true, web: { env: ["WEB_FLAG"] } });
    const k = (env: Record<string, string>) => computeStepKey(buildStepKeyInputs(node, p, repo, [], env).inputs!).key;
    expect(k({ WEB_FLAG: "a" })).not.toBe(k({ WEB_FLAG: "b" }));
  });
});

describe("plan compaction stamps per-target opt-in", () => {
  it("records each claimed command's cache declaration in meta.cacheOptIn", () => {
    const plan = planFromNodes([lintExec("api", true), lintExec("web")]);
    const ctx = {
      services: {}, env: {}, args: {},
      project: { plugins: [{ definition: { name: "eslint", batches: [{
        claims: (n: PlanNode) => (n.payload as { task?: { plugin?: string } })?.task?.plugin === "eslint",
        coalesce: (claimed: readonly PlanNode[]) => ({
          id: "eslint:batch",
          handler: { kind: "plugin-hook" as const, plugin: "eslint", hook: "lintBatch" },
          payload: { targets: claimed.map((n) => n.target!) },
        }),
      }] }, serviceConfigs: {} }] },
    } as never;
    const out = compactPlan(plan, ctx);
    expect(out.nodes.get("eslint:batch")!.meta).toEqual({
      batchOf: ["cmd:0:api:lint", "cmd:0:web:lint"],
      cacheOptIn: { api: true, web: null },
    });
  });

  it("leaves meta unchanged when no claimed command opted in", () => {
    const plan = planFromNodes([lintExec("api"), lintExec("web")]);
    const ctx = {
      services: {}, env: {}, args: {},
      project: { plugins: [{ definition: { name: "eslint", batches: [{
        claims: () => true,
        coalesce: () => ({ id: "b", handler: { kind: "plugin-hook" as const, plugin: "eslint", hook: "lintBatch" } }),
      }] }, serviceConfigs: {} }] },
    } as never;
    expect(compactPlan(plan, ctx).nodes.get("b")!.meta).toEqual({ batchOf: ["cmd:0:api:lint", "cmd:0:web:lint"] });
  });
});


describe("S3 store availability probe", () => {
  it("probes an object (not the bucket) and treats 403 as unavailable", async () => {
    const http = await import("node:http");
    const { S3Store } = await import("./stores/s3.ts");
    const paths: string[] = [];
    let status = 404;
    const srv = http.createServer((req, res) => { paths.push(`${req.method} ${req.url}`); res.writeHead(status); res.end(); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    const store = new S3Store({ endpoint: `http://127.0.0.1:${port}`, bucket: "b", accessKeyId: "a", secretAccessKey: "s", ttlSeconds: 60 });
    try {
      expect(await store.isAvailable()).toBe(true);
      expect(paths[0]).toMatch(/^HEAD \/b\/nopo-cache\/__nopo_probe__\.json/);
      status = 403;
      expect(await store.isAvailable()).toBe(false);
    } finally {
      srv.close();
    }
  });
});
