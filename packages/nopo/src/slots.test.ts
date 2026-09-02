import { describe, expect, expectTypeOf, it } from "vitest";

import type { IO } from "./io.ts";
import {
  type AllSlots,
  assertSlotsValid,
  definePlugin,
  type Hook,
  type HookContext,
  type ImplementedSlots,
  isSlotForScript,
  manifestSlots,
  type PluginManifest,
  PluginSlotError,
  SCRIPT_REGISTRY,
  type ScriptName,
  type SlotsFor,
} from "./slots.ts";

// helpers

const noop: Hook = () => {};

/** Build a "dirty" hooks map for the runtime-defensive tests — simulates a plugin loaded
 * dynamically where TypeScript hasn't validated keys against {@link AllSlots}. Centralized
 * so the eslint-disable for the double type assertion lives in one place instead of every
 * callsite.
 */
function dirtyHooks(
  raw: Record<string, Hook>,
): NonNullable<PluginManifest["hooks"]> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- simulating dynamically-loaded plugin where TS can't help
  return raw as unknown as NonNullable<PluginManifest["hooks"]>;
}

// Type-level — slot derivation

describe("SlotsFor<S>", () => {
  it("derives the trio for a single script", () => {
    expectTypeOf<SlotsFor<"build">>().toEqualTypeOf<
      "pre_build" | "build" | "post_build"
    >();
  });

  it("derives the trio for env (no `_` collision)", () => {
    expectTypeOf<SlotsFor<"env">>().toEqualTypeOf<
      "pre_env" | "env" | "post_env"
    >();
  });

  it("distributes over a script-name union", () => {
    expectTypeOf<SlotsFor<"up" | "down">>().toEqualTypeOf<
      "pre_up" | "up" | "post_up" | "pre_down" | "down" | "post_down"
    >();
  });
});

describe("AllSlots", () => {
  it("includes pre_build / build / post_build", () => {
    expectTypeOf<"pre_build">().toMatchTypeOf<AllSlots>();
    expectTypeOf<"build">().toMatchTypeOf<AllSlots>();
    expectTypeOf<"post_build">().toMatchTypeOf<AllSlots>();
  });

  it("includes the trios for every registered script", () => {
    expectTypeOf<"pre_up">().toMatchTypeOf<AllSlots>();
    expectTypeOf<"post_down">().toMatchTypeOf<AllSlots>();
    expectTypeOf<"status">().toMatchTypeOf<AllSlots>();
    expectTypeOf<"post_env">().toMatchTypeOf<AllSlots>();
    expectTypeOf<"pre_command">().toMatchTypeOf<AllSlots>();
  });

  it("rejects strings that aren't valid slots", () => {
    // @ts-expect-error — "foo" is not a valid slot
    const _bad: AllSlots = "foo";
    void _bad;
    // @ts-expect-error — "pe_build" is a typo
    const _typo: AllSlots = "pe_build";
    void _typo;
  });
});

// Type-level — definePlugin inference

describe("definePlugin — type inference", () => {
  it("accepts a manifest with valid slot keys", () => {
    const m = definePlugin({
      name: "docker-compose",
      hooks: {
        pre_build: noop,
        build: noop,
        post_build: noop,
        up: noop,
      },
    });
    expect(m.name).toBe("docker-compose");
    // hooks is preserved (not widened to a generic Partial<...>)
    expectTypeOf(m.hooks).not.toBeUndefined();
  });

  it("rejects a typo'd slot key at compile time", () => {
    definePlugin({
      name: "x",
      hooks: {
        // @ts-expect-error — `pe_build` is a typo, not a registered slot
        pe_build: noop,
      },
    });
  });

  it("rejects a slot for an unknown script at compile time", () => {
    definePlugin({
      name: "x",
      hooks: {
        // @ts-expect-error — `foo` is not in SCRIPT_REGISTRY
        foo: noop,
      },
    });
    definePlugin({
      name: "x",
      hooks: {
        // @ts-expect-error — `pre_foo` is not in SCRIPT_REGISTRY
        pre_foo: noop,
      },
    });
  });
});

describe("ImplementedSlots<M>", () => {
  it("narrows to the keys actually present on hooks", () => {
    const _m = definePlugin({
      name: "p",
      hooks: { pre_build: noop, up: noop },
    });
    expectTypeOf<ImplementedSlots<typeof _m>>().toEqualTypeOf<
      "pre_build" | "up"
    >();
    expect(_m.name).toBe("p");
  });

  it("resolves to never when hooks is absent", () => {
    const _m = definePlugin({ name: "p" });
    expectTypeOf<ImplementedSlots<typeof _m>>().toEqualTypeOf<never>();
    expect(_m.name).toBe("p");
  });
});

// Runtime — SCRIPT_REGISTRY

describe("SCRIPT_REGISTRY", () => {
  it("contains the baseline scripts", () => {
    expect(SCRIPT_REGISTRY).toEqual([
      "build",
      "up",
      "down",
      "status",
      "env",
      "command",
    ]);
  });

  it("ScriptName matches the registry", () => {
    expectTypeOf<ScriptName>().toEqualTypeOf<
      "build" | "up" | "down" | "status" | "env" | "command"
    >();
  });
});

