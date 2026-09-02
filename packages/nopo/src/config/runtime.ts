/** Two accepted YAML shapes for `runtime:` on a service nopo.yml: (1) Flat (legacy /
 * shorthand): Auto-wrapped during normalization to `{ default: <flat> }`. Existing
 * services need zero changes. 2. Map (full shape): `default` is REQUIRED when the map
 * shape is used. Named runtimes are partial overlays that deep-merge onto `default`
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/*  Healthcheck schema                                                         */
/* -------------------------------------------------------------------------- */

/** Healthcheck `interval` / `timeout` / `delay` are whole seconds or minutes (`30s`,
 * `2m`). Sub-second is excluded: k8s probes only accept integer seconds, so `500ms` would
 * break the terraform plugin.
 */
const HEALTHCHECK_DURATION_RE = /^(\d+)(s|m)$/;

const HealthcheckDurationSchema = z
  .string()
  .regex(
    HEALTHCHECK_DURATION_RE,
    "Healthcheck durations must be whole seconds or minutes (e.g. `30s`, `2m`). Sub-second precision is not supported because k8s probes only accept integer seconds.",
  );

/** Unified healthcheck schema — single source of truth for both the compose `healthcheck:`
 * block and the k8s `readinessProbe`. A discriminated union on `type` with two variants:
 * `type: exec` — explicit argv probe. Compose emits `test: ["CMD", ...exec]`; k8s emits
 * `exec.command`. Requires the target container image to actually ship the probe binary
 */
const ExecHealthcheckSchema = z
  .object({
    type: z.literal("exec"),
    exec: z.array(z.string().min(1)).min(1),
    interval: HealthcheckDurationSchema,
    timeout: HealthcheckDurationSchema,
    retries: z.number().int().positive(),
    delay: HealthcheckDurationSchema,
  })
  .strict();

const HttpHealthcheckSchema = z
  .object({
    type: z.literal("http"),
    /** HTTP path to probe. Must start with `/`. */
    path: z.string().startsWith("/", {
      message:
        "Healthcheck `path` must start with `/` (e.g. `/health`, `/api/health/readiness`).",
    }),
    /** When omitted, the emitter falls back to the runtime's `process.port`. Parse fails
     * downstream (in the emitter) when neither is set — the schema can't enforce this
     * cross-field rule because `process.port` lives outside the healthcheck object.
     */
    port: z.number().int().positive().optional(),
    interval: HealthcheckDurationSchema,
    timeout: HealthcheckDurationSchema,
    retries: z.number().int().positive(),
    delay: HealthcheckDurationSchema,
  })
  .strict();

export const HealthcheckSchema = z.discriminatedUnion("type", [
  ExecHealthcheckSchema,
  HttpHealthcheckSchema,
]);

export type Healthcheck = z.infer<typeof HealthcheckSchema>;

/**
 * Parse a healthcheck duration string into whole seconds. Internal helper
 * — callers in the plugins translate to the target format directly off
 * the parsed `Healthcheck` value.
 */
export function healthcheckDurationToSeconds(value: string): number {
  const match = HEALTHCHECK_DURATION_RE.exec(value);
  if (!match) {
    throw new Error(
      `Invalid healthcheck duration: ${value}. Must match /^\\d+(s|m)$/.`,
    );
  }
  const n = Number(match[1]);
  return match[2] === "m" ? n * 60 : n;
}

/* -------------------------------------------------------------------------- */
/*  Volume schema                                                              */
/* -------------------------------------------------------------------------- */

/** Declared once per service runtime block, consumed by BOTH deploy plugins. Two mutually
 * exclusive modes selected by which of `size` / `source` is present: PVC mode (`size`
 * present, `source` absent): docker-compose plugin emits one named volume per entry under
 * the top-level compose `volumes:` block and a `<name>:<mountPath>` line under
 */
const VOLUME_NAME_RE = /^[a-z][a-z0-9-]*$/;
const VOLUME_SIZE_RE = /^\d+(Mi|Gi|Ti)$/;

