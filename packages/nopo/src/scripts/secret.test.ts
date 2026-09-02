import { describe, expect, it } from "vitest";

import { serializePlan } from "../plan.ts";
import { ScriptArgs } from "../script-args.ts";
import SecretScript, { parseSecretArgs } from "./secret.ts";

// parseSecretArgs — argv -> ParsedSecretArgs

describe("parseSecretArgs", () => {
  it("skips a leading 'secret' token and returns the verb", () => {
    const parsed = parseSecretArgs(["secret", "list", "api"]);
    expect(parsed.verb).toBe("list");
    expect(parsed.positionals).toEqual(["api"]);
  });

  it("returns verb=undefined when argv has only 'secret'", () => {
    const parsed = parseSecretArgs(["secret"]);
    expect(parsed.verb).toBeUndefined();
  });

  it("collects positionals after the verb in order", () => {
    const parsed = parseSecretArgs(["secret", "set", "api", "KEY", "value"]);
    expect(parsed.positionals).toEqual(["api", "KEY", "value"]);
  });

  it("parses --runtime <name> into the runtime field", () => {
    const parsed = parseSecretArgs([
      "secret",
      "get",
      "api",
      "KEY",
      "--runtime",
      "prod",
    ]);
    expect(parsed.runtime).toBe("prod");
  });

  it("parses --runtime=<name> (= form) into the runtime field", () => {
    const parsed = parseSecretArgs([
      "secret",
      "get",
      "api",
      "KEY",
      "--runtime=prod",
    ]);
    expect(parsed.runtime).toBe("prod");
  });

  it("parses --from-stdin and --unsafe as booleans", () => {
    const parsed = parseSecretArgs([
      "secret",
      "set",
      "api",
      "KEY",
      "--from-stdin",
      "--unsafe",
    ]);
    expect(parsed.fromStdin).toBe(true);
    expect(parsed.unsafe).toBe(true);
  });

  it("silently consumes --help / --print / --json so they don't surface as positionals", () => {
    const parsed = parseSecretArgs(["secret", "list", "api", "--help"]);
    expect(parsed.positionals).toEqual(["api"]);

    // M3: --json is accepted as a sibling of --print and is also consumed.
    const parsedWithJson = parseSecretArgs([
      "secret",
      "list",
      "api",
      "--print",
      "--json",
    ]);
    expect(parsedWithJson.positionals).toEqual(["api"]);
  });

  it("rejects unknown flags with a 'Supported: ...' message", () => {
    expect(() =>
      parseSecretArgs(["secret", "list", "api", "--frobby"]),
    ).toThrow(/Unknown flag --frobby/);
  });
});

// SecretScript.plan — verb routing

describe("SecretScript.plan", () => {
  it("emits a node with handler 'secret:list' for `secret list`", () => {
    const plan = SecretScript.plan(new ScriptArgs({}), {
      argv: ["secret", "list", "api"],
    });
    expect(plan.nodes.size).toBe(1);
    const node = plan.nodes.get("secret:list");
    if (node === undefined) throw new Error("expected 'secret:list' node");
    if (node.handler.kind !== "builtin") {
      throw new Error(`expected builtin handler, got ${node.handler.kind}`);
    }
    expect(node.handler.name).toBe("secret:list");
    expect(node.meta?.script).toBe("secret");
    expect(node.meta?.verb).toBe("list");
  });

  it("emits handler 'secret:keygen' for `secret keygen`", () => {
    const plan = SecretScript.plan(new ScriptArgs({}), {
      argv: ["secret", "keygen"],
    });
    const node = plan.nodes.get("secret:keygen");
    if (node === undefined) throw new Error("expected 'secret:keygen' node");
    if (node.handler.kind !== "builtin") {
      throw new Error("expected builtin handler");
    }
    expect(node.handler.name).toBe("secret:keygen");
  });

  it("emits handler 'secret:rotate-key' for `secret rotate-key`", () => {
    const plan = SecretScript.plan(new ScriptArgs({}), {
      argv: ["secret", "rotate-key"],
    });
    const node = plan.nodes.get("secret:rotate-key");
    if (node === undefined) {
      throw new Error("expected 'secret:rotate-key' node");
    }
    if (node.handler.kind !== "builtin") {
      throw new Error("expected builtin handler");
    }
    expect(node.handler.name).toBe("secret:rotate-key");
  });

  it("throws 'Missing secret verb' when no verb is on argv", () => {
    expect(() =>
      SecretScript.plan(new ScriptArgs({}), { argv: ["secret"] }),
    ).toThrow(/Missing secret verb/);
  });

  it("throws 'Unknown secret verb' when verb isn't in VALID_VERBS", () => {
    expect(() =>
      SecretScript.plan(new ScriptArgs({}), {
        argv: ["secret", "frobnicate"],
      }),
    ).toThrow(/Unknown secret verb/);
  });

  it("carries the parsed argv on payload.parsed", () => {
    const plan = SecretScript.plan(new ScriptArgs({}), {
      argv: ["secret", "get", "api", "KEY", "--unsafe", "--runtime", "prod"],
    });
    const node = plan.nodes.get("secret:get")!;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime narrowing of plan payload for unit assertion
    const payload = node.payload as {
      parsed: ReturnType<typeof parseSecretArgs>;
    };
    expect(payload.parsed.positionals).toEqual(["api", "KEY"]);
    expect(payload.parsed.unsafe).toBe(true);
    expect(payload.parsed.runtime).toBe("prod");
  });

  it("serializePlan round-trips a secret plan losslessly", () => {
    const plan = SecretScript.plan(new ScriptArgs({}), {
      argv: ["secret", "list", "api"],
    });
    const serialized = serializePlan(plan);
    const json: unknown = JSON.parse(JSON.stringify(serialized));
    expect(json).toEqual(serialized);
  });
});
