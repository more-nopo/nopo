/* Workspace packages declared in package.json feed cache keys and dirty checks. */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type PlanNode } from "../plan.ts";
import { buildStepKeyInputs, checkCacheEligibility, collectWorkspaceDepDirs, computeStepKey } from "./cache-key.ts";

let repo: string;
const sh = (c: string) => execSync(c, { cwd: repo, stdio: "pipe" }).toString();
const commit = (m: string) => sh(`git -c user.email=a@b -c user.name=a add -A && git -c user.email=a@b -c user.name=a commit -qm ${m}`);
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};
const link = (name: string, target: string) => {
  const at = path.join(repo, "node_modules", name);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(path.join(repo, target), at);
};
const svc = (root: string) => ({ paths: { root: path.join(repo, root) }, buildDeps: [], runtimeDeps: [], systemDeps: [], packageManagers: [] });
const project = () => ({ services: { entries: { api: svc("packages/api") } }, plugins: [] }) as never;
const node: PlanNode = {
  id: "cmd:0:api:check", handler: { kind: "builtin", name: "command:exec" }, needs: [], target: "api",
  payload: { task: { service: "api", command: "check", executable: "tsc --noEmit", cache: true } },
};
const key = () => {
  const r = buildStepKeyInputs(node, project(), repo, [], {});
  return r.inputs ? computeStepKey(r.inputs).key : null;
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "wsd-"));
  write(".gitignore", "node_modules\n");
  write("packages/api/package.json", JSON.stringify({ name: "@x/api", dependencies: { "@x/lib": "workspace:*", leftpad: "1.0.0" } }));
  write("packages/api/index.ts", "export {};\n");
  write("packages/lib/package.json", JSON.stringify({ name: "@x/lib", devDependencies: { "@x/core": "workspace:*" } }));
  write("packages/lib/index.ts", "export const a = 1;\n");
  write("packages/core/package.json", JSON.stringify({ name: "@x/core" }));
  write("packages/core/index.ts", "export const c = 1;\n");
  write("packages/other/package.json", JSON.stringify({ name: "@x/other" }));
  write("node_modules/leftpad/package.json", "{}");
  link("@x/lib", "packages/lib");
  link("@x/core", "packages/core");
  link("@x/other", "packages/other");
  sh("git init -q");
  commit("init");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("workspace package deps", () => {
  it("resolves declared workspace packages transitively, ignoring registry deps", () => {
    expect(collectWorkspaceDepDirs(repo, path.join(repo, "packages/api"))).toEqual(["packages/core", "packages/lib"]);
  });

  it("a committed change to a direct workspace dep changes the key", () => {
    const before = key();
    write("packages/lib/index.ts", "export const a = 2;\n");
    commit("lib");
    expect(key()).not.toBe(before);
  });

  it("a committed change to a transitive workspace dep changes the key", () => {
    const before = key();
    write("packages/core/index.ts", "export const c = 2;\n");
    commit("core");
    expect(key()).not.toBe(before);
  });

  it("an unrelated workspace package does not change the key", () => {
    const before = key();
    write("packages/other/index.ts", "export const o = 2;\n");
    commit("other");
    expect(key()).toBe(before);
  });

  it("an uncommitted change in a workspace dep makes the step ineligible", () => {
    write("packages/core/index.ts", "dirty\n");
    const r = checkCacheEligibility(project(), "api", repo);
    expect(r.eligible).toBe(false);
    expect(r.dirtyPaths).toContain("packages/core");
  });

  it("declared input globs skip node_modules", () => {
    write("packages/api/gen/a.json", "{}\n");
    write("packages/api/gen/node_modules/x/b.json", "{}\n");
    const n = { ...node, payload: { task: { service: "api", command: "check", executable: "tsc", cache: { inputs: ["gen/**"] } } } };
    const r = buildStepKeyInputs(n, project(), repo, [], {});
    expect(Object.keys(r.inputs!.extraInputHashes!)).toEqual(["packages/api/gen/a.json"]);
  });
});

describe("selector-independent keys", () => {
  it("the typed command selector does not change a leaf's key", () => {
    const withName = (commandName: string): PlanNode => ({ ...node, payload: { ...(node.payload as object), commandName } });
    const k = (n: PlanNode) => computeStepKey(buildStepKeyInputs(n, project(), repo, [], {}).inputs!).key;
    expect(k(withName("test"))).toBe(k(withName("test:-integration,-cards")));
  });
});