export const VolumeSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        VOLUME_NAME_RE,
        "Volume `name` must be lowercase kebab-case (e.g. `data`, `extensions`, `pg-data`). Used as the compose volume name and the PVC suffix.",
      ),
    mountPath: z.string().startsWith("/", {
      message:
        "Volume `mountPath` must be an absolute path inside the container (e.g. `/opt/sonarqube/data`).",
    }),
    size: z
      .string()
      .regex(
        VOLUME_SIZE_RE,
        "Volume `size` must be a k8s quantity string (e.g. `5Gi`, `500Mi`, `1Ti`). Used for the PVC's spec.resources.requests.storage; compose ignores this.",
      )
      .optional(),
    source: z
      .string()
      .min(1, {
        message:
          "Volume `source` must be a non-empty path string (relative to the service's directory).",
      })
      .optional(),
    readOnly: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasSize = v.size !== undefined;
    const hasSource = v.source !== undefined;
    if (hasSize && hasSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Volume "${v.name}": cannot declare both \`size\` and \`source\`. Use \`size\` for a managed PVC / named docker volume, OR \`source\` for a host-mount / ConfigMap; never both.`,
      });
    } else if (!hasSize && !hasSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Volume "${v.name}": exactly one of \`size\` or \`source\` must be set. Use \`size: 5Gi\` for a managed PVC, or \`source: ./path\` for a host-mount / ConfigMap.`,
      });
    }
  });

export type Volume = z.infer<typeof VolumeSchema>;

/**
 * `.superRefine`-friendly volume-list validator. Enforces within-service
 * uniqueness on both `name` and `mountPath`. Hoisted so the runtime-block
 * and per-process schemas share one implementation.
 */
function validateVolumeList(
  volumes: Volume[],
  ctx: z.RefinementCtx,
  basePath: (string | number)[],
): void {
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i]!;
    if (seenNames.has(v.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...basePath, i, "name"],
        message: `volumes: duplicate name "${v.name}" — each volume in a service must have a unique name.`,
      });
    }
    seenNames.add(v.name);
    if (seenPaths.has(v.mountPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...basePath, i, "mountPath"],
        message: `volumes: duplicate mountPath "${v.mountPath}" — each volume in a service must mount at a unique container path.`,
      });
    }
    seenPaths.add(v.mountPath);
  }
}

/* -------------------------------------------------------------------------- */
/*  Per-runtime block schema                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A `secrets:` map under a runtime block. Keys are env var names; values
 * MUST be `ENC[...]` ciphertext. The `.refine()` rejects plaintext entries
 * structurally without decrypting anything.
 */
const SecretCiphertextSchema = z
  .string()
  .min(1)
  .refine((v) => v.startsWith("ENC["), {
    message:
      "Secret values must be ENC[...] ciphertext. Plaintext is forbidden under runtime.<name>.secrets:. Use `nopo secret set` to encrypt, or move the value to env: if it is non-sensitive.",
  });

const RuntimeSecretsSchema = z.record(
  z.string().min(1),
  SecretCiphertextSchema,
);

const RuntimeEnvSchema = z.record(z.string().min(1), z.string());

/** Per-process overlay inside `runtime.processes:`. Multi-process services declare named
 * processes (e.g. `worker`, `cron`) that share the service's image but run different
 * commands. The schema is intentionally loose — the canonical per-process schema is
 * defined elsewhere; the parser only needs to accept the shape so deep-merge works.
 */
