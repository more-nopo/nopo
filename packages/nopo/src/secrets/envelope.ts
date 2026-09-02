/** Per-value sops-style envelope for secrets stored inline in nopo.yml. Format (compatible
 * style with sops's ENC[AES256_GCM,...] stanza, with an extra `key:` field carrying the
 * age-wrapped data key): ENC[AES256_GCM,data:<b64>,iv:<b64>,tag:<b64>,key:<b64>,type:str]
 * Each value gets its own random 256-bit data key + 96-bit IV. The data key is wrapped
 */
import { Decrypter, Encrypter } from "age-encryption";
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_PREFIX = "ENC[AES256_GCM,";
const ENVELOPE_SUFFIX = "]";

/** Parsed fields of a sops-style ENC[...] envelope. */
interface ParsedEnvelope {
  data: Buffer;
  iv: Buffer;
  tag: Buffer;
  /** age-encrypted file containing the 32-byte AES-256-GCM data key. */
  wrappedKey: Buffer;
  type: string;
}

/**
 * Encrypt a plaintext value into an ENC[...] envelope using the given age
 * recipient (a string like `age1...`).
 */
export async function encryptValue(
  plaintext: string,
  recipient: string,
): Promise<string> {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);

  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const enc1 = cipher.update(Buffer.from(plaintext, "utf-8"));
  const enc2 = cipher.final();
  const data = Buffer.concat([enc1, enc2]);
  const tag = cipher.getAuthTag();

  const enc = new Encrypter();
  enc.addRecipient(recipient);
  const wrappedKey = Buffer.from(await enc.encrypt(dataKey));

  return formatEnvelope({
    data,
    iv,
    tag,
    wrappedKey,
    type: "str",
  });
}

/**
 * Decrypt an ENC[...] envelope using the given age identity (a string like
 * `AGE-SECRET-KEY-1...`). Throws if the envelope is malformed or the
 * identity can't unwrap it.
 */
export async function decryptValue(
  envelope: string,
  identity: string,
): Promise<string> {
  const parsed = parseEnvelope(envelope);

  const dec = new Decrypter();
  dec.addIdentity(identity);
  const dataKey = await dec.decrypt(parsed.wrappedKey, "uint8array");
  if (dataKey.length !== 32) {
    throw new Error(
      `Decrypted data key has unexpected length ${dataKey.length} (expected 32). The envelope may be malformed or corrupt.`,
    );
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(dataKey),
    parsed.iv,
  );
  decipher.setAuthTag(parsed.tag);
  const dec1 = decipher.update(parsed.data);
  const dec2 = decipher.final();
  // Trim trailing newlines: age CLI and stdin-piped `echo` calls always append a trailing
  // `\n` when the secret is stored. The newline is not part of the value itself
  return Buffer.concat([dec1, dec2]).toString("utf-8").trimEnd();
}

/** Parse an ENC[...] envelope into its component fields. Field order is not significant.
 * Unknown fields are rejected so we catch malformed envelopes early.
 */
export function parseEnvelope(envelope: string): ParsedEnvelope {
  if (
    !envelope.startsWith(ENVELOPE_PREFIX) ||
    !envelope.endsWith(ENVELOPE_SUFFIX)
  ) {
    throw new Error(
      `Invalid secret envelope: must start with "${ENVELOPE_PREFIX}" and end with "${ENVELOPE_SUFFIX}".`,
    );
  }
  const body = envelope.slice(ENVELOPE_PREFIX.length, -ENVELOPE_SUFFIX.length);
  const fields: Record<string, string> = {};
  for (const part of body.split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) {
      throw new Error(
        `Invalid envelope field "${part}": expected "key:value".`,
      );
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    fields[key] = value;
  }

  const required = ["data", "iv", "tag", "key", "type"] as const;
  for (const k of required) {
    if (fields[k] === undefined) {
      throw new Error(`Invalid secret envelope: missing field "${k}".`);
    }
  }

  return {
    data: Buffer.from(fields.data!, "base64"),
    iv: Buffer.from(fields.iv!, "base64"),
    tag: Buffer.from(fields.tag!, "base64"),
    wrappedKey: Buffer.from(fields.key!, "base64"),
    type: fields.type!,
  };
}

/**
 * Format the envelope fields back into the canonical
 * `ENC[AES256_GCM,data:...,iv:...,tag:...,key:...,type:str]` string.
 */
export function formatEnvelope(parsed: ParsedEnvelope): string {
  const parts = [
    `data:${parsed.data.toString("base64")}`,
    `iv:${parsed.iv.toString("base64")}`,
    `tag:${parsed.tag.toString("base64")}`,
    `key:${parsed.wrappedKey.toString("base64")}`,
    `type:${parsed.type}`,
  ];
  return `${ENVELOPE_PREFIX}${parts.join(",")}${ENVELOPE_SUFFIX}`;
}

/**
 * Cheap structural check — does this string look like an ENC[...] envelope?
 * Used by the runtime parser; we never decrypt inside the parser.
 */
export function isEnvelope(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX) && value.endsWith(ENVELOPE_SUFFIX);
}
