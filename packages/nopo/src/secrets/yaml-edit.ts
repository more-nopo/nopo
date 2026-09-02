/** In-place edits of a service's `nopo.yml` `runtime.<runtime>.secrets:` map. Uses the
 * `yaml` library's Document API so comments and formatting are preserved across writes.
 * Two `runtime:` shapes are accepted (matching runtime.ts): flat (legacy): `runtime: {
 * command, port, ..., secrets: { ... } }` Treated as the `default` runtime. `set` /
 */
import fs from "node:fs";
import { isMap, isScalar, parseDocument, YAMLMap } from "yaml";

interface SecretsView {
  runtime: string;
  keys: string[];
}

/** Load a service nopo.yml as a yaml Document, preserving comments. */
function loadServiceDocument(
  configPath: string,
): ReturnType<typeof parseDocument> {
  const contents = fs.readFileSync(configPath, "utf-8");
  return parseDocument(contents, { keepSourceTokens: true });
}

/** Truncate-then-write would leave the file in a corrupt state if the process is killed
 * mid-write — and for nopo.yml that would lose every prior `ENC[...]` ciphertext. Instead
 * we write a temp file alongside and `rename(2)` over the target. POSIX guarantees rename
 * is atomic on the same filesystem, so the file is either the old contents or the new
 */
function saveServiceDocument(
  configPath: string,
  doc: ReturnType<typeof parseDocument>,
): void {
  // atomic write: temp + rename
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  // The contract: `secret set` only mutates the runtime block it targets. Defaults in the
  // `yaml` library re-format anything outside that block: onto continuation lines, mangling
  fs.writeFileSync(
    tmpPath,
    doc.toString({ lineWidth: 0, flowCollectionPadding: false }),
  );
  fs.renameSync(tmpPath, configPath);
}

/**
 * List secret keys per runtime for a service config. Returns an empty
 * array when the service has no runtime block. Never returns values.
 */
export function listSecrets(configPath: string): SecretsView[] {
  const doc = loadServiceDocument(configPath);
  const runtime = doc.get("runtime");
  if (!isMap(runtime)) return [];

  const result: SecretsView[] = [];
  if (isFlatRuntime(runtime)) {
    const keys = readSecretKeys(runtime);
    result.push({ runtime: "default", keys });
    return result;
  }

  for (const item of runtime.items) {
    if (!isScalar(item.key)) continue;
    const name = String(item.key.value ?? "");
    if (!name) continue;
    if (!isMap(item.value)) continue;
    const keys = readSecretKeys(item.value);
    result.push({ runtime: name, keys });
  }
  return result;
}

/**
 * Read the encrypted ciphertext for a single (runtime, key). Returns
 * `undefined` if the service / runtime / key is absent. Returns the raw
 * ENC[...] string — does NOT decrypt.
 */
export function readSecretCiphertext(
  configPath: string,
  runtime: string,
  key: string,
): string | undefined {
  const doc = loadServiceDocument(configPath);
  const block = getRuntimeBlock(doc, runtime, { create: false });
  if (!block) return undefined;
  const secrets = block.get("secrets");
  if (!isMap(secrets)) return undefined;
  const value = secrets.get(key);
  return typeof value === "string" ? value : undefined;
}

/** Set `runtime.<runtime>.secrets.<key>` to the given ENC[...] ciphertext, creating
 * intermediate maps as needed. The flat shape is preserved when the target is `default`;
 * targeting any other runtime forces a reshape to the map form (legacy `default` block is
 * preserved verbatim).
 */
