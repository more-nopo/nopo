import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedService } from "@more-nopo/nopo/config";
import type { HookContext } from "@more-nopo/nopo/plugin";
import plugin, { discoverTargets } from "./index.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "nopo-vitest-tests-"));
  roots.push(root);
  return root;
}
function service(root: string, id: string, data?: unknown): NormalizedService {
  mkdirSync(path.join(root, id), { recursive: true });
  return {
    id,
    commands: {},
    paths: { root: path.join(root, id), context: root },
    pluginData: data === undefined ? {} : { vitest: data },
  } as NormalizedService;
}
function config(service: NormalizedService) {
  writeFileSync(
    path.join(service.paths.root, "vitest.config.ts"),
    "export default {};",
  );
}
function install(root: string) {
  const manifest = createRequire(import.meta.url).resolve(
    "vitest/package.json",
  );
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  symlinkSync(
    path.dirname(manifest),
    path.join(root, "node_modules/vitest"),
    "junction",
  );
}
function context(
  root: string,
  services: NormalizedService[],
  positionals: string[] = [],
  passthrough: string[] = [],
) {
  const exec = vi.fn().mockResolvedValue({ exitCode: 0 });
  const write = vi.fn();
  const ctx = {
    positionals,
    passthrough,
    exec,
    io: {
      env: { FROM_HOST: "host" },
      stdout: { write },
      stderr: { write: vi.fn() },
    },
    runner: {
      config: {
        root,
        project: {
          services: {
            entries: Object.fromEntries(services.map((s) => [s.id, s])),
          },
        },
      },
      environment: { env: {}, extraEnv: {} },
      logger: { log: vi.fn() },
    },
  } as unknown as HookContext;
  return { ctx, exec, write };
}
async function run(
  ctx: HookContext,
  options: string[] = [],
  mode = "run",
  config: unknown = {},
) {
  const command = plugin(config).commands!.find((c) => c.name === mode)!;
  await command.fn(ctx, command.args!.parse(options));
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("target discovery", () => {
  it("discovers native configs and explicit opt-ins, honors opt-outs", () => {
    const root = fixture();
    const api = service(root, "api");
    config(api);
    const web = service(root, "web", {});
    const disabled = service(root, "disabled", false);
    config(disabled);
    const unrelated = service(root, "unrelated");
    const entries = Object.fromEntries(
      [api, web, disabled, unrelated].map((s) => [s.id, s]),
    );
    expect(
      discoverTargets(entries, [], { args: [], env: {} }, {}).map((t) => t.id),
    ).toEqual(["api", "web"]);
    expect(
      discoverTargets(
        entries,
        ["web", "api", "web"],
        { args: [], env: {} },
        {},
      ).map((t) => t.id),
    ).toEqual(["web", "api"]);
    for (const id of ["missing", "disabled", "unrelated"]) {
      expect(() =>
        discoverTargets(entries, [id], { args: [], env: {} }, {}),
      ).toThrow();
    }
  });
  it("validates configuration rather than silently ignoring a typo or missing config", () => {
    const root = fixture();
    const invalid = service(root, "web", { config: "missing.ts" });
    expect(() =>
      discoverTargets({ web: invalid }, [], { args: [], env: {} }, {}),
    ).toThrow("does not exist");
    invalid.pluginData = { vitest: { configs: "typo.ts" } };
    expect(() =>
      discoverTargets({ web: invalid }, [], { args: [], env: {} }, {}),
    ).toThrow();
  });
});

describe("execution", () => {
  it("prints a plan without loading Vitest or exposing environment values", async () => {
    const root = fixture();
    const web = service(root, "web", { env: { SECRET: "secret-value" } });
    const { ctx, exec, write } = context(root, [web]);
    await run(ctx, ["--print"]);
    expect(exec).not.toHaveBeenCalled();
    const output = write.mock.calls[0]![0];
    expect(JSON.parse(output).targets[0].id).toBe("web");
    expect(output).not.toContain("secret-value");
  });
  it("runs only requested targets, preserves argv, and scopes target env to its project", async () => {
    const root = fixture();
    install(root);
    const web = service(root, "web", {
      env: { NODE_ENV: "custom", TOKEN: "$FROM_HOST" },
    });
    web.env = { SERVICE_ENV: "service" };
    config(web);
    const api = service(root, "api", {});
    const passthrough = [
      "a file 'with' spaces.test.ts",
      "--shard=1/3",
      "--testNamePattern=a=b",
    ];
    const { ctx, exec } = context(root, [api, web], ["web"], passthrough);
    await run(ctx, [], "run", {
      args: ["--reporter=dot"],
      env: { GLOBAL: "global" },
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![1]).toEqual([
      expect.stringContaining("vitest.mjs"),
      "run",
      "--config",
      path.join(web.paths.root, "vitest.config.ts"),
      "--reporter=dot",
      ...passthrough,
    ]);
    expect(exec.mock.calls[0]![2]).toMatchObject({
      cwd: web.paths.root,
      env: {
        FROM_HOST: "host",
        NODE_ENV: "custom",
        TOKEN: "host",
        GLOBAL: "global",
      },
    });
  });
  it("fails preflight for missing installations without starting earlier targets", async () => {
    const root = fixture();
    const { ctx, exec } = context(root, [service(root, "web", {})]);
    await expect(run(ctx)).rejects.toThrow(
      "Cannot resolve an installed Vitest",
    );
    expect(exec).not.toHaveBeenCalled();
  });
  it("propagates failure from the single invocation", async () => {
    const root = fixture();
    install(root);
    const { ctx, exec } = context(root, [
      service(root, "a", {}),
      service(root, "b", {}),
    ]);
    exec.mockRejectedValueOnce(new Error("test failed"));
    await expect(run(ctx)).rejects.toThrow("test failed");
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("delegates file listing to Vitest without reimplementing test discovery", async () => {
    const root = fixture();
    install(root);
    const { ctx, exec } = context(
      root,
      [service(root, "web", {})],
      [],
      ["--filesOnly", "--json"],
    );
    await run(ctx, [], "list");
    expect(exec.mock.calls[0]![1].slice(1)).toEqual([
      "list",
      "--filesOnly",
      "--json",
    ]);
  });
  it("refuses forwarded configuration overrides", async () => {
    const root = fixture();
    for (const flag of [
      "--root=elsewhere",
      "--config",
      "--workspace",
      "--projects.0=x",
      "-c",
      "-cother.ts",
      "-r",
      "-r../other",
    ]) {
      const { ctx, exec } = context(
        root,
        [service(root, "web", {}), service(root, "api", {})],
        [],
        [flag],
      );
      await expect(run(ctx)).rejects.toThrow("target configuration");
      expect(exec).not.toHaveBeenCalled();
    }
  });
  it("creates one native project run and cleans temporary configs after failure", async () => {
    const root = fixture();
    install(root);
    const a = service(root, "a", {});
    config(a);
    const b = service(root, "b", {});
    config(b);
    const { ctx, exec } = context(root, [a, b], [], ["--shard=1/2"]);
    let file = "";
    exec.mockImplementationOnce(async (_cmd, argv) => {
      file = argv[3];
      const source = readFileSync(file, "utf8");
      expect(source).toContain(a.paths.root);
      expect(source).toContain(b.paths.root);
      expect(source).toContain('"name":"a"');
      expect(argv.at(-1)).toBe("--shard=1/2");
      throw new Error("test failed");
    });
    await expect(run(ctx)).rejects.toThrow("test failed");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(file)).toThrow();
    expect(exec.mock.calls[0]![2].cwd).toBe(root);
  });
  it("keeps distinct target environments in their native Vitest projects", async () => {
    const root = fixture();
    install(root);
    const { ctx, exec } = context(root, [
      service(root, "a", { env: { TARGET: "a" } }),
      service(root, "b", { env: { TARGET: "b" } }),
    ]);
    exec.mockImplementationOnce(async (_cmd, argv) => {
      const source = readFileSync(argv[3], "utf8");
      expect(source).toContain('"TARGET":"a"');
      expect(source).toContain('"TARGET":"b"');
    });
    await run(ctx);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![2].env).not.toHaveProperty("TARGET");
  });
});