const RuntimeProcessSchema = z
  .object({
    command: z.string().optional(),
    pre_command: z.string().optional(),
    post_command: z.string().optional(),
    port: z.number().int().positive().optional(),
    cpu: z.string().optional(),
    memory: z.string().optional(),
    replicas: z.number().int().nonnegative().optional(),
    /** Seconds the container sleeps in `lifecycle.preStop` before termination, so k8s can drain
     * this pod from Endpoints before the process exits. Port-bearing processes default to 5;
     * `0` disables the hook entirely.
     */
    pre_stop_delay: z.number().int().nonnegative().optional(),
    /** Working directory for the process (relative to monorepo root). */
    directory: z.string().optional(),
    env: RuntimeEnvSchema.optional(),
    secrets: RuntimeSecretsSchema.optional(),
    deps: z.array(z.string().min(1)).optional(),
    /** Overrides the runtime-block-level healthcheck for this process only. Plugins emit one
     * probe per process: a port-bearing process inherits the runtime-block healthcheck unless
     * it declares its own here.
     */
    healthcheck: HealthcheckSchema.optional(),
    /**
     * Per-process persistent volumes. Falls back to the runtime-block-level
     * `volumes:` when omitted. Plugins emit one PVC + mount per entry; see
     * {@link VolumeSchema}.
     */
    volumes: z.array(VolumeSchema).optional(),
  })
  .passthrough()
  .superRefine((block, ctx) => {
    if (block.volumes !== undefined) {
      validateVolumeList(block.volumes, ctx, ["volumes"]);
    }
  });

const RuntimeProcessesSchema = z.record(
  z.string().min(1),
  RuntimeProcessSchema,
);

/** Two flavours: `RuntimeBlockSchema` (a.k.a. NamedRuntimeBlockSchema): used for any
 * non-default runtime overlay. Every field is optional — overlays merge onto the default
 * block, so missing scalars inherit, not synthesize. `DefaultRuntimeBlockSchema`: used for
 * the `default:` block specifically. Carries baked-in scalar defaults
 */
/** Process-level keys: may NOT appear alongside `processes:` in the same block. When
 * `processes:` is declared, these keys must move inside each named process. Service-level
 * keys (deps, env, secrets) are siblings of `processes:` and are always allowed at the
 * runtime-block level.
 */
const INLINE_PROCESS_KEYS = [
  "command",
  "pre_command",
  "post_command",
  "port",
  "cpu",
  "memory",
  "replicas",
] as const;

export const RuntimeBlockSchema = z
  .object({
    command: z.string().optional(),
    pre_command: z.string().optional(),
    post_command: z.string().optional(),
    port: z.number().int().positive().optional(),
    cpu: z.string().optional(),
    memory: z.string().optional(),
    replicas: z.number().int().nonnegative().optional(),
    /** Seconds the container sleeps in `lifecycle.preStop` before termination, so k8s can drain
     * this pod from Endpoints before the process exits. Port-bearing processes default to 5;
     * `0` disables the hook entirely.
     */
    pre_stop_delay: z.number().int().nonnegative().optional(),
    /** Working directory for the service at runtime (relative to monorepo root). */
    directory: z.string().optional(),
    env: RuntimeEnvSchema.optional(),
    secrets: RuntimeSecretsSchema.optional(),
    deps: z.array(z.string().min(1)).optional(),
    processes: RuntimeProcessesSchema.optional(),
    /**
     * Unified probe definition. Drives the docker-compose `healthcheck:`
     * block and the k8s `readinessProbe` (terraform plugin). See
     * {@link HealthcheckSchema}.
     */
    healthcheck: HealthcheckSchema.optional(),
    /** Single source of truth for both the docker-compose plugin (named volumes) and the
     * terraform plugin (PVCs + volumeMounts). Shorthand applying to the default process when
     * `processes:` is not declared; multi-process services should declare volumes per-process
     * under `processes.<p>.volumes:`. See {@link VolumeSchema}.
     */
    volumes: z.array(VolumeSchema).optional(),
  })
  .passthrough()
  .superRefine((block, ctx) => {
    if (block.volumes !== undefined) {
      validateVolumeList(block.volumes, ctx, ["volumes"]);
    }
  })
  .superRefine((block, ctx) => {
    // Discriminated union: a runtime block either has inline process keys (flat /
    // single-process shape) OR a `processes:` map, but not both. Mixing the two is a parse
    if (
      block.processes !== undefined &&
      Object.keys(block.processes).length > 0
    ) {
      const blockRecord = block as Record<string, unknown>; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- block is .passthrough() so unknown keys exist at runtime; widening to Record is safe here
      const mixedKeys = INLINE_PROCESS_KEYS.filter(
        (k) => blockRecord[k] !== undefined,
      );
      if (mixedKeys.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `runtime.<name>: cannot mix inline process keys (${INLINE_PROCESS_KEYS.join("/")}) with processes: map. Found: ${mixedKeys.join(", ")}. Move process-level keys (command/port/cpu/memory/replicas/pre_command/post_command) inside each named process under processes:.`,
        });
      }
    }
  });