// Runtime — manifestSlots

describe("manifestSlots", () => {
  it("lists hook keys in declaration order", () => {
    const slots = manifestSlots({
      name: "x",
      hooks: { pre_build: noop, up: noop, post_down: noop },
    });
    expect(slots).toEqual(["pre_build", "up", "post_down"]);
  });

  it("returns [] when hooks is missing", () => {
    expect(manifestSlots({ name: "x" })).toEqual([]);
  });

  it("returns [] when hooks is empty", () => {
    expect(manifestSlots({ name: "x", hooks: {} })).toEqual([]);
  });

  it("filters unknown keys without throwing", () => {
    // Defensive — exercises the dynamic-load path where the type system
    // hasn't validated the input.
    const slots = manifestSlots({
      name: "x",
      hooks: dirtyHooks({ pre_build: noop, bogus: noop, up: noop }),
    });
    expect(slots).toEqual(["pre_build", "up"]);
  });
});

// Runtime — assertSlotsValid + PluginSlotError

describe("assertSlotsValid", () => {
  it("does not throw for a clean manifest", () => {
    expect(() =>
      assertSlotsValid({
        name: "x",
        hooks: { pre_build: noop, build: noop, post_build: noop },
      }),
    ).not.toThrow();
  });

  it("does not throw when hooks is absent", () => {
    expect(() => assertSlotsValid({ name: "x" })).not.toThrow();
  });

  it("throws PluginSlotError listing every offender", () => {
    let caught: unknown;
    try {
      assertSlotsValid({
        name: "evil",
        hooks: dirtyHooks({
          pre_build: noop,
          bogus: noop,
          pe_build: noop,
        }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginSlotError);
    if (!(caught instanceof PluginSlotError)) throw new Error("unreachable");
    expect(caught.pluginName).toBe("evil");
    expect(caught.invalidSlots).toEqual(["bogus", "pe_build"]);
    expect(caught.message).toContain("evil");
    expect(caught.message).toContain("bogus");
    expect(caught.message).toContain("pe_build");
  });

  it("uses singular wording when only one slot is invalid", () => {
    try {
      assertSlotsValid({ name: "x", hooks: dirtyHooks({ bogus: noop }) });
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof Error)) throw new Error("unreachable");
      expect(err.message).toMatch(/unknown slot:/);
      expect(err.message).not.toMatch(/unknown slots:/);
    }
  });
});

describe("PluginSlotError", () => {
  it("is an Error subclass with `name` set", () => {
    const e = new PluginSlotError("msg", "p", ["x"]);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PluginSlotError");
    expect(e.pluginName).toBe("p");
    expect(e.invalidSlots).toEqual(["x"]);
  });
});

// Runtime — isSlotForScript

describe("isSlotForScript", () => {
  it("matches the pre/main/post trio for a script", () => {
    expect(isSlotForScript("pre_build", "build")).toBe(true);
    expect(isSlotForScript("build", "build")).toBe(true);
    expect(isSlotForScript("post_build", "build")).toBe(true);
  });

  it("rejects a slot that belongs to a different script", () => {
    expect(isSlotForScript("pre_up", "build")).toBe(false);
    expect(isSlotForScript("post_env", "build")).toBe(false);
    expect(isSlotForScript("status", "build")).toBe(false);
  });

  it("rejects an entirely unknown slot", () => {
    expect(isSlotForScript("foo", "build")).toBe(false);
    expect(isSlotForScript("pre_foo", "build")).toBe(false);
  });
});

// definePlugin — runtime identity

describe("definePlugin — runtime", () => {
  it("returns the same object reference passed in", () => {
    const input: PluginManifest = { name: "x", hooks: { build: noop } };
    expect(definePlugin(input)).toBe(input);
  });

  it("preserves additional own keys without complaining", () => {
    // The return type is the input type, so extra keys survive even though PluginManifest
    // doesn't declare them. The generic `M extends PluginManifest` captures the literal shape
    const m = definePlugin({
      name: "x",
      hooks: { build: noop },
      extra: 42,
    });
    expect(m.extra).toBe(42);
  });
});

// Hook / HookContext shape

describe("Hook / HookContext", () => {
  it("typechecks an async hook with a narrow payload", () => {
    const h: Hook<{ service: string }> = async (ctx) => {
      expectTypeOf(ctx.payload.service).toEqualTypeOf<string>();
      expectTypeOf(ctx.io).toEqualTypeOf<IO>();
    };
    void h;
  });

  it("typechecks a sync hook returning void", () => {
    const h: Hook = (ctx) => {
      void ctx;
    };
    void h;
  });

  it("HookContext defaults Payload to unknown", () => {
    type C = HookContext;
    expectTypeOf<C["payload"]>().toEqualTypeOf<unknown>();
  });
});
