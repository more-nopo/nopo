/* Second-pass repros for PR #37 @ 6e7ab7b. Each asserts CORRECT behavior; expected to FAIL on the branch. */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StepCache, loadCacheConfig, getDeclaredEnvInputs } from "./index.ts";
import { buildStepKeyInputs, computeStepKey } from "./cache-key.ts";
import { loadProjectConfig } from "../config/index.ts";
import type { PlanNode } from "../plan.ts";

let repo: string;
let cacheDir: string;
const sh = (c: string) => execSync(c, { cwd: repo, stdio: "pipe" }).toString();
const commit = (m: string) => sh(`git -c user.email=a@b -c user.name=a add -A && git -c user.email=a@b -c user.name=a commit -qm ${m}`);
const svc = (root: string, deps: string[] = []) => ({ paths: { root }, buildDeps: deps, runtimeDeps: [], systemDeps: [], packageManagers: [] });
const project = (entries: Record<string, unknown>, plugins: unknown[] = []) => ({ services: { entries }, plugins } as never);
const cfg = (extra: Record<string, unknown> = {}) => loadCacheConfig({}, {
  enabled: true, writeEnabled: true, samplingPercent: 0, store: { type: "filesystem", filesystem: { baseDir: cacheDir } }, ...extra });
const cmdNode = (target: string, task: Record<string, unknown> = {}): PlanNode => ({
  id: `cmd:0:${target}:x`, handler: { kind: "builtin", name: "command:exec" }, needs: [], target,
  payload: { commandName: "x", stageIndex: 0, task: { service: target, command: "x", executable: "vitest run", cache: true, ...task } } });
const mk = (p: never, extra = {}) => StepCache.create(cfg(extra), { project: p, repoRoot: repo, env: {} }).then((c) => c!);
function writeEntry(key: string, e: Record<string, unknown>) {
  fs.mkdirSync(path.join(cacheDir, key.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, key.slice(0, 2), `${key}.json`), JSON.stringify({ key, passed: true, durationMs: 1, ...e }));
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "r37b-"));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "r37bc-"));
  fs.mkdirSync(path.join(repo, "packages/api"), { recursive: true });
  fs.writeFileSync(path.join(repo, "packages/api/index.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(repo, "bun.lock"), "{}\n");
  sh("git init -q");
  commit("init");
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(cacheDir, { recursive: true, force: true }); });

describe("PR#37 second pass", () => {
  it("N1 container context set in nopo.yml (task.context) must be uncacheable, not just --context override", () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    const r = buildStepKeyInputs(cmdNode("api", { context: "container" }), p, repo, [], {});
    expect(r.inputs).toBeNull();
  });

  it("N2 command without cache: true is not cacheable (default is never cache)", () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    // Override cache to undefined to test default behavior (no cache opt-in)
    const r = buildStepKeyInputs(cmdNode("api", { cache: undefined }), p, repo, [], {});
    expect(r.inputs).toBeNull();
    expect(r.reason).toBe("command has no cache: true declaration");
  });

  it("N3 editing the plugin source must change a plugin-hook key (plugin hashes are dead: no sourcePath ever set)", () => {
    fs.writeFileSync(path.join(repo, "plugin.ts"), "export default 1;\n"); commit("plugin");
    // Include pluginRefs with path so plugin source hash can be collected
    const p = {
      services: { entries: { api: svc(`${repo}/packages/api`) } },
      plugins: [{ definition: { name: "eslint", hooks: {}, cacheableHooks: { lintBatch: {} } }, serviceConfigs: {} }],
      pluginRefs: [{ name: "eslint", path: "./plugin.ts" }],
      configPath: path.join(repo, "nopo.yml"),
    } as never;
    const node: PlanNode = { id: "eslint:batch", handler: { kind: "plugin-hook", plugin: "eslint", hook: "lintBatch" }, needs: [], payload: { targets: ["api"] }, meta: { cacheOptIn: { api: true } } };
    const k1 = computeStepKey(buildStepKeyInputs(node, p, repo, [], {}).inputs!).key;
    fs.writeFileSync(path.join(repo, "plugin.ts"), "export default 2; // rule now errors\n"); commit("plugin2");
    const k2 = computeStepKey(buildStepKeyInputs(node, p, repo, [], {}).inputs!).key;
    expect(k2).not.toBe(k1);
  });

  it("N4a unparseable expiresAt must not be treated as unexpired", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    const c = await mk(p);
    const k = (await c.lookup(cmdNode("api"))).stepKey!.key;
    writeEntry(k, { createdAt: "x", expiresAt: "never" });
    expect((await (await mk(p)).lookup(cmdNode("api"))).hit).toBe(false);
  });

  it("N4b reader TTL must win over writer expiresAt (entry 30d old, reader ttl 2d)", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    const k = (await (await mk(p)).lookup(cmdNode("api"))).stepKey!.key;
    writeEntry(k, { createdAt: new Date(Date.now() - 30 * 864e5).toISOString(), expiresAt: "2099-01-01T00:00:00Z" });
    expect((await (await mk(p, { ttlSeconds: 2 * 86400 })).lookup(cmdNode("api"))).hit).toBe(false);
  });

  it("N5 step that dirties its own inputs during the run (vitest -u / --fix / codegen) must not record a pass", async () => {
    const p = project({ api: svc(`${repo}/packages/api`) });
    const node = cmdNode("api");
    const c = await mk(p);
    const lr = await c.lookup(node);
    fs.writeFileSync(path.join(repo, "packages/api/index.ts.snap"), "updated snapshot\n"); // written by the step
    await c.record(lr.stepKey, true, 10, node);
    fs.rmSync(path.join(repo, "packages/api/index.ts.snap")); // clean checkout of same commit
    expect((await (await mk(p)).lookup(node)).hit).toBe(false);
  });

  it("N6 service nopo.yml `cache.env` (as documented) must reach getDeclaredEnvInputs", () => {
    fs.writeFileSync(path.join(repo, "nopo.yml"), "name: t\nservices:\n  dirs:\n    - ./packages\n");
    fs.writeFileSync(path.join(repo, "packages/api/nopo.yml"), "name: api\ncommands:\n  test: vitest run\ncache:\n  env:\n    - DATABASE_URL\n");
    const cfgP = loadProjectConfig(repo);
    expect(getDeclaredEnvInputs(cfgP.services.entries["api"])).toContain("DATABASE_URL");
  });
});