export function setSecretCiphertext(
  configPath: string,
  runtime: string,
  key: string,
  ciphertext: string,
): void {
  const doc = loadServiceDocument(configPath);
  const block = getRuntimeBlock(doc, runtime, { create: true });
  if (!block) {
    throw new Error(
      `Failed to locate or create runtime block "${runtime}" in ${configPath}.`,
    );
  }

  let secrets = block.get("secrets");
  if (!isMap(secrets)) {
    secrets = new YAMLMap();
    block.set("secrets", secrets);
  }
  // Node-level set so the value renders unquoted-ish; we explicitly want a plain
  // double-quoted scalar so YAML escaping is unambiguous for ENC[...]. yaml's default plain
  if (isMap(secrets)) {
    secrets.set(key, ciphertext);
  }

  saveServiceDocument(configPath, doc);
}

/**
 * Remove a single key from `runtime.<runtime>.secrets`. No-op (returns
 * false) if the runtime or key is absent. Empty `secrets:` maps are left
 * in place — operators can prune them by hand if desired.
 */
export function unsetSecretCiphertext(
  configPath: string,
  runtime: string,
  key: string,
): boolean {
  const doc = loadServiceDocument(configPath);
  const block = getRuntimeBlock(doc, runtime, { create: false });
  if (!block) return false;
  const secrets = block.get("secrets");
  if (!isMap(secrets)) return false;
  if (!secrets.has(key)) return false;
  secrets.delete(key);
  saveServiceDocument(configPath, doc);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** Decide whether a `runtime:` YAMLMap is in flat shape. (or sequence) value at the top
 * level — `command`, `port`, `cpu`, `memory`, `pre_command`, `post_command`, `replicas`,
 * `directory`, or `deps`. A map-shape `runtime:` block is structurally `Record<string,
 * RuntimeBlock>` where every value is a Map. Earlier versions used a name-based signal
 */
function isFlatRuntime(runtime: YAMLMap): boolean {
  // Any scalar / sequence at the top level proves flat shape: map-shape
  // values are always Maps (runtime blocks).
  for (const item of runtime.items) {
    const v = item.value;
    if (v && !isMap(v)) return true;
  }
  // Treat as map shape so we never misread a runtime named env/secrets/processes as a flat
  // field. Empty `runtime: {}` (no items) also falls through here and is treated as map
  return false;
}

/** Locate (and optionally create) the YAMLMap for a given runtime name. `runtime: {
 * command: ... }` (flat shape) + name=`default`: returns the flat block itself. `runtime:
 * { command: ... }` (flat shape) + name=other: reshapes the document in place to `{
 * default: <flat>, <name>: {} }` and returns the new named block (when create=true).
 */
function getRuntimeBlock(
  doc: ReturnType<typeof parseDocument>,
  runtime: string,
  opts: { create: boolean },
): YAMLMap | undefined {
  let runtimeNode = doc.get("runtime");

  if (!isMap(runtimeNode)) {
    if (!opts.create) return undefined;
    runtimeNode = new YAMLMap();
    doc.set("runtime", runtimeNode);
  }

  if (!isMap(runtimeNode)) return undefined;

  if (isFlatRuntime(runtimeNode)) {
    if (runtime === "default") {
      return runtimeNode;
    }
    if (!opts.create) return undefined;
    // Reshape: move the flat block to runtime.default, then add the named runtime.
    const flat = runtimeNode;
    const reshaped = new YAMLMap();
    reshaped.set("default", flat);
    const named = new YAMLMap();
    reshaped.set(runtime, named);
    doc.set("runtime", reshaped);
    return named;
  }

  // Map shape.
  const existing = runtimeNode.get(runtime);
  if (isMap(existing)) return existing;
  if (!opts.create) return undefined;
  const fresh = new YAMLMap();
  runtimeNode.set(runtime, fresh);
  return fresh;
}

/**
 * Read the keys of a `secrets:` map from a runtime block, in declaration
 * order. Empty array when `secrets:` is absent.
 */
function readSecretKeys(block: YAMLMap): string[] {
  const secrets = block.get("secrets");
  if (!isMap(secrets)) return [];
  const out: string[] = [];
  for (const item of secrets.items) {
    if (!isScalar(item.key)) continue;
    const name = String(item.key.value ?? "");
    if (name) out.push(name);
  }
  return out;
}
