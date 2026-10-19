/* Adversarial repros for PR #37. Each test asserts the CORRECT behavior and is expected to FAIL on the branch. */
import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StepCache, loadCacheConfig, generateSigningKeypair } from "./index.ts";
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
  payload: { commandName: "test", stageIndex: 0, task: { service: target, command: "test", executable: "vitest run", cache: true } },
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

describe("PR#37 additional fixes", () => {
  it("container context steps are never cacheable", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    // Node with contextOverride === "container"
    const containerNode: PlanNode = {
      id: "cmd:0:api:test-container",
      handler: { kind: "builtin", name: "command:exec" },
      needs: [],
      target: "api",
      payload: { commandName: "test", contextOverride: "container" },
    };
    const c = (await StepCache.create(cfg(), { project: p, repoRoot: repo, env: {} }))!;
    const result = await c.lookup(containerNode);
    expect(result.hit).toBe(false);
    expect(result.stepKey).toBe(null);
    expect(result.bypassed).toBe(true);
    expect(result.bypassReason).toContain("container context");
  });

  it("Ed25519 signing: unsigned entries rejected when public key is configured", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    const node = cmdNode("api");
    const { publicKey } = generateSigningKeypair();
    // Warm cache WITHOUT private key (no signature)
    await warm(p, node);
    // Try to read WITH public key - should reject unsigned entry
    const c = (await StepCache.create(cfg({ signingPublicKey: publicKey }), { project: p, repoRoot: repo, env: {} }))!;
    const result = await c.lookup(node);
    expect(result.hit).toBe(false);
  });

  it("Ed25519 signing: signed entries accepted when keypair matches", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    const node = cmdNode("api");
    const { privateKey, publicKey } = generateSigningKeypair();
    // Warm cache WITH private key (entry will be signed)
    const c1 = (await StepCache.create(cfg({ signingPrivateKey: privateKey, signingPublicKey: publicKey }), { project: p, repoRoot: repo, env: {} }))!;
    const k = (await c1.lookup(node)).stepKey;
    await c1.record(k, true, 10, node);
    // Read with same public key - should accept
    const c2 = (await StepCache.create(cfg({ signingPublicKey: publicKey }), { project: p, repoRoot: repo, env: {} }))!;
    const result = await c2.lookup(node);
    expect(result.hit).toBe(true);
  });

  it("Ed25519 signing: signed entries rejected with wrong public key", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    const node = cmdNode("api");
    const keyPair1 = generateSigningKeypair();
    const keyPair2 = generateSigningKeypair();
    // Warm cache WITH keypair1
    const c1 = (await StepCache.create(cfg({ signingPrivateKey: keyPair1.privateKey, signingPublicKey: keyPair1.publicKey }), { project: p, repoRoot: repo, env: {} }))!;
    const k = (await c1.lookup(node)).stepKey;
    await c1.record(k, true, 10, node);
    // Read with keypair2's public key - should reject (wrong key)
    const c2 = (await StepCache.create(cfg({ signingPublicKey: keyPair2.publicKey }), { project: p, repoRoot: repo, env: {} }))!;
    const result = await c2.lookup(node);
    expect(result.hit).toBe(false);
  });

  it("Ed25519 signing: write skipped when public key configured but no private key", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    const node = cmdNode("api");
    const { publicKey } = generateSigningKeypair();
    // Try to warm with public key but no private key - should skip write
    const c1 = (await StepCache.create(cfg({ signingPublicKey: publicKey }), { project: p, repoRoot: repo, env: {} }))!;
    const k = (await c1.lookup(node)).stepKey;
    await c1.record(k, true, 10, node);
    // Should not have written the entry
    const c2 = (await StepCache.create(cfg({}), { project: p, repoRoot: repo, env: {} }))!;
    const result = await c2.lookup(node);
    expect(result.hit).toBe(false);
  });

  it("cache.env in service config affects key", async () => {
    // Service with cache.env declaring MY_VAR
    const svcWithEnv = {
      ...svc(`${repo}/packages/api`),
      cache: { env: ["MY_VAR"] },
    };
    const p = project({ api: svcWithEnv });
    const node = cmdNode("api");
    // Warm with MY_VAR=value1
    const c1 = (await StepCache.create(cfg(), { project: p, repoRoot: repo, env: { MY_VAR: "value1" } }))!;
    const k1 = (await c1.lookup(node)).stepKey;
    await c1.record(k1, true, 10, node);
    // Read with MY_VAR=value2 - should miss (different key)
    const c2 = (await StepCache.create(cfg(), { project: p, repoRoot: repo, env: { MY_VAR: "value2" } }))!;
    const r = await c2.lookup(node);
    expect(r.hit).toBe(false);
    // Keys should differ
    expect(r.stepKey?.key).not.toBe(k1?.key);
  });

  it("plugin hook includes plugin source hash in key", async () => {
    // Create a fake plugin file
    const pluginPath = path.join(repo, "plugin.ts");
    fs.writeFileSync(pluginPath, "export function lint() {}");
    sh("git -c user.email=a@b -c user.name=a add -A && git -c user.email=a@b -c user.name=a commit -qm plugin");

    const pluginNode: PlanNode = {
      id: "eslint:lint:api",
      handler: { kind: "plugin-hook", plugin: "eslint", hook: "lint" },
      needs: [],
      target: "api",
      meta: { cacheOptIn: { api: true } },
    };
    const p = {
      services: { entries: { api: svc(`${repo}/packages/api`) } },
      plugins: [{ definition: { name: "eslint", cacheableHooks: { lint: {} } }, serviceConfigs: {} }],
      pluginRefs: [{ name: "eslint", path: "./plugin.ts" }],
      configPath: path.join(repo, "nopo.yml"),
    } as never;

    const c1 = (await StepCache.create(cfg(), { project: p, repoRoot: repo, env: {} }))!;
    const k1 = (await c1.lookup(pluginNode)).stepKey;
    await c1.record(k1, true, 10, pluginNode);

    // Modify plugin source
    fs.writeFileSync(pluginPath, "export function lint() { /* changed */ }");
    sh("git -c user.email=a@b -c user.name=a commit -qam update-plugin");

    const c2 = (await StepCache.create(cfg(), { project: p, repoRoot: repo, env: {} }))!;
    const k2 = (await c2.lookup(pluginNode)).stepKey;
    // Key should differ due to plugin source change
    expect(k2?.key).not.toBe(k1?.key);
  });

  it("skipped steps emit node-skip plan events", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    await warm(p, cmdNode("api"));
    const events: Array<{ type: string; nodeId?: string }> = [];
    const io = { env: {}, stdout: { write: () => true }, stderr: { write: () => true } } as never;
    await executePlanWithCache(planFromNodes([cmdNode("api")]), {
      io,
      project: p,
      repoRoot: repo,
      cache: cfg(),
      dispatch: { builtin: async () => {}, pluginHook: async () => {} },
      onEvent: (e: { type: string; nodeId?: string }) => events.push(e),
    } as never);
    const skipEvent = events.find(e => e.type === "node-skip");
    expect(skipEvent).toBeDefined();
    expect(skipEvent?.nodeId).toBe("cmd:0:api:test");
  });
});
