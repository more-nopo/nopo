/* Adversarial repros for PR #37. Each test asserts the CORRECT behavior and is expected to FAIL on the branch. */
import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StepCache, loadCacheConfig } from "./index.ts";
import { executePlanWithCache } from "./plan-cache.ts";
import { planFromNodes, type PlanNode } from "../plan.ts";

let repo: string;
let cacheDir: string;
const sh = (c: string) => execSync(c, { cwd: repo, stdio: "pipe" }).toString();

function svc(root: string, deps: string[] = []) {
  return { paths: { root }, buildDeps: deps, runtimeDeps: [], systemDeps: [], packageManagers: [] };
}
function project(entries: Record<string, unknown>) {
  return { services: { entries }, plugins: [] } as never;
}
function cfg(extra: Record<string, unknown> = {}) {
  return loadCacheConfig({}, {
    enabled: true, writeEnabled: true, samplingPercent: 0,
    store: { type: "filesystem", filesystem: { baseDir: cacheDir } }, ...extra,
  });
}
const cmdNode = (target: string): PlanNode => ({
  id: `cmd:0:${target}:test`, handler: { kind: "builtin", name: "command:exec" }, needs: [], target,
  payload: { commandName: "test", stageIndex: 0, task: { service: target, command: "test", executable: "vitest run" } },
});
async function warm(p: never, node: PlanNode) {
  const c = (await StepCache.create(cfg(), { project: p, repoRoot: repo, env: {} }))!;
  const k = (await c.lookup(node)).stepKey;
  await c.record(k, true, 10, node);
}
async function hit(p: never, node: PlanNode, extra = {}) {
  const c = (await StepCache.create(cfg(extra), { project: p, repoRoot: repo, env: {} }))!;
  return c.lookup(node);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "r37-"));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "r37c-"));
  for (const d of ["packages/api", "packages/shared", "packages/core"]) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
    fs.writeFileSync(path.join(repo, d, "index.ts"), "export const x = 1;\n");
  }
  fs.writeFileSync(path.join(repo, "tsconfig.base.json"), '{"strict":true}\n');
  fs.writeFileSync(path.join(repo, "bun.lock"), "{}\n");
  sh("git init -q && git -c user.email=a@b -c user.name=a add -A && git -c user.email=a@b -c user.name=a commit -qm init");
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(cacheDir, { recursive: true, force: true }); });