export type RuntimeBlock = z.infer<typeof RuntimeBlockSchema>;

/** Default-block schema: same shape as RuntimeBlockSchema but with scalar defaults baked in
 * via `.default()`. After parsing, cpu/memory/port/replicas are guaranteed to be defined —
 * plugins reading `resolveRuntime(...).cpu` never see `undefined` for these scalars.
 * `command` stays optional here because the deploy plugin owns the "command required"
 */
export const DefaultRuntimeBlockSchema = z
  .object({
    command: z.string().optional(),
    pre_command: z.string().optional(),
    post_command: z.string().optional(),
    port: z.number().int().positive().default(3000),
    cpu: z.string().default("1"),
    memory: z.string().default("512Mi"),
    replicas: z.number().int().nonnegative().default(1),
    /** Seconds the container sleeps in `lifecycle.preStop` before termination, so k8s can drain
     * this pod from Endpoints before the process exits. Port-bearing processes default to 5;
     * `0` disables the hook entirely.
     */
    pre_stop_delay: z.number().int().nonnegative().optional(),
    /** Working directory for the service at runtime (relative to monorepo root). */
    directory: z.string().optional(),
    env: RuntimeEnvSchema.optional(),
    secrets: RuntimeSecretsSchema.optional(),
    deps: z.array(z.string().min(1)).optional(),
    processes: RuntimeProcessesSchema.optional(),
    /**
     * Unified probe definition. Drives the docker-compose `healthcheck:`
     * block and the k8s `readinessProbe` (terraform plugin). See
     * {@link HealthcheckSchema}.
     */
    healthcheck: HealthcheckSchema.optional(),
    /**
     * Persistent volumes for this runtime. See {@link VolumeSchema}.
     */
    volumes: z.array(VolumeSchema).optional(),
  })
  .passthrough()
  .superRefine((block, ctx) => {
    if (block.volumes !== undefined) {
      validateVolumeList(block.volumes, ctx, ["volumes"]);
    }
  });
// with processes:) is enforced by RuntimeBlockSchema.superRefine, which runs before this
// schema. DefaultRuntimeBlockSchema only applies scalar defaults

/** Scalar fields (port/cpu/memory/replicas) are guaranteed to be defined post-parse.
 * Distinguished from `RuntimeBlock` (the partial overlay shape) at the type level so
 * plugins can statically see the defined-ness guarantee.
 */
export type DefaultRuntimeBlock = z.infer<typeof DefaultRuntimeBlockSchema>;

/* -------------------------------------------------------------------------- */
/*  Map vs flat detection                                                      */
/* -------------------------------------------------------------------------- */

/** Names that, if present at the top level of `runtime:`, signal the flat shape (these are
 * runtime-block fields, not runtime names). Anything not in this set is treated as a
 * runtime name — including `default`. This lets the parser disambiguate `runtime: {
 * command: ... }` (flat) from `runtime: { default: { command: ... }, prod: { ... } }`
 */
const RUNTIME_BLOCK_FIELD_NAMES = new Set([
  "command",
  "pre_command",
  "post_command",
  "port",
  "cpu",
  "memory",
  "replicas",
  "pre_stop_delay",
  "directory",
  "env",
  "secrets",
  "deps",
  "processes",
  "healthcheck",
  "volumes",
]);

/** Decide whether a raw `runtime:` value is the flat shape or the map shape. non-object /
 * null / undefined / array / empty `{}`: flat any top-level value that is a scalar or
 * array: flat (flat blocks have fields like `port: 80`, `cpu: "0.25"`, `deps: [...]`;
 * map-shape values are always runtime blocks i.e. plain objects) all values are objects
 */
