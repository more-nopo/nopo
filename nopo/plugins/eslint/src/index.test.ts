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
import type { PlanNode } from "@more-nopo/nopo/plan";
import type { BatchSpec } from "@more-nopo/nopo/plan-compact";
import plugin, {
  attributeResults,
  discoverTargets,
  isEslintCommandExecNode,
  renderMetaConfig,
} from "./index.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "nopo-eslint-tests-"));
  roots.push(root);
  return root;
}
function service(root: string, id: string, data?: unknown): NormalizedService {
  mkdirSync(path.join(root, id), { recursive: true });
  return {
    id,
    commands: {},
    paths: { root: path.join(root, id), context: root },
    pluginData: data === undefined ? {} : { eslint: data },
  } as NormalizedService;
}
function config(service: NormalizedService) {
  writeFileSync(
    path.join(service.paths.root, "eslint.config.mjs"),
    "export default [];",
  );
}
function install(root: string) {
  const manifest = createRequire(import.meta.url).resolve(
    "eslint/package.json",
  );
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  symlinkSync(
    path.dirname(manifest),
    path.join(root, "node_modules/eslint"),
    "junction",
  );
}
function context(
  root: string,
  services: NormalizedService[],
  positionals: string[] = [],
  passthrough: string[] = [],
) {
  const exec = vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: "[]",
    stderr: "",
  });
  const write = vi.fn();
  const stderr = vi.fn();
  const ctx = {
    positionals,
    passthrough,
    exec,
    io: {
      env: { FROM_HOST: "host" },
      stdout: { write },
      stderr: { write: stderr },
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
  return { ctx, exec, write, stderr };
}
async function run(
  ctx: HookContext,
  options: string[] = [],
  config: unknown = {},
) {
  const command = plugin(config).commands!.find((c) => c.name === "run")!;
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
    const invalid = service(root, "web", { config: "missing.mjs" });
    expect(() =>
      discoverTargets({ web: invalid }, [], { args: [], env: {} }, {}),
    ).toThrow("does not exist");
    invalid.pluginData = { eslint: { configs: "typo.mjs" } };
    expect(() =>
      discoverTargets({ web: invalid }, [], { args: [], env: {} }, {}),
    ).toThrow();
  });
});

describe("attribution", () => {
  it("attributes lint messages to the deepest matching target root", () => {
    const root = fixture();
    const a = service(root, "a", {});
    const b = service(root, "b", {});
    const attribution = attributeResults(
      [
        { id: "a", root: a.paths.root, env: {} },
        { id: "b", root: b.paths.root, env: {} },
      ],
      [
        {
          filePath: path.join(a.paths.root, "src/bad.js"),
          errorCount: 2,
          warningCount: 0,
          messages: [],
        },
        {
          filePath: path.join(b.paths.root, "ok.js"),
          errorCount: 0,
          warningCount: 1,
          messages: [],
        },
      ],
    );
    expect(attribution).toEqual([
      {
        id: "a",
        errorCount: 2,
        warningCount: 0,
        files: [path.join(a.paths.root, "src/bad.js")],
      },
      {
        id: "b",
        errorCount: 0,
        warningCount: 1,
        files: [path.join(b.paths.root, "ok.js")],
      },
    ]);
  });
});

