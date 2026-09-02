/**
 * Envelope encrypt/decrypt round-trip tests using a deterministic test
 * identity generated at setup. We never check a real key into the repo.
 */
import { generateIdentity, identityToRecipient } from "age-encryption";
import { beforeAll, describe, expect, it } from "vitest";

import {
  decryptValue,
  encryptValue,
  formatEnvelope,
  isEnvelope,
  parseEnvelope,
} from "../../src/secrets/envelope.ts";

let identity: string;
let recipient: string;

beforeAll(async () => {
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
});

describe("envelope", () => {
  it("round-trips a short ASCII value", async () => {
    const ct = await encryptValue("hello world", recipient);
    expect(isEnvelope(ct)).toBe(true);
    expect(ct.startsWith("ENC[AES256_GCM,")).toBe(true);
    expect(ct.endsWith("]")).toBe(true);

    const pt = await decryptValue(ct, identity);
    expect(pt).toBe("hello world");
  });

  it("trims trailing newline from decrypted plaintext", async () => {
    // When a secret was set via `echo "value" | nopo secret set ... --from-stdin`, the
    // trailing \\n is baked into the ciphertext. decryptValue must strip it so docker-compose
    const ct = await encryptValue("hello\n", recipient);
    const pt = await decryptValue(ct, identity);
    expect(pt).toBe("hello");
  });

  it("trims trailing CRLF from decrypted plaintext", async () => {
    // Windows-style line endings also get stripped.
    const ct = await encryptValue("hello\r\n", recipient);
    const pt = await decryptValue(ct, identity);
    expect(pt).toBe("hello");
  });

  it("preserves internal newlines in multiline secrets", async () => {
    // PEM private keys and other multiline secrets must have their internal
    // structure preserved — only the trailing newline is stripped.
    const value = "line-one\nline-two\nline-three";
    const ct = await encryptValue(value, recipient);
    const pt = await decryptValue(ct, identity);
    expect(pt).toBe(value);
  });

  it("round-trips multiline content", async () => {
    // Use a generic multi-line value rather than a PEM literal — secret-scanners flag the
    // BEGIN/END markers regardless of content. No trailing newline: trimEnd() strips it
    const value = [
      "test-secret-line-one",
      "test-secret-line-two-with-special-chars-!@#$%",
      "test-secret-line-three",
    ].join("\n");
    const ct = await encryptValue(value, recipient);
    const pt = await decryptValue(ct, identity);
    expect(pt).toBe(value);
  });

  it("round-trips UTF-8 content", async () => {
    const value = "naïve café — 日本語 🔐";
    const ct = await encryptValue(value, recipient);
    const pt = await decryptValue(ct, identity);
    expect(pt).toBe(value);
  });

  it("produces distinct ciphertext for repeated encrypts of the same value", async () => {
    const a = await encryptValue("same", recipient);
    const b = await encryptValue("same", recipient);
    expect(a).not.toBe(b);
  });

  it("rejects malformed envelopes", () => {
    expect(() => parseEnvelope("not-an-envelope")).toThrow();
    // Empty field after the marker hits the "Invalid envelope field" branch.
    expect(() => parseEnvelope("ENC[AES256_GCM,]")).toThrow(
      /Invalid envelope field/,
    );
    // Has a valid `data:abc` field but is missing iv/tag/key/type.
    expect(() => parseEnvelope("ENC[AES256_GCM,data:abc]")).toThrow(
      /missing field/,
    );
  });

  it("formatEnvelope and parseEnvelope are inverses", async () => {
    const ct = await encryptValue("payload", recipient);
    const parsed = parseEnvelope(ct);
    const formatted = formatEnvelope(parsed);
    expect(formatted).toBe(ct);
  });

  it("decryption fails with a different identity", async () => {
    const ct = await encryptValue("secret", recipient);
    const otherIdentity = await generateIdentity();
    await expect(decryptValue(ct, otherIdentity)).rejects.toThrow();
  });
});