export function isRuntimeMapShape(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw !== "object" || Array.isArray(raw)) return false;
  // After the typeof + Array guards above, raw is narrowed to `object`,
  // which is what Object.entries accepts — no cast needed.
  const entries = Object.entries(raw);
  if (entries.length === 0) return false;
  // Map-shape values are always runtime blocks (plain non-null, non-array
  // objects). A scalar or array under any top-level key proves flat.
  for (const [, v] of entries) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  }
  // Treat as map only if at least one key is unknown to the flat field set — otherwise it's
  // a flat block whose only fields happen to be the object-valued ones (env/secrets/...).
  return entries.some(([k]) => !RUNTIME_BLOCK_FIELD_NAMES.has(k));
}

/* -------------------------------------------------------------------------- */
/*  Runtime map schema                                                         */
/* -------------------------------------------------------------------------- */

/** The normalized runtime map: `default` is required and parses against the
 * DefaultRuntimeBlockSchema (scalar defaults applied). Every other key is a named overlay
 * parsed against RuntimeBlockSchema (all optional). Validated AFTER auto-wrapping the flat
 * shape so the schema can require `default` unconditionally. Implementation note:
 */
export const RuntimeMapSchema = z
  .record(z.string().min(1), RuntimeBlockSchema)
  .refine((m) => "default" in m, {
    message:
      "runtime: must declare a `default:` block. When using the map shape (runtime: { default: { ... }, prod: { ... } }), `default` is required. Flat shorthand auto-wraps to default automatically.",
  })
  .transform((m, ctx) => {
    // After the refine guarantees `"default" in m`, m.default is a parsed RuntimeBlock —
    // re-parse it through DefaultRuntimeBlockSchema to apply the scalar defaults
    const def = DefaultRuntimeBlockSchema.safeParse(m.default);
    if (!def.success) {
      for (const issue of def.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ["default", ...issue.path],
        });
      }
      return z.NEVER;
    }
    // Build the result map with the upgraded default + the original overlays.
    // We don't strip extra keys — passthrough preserves them.
    const out: { default: DefaultRuntimeBlock } & Record<string, RuntimeBlock> =
      { default: def.data };
    for (const [name, block] of Object.entries(m)) {
      if (name === "default") continue;
      out[name] = block;
    }
    return out;
  });

export type RuntimeMap = z.infer<typeof RuntimeMapSchema>;

/* -------------------------------------------------------------------------- */
/*  Auto-wrap: flat → { default }                                              */
/* -------------------------------------------------------------------------- */

/** Convert a raw `runtime:` value into a runtime map. flat shape (or empty): wraps as `{
 * default: <flat> }` map shape: pass-through (validated by RuntimeMapSchema downstream)
 * Returns `undefined` if the service has no runtime at all (a package). The wrapping is
 * structural only — any unknown fields on the flat block ride along on `default` and are
 */
export function autoWrapRuntime(raw: unknown): unknown | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    // Non-object / array — let RuntimeMapSchema produce a clear Zod error. Returning the value
    // (rather than undefined) keeps the validator chain in charge of the error message.
    return raw;
  }
  if (isRuntimeMapShape(raw)) return raw;
  // Flat shape — wrap. Empty `{}` becomes `{ default: {} }`.
  return { default: raw };
}

/* -------------------------------------------------------------------------- */
/*  Resolver                                                                   */
/* -------------------------------------------------------------------------- */

/** `env` and `secrets` reflect "where each key ended up after applying the 4-layer override
 * precedence." A key is reported under `secrets` if its winning value came from any
 * `secrets:` block (default or named), and under `env` if its winning value came from an
 * `env:` block. `effective` is the full merged map ready to hand to the process
 */
export interface ResolvedEnv {
  env: Record<string, string>;
  secrets: Record<string, string>;
  effective: Record<string, string>;
}

/** Scalar fields (port/cpu/memory/replicas) are always defined: the default block carries
 * baked-in defaults via DefaultRuntimeBlockSchema, and named overlays inherit any fields
 * they don't override. Plugins can therefore read `resolveRuntime(...).cpu` without
 * nullish-coalescing. `command`, `preCommand`, `postCommand` remain optional — some
 */
