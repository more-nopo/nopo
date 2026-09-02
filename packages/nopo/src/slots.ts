/** Each registered script exposes a `pre_<s>` / `<s>` / `post_<s>` trio; plugins hook those
 * names via {@link definePlugin} for compile-time validation, or load dynamically with
 * runtime checks via {@link assertSlotsValid}.
 */

import type { IO } from "./io.ts";

/** Source of truth for which scripts have a slot trio. */
export const SCRIPT_REGISTRY = [
  "build",
  "up",
  "down",
  "status",
  "env",
  "command",
] as const;

export type ScriptName = (typeof SCRIPT_REGISTRY)[number];

const SCRIPT_SET: ReadonlySet<ScriptName> = new Set(SCRIPT_REGISTRY);

/** e.g. `SlotsFor<"build">` = `"pre_build" | "build" | "post_build"`. */
export type SlotsFor<S extends ScriptName> = `pre_${S}` | `${S}` | `post_${S}`;

export type AllSlots = SlotsFor<ScriptName>;

export interface HookContext<Payload = unknown> {
  io: IO;
  /** Per-node payload from the {@link Plan}, merged with handler defaults. */
  payload: Payload;
}

export type Hook<Payload = unknown> = (
  ctx: HookContext<Payload>,
) => Promise<void> | void;

/** Plugins author this via {@link definePlugin}; unknown keys = compile error. */
export type SlotMap = {
  readonly [K in AllSlots]?: Hook;
};

export interface PluginManifest {
  /** Referenced by `PlanHandler.plugin`. */
  readonly name: string;
  readonly description?: string;
  readonly hooks?: SlotMap;
}

/** Type-level: which slots a manifest actually implements. */
export type ImplementedSlots<M extends PluginManifest> =
  M["hooks"] extends infer H
    ? H extends SlotMap
      ? Extract<keyof H, AllSlots>
      : never
    : never;

/** Identity function — all the value is in the inferred return type. */
export function definePlugin<M extends PluginManifest>(manifest: M): M {
  return manifest;
}

/** Lists hook slots in declaration order; filters unknown keys defensively. */
export function manifestSlots(manifest: PluginManifest): AllSlots[] {
  const hooks = manifest.hooks;
  if (hooks === undefined) return [];
  const out: AllSlots[] = [];
  for (const key of Object.keys(hooks)) {
    if (isKnownSlot(key)) out.push(key);
  }
  return out;
}

/** Throws {@link PluginSlotError} listing every offending key. */
export function assertSlotsValid(manifest: PluginManifest): void {
  const hooks = manifest.hooks;
  if (hooks === undefined) return;
  const invalid: string[] = [];
  for (const key of Object.keys(hooks)) {
    if (!isKnownSlot(key)) invalid.push(key);
  }
  if (invalid.length > 0) {
    throw new PluginSlotError(
      `Plugin "${manifest.name}" declares unknown slot${
        invalid.length === 1 ? "" : "s"
      }: ${invalid.map((s) => `"${s}"`).join(", ")}`,
      manifest.name,
      invalid,
    );
  }
}

export class PluginSlotError extends Error {
  public readonly pluginName: string;
  public readonly invalidSlots: readonly string[];

  constructor(
    message: string,
    pluginName: string,
    invalidSlots: readonly string[],
  ) {
    super(message);
    this.name = "PluginSlotError";
    this.pluginName = pluginName;
    this.invalidSlots = invalidSlots;
  }
}

/** True iff `slot` is `pre_<script>` | `<script>` | `post_<script>`. */
export function isSlotForScript(slot: string, script: ScriptName): boolean {
  if (!SCRIPT_SET.has(script)) return false;
  return (
    slot === script || slot === `pre_${script}` || slot === `post_${script}`
  );
}

function isKnownSlot(key: string): key is AllSlots {
  if (key.startsWith("pre_")) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Set.has narrows the literal at runtime
    return SCRIPT_SET.has(key.slice(4) as ScriptName);
  }
  if (key.startsWith("post_")) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Set.has narrows the literal at runtime
    return SCRIPT_SET.has(key.slice(5) as ScriptName);
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Set.has narrows the literal at runtime
  return SCRIPT_SET.has(key as ScriptName);
}
