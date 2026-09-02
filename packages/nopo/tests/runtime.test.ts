/**
 * Runtime schema, normalizer, and resolver. Covers wrap, map parse,
 * 4-layer override, secret-vs-env, named-vs-default, deps replace,
 * env/secrets/processes merge, ENC[...] reject, mix reject.
 */
import { describe, expect, it } from "vitest";

import {
  autoWrapRuntime,
  HealthcheckSchema,
  isRuntimeMapShape,
  mergeRuntimeBlock,
  resolveRuntime,
  RuntimeBlockSchema,
  RuntimeMapSchema,
  VolumeSchema,
} from "../src/config/runtime.ts";

describe("HealthcheckSchema — discriminated union on `type`", () => {
  // Discriminated union on `type`. `exec`: argv probe (compose CMD; k8s
  // exec.command). `http`: path + optional port (compose curl mount; k8s httpGet).

  it("accepts a fully-specified exec healthcheck", () => {
    const result = HealthcheckSchema.safeParse({
      type: "exec",
      exec: ["curl", "-f", "http://localhost:3000/health"],
      interval: "10s",
      timeout: "5s",
      retries: 3,
      delay: "20s",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a fully-specified http healthcheck (with port)", () => {
    const result = HealthcheckSchema.safeParse({
      type: "http",
      path: "/health",
      port: 4000,
      interval: "10s",
      timeout: "5s",
      retries: 5,
      delay: "30s",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an http healthcheck without `port` (emitter resolves via process.port)", () => {
    // Omitted `port` falls back to `process.port`. The schema accepts
    // omission; the emitter resolves it (process.port is outside this object).
    const result = HealthcheckSchema.safeParse({
      type: "http",
      path: "/health",
      interval: "10s",
      timeout: "5s",
      retries: 5,
      delay: "30s",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a healthcheck without `type`", () => {
    // `type` is required — no default branch. The migration sweep added
    // `type: exec` to existing declarations; this rejects new omissions.
    const result = HealthcheckSchema.safeParse({
      exec: ["curl", "-f", "http://localhost:3000/health"],
      interval: "10s",
      timeout: "5s",
      retries: 3,
      delay: "20s",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown `type`", () => {
    const result = HealthcheckSchema.safeParse({
      type: "tcp",
      port: 3000,
      interval: "10s",
      timeout: "5s",
      retries: 3,
      delay: "20s",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an http healthcheck whose `path` does not start with /", () => {
    const result = HealthcheckSchema.safeParse({
      type: "http",
      path: "health",
      interval: "10s",
      timeout: "5s",
      retries: 5,
      delay: "30s",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an http healthcheck with `exec` (cross-variant field)", () => {
    // .strict() on each branch rejects unknown keys so a half-migrated
    // declaration that left `exec:` on a `type: http` block fails fast.
    const result = HealthcheckSchema.safeParse({
      type: "http",
      path: "/health",
      exec: ["curl", "-f", "http://localhost:3000/health"],
      interval: "10s",
      timeout: "5s",
      retries: 3,
      delay: "20s",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an exec healthcheck with `path` (cross-variant field)", () => {
    const result = HealthcheckSchema.safeParse({
      type: "exec",
      exec: ["curl", "-f", "http://localhost:3000/health"],
      path: "/health",
      interval: "10s",
      timeout: "5s",
      retries: 3,
      delay: "20s",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an exec healthcheck with empty `exec`", () => {
    const result = HealthcheckSchema.safeParse({
      type: "exec",
      exec: [],
      interval: "10s",
      timeout: "5s",
      retries: 3,
      delay: "20s",
    });
    expect(result.success).toBe(false);
  });

  it("rejects sub-second durations (k8s readinessProbe only accepts integer seconds)", () => {
    const result = HealthcheckSchema.safeParse({
      type: "http",
      path: "/health",
      interval: "500ms",
      timeout: "5s",
      retries: 3,
      delay: "20s",
    });
    expect(result.success).toBe(false);
  });
});

describe("isRuntimeMapShape", () => {
  it("treats flat-shape with only known block fields as flat", () => {
    expect(isRuntimeMapShape({ command: "x", port: 3000 })).toBe(false);
    expect(isRuntimeMapShape({ env: { K: "v" } })).toBe(false);
    expect(isRuntimeMapShape({ secrets: { K: "ENC[..]" } })).toBe(false);
  });

  it("treats empty object as flat (legacy `runtime: {}`)", () => {
    expect(isRuntimeMapShape({})).toBe(false);
  });

  it("treats null/undefined/non-object as flat (no fields)", () => {
    expect(isRuntimeMapShape(null)).toBe(false);
    expect(isRuntimeMapShape(undefined)).toBe(false);
    expect(isRuntimeMapShape("string")).toBe(false);
    expect(isRuntimeMapShape(42)).toBe(false);
  });

  it("treats a `default:` key as map-shape", () => {
    expect(isRuntimeMapShape({ default: { command: "x" } })).toBe(true);
  });

  it("treats any unknown top-level key as map-shape (named runtimes)", () => {
    expect(isRuntimeMapShape({ default: {}, prod: {} })).toBe(true);
    expect(isRuntimeMapShape({ default: {}, dev: {}, test: {} })).toBe(true);
  });

  it("treats flat-shape with extra passthrough keys as flat", () => {
    // nginx: flat block with passthrough `healthcheck:`. Scalars
    // (port, cpu, deps) prove flat even if `healthcheck` is unknown.
    expect(
      isRuntimeMapShape({
        port: 80,
        cpu: "0.25",
        memory: "64Mi",
        deps: ["api"],
        healthcheck: { test: ["CMD", "curl"] },
      }),
    ).toBe(false);
  });

  it("treats flat-shape with array value as flat", () => {
    // Anonymous lists like `deps:` prove flat shape (map values are objects).
    expect(isRuntimeMapShape({ deps: ["a", "b"] })).toBe(false);
  });
});

describe("autoWrapRuntime", () => {
  it("wraps flat shape into { default }", () => {
    expect(autoWrapRuntime({ command: "node x.js", port: 3000 })).toEqual({
      default: { command: "node x.js", port: 3000 },
    });
  });

  it("wraps empty `{}` into { default: {} }", () => {
    expect(autoWrapRuntime({})).toEqual({ default: {} });
  });

  it("returns map shape unchanged", () => {
    const map = { default: { command: "x" }, prod: { cpu: "2" } };
    expect(autoWrapRuntime(map)).toBe(map);
  });

  it("returns undefined for null/undefined", () => {
    expect(autoWrapRuntime(null)).toBeUndefined();
    expect(autoWrapRuntime(undefined)).toBeUndefined();
  });
});

describe("RuntimeMapSchema", () => {
  it("parses a wrapped flat block (back-compat path)", () => {
    const wrapped = autoWrapRuntime({ command: "node x.js", port: 3000 });
    const parsed = RuntimeMapSchema.parse(wrapped);
    expect(parsed.default?.command).toBe("node x.js");
    expect(parsed.default?.port).toBe(3000);
  });

  it("parses an explicit map shape with default + named runtimes", () => {
    const parsed = RuntimeMapSchema.parse({
      default: { command: "node x.js", port: 3000 },
      prod: { cpu: "2", memory: "1Gi" },
      dev: { env: { LOG_LEVEL: "debug" } },
    });
    expect(parsed.default?.command).toBe("node x.js");
    expect(parsed.prod?.cpu).toBe("2");
    expect(parsed.dev?.env).toEqual({ LOG_LEVEL: "debug" });
  });

  it("rejects map shape that omits `default`", () => {
    const result = RuntimeMapSchema.safeParse({
      prod: { cpu: "2" },
      dev: { cpu: "0.5" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0]?.message).toMatch(/`default:` block/);
    }
  });

  it("rejects plaintext under default.secrets:", () => {
    const result = RuntimeMapSchema.safeParse({
      default: {
        secrets: {
          API_KEY: "this-is-plaintext",
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map((e) => e.message).join("\n");
      expect(messages).toMatch(/ENC\[\.\.\.\] ciphertext/);
    }
  });

  it("rejects plaintext under <name>.secrets:", () => {
    const result = RuntimeMapSchema.safeParse({
      default: { command: "x" },
      prod: {
        secrets: {
          DATABASE_URL: "postgres://prod:plaintext@host/db",
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.errors.map((e) => e.path.join("."));
      expect(
        paths.some((p) => p.includes("prod") && p.includes("secrets")),
      ).toBe(true);
    }
  });

  it("rejects plaintext under processes.<p>.secrets:", () => {
    const result = RuntimeMapSchema.safeParse({
      default: {
        command: "x",
        processes: {
          worker: {
            secrets: { WORKER_TOKEN: "raw" },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts ENC[...] ciphertext in secrets:", () => {
    const result = RuntimeMapSchema.safeParse({
      default: {
        command: "x",
        secrets: {
          BROKER_KEK: "ENC[AES256_GCM,data:abc,iv:def,tag:ghi,type:str]",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("preserves unknown passthrough fields on default", () => {
    const parsed = RuntimeMapSchema.parse({
      default: {
        command: "x",
        // Plugin-specific extension key — survives via .passthrough().
        custom_plugin_field: { foo: "bar" },
      },
    });
    // .passthrough() keeps unknown keys at runtime. Assert via
    // toMatchObject so we do not need an unsafe cast.
    expect(parsed.default).toMatchObject({
      command: "x",
      custom_plugin_field: { foo: "bar" },
    });
  });
});

describe("RuntimeBlockSchema — discriminated union (Rule 2)", () => {
  // Inline: process keys at the block. Or processes: map. Mixing is a parse error.
  // Named processes own those keys; the block keeps deps, env, secrets.

  it("accepts inline-only shape (no processes:)", () => {
    const result = RuntimeBlockSchema.safeParse({
      command: "node x.js",
      port: 3000,
      cpu: "1",
      memory: "512Mi",
    });
    expect(result.success).toBe(true);
  });

  it("accepts processes:-only shape (no inline process keys)", () => {
    const result = RuntimeBlockSchema.safeParse({
      deps: ["db"],
      processes: {
        default: { command: "node x.js", port: 3000 },
        worker: { command: "node worker.js" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts processes: alongside service-level keys (deps/env/secrets)", () => {
    // deps, env, and secrets are service-level — allowed alongside processes:.
    const result = RuntimeBlockSchema.safeParse({
      deps: ["db", "redis"],
      env: { LOG_LEVEL: "info" },
      processes: {
        default: { command: "bun run src/index.ts", port: 3001 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects mixing command with processes:", () => {
    const result = RuntimeBlockSchema.safeParse({
      command: "node x.js",
      processes: {
        worker: { command: "node worker.js" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.errors.map((e) => e.message).join("\n");
      expect(msg).toMatch(/cannot mix inline process keys/);
      expect(msg).toMatch(/command/);
    }
  });

  it("rejects mixing port with processes:", () => {
    const result = RuntimeBlockSchema.safeParse({
      port: 3000,
      processes: { default: { command: "x" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.errors.map((e) => e.message).join("\n");
      expect(msg).toMatch(/cannot mix inline process keys/);
      expect(msg).toMatch(/port/);
    }
  });

  it("rejects mixing cpu/memory with processes:", () => {
    const result = RuntimeBlockSchema.safeParse({
      cpu: "2",
      memory: "1Gi",
      processes: { default: { command: "x" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.errors.map((e) => e.message).join("\n");
      expect(msg).toMatch(/cannot mix inline process keys/);
      expect(msg).toMatch(/cpu/);
      expect(msg).toMatch(/memory/);
    }
  });

  it("rejects mixing pre_command with processes:", () => {
    const result = RuntimeBlockSchema.safeParse({
      pre_command: "bunx drizzle-kit migrate",
      processes: { default: { command: "x" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.errors.map((e) => e.message).join("\n");
      expect(msg).toMatch(/cannot mix inline process keys/);
      expect(msg).toMatch(/pre_command/);
    }
  });

  it("rejects via RuntimeMapSchema when default block mixes inline keys with processes:", () => {
    // Validates that the superRefine check propagates through the full map parse.
    const result = RuntimeMapSchema.safeParse({
      default: {
        command: "node x.js",
        port: 3000,
        processes: {
          worker: { command: "node worker.js" },
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.errors.map((e) => e.message).join("\n");
      expect(msg).toMatch(/cannot mix inline process keys/);
    }
  });

  it("allows empty processes: map (no inline keys present)", () => {
    // Empty map — no processes declared. superRefine only fires when
    // processes map has entries, so this should pass.
    const result = RuntimeBlockSchema.safeParse({
      command: "x",
      processes: {},
    });
    expect(result.success).toBe(true);
  });
});

describe("mergeRuntimeBlock", () => {
  it("deep-merges env by key (named wins on collision)", () => {
    const merged = mergeRuntimeBlock(
      { env: { A: "default-A", B: "default-B" } },
      { env: { B: "named-B", C: "named-C" } },
    );
    expect(merged.env).toEqual({
      A: "default-A",
      B: "named-B",
      C: "named-C",
    });
  });

  it("deep-merges secrets by key (named wins on collision)", () => {
    const merged = mergeRuntimeBlock(
      {
        secrets: {
          A: "ENC[default-A]",
          B: "ENC[default-B]",
        },
      },
      {
        secrets: {
          B: "ENC[named-B]",
          C: "ENC[named-C]",
        },
      },
    );
    expect(merged.secrets).toEqual({
      A: "ENC[default-A]",
      B: "ENC[named-B]",
      C: "ENC[named-C]",
    });
  });

  it("replaces deps (anonymous list) — does NOT concatenate", () => {
    const merged = mergeRuntimeBlock(
      { deps: ["db", "redis"] },
      { deps: ["postgres"] },
    );
    expect(merged.deps).toEqual(["postgres"]);
  });

  it("replaces scalars (command, cpu, port) on overlay", () => {
    const merged = mergeRuntimeBlock(
      { command: "default-cmd", cpu: "1", port: 3000 },
      { command: "named-cmd", cpu: "2" },
    );
    expect(merged.command).toBe("named-cmd");
    expect(merged.cpu).toBe("2");
    expect(merged.port).toBe(3000); // not overridden
  });

  it("recursively merges processes by process name", () => {
    const merged = mergeRuntimeBlock(
      {
        processes: {
          worker: { command: "default-worker", env: { A: "1" } },
          cron: { command: "default-cron" },
        },
      },
      {
        processes: {
          worker: { env: { B: "2" } }, // partial overlay — keeps default-worker command
          extra: { command: "extra-cmd" }, // new process
        },
      },
    );
    expect(merged.processes?.worker?.command).toBe("default-worker");
    expect(merged.processes?.worker?.env).toEqual({ A: "1", B: "2" });
    expect(merged.processes?.cron?.command).toBe("default-cron");
    expect(merged.processes?.extra?.command).toBe("extra-cmd");
  });
});

describe("resolveRuntime — 4-layer override priority", () => {
  it("layer 1: default.env wins when nothing else sets a key", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: { env: { LOG_LEVEL: "info" } },
      }),
      "default",
    );
    expect(resolved.envs.effective.LOG_LEVEL).toBe("info");
    expect(resolved.envs.env.LOG_LEVEL).toBe("info");
    expect(resolved.envs.secrets.LOG_LEVEL).toBeUndefined();
  });

  it("layer 2: default.secret overrides default.env (secret wins in same runtime)", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: {
          env: { API_KEY: "plaintext-api-key" },
          secrets: { API_KEY: "ENC[ciphertext]" },
        },
      }),
      "default",
    );
    expect(resolved.envs.effective.API_KEY).toBe("ENC[ciphertext]");
    expect(resolved.envs.secrets.API_KEY).toBe("ENC[ciphertext]");
    // env should NOT contain API_KEY — it's masked by the secret.
    expect(resolved.envs.env.API_KEY).toBeUndefined();
  });

  it("layer 3: name.env overrides default.env (named wins over default)", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: { env: { LOG_LEVEL: "info" } },
        prod: { env: { LOG_LEVEL: "warn" } },
      }),
      "prod",
    );
    expect(resolved.envs.effective.LOG_LEVEL).toBe("warn");
    expect(resolved.envs.env.LOG_LEVEL).toBe("warn");
  });

  it("layer 4: name.secret overrides everything (highest priority)", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: {
          env: { DATABASE_URL: "default-env-value" },
          secrets: { DATABASE_URL: "ENC[default-secret]" },
        },
        prod: {
          env: { DATABASE_URL: "prod-env-value" },
          secrets: { DATABASE_URL: "ENC[prod-secret]" },
        },
      }),
      "prod",
    );
    expect(resolved.envs.effective.DATABASE_URL).toBe("ENC[prod-secret]");
    expect(resolved.envs.secrets.DATABASE_URL).toBe("ENC[prod-secret]");
  });

  it("named runtime wins over default for env-only keys", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: { secrets: { TOKEN: "ENC[default-token]" } },
        test: { env: { TOKEN: "test-token-plaintext" } },
      }),
      "test",
    );
    // Named runtime's env overrides default's secret for the same key —
    // named wins over default regardless of env-vs-secret.
    expect(resolved.envs.effective.TOKEN).toBe("test-token-plaintext");
    expect(resolved.envs.env.TOKEN).toBe("test-token-plaintext");
    expect(resolved.envs.secrets.TOKEN).toBeUndefined();
  });

  it("merges non-overlapping keys from default + named", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: { env: { A: "1", B: "2" } },
        prod: { env: { C: "3" } },
      }),
      "prod",
    );
    expect(resolved.envs.effective).toEqual({ A: "1", B: "2", C: "3" });
  });

  it("default-only resolution ignores named runtimes", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: { env: { A: "default" } },
        prod: { env: { A: "prod" } },
      }),
      "default",
    );
    expect(resolved.envs.effective.A).toBe("default");
  });

  it("falls back to default block when service has no overlay for the requested runtime", () => {
    // Missing named overlay falls back to default. Unknown runtime
    // names are caught upstream by resolveRuntimePlugin, not here.
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: { command: "x", env: { A: "default" } },
      }),
      "staging",
    );
    expect(resolved.command).toBe("x");
    expect(resolved.envs.effective.A).toBe("default");
    // Name still surfaces as the requested runtime so plugins can log
    // or branch on it consistently.
    expect(resolved.name).toBe("staging");
  });
});

describe("resolveRuntime — non-env fields", () => {
  it("resolves command/port/cpu/memory from named overlay", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: {
          command: "node x.js",
          port: 3000,
          cpu: "1",
          memory: "512Mi",
        },
        prod: { cpu: "2", memory: "1Gi" },
      }),
      "prod",
    );
    // command/port inherit from default; cpu/memory come from prod.
    expect(resolved.command).toBe("node x.js");
    expect(resolved.port).toBe(3000);
    expect(resolved.cpu).toBe("2");
    expect(resolved.memory).toBe("1Gi");
  });

  it("named deps replace default deps (anonymous list)", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: { deps: ["db", "redis"] },
        prod: { deps: ["postgres"] },
      }),
      "prod",
    );
    expect(resolved.deps).toEqual(["postgres"]);
  });

  it("inherits deps from default when named omits them", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: { deps: ["db", "redis"] },
        prod: { cpu: "2" },
      }),
      "prod",
    );
    expect(resolved.deps).toEqual(["db", "redis"]);
  });

  it("applies scalar defaults on the default block (cpu/memory/port/replicas)", () => {
    // Service declares only `command` — default block scalars must come from
    // DefaultRuntimeBlockSchema's baked-in defaults, not be undefined.
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({ default: { command: "x" } }),
    );
    expect(resolved.cpu).toBe("1");
    expect(resolved.memory).toBe("512Mi");
    expect(resolved.port).toBe(3000);
    expect(resolved.replicas).toBe(1);
  });

  it("named overlays inherit scalar defaults from default block", () => {
    // Named overlay sets nothing scalar — must inherit from default's
    // post-default cpu="1"/memory="512Mi"/port=3000/replicas=1.
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: { command: "x" },
        prod: { env: { LOG: "info" } },
      }),
      "prod",
    );
    expect(resolved.cpu).toBe("1");
    expect(resolved.memory).toBe("512Mi");
    expect(resolved.port).toBe(3000);
    expect(resolved.replicas).toBe(1);
  });

  it("explicit values on default block override the schema defaults", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: { command: "x", cpu: "2", port: 8080 },
      }),
    );
    expect(resolved.cpu).toBe("2");
    expect(resolved.port).toBe(8080);
    // Unset scalars still get baked-in defaults
    expect(resolved.memory).toBe("512Mi");
    expect(resolved.replicas).toBe(1);
  });

  it("merges processes by name across runtimes", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: {
          processes: {
            web: { command: "node web.js", port: 3000 },
            worker: { command: "node worker.js" },
          },
        },
        prod: {
          processes: {
            web: { cpu: "2" }, // partial overlay
            // worker stays from default
          },
        },
      }),
      "prod",
    );
    expect(resolved.processes?.web?.command).toBe("node web.js");
    expect(resolved.processes?.web?.cpu).toBe("2");
    expect(resolved.processes?.worker?.command).toBe("node worker.js");
  });
});

describe("VolumeSchema", () => {
  // Volumes on `runtime.<env>.volumes` and per-process. Compose emits
  // named volumes (size ignored); terraform emits one PVC (size → storage).

  it("accepts a valid entry (name kebab-case, mountPath absolute, size k8s quantity)", () => {
    const result = VolumeSchema.safeParse({
      name: "data",
      mountPath: "/opt/sonarqube/data",
      size: "5Gi",
    });
    expect(result.success).toBe(true);
  });

  it("accepts Mi / Gi / Ti suffixes on size", () => {
    for (const size of ["500Mi", "5Gi", "1Ti"]) {
      const result = VolumeSchema.safeParse({
        name: "data",
        mountPath: "/data",
        size,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects a name that is not lowercase kebab-case", () => {
    for (const name of ["Data", "data_volume", "data!", "1data", "-data"]) {
      const result = VolumeSchema.safeParse({
        name,
        mountPath: "/data",
        size: "5Gi",
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects a mountPath that is not absolute", () => {
    const result = VolumeSchema.safeParse({
      name: "data",
      mountPath: "opt/sonarqube/data",
      size: "5Gi",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a size without a k8s quantity suffix", () => {
    for (const size of ["5", "5G", "5GB", "5gi", "5 Gi"]) {
      const result = VolumeSchema.safeParse({
        name: "data",
        mountPath: "/data",
        size,
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects unknown keys via `.strict()`", () => {
    const result = VolumeSchema.safeParse({
      name: "data",
      mountPath: "/data",
      size: "5Gi",
      accessMode: "ReadWriteMany",
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate volume names within a single runtime block (parse-time)", () => {
    const result = RuntimeBlockSchema.safeParse({
      volumes: [
        { name: "data", mountPath: "/a", size: "5Gi" },
        { name: "data", mountPath: "/b", size: "5Gi" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate mountPaths within a single runtime block (parse-time)", () => {
    const result = RuntimeBlockSchema.safeParse({
      volumes: [
        { name: "data", mountPath: "/shared", size: "5Gi" },
        { name: "extras", mountPath: "/shared", size: "5Gi" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts volumes on the runtime block (shorthand for the default process)", () => {
    const result = RuntimeBlockSchema.safeParse({
      command: "x",
      volumes: [{ name: "data", mountPath: "/data", size: "5Gi" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts volumes inside a named process", () => {
    const result = RuntimeBlockSchema.safeParse({
      processes: {
        web: {
          command: "x",
          volumes: [{ name: "data", mountPath: "/data", size: "5Gi" }],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  // source vs size picks host-mount/ConfigMap vs PVC/named-volume.
  // Compose uses `source` as-is; terraform reads child files into a ConfigMap.
  describe("host-mount mode (source-based volumes)", () => {
    it("accepts a valid host-mount entry (source present, size absent)", () => {
      const result = VolumeSchema.safeParse({
        name: "migrations",
        mountPath: "/docker-entrypoint-initdb.d",
        source: "./migrations",
        readOnly: true,
      });
      expect(result.success).toBe(true);
    });

    it("defaults `readOnly` to false when omitted", () => {
      const result = VolumeSchema.safeParse({
        name: "migrations",
        mountPath: "/etc/config",
        source: "./config",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.readOnly).toBe(false);
      }
    });

    it("accepts `readOnly: true` parses correctly", () => {
      const result = VolumeSchema.safeParse({
        name: "migrations",
        mountPath: "/etc/config",
        source: "./config",
        readOnly: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.readOnly).toBe(true);
      }
    });

    it("PVC mode defaults `readOnly` to false as well (shared field)", () => {
      const result = VolumeSchema.safeParse({
        name: "data",
        mountPath: "/data",
        size: "5Gi",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.readOnly).toBe(false);
      }
    });

    it("rejects an entry that declares BOTH `source` and `size`", () => {
      const result = VolumeSchema.safeParse({
        name: "data",
        mountPath: "/data",
        source: "./migrations",
        size: "5Gi",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const message = result.error.issues.map((i) => i.message).join("\n");
        expect(message).toContain("data");
        expect(message).toMatch(/cannot declare both/i);
      }
    });

    it("rejects an entry that declares NEITHER `source` nor `size`", () => {
      const result = VolumeSchema.safeParse({
        name: "data",
        mountPath: "/data",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const message = result.error.issues.map((i) => i.message).join("\n");
        expect(message).toContain("data");
        expect(message).toMatch(/exactly one of/i);
      }
    });

    it("rejects a non-string `source`", () => {
      const result = VolumeSchema.safeParse({
        name: "migrations",
        mountPath: "/etc/config",
        source: 42,
      });
      expect(result.success).toBe(false);
    });

    it("rejects an empty `source`", () => {
      const result = VolumeSchema.safeParse({
        name: "migrations",
        mountPath: "/etc/config",
        source: "",
      });
      expect(result.success).toBe(false);
    });

    it("rejects a non-boolean `readOnly`", () => {
      const result = VolumeSchema.safeParse({
        name: "migrations",
        mountPath: "/etc/config",
        source: "./config",
        readOnly: "true",
      });
      expect(result.success).toBe(false);
    });
  });
});

describe("post_command — symmetric mirror of pre_command", () => {
  // post_command on the block (default process) and each named process.
  // Terraform → lifecycle.postStart.exec.command. Compose drops it.

  it("accepts post_command at the runtime block level (flat shorthand)", () => {
    const result = RuntimeBlockSchema.safeParse({
      command: "node server.js",
      post_command: "curl -s http://localhost/bootstrap || true",
    });
    expect(result.success).toBe(true);
  });

  it("accepts post_command inside a named process", () => {
    const result = RuntimeBlockSchema.safeParse({
      processes: {
        web: {
          command: "node server.js",
          post_command: "echo ready",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects mixing inline post_command with a processes: map", () => {
    // post_command is process-level. Mixing the inline shorthand with
    // processes: is the same union violation pre_command enforces.
    const result = RuntimeBlockSchema.safeParse({
      post_command: "echo ready",
      processes: {
        web: { command: "node server.js" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("resolveRuntime surfaces post_command as postCommand on the resolved runtime", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: {
          command: "node server.js",
          post_command: "echo ready",
        },
      }),
    );
    expect(resolved.postCommand).toBe("echo ready");
  });
});

describe("resolveRuntime — volumes propagation", () => {
  it("surfaces block-level volumes on the resolved runtime", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: {
          command: "x",
          volumes: [{ name: "data", mountPath: "/data", size: "5Gi" }],
        },
      }),
    );
    expect(resolved.volumes).toEqual([
      { name: "data", mountPath: "/data", size: "5Gi", readOnly: false },
    ]);
  });

  it("named overlay volumes replace default volumes (anonymous list semantics)", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: {
          command: "x",
          volumes: [{ name: "data", mountPath: "/data", size: "1Gi" }],
        },
        prod: {
          volumes: [
            { name: "data", mountPath: "/data", size: "10Gi" },
            { name: "extras", mountPath: "/extras", size: "5Gi" },
          ],
        },
      }),
      "prod",
    );
    expect(resolved.volumes).toEqual([
      { name: "data", mountPath: "/data", size: "10Gi", readOnly: false },
      { name: "extras", mountPath: "/extras", size: "5Gi", readOnly: false },
    ]);
  });

  it("named overlay without volumes inherits default volumes", () => {
    const resolved = resolveRuntime(
      RuntimeMapSchema.parse({
        default: {
          command: "x",
          volumes: [{ name: "data", mountPath: "/data", size: "5Gi" }],
        },
        prod: { cpu: "2" },
      }),
      "prod",
    );
    expect(resolved.volumes).toEqual([
      { name: "data", mountPath: "/data", size: "5Gi", readOnly: false },
    ]);
  });
});