export interface ResolvedRuntime {
  name: string;
  command?: string;
  preCommand?: string;
  postCommand?: string;
  port: number;
  cpu: string;
  memory: string;
  replicas: number;
  /** preStop drain seconds for this runtime. Undefined when nothing declares one —
   * plugins apply their own default for port-bearing processes. */
  preStopDelay?: number;
  /** Working directory for the service (relative to monorepo root). Optional. */
  directory?: string;
  /** Service-level deps for this runtime. Anonymous list — replace, not merge. */
  deps: string[];
  /**
   * Unified healthcheck for this runtime. Plugins translate this into their
   * own probe shape (compose `healthcheck:` / k8s `readinessProbe`). Undefined
   * when neither the default block nor the active named overlay declared one.
   */
  healthcheck?: Healthcheck;
  /**
   * Persistent volumes for this runtime (shorthand applying to the default
   * process). Plugins emit PVCs + mounts per entry. See {@link VolumeSchema}.
   */
  volumes?: Volume[];
  /** Effective env+secret resolution (see ResolvedEnv). */
  envs: ResolvedEnv;
  /** Per-process map after deep-merging default.processes with named.processes. Each process
   * inherits its parent runtime's env/secret implicitly through the deploy plugin —
   * process-level scope shares the service runtime's env+secrets. The resolver does not
   * flatten processes into the parent — that remains a plugin concern.
   */
  processes?: Record<string, RuntimeBlock>;
}

/** `env`, `secrets`, and `processes` deep-merge by key (overlay wins). `deps` (anonymous
 * list) replaces. All other scalars (command, port, cpu, ...) replace. Exported so plugins
 * (and tests) can apply identical merge semantics.
 */
/**
 * Known structured fields on RuntimeBlock that need explicit handling.
 * Anything outside this set rides through .passthrough() and is
 * shallow-copied.
 */
const STRUCTURED_RUNTIME_BLOCK_FIELDS = new Set([
  "command",
  "pre_command",
  "post_command",
  "port",
  "cpu",
  "memory",
  "replicas",
  "pre_stop_delay",
  "directory",
  "env",
  "secrets",
  "deps",
  "processes",
  "healthcheck",
  "volumes",
]);

export function mergeRuntimeBlock(
  base: RuntimeBlock,
  overlay: RuntimeBlock,
): RuntimeBlock {
  const out: RuntimeBlock = { ...base };

  // Each access goes through the typed field rather than an indexed lookup, so no casts are
  // needed — Zod's .passthrough() exposes the typed shape on the inferred type and TS
  if (overlay.env !== undefined) {
    out.env = { ...(base.env ?? {}), ...overlay.env };
  }
  if (overlay.secrets !== undefined) {
    out.secrets = { ...(base.secrets ?? {}), ...overlay.secrets };
  }
  if (overlay.processes !== undefined) {
    const baseProc = base.processes ?? {};
    const merged: Record<string, RuntimeBlock> = { ...baseProc };
    for (const [pname, pblock] of Object.entries(overlay.processes)) {
      // Recurse so per-process env/secrets also deep-merge by key.
      merged[pname] = baseProc[pname]
        ? mergeRuntimeBlock(baseProc[pname]!, pblock)
        : pblock;
    }
    out.processes = merged;
  }

  // Scalar / replace fields. Each is its own narrow branch so the
  // assignment stays type-safe.
  if (overlay.command !== undefined) out.command = overlay.command;
  if (overlay.pre_command !== undefined) out.pre_command = overlay.pre_command;
  if (overlay.post_command !== undefined)
    out.post_command = overlay.post_command;
  if (overlay.port !== undefined) out.port = overlay.port;
  if (overlay.cpu !== undefined) out.cpu = overlay.cpu;
  if (overlay.memory !== undefined) out.memory = overlay.memory;
  if (overlay.replicas !== undefined) out.replicas = overlay.replicas;
  if (overlay.pre_stop_delay !== undefined)
    out.pre_stop_delay = overlay.pre_stop_delay;
  if (overlay.directory !== undefined) out.directory = overlay.directory;
  // deps is an anonymous list — replace, not merge.
  if (overlay.deps !== undefined) out.deps = overlay.deps;
  // healthcheck is a structured unit — replace, not field-merge, so partial overrides (e.g.
  // overlay only sets `delay:`) can't accidentally inherit a stale exec command
  if (overlay.healthcheck !== undefined) out.healthcheck = overlay.healthcheck;
  // volumes is an anonymous list — replace, not merge (matches deps semantics).
  // An overlay that wants to add a volume must restate the full list.
  if (overlay.volumes !== undefined) out.volumes = overlay.volumes;

  // Use Object.assign so TS doesn't insist on widening `out` — assign returns an
  // intersection that is still assignable as RuntimeBlock.
  for (const [key, value] of Object.entries(overlay)) {
    if (STRUCTURED_RUNTIME_BLOCK_FIELDS.has(key) || value === undefined)
      continue;
    Object.assign(out, { [key]: value });
  }

  return out;
}

