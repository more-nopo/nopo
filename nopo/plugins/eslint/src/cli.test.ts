import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(
  new URL("../../../../packages/nopo/bin.ts", import.meta.url),
);
const plugin = fileURLToPath(new URL("./index.ts", import.meta.url));
const eslintPackage = createRequire(import.meta.url).resolve(
  "eslint/package.json",
);
const roots: string[] = [];

function fixture(opts: { failBeta?: boolean } = {}) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "nopo-eslint-cli-")),
  );
  roots.push(root);
  mkdirSync(path.join(root, "node_modules"));
  symlinkSync(
    path.dirname(eslintPackage),
    path.join(root, "node_modules/eslint"),
    "junction",
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", type: "module" }),
  );
  writeFileSync(
    path.join(root, "nopo.yml"),
    JSON.stringify({
      name: "fixture",
      services: { dirs: ["./apps"] },
      plugins: [{ name: "eslint", path: plugin }],
    }),
  );
  for (const name of ["alpha", "beta"]) {
    const dir = path.join(root, "apps", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "nopo.yml"),
      JSON.stringify({
        name,
        plugins: { eslint: {} },
        commands: {
          lint: { plugin: "eslint" },
        },
      }),
    );
    writeFileSync(
      path.join(dir, "eslint.config.mjs"),
      `export default [
  {
    files: ["**/*.js"],
    rules: {
      "no-undef": "error",
      "no-unused-vars": "error",
    },
  },
];
`,
    );
    if (name === "beta" && opts.failBeta) {
      writeFileSync(
        path.join(dir, "bad.js"),
        "const unused = 1;\nconsole.log(missing);\n",
      );
    } else {
      writeFileSync(
        path.join(dir, "ok.js"),
        "export const value = " + JSON.stringify(name) + ";\n",
      );
    }
  }
  return root;
}

async function nopo(root: string, ...args: string[]) {
  return new Promise<{ code: number | null; output: string; stdout: string }>(
    (resolve, reject) => {
      const child = spawn("bun", [cli, ...args], {
        cwd: root,
        env: {
          ...process.env,
          ROOT_DIR: root,
          NOPO_NO_QUEUE: "1",
          DOCKER_PORT: "80",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Fixture CLI timed out"));
      }, 30000);
      child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, output: stdout + stderr, stdout });
      });
    },
  );
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("eslint CLI multi-target collapse", () => {
  it("prints selected targets without executing eslint", async () => {
    const root = fixture();
    const result = await nopo(root, "eslint", "run", "--print");
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout.trim());
    expect(plan.command).toBe("eslint");
    expect(plan.targets.map((t: { id: string }) => t.id).sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("collapses multiple opted-in targets into one coordinator run", async () => {
    const root = fixture();
    const result = await nopo(root, "eslint", "run", "alpha", "beta");
    expect(result.output).toContain("[eslint] Targets: alpha, beta");
    expect(result.output).toContain("[eslint] alpha: clean");
    expect(result.output).toContain("[eslint] beta: clean");
    expect(result.code).toBe(0);
  });

  it("attributes lint failures to the owning target", async () => {
    const root = fixture({ failBeta: true });
    const result = await nopo(root, "eslint", "run", "alpha", "beta");
    expect(result.output).toContain("[eslint] Targets: alpha, beta");
    expect(result.output).toMatch(/\[eslint\] alpha: clean/);
    expect(result.output).toMatch(/\[eslint\] beta: .*error/);
    expect(result.output).toMatch(/Lint failed for beta/);
    expect(result.code).not.toBe(0);
    expect(existsSync(path.join(root, "apps/beta/bad.js"))).toBe(true);
    // Prove the failing file content is what we expect for attribution.
    expect(readFileSync(path.join(root, "apps/beta/bad.js"), "utf8")).toContain(
      "missing",
    );
  });
});