/** The envelope delegates GCM tag verification to Node's C layer (`decipher.setAuthTag` +
 * `decipher.final()`), and the wrapped key relies on age's MAC. We pin the contract: every
 * component of the envelope is authenticated, so a single bit flip anywhere must reject
 * the decrypt — and a structurally truncated envelope must reject before reaching
 */
function flipBitInBase64(b64: string): string {
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.length === 0) {
    throw new Error("Cannot flip a bit in an empty buffer");
  }
  bytes[0] = (bytes[0] ?? 0) ^ 0x01; // flip lowest bit of first byte
  return Buffer.from(bytes).toString("base64");
}

describe("envelope tamper rejection", () => {
  // Re-format a parsed envelope's b64 fields directly. We need string-level
  // access to mutate one field at a time without re-encrypting.
  function reassemble(fields: {
    data: string;
    iv: string;
    tag: string;
    key: string;
    type: string;
  }): string {
    return `ENC[AES256_GCM,data:${fields.data},iv:${fields.iv},tag:${fields.tag},key:${fields.key},type:${fields.type}]`;
  }

  function fieldsFrom(envelope: string): {
    data: string;
    iv: string;
    tag: string;
    key: string;
    type: string;
  } {
    // Re-parse the envelope text to extract the raw b64 strings (parseEnvelope
    // returns Buffers — we need the original encoded strings for mutation).
    const body = envelope.slice("ENC[AES256_GCM,".length, -1);
    const out: Record<string, string> = {};
    for (const part of body.split(",")) {
      const idx = part.indexOf(":");
      if (idx <= 0) continue;
      out[part.slice(0, idx)] = part.slice(idx + 1);
    }
    return {
      data: out.data ?? "",
      iv: out.iv ?? "",
      tag: out.tag ?? "",
      key: out.key ?? "",
      type: out.type ?? "str",
    };
  }

  it("rejects a bit-flipped data field", async () => {
    const ct = await encryptValue("contents", recipient);
    const f = fieldsFrom(ct);
    const tampered = reassemble({ ...f, data: flipBitInBase64(f.data) });
    await expect(decryptValue(tampered, identity)).rejects.toThrow();
  });

  it("rejects a bit-flipped iv field", async () => {
    const ct = await encryptValue("contents", recipient);
    const f = fieldsFrom(ct);
    const tampered = reassemble({ ...f, iv: flipBitInBase64(f.iv) });
    await expect(decryptValue(tampered, identity)).rejects.toThrow();
  });

  it("rejects a bit-flipped tag field", async () => {
    const ct = await encryptValue("contents", recipient);
    const f = fieldsFrom(ct);
    const tampered = reassemble({ ...f, tag: flipBitInBase64(f.tag) });
    await expect(decryptValue(tampered, identity)).rejects.toThrow();
  });

  it("rejects a bit-flipped wrapped key field", async () => {
    // The age library's MAC catches this branch — flipping a bit in the
    // sealed data key makes the unwrap fail before AES-GCM ever runs.
    const ct = await encryptValue("contents", recipient);
    const f = fieldsFrom(ct);
    const tampered = reassemble({ ...f, key: flipBitInBase64(f.key) });
    await expect(decryptValue(tampered, identity)).rejects.toThrow();
  });

  it("rejects a structurally truncated envelope at parse time", async () => {
    // Drop the `tag:` field entirely — parseEnvelope must reject before the value ever reaches
    // the cipher. The error message names the missing field so operators have a clear failure
    const ct = await encryptValue("contents", recipient);
    const f = fieldsFrom(ct);
    const truncated = `ENC[AES256_GCM,data:${f.data},iv:${f.iv},key:${f.key},type:${f.type}]`;
    await expect(decryptValue(truncated, identity)).rejects.toThrow(
      /missing field "tag"/,
    );
  });
});
