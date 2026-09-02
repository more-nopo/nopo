import { beforeEach, describe, expect, it, vi } from "vitest";

import { exec, Logger, Runner } from "../../src/lib.ts";
import { createConfig } from "../../src/lib.ts";
import { Environment } from "../../src/parse-env.ts";
import CommandScript from "../../src/scripts/command.ts";
import { createTmpEnv, FIXTURES_ROOT } from "../utils.ts";

// Mock exec so commands don't actually run — we inspect the env passed to them
vi.mock("../../src/lib.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib.ts")>();
  return {
    ...original,
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  };
});

function createRunner(argv: string[], processEnv: Record<string, string> = {}) {
  const config = createConfig({
    rootDir: FIXTURES_ROOT,
    envFile: createTmpEnv({}),
    processEnv,
    silent: true,
  });
  const logger = new Logger(config);
  const environment = new Environment(config);
  return new Runner(config, environment, argv, logger);
}

function getExecEnv(callIndex = 0): Record<string, string> {
  const calls = vi.mocked(exec).mock.calls;
  const call = calls[callIndex];
  if (!call) throw new Error(`exec was not called (index ${callIndex})`);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test helper accessing mock call args
  const opts = call[2] as { env?: Record<string, string> } | undefined;
  return opts?.env ?? {};
}

describe("Environment variable expansion (e2e with fixture)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("defaults — no process env overrides", () => {
    it("expands ${VAR:-default} to the default value", async () => {
      const runner = createRunner(["show-env", "env-expand"]);
      await runner.run(CommandScript);

      const env = getExecEnv();
      // ${TALOS_NODE:-192.168.1.124} → "192.168.1.124"
      expect(env.NODE_IP).toBe("192.168.1.124");
    });

    it("expands ${VAR} to empty string when unset", async () => {
      const runner = createRunner(["show-env", "env-expand"]);
      await runner.run(CommandScript);

      const env = getExecEnv();
      // ${CUSTOM_HOST} → "" (not set)
      expect(env.SIMPLE_REF).toBe("");
    });

    it("expands $VAR to empty string when unset", async () => {
      const runner = createRunner(["show-env", "env-expand"]);
      await runner.run(CommandScript);

      const env = getExecEnv();
      // $CUSTOM_HOST → "" (not set)
      expect(env.UNBRACED).toBe("");
    });

    it("expands ${VAR-default} to default when unset", async () => {
      const runner = createRunner(["show-env", "env-expand"]);
      await runner.run(CommandScript);

      const env = getExecEnv();
      // ${MAYBE_SET-fallback_value} → "fallback_value"
      expect(env.UNSET_ONLY).toBe("fallback_value");
    });

    it("expands inline references in composite strings", async () => {
      const runner = createRunner(["show-env", "env-expand"]);
      await runner.run(CommandScript);

      const env = getExecEnv();
      // "https://${TALOS_NODE:-192.168.1.124}:6443" → "https://192.168.1.124:6443"
      expect(env.ENDPOINT).toBe("https://192.168.1.124:6443");
    });

    it("passes plain values unchanged", async () => {
      const runner = createRunner(["show-env", "env-expand"]);
      await runner.run(CommandScript);

      const env = getExecEnv();
      expect(env.STATIC).toBe("plain_value");
    });
  });

  describe("process env overrides", () => {
    it("uses process env value instead of default", async () => {
      const runner = createRunner(["show-env", "env-expand"], {
        TALOS_NODE: "10.0.0.50",
      });
      await runner.run(CommandScript);

      const env = getExecEnv();
      expect(env.NODE_IP).toBe("10.0.0.50");
      expect(env.ENDPOINT).toBe("https://10.0.0.50:6443");
    });

    it("uses process env for simple ${VAR} expansion", async () => {
      const runner = createRunner(["show-env", "env-expand"], {
        CUSTOM_HOST: "myhost.local",
      });
      await runner.run(CommandScript);

      const env = getExecEnv();
      expect(env.SIMPLE_REF).toBe("myhost.local");
      expect(env.UNBRACED).toBe("myhost.local");
    });

    it("${VAR-default} keeps empty string (not treated as unset)", async () => {
      const runner = createRunner(["show-env", "env-expand"], {
        MAYBE_SET: "",
      });
      await runner.run(CommandScript);

      const env = getExecEnv();
      // ${MAYBE_SET-fallback_value} with MAYBE_SET="" → "" (empty is not unset)
      expect(env.UNSET_ONLY).toBe("");
    });
  });

  describe("command-level env with expansion", () => {
    it("expands env defined at the command level", async () => {
      const runner = createRunner(["nested-env", "env-expand"]);
      await runner.run(CommandScript);

      const env = getExecEnv();
      // Command-level env: CHILD_VAR: "${TALOS_NODE:-10.0.0.1}"
      expect(env.CHILD_VAR).toBe("10.0.0.1");
    });

    it("command-level env picks up process env override", async () => {
      const runner = createRunner(["nested-env", "env-expand"], {
        TALOS_NODE: "172.16.0.1",
      });
      await runner.run(CommandScript);

      const env = getExecEnv();
      expect(env.CHILD_VAR).toBe("172.16.0.1");
    });
  });

  describe("subcommand env inheritance with expansion", () => {
    it("inherits and expands parent + child env", async () => {
      const runner = createRunner(["sub:child", "env-expand"]);
      await runner.run(CommandScript);

      const env = getExecEnv();
      // Parent: PARENT_VAL: "${TALOS_NODE:-parent_default}" → "parent_default"
      expect(env.PARENT_VAL).toBe("parent_default");
      // Child: CHILD_VAL: "inherited-${TALOS_NODE:-child_default}" → "inherited-child_default"
      expect(env.CHILD_VAL).toBe("inherited-child_default");
    });

    it("subcommand env uses process env override", async () => {
      const runner = createRunner(["sub:child", "env-expand"], {
        TALOS_NODE: "10.10.10.10",
      });
      await runner.run(CommandScript);

      const env = getExecEnv();
      expect(env.PARENT_VAL).toBe("10.10.10.10");
      expect(env.CHILD_VAL).toBe("inherited-10.10.10.10");
    });
  });
});