describe("execution", () => {
  it("prints a plan without loading ESLint or exposing environment values", async () => {
    const root = fixture();
    const web = service(root, "web", { env: { SECRET: "secret-value" } });
    const { ctx, exec, write } = context(root, [web]);
    await run(ctx, ["--print"]);
    expect(exec).not.toHaveBeenCalled();
    const output = write.mock.calls[0]![0];
    expect(JSON.parse(output).targets[0].id).toBe("web");
    expect(output).not.toContain("secret-value");
  });
  it("runs only requested targets and preserves argv for a single target", async () => {
    const root = fixture();
    install(root);
    const web = service(root, "web", {
      env: { TOKEN: "$FROM_HOST" },
    });
    web.env = { SERVICE_ENV: "service" };
    config(web);
    const api = service(root, "api", {});
    const passthrough = ["src/index.ts", "--max-warnings=0"];
    const { ctx, exec } = context(root, [api, web], ["web"], passthrough);
    await run(ctx, [], {
      args: ["--no-warn-ignored"],
      env: { GLOBAL: "global" },
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![1]).toEqual([
      "--config",
      path.join(web.paths.root, "eslint.config.mjs"),
      "--format",
      "json",
      "--no-warn-ignored",
      ...passthrough,
    ]);
    expect(exec.mock.calls[0]![2]).toMatchObject({
      cwd: web.paths.root,
      env: {
        FROM_HOST: "host",
        TOKEN: "host",
        GLOBAL: "global",
      },
    });
  });
  it("fails preflight for missing installations without starting earlier targets", async () => {
    const root = fixture();
    const { ctx, exec } = context(root, [service(root, "web", {})]);
    await expect(run(ctx)).rejects.toThrow(
      "Cannot resolve an installed ESLint",
    );
    expect(exec).not.toHaveBeenCalled();
  });
  it("creates one coordinator run and cleans temporary configs after failure", async () => {
    const root = fixture();
    install(root);
    const a = service(root, "a", {});
    config(a);
    const b = service(root, "b", {});
    config(b);
    const { ctx, exec, stderr } = context(root, [a, b], [], ["--fix"]);
    let file = "";
    exec.mockImplementationOnce(async (_cmd, argv) => {
      file = argv[1];
      const source = readFileSync(file, "utf8");
      expect(source).toContain(a.paths.root);
      expect(source).toContain(b.paths.root);
      expect(source).toContain('"id":"a"');
      expect(source).toContain('"id":"b"');
      expect(argv).toContain("--fix");
      expect(argv.filter((arg: string) => arg === path.relative(root, a.paths.root) || arg === "a").length).toBeGreaterThan(0);
      return {
        exitCode: 1,
        stdout: JSON.stringify([
          {
            filePath: path.join(a.paths.root, "bad.js"),
            errorCount: 1,
            warningCount: 0,
            messages: [
              {
                severity: 2,
                message: "no-undef 'x'",
                ruleId: "no-undef",
                line: 1,
              },
            ],
          },
        ]),
        stderr: "",
      };
    });
    await expect(run(ctx)).rejects.toThrow("Lint failed for a");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(file)).toThrow();
    expect(exec.mock.calls[0]![2].cwd).toBe(root);
    const stderrText = stderr.mock.calls.map((call) => call[0]).join("");
    expect(stderrText).toContain("[eslint] Targets: a, b");
    expect(stderrText).toContain("[eslint] a: 1 error(s)");
    expect(stderrText).toContain("[eslint] b: clean");
  });
  it("refuses forwarded configuration overrides for multi-target runs", async () => {
    const root = fixture();
    for (const flag of ["--config", "--config=other.mjs", "-c"]) {
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
  it("renders a meta-config that scopes each target", () => {
    const root = fixture();
    const a = service(root, "a", {});
    config(a);
    const b = service(root, "b", {});
    config(b);
    const source = renderMetaConfig(
      [
        {
          id: "a",
          root: a.paths.root,
          config: path.join(a.paths.root, "eslint.config.mjs"),
          env: {},
        },
        {
          id: "b",
          root: b.paths.root,
          config: path.join(b.paths.root, "eslint.config.mjs"),
          env: {},
        },
      ],
      root,
    );
    expect(source).toContain('"id":"a"');
    expect(source).toContain('"id":"b"');
    expect(source).toContain("scopeEntry");
  });
});

describe("eslintPlugin factory batches", () => {
  const definition = plugin({});

  it("exposes lintBatch hook and a single BatchSpec", () => {
    expect(definition.hooks?.lintBatch).toBeTypeOf("function");
    expect(definition.batches).toBeDefined();
    expect(definition.batches).toHaveLength(1);
  });
});

function makeCmdNode(
  service: string,
  pluginName?: string,
): PlanNode {
  return {
    id: `cmd:0:${service}:lint`,
    handler: { kind: "builtin", name: "command:exec" },
    needs: ["pre_command"],
    target: service,
    payload: {
      commandName: "lint",
      stageIndex: 0,
      task: {
        service,
        command: "lint",
        executable: "run",
        ...(pluginName ? { plugin: pluginName } : {}),
      },
    },
  };
}

describe("eslintPlugin BatchSpec.claims", () => {
  const spec = plugin({}).batches![0]!;

  it("claims command:exec nodes delegated to eslint", () => {
    expect(spec.claims(makeCmdNode("web", "eslint"), {
      services: {},
      project: { plugins: [] } as never,
      env: {},
      args: {} as never,
    })).toBe(true);
    expect(isEslintCommandExecNode(makeCmdNode("web", "eslint"))).toBe(true);
  });

  it("does NOT claim shell command:exec or other plugins", () => {
    const ctx = {
      services: {},
      project: { plugins: [] } as never,
      env: {},
      args: {} as never,
    };
    expect(spec.claims(makeCmdNode("web"), ctx)).toBe(false);
    expect(spec.claims(makeCmdNode("web", "vitest"), ctx)).toBe(false);
    expect(
      spec.claims(
        {
          id: "pre_command",
          handler: { kind: "builtin", name: "command:pre" },
          needs: [],
        },
        ctx,
      ),
    ).toBe(false);
  });
});

describe("eslintPlugin BatchSpec.coalesce", () => {
  const spec: BatchSpec = plugin({}).batches![0]!;
  const ctx = {
    services: {},
    project: { plugins: [] } as never,
    env: {},
    args: {} as never,
  };

  it("coalesces into eslint:batch with lintBatch handler", () => {
    const claimed = [
      makeCmdNode("a", "eslint"),
      makeCmdNode("b", "eslint"),
      makeCmdNode("c", "eslint"),
    ];
    const out = spec.coalesce(claimed, ctx);
    expect(out.id).toBe("eslint:batch");
    expect(out.handler).toEqual({
      kind: "plugin-hook",
      plugin: "eslint",
      hook: "lintBatch",
    });
    expect(out.payload).toEqual({ targets: ["a", "b", "c"] });
    expect(out.meta).toEqual({
      batchOf: ["cmd:0:a:lint", "cmd:0:b:lint", "cmd:0:c:lint"],
    });
  });
});

describe("lintBatch hook execution", () => {
  it("runs one coordinator for payload.targets", async () => {
    const root = fixture();
    install(root);
    const a = service(root, "a", {});
    config(a);
    const b = service(root, "b", {});
    config(b);
    const { ctx, exec, stderr } = context(root, [a, b]);
    exec.mockResolvedValue({ exitCode: 0, stdout: "[]", stderr: "" });
    await plugin({}).hooks!.lintBatch!({
      ...ctx,
      payload: { targets: ["a", "b"] },
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![2].cwd).toBe(root);
    const stderrText = stderr.mock.calls.map((call) => call[0]).join("");
    expect(stderrText).toContain("[eslint] Targets: a, b");
  });
});