/** Resolve the effective runtime config for a service runtime by name. Walks the
 * override-priority chain (last wins): (1) default.env 2. default.secret 3. <name>.env 4.
 * <name>.secret If `name` is omitted or equals `"default"`, only the default block is
 * applied. Throws if `name` is requested but absent — callers should validate the runtime
 */
export function resolveRuntime(
  runtimes: RuntimeMap,
  name: string = "default",
): ResolvedRuntime {
  const def = runtimes.default;
  if (!def) {
    throw new Error(
      "resolveRuntime: missing `default` runtime block. RuntimeMapSchema should have caught this earlier.",
    );
  }

  // Start with default (DefaultRuntimeBlock — scalar fields always defined); layer named
  // runtime if present and not 'default'. The merge result is structurally a RuntimeBlock
  let merged: RuntimeBlock = def;
  let named: RuntimeBlock = {};
  if (name !== "default") {
    const overlay = runtimes[name];
    if (overlay) {
      named = overlay;
      merged = mergeRuntimeBlock(def, overlay);
    }
  }

  // 4-layer precedence (last wins): (1) default.env 2. default.secret 3. <name>.env 4.
  // <name>.secret Same key in env+secret of same runtime: secret wins
  const defEnv = def.env ?? {};
  const defSecret = def.secrets ?? {};
  const namedEnv = named.env ?? {};
  const namedSecret = named.secrets ?? {};

  const effective: Record<string, string> = {
    ...defEnv,
    ...defSecret,
    ...namedEnv,
    ...namedSecret,
  };

  // For the env/secret split, compute the source of each key's WINNING value. Walk layers in
  // priority order; track the last layer that set each key. Then bucket by layer kind.
  type Source = "env" | "secret";
  const winningSource = new Map<string, Source>();
  for (const k of Object.keys(defEnv)) winningSource.set(k, "env");
  for (const k of Object.keys(defSecret)) winningSource.set(k, "secret");
  for (const k of Object.keys(namedEnv)) winningSource.set(k, "env");
  for (const k of Object.keys(namedSecret)) winningSource.set(k, "secret");

  const env: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(effective)) {
    if (winningSource.get(k) === "secret") {
      secrets[k] = v;
    } else {
      env[k] = v;
    }
  }

  // Scalar fields: default block guarantees these post-parse (DefaultRuntimeBlockSchema
  // applies port/cpu/memory/replicas defaults). Named overlay overrides them when set;
  return {
    name,
    command: merged.command,
    preCommand: merged.pre_command,
    postCommand: merged.post_command,
    port: named.port ?? def.port,
    cpu: named.cpu ?? def.cpu,
    memory: named.memory ?? def.memory,
    replicas: named.replicas ?? def.replicas,
    preStopDelay: named.pre_stop_delay ?? def.pre_stop_delay,
    directory: named.directory ?? def.directory,
    deps: merged.deps ?? [],
    healthcheck: named.healthcheck ?? def.healthcheck,
    volumes: named.volumes ?? def.volumes,
    envs: { env, secrets, effective },
    processes: merged.processes,
  };
}