describe("PR#37 repros", () => {
  it("R1 transitive dep with uncommitted edit must bypass (api -> shared -> core)", async () => {
    const p = project({ api: svc(`${repo}/packages/api`, ["shared"]), shared: svc(`${repo}/packages/shared`, ["core"]), core: svc(`${repo}/packages/core`) });
    await warm(p, cmdNode("api"));
    fs.writeFileSync(path.join(repo, "packages/core/index.ts"), "export const x = BROKEN;\n");
    const r = await hit(p, cmdNode("api"));
    expect(r.hit).toBe(false);
  });

  it("R2 root target (paths.root === repoRoot) with uncommitted edit must bypass", async () => {
    const p = project({ root: svc(repo) });
    await warm(p, cmdNode("root"));
    fs.writeFileSync(path.join(repo, "packages/api/index.ts"), "BROKEN\n");
    const r = await hit(p, cmdNode("root"));
    expect(r.hit).toBe(false);
  });

  it("R3 committed change to root-level config (tsconfig.base.json) must change api's key", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    await warm(p, cmdNode("api"));
    fs.writeFileSync(path.join(repo, "tsconfig.base.json"), '{"strict":false,"noEmit":"bogus"}\n');
    sh("git -c user.email=a@b -c user.name=a commit -qam cfg");
    const r = await hit(p, cmdNode("api"));
    expect(r.hit).toBe(false);
  });

  it("R4 target-less batch node (eslint:batch) must not hit after target code changes", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    const batch: PlanNode = { id: "eslint:batch", handler: { kind: "plugin-hook", plugin: "eslint", hook: "lintBatch" }, needs: [], payload: { targets: ["api"] } };
    await warm(p, batch);
    fs.writeFileSync(path.join(repo, "packages/api/index.ts"), "var unused = 1; debugger;\n");
    sh("git -c user.email=a@b -c user.name=a commit -qam lint-violation");
    const r = await hit(p, batch);
    expect(r.hit).toBe(false);
  });

  it("R5 side-effect builtin (install:run) must never be skipped", async () => {
    const p = project({});
    const plan = planFromNodes([{ id: "install", handler: { kind: "builtin", name: "install:run" }, needs: [] }]);
    let calls = 0;
    const io = { env: {}, stdout: { write: () => true }, stderr: { write: () => true } } as never;
    const ctx = { io, project: p, repoRoot: repo, cache: cfg(), dispatch: { builtin: async () => { calls++; }, pluginHook: async () => {} } } as never;
    await executePlanWithCache(plan, ctx);
    await new Promise((r) => setTimeout(r, 50));
    await executePlanWithCache(plan, ctx);
    expect(calls).toBe(2);
  });

  it("R6 sampled verification that FAILS must invalidate the cached pass", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    const node = cmdNode("api");
    await warm(p, node);
    const v = (await StepCache.create(cfg({ samplingPercent: 100 }), { project: p, repoRoot: repo, env: {} }))!;
    const lr = await v.lookup(node);
    expect(lr.shouldVerify).toBe(true);
    await v.record(lr.stepKey, false, 10, node); // verification run failed
    const r = await hit(p, node);
    expect(r.hit).toBe(false);
  });

  it("R7 poisoned entry: passed:\"false\" string / far-future expiresAt / mismatched key must not hit", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    const node = cmdNode("api");
    const k = (await hit(p, node)).stepKey!.key;
    fs.mkdirSync(path.join(cacheDir, k.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, k.slice(0, 2), `${k}.json`), JSON.stringify({ key: "attacker", passed: "false", durationMs: 1, createdAt: "2000-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" }));
    const r = await hit(p, node);
    expect(r.hit).toBe(false);
  });

  it("R8 S3 store GET that never responds must not hang the run (needs timeout)", async () => {
    const srv = http.createServer((req, res) => { if (req.method === "HEAD") { res.writeHead(200); res.end(); } /* GET: hang */ });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    const p = project({ api: svc(`${repo}/packages/api`) });
    const c = (await StepCache.create(cfg({ store: { type: "s3", s3: { endpoint: `http://127.0.0.1:${port}`, bucket: "b", accessKeyId: "a", secretAccessKey: "s" } } }), { project: p, repoRoot: repo, env: {} }))!;
    const res = await Promise.race([c.lookup(cmdNode("api")).then(() => "done"), new Promise((r) => setTimeout(() => r("hung"), 3000))]);
    srv.closeAllConnections(); srv.close();
    expect(res).toBe("done");
  }, 10000);

  it("R9 results must be persisted before executePlanWithCache resolves (CLI calls io.exit right after)", async () => {
    let putDone = false;
    const srv = http.createServer((req, res) => {
      if (req.method === "HEAD") { res.writeHead(200); return res.end(); }
      if (req.method === "GET") { res.writeHead(404); return res.end(); }
      req.resume(); req.on("end", () => setTimeout(() => { putDone = true; res.writeHead(200); res.end(); }, 300));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    const p = project({ api: svc(`${repo}/packages/api`) });
    const io = { env: {}, stdout: { write: () => true }, stderr: { write: () => true } } as never;
    await executePlanWithCache(planFromNodes([cmdNode("api")]), { io, project: p, repoRoot: repo,
      cache: cfg({ store: { type: "s3", s3: { endpoint: `http://127.0.0.1:${port}`, bucket: "b", accessKeyId: "a", secretAccessKey: "s" } } }),
      dispatch: { builtin: async () => {}, pluginHook: async () => {} } } as never);
    const done = putDone;
    await new Promise((r) => setTimeout(r, 500)); srv.close();
    expect(done).toBe(true);
  }, 10000);
});
