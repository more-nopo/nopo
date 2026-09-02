import { describe, expect, it } from "vitest";

import { Script } from "./lib.ts";
import ActScript from "./scripts/act.ts";
import BuildScript from "./scripts/build.ts";
import CommandScript from "./scripts/command.ts";
import DownScript from "./scripts/down.ts";
import EnvScript from "./scripts/env.ts";
import InstallScript from "./scripts/install.ts";
import ListScript from "./scripts/list.ts";
import SecretScript from "./scripts/secret.ts";
import StatusScript from "./scripts/status.ts";
import SyncScript from "./scripts/sync.ts";
import UpScript from "./scripts/up.ts";

/**
 * The queue-participation contract: core decides whether a command queues
 * from the resolved Script CLASS, never from a command-name string. Everything
 * queues by default; only the listed core scripts opt out via `skipQueue`.
 */
describe("worker-queue exemption", () => {
  it("defaults to queuing (base Script.skipQueue is false)", () => {
    expect(Script.skipQueue).toBe(false);
  });

  it("exempts instant read-only core scripts", () => {
    for (const S of [StatusScript, ListScript, EnvScript, SecretScript]) {
      expect(S.skipQueue).toBe(true);
    }
  });

  it("exempts long-lived service-lifecycle core scripts", () => {
    for (const S of [UpScript, DownScript, ActScript]) {
      expect(S.skipQueue).toBe(true);
    }
  });

  it("queues genuinely heavy core scripts", () => {
    for (const S of [BuildScript, InstallScript, SyncScript]) {
      expect(S.skipQueue).toBe(false);
    }
  });

  it("queues CommandScript — every arbitrary `nopo <cmd>` participates", () => {
    expect(CommandScript.skipQueue).toBe(false);
  });
});
