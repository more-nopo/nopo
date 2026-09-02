/** Adversarial tests for the terraform plugin's secret manifest emission. Threat model: a malicious PR
 * adds (or modifies) a service nopo.yml with crafted secret KEY names or VALUES intended to break out
 * of the YAML `stringData:` field and inject arbitrary k8s Secret entries, leak decrypted plaintext
 * into apply-time error logs, or corrupt the manifest.
 */
import { generateIdentity, identityToRecipient } from "age-encryption";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import type { ResolvedRuntime } from "../../../../packages/nopo/src/config/index.ts";
import { encryptValue } from "../../../../packages/nopo/src/secrets/index.ts";
import {
  buildSecretManifestsForServices,
  redactSecretManifest,
  secretKeysForRuntime,
} from "./index.ts";

function makeRuntime(
  name: string,
  secrets: Record<string, string>,
): ResolvedRuntime {
  return {
    name,
    port: 3000,
    cpu: "0.25",
    memory: "64Mi",
    replicas: 1,
    deps: [],
    envs: { env: {}, secrets, effective: { ...secrets } },
  };
}

async function makeKey(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  return { identity, recipient };
}

describe("buildSecretManifestsForServices — adversarial KEY names", () => {
  it("rejects a key containing a newline (sibling-key injection vector)", async () => {
    const { identity, recipient } = await makeKey();
    const ct = await encryptValue("ok", recipient);
    const evilKey = `OK\n  INJECTED: pwn\n  STILL`;
    await expect(
      buildSecretManifestsForServices(
        [{ id: "svc", overlay: makeRuntime("default", { [evilKey]: ct }) }],
        "ns",
        async () => identity,
      ),
    ).rejects.toThrow(/invalid secret key.*svc/i);
  });

  it("rejects a key containing a colon (would split into mapping)", async () => {
    const { identity, recipient } = await makeKey();
    const ct = await encryptValue("ok", recipient);
    await expect(
      buildSecretManifestsForServices(
        [
          {
            id: "svc",
            overlay: makeRuntime("default", { "BAD: KEY": ct }),
          },
        ],
        "ns",
        async () => identity,
      ),
    ).rejects.toThrow(/invalid secret key.*svc/i);
  });

  it("rejects a key with leading/trailing whitespace", async () => {
    const { identity, recipient } = await makeKey();
    const ct = await encryptValue("ok", recipient);
    for (const bad of [" LEADING", "TRAILING "]) {
      await expect(
        buildSecretManifestsForServices(
          [
            {
              id: "svc",
              overlay: makeRuntime("default", { [bad]: ct }),
            },
          ],
          "ns",
          async () => identity,
        ),
      ).rejects.toThrow(/invalid secret key.*svc/i);
    }
  });

  it("rejects a key not matching the k8s Secret data-key pattern (slash, $, space)", async () => {
    const { identity, recipient } = await makeKey();
    const ct = await encryptValue("ok", recipient);
    for (const bad of ["a/b", "a$b", "a b", "a*b", "a\0b"]) {
      await expect(
        buildSecretManifestsForServices(
          [{ id: "svc", overlay: makeRuntime("default", { [bad]: ct }) }],
          "ns",
          async () => identity,
        ),
      ).rejects.toThrow(/invalid secret key.*svc/i);
    }
  });

  it("rejects __proto__ / constructor / prototype keys (prototype-pollution surface)", async () => {
    const { identity, recipient } = await makeKey();
    const ct = await encryptValue("ok", recipient);
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      await expect(
        buildSecretManifestsForServices(
          [{ id: "svc", overlay: makeRuntime("default", { [bad]: ct }) }],
          "ns",
          async () => identity,
        ),
      ).rejects.toThrow(/invalid secret key.*svc/i);
    }
  });

  it("accepts the standard pattern: alphanumerics, underscore, dash, dot", async () => {
    const { identity, recipient } = await makeKey();
    const ct = await encryptValue("ok", recipient);
    const manifests = await buildSecretManifestsForServices(
      [
        {
          id: "svc",
          overlay: makeRuntime("default", {
            API_KEY: ct,
            "db.password": ct,
            "release-token": ct,
          }),
        },
      ],
      "ns",
      async () => identity,
    );
    expect(manifests).toHaveLength(1);
    const doc = parseYaml(manifests[0]!.yaml);
    expect(Object.keys(doc.data ?? doc.stringData ?? {}).sort()).toEqual([
      "API_KEY",
      "db.password",
      "release-token",
    ]);
  });
});

describe("buildSecretManifestsForServices — value round-trip safety", () => {
  it("round-trips a value containing a newline through YAML cleanly", async () => {
    const { identity, recipient } = await makeKey();
    const plaintext = "line1\nline2\nline3";
    const ct = await encryptValue(plaintext, recipient);
    const manifests = await buildSecretManifestsForServices(
      [{ id: "svc", overlay: makeRuntime("default", { K: ct }) }],
      "ns",
      async () => identity,
    );
    const doc = parseYaml(manifests[0]!.yaml);
    // Either stringData or data path — we accept both, but the decoded
    // value must equal the original.
    if (doc.stringData) {
      expect(doc.stringData.K).toBe(plaintext);
    } else {
      expect(Buffer.from(doc.data.K, "base64").toString("utf-8")).toBe(
        plaintext,
      );
    }
  });

  it("does not allow a value to inject a sibling key via newline + colon", async () => {
    const { identity, recipient } = await makeKey();
    // Crafted to look like YAML if naively interpolated.
    const evil = `safe\n  INJECTED: pwn\n  ANOTHER: "still`;
    const ct = await encryptValue(evil, recipient);
    const manifests = await buildSecretManifestsForServices(
      [{ id: "svc", overlay: makeRuntime("default", { K: ct }) }],
      "ns",
      async () => identity,
    );
    const doc = parseYaml(manifests[0]!.yaml);
    const map =
      doc.stringData ??
      Object.fromEntries(
        Object.entries(doc.data ?? {}).map(([k, v]) => [
          k,
          Buffer.from(String(v), "base64").toString("utf-8"),
        ]),
      );
    expect(Object.keys(map)).toEqual(["K"]);
    expect("INJECTED" in map).toBe(false);
    expect("ANOTHER" in map).toBe(false);
    expect(map.K).toBe(evil);
  });

  it("round-trips a value containing double-quote and backslash", async () => {
    const { identity, recipient } = await makeKey();
    const plaintext = `she said "hi" \\path\\to\\file`;
    const ct = await encryptValue(plaintext, recipient);
    const manifests = await buildSecretManifestsForServices(
      [{ id: "svc", overlay: makeRuntime("default", { K: ct }) }],
      "ns",
      async () => identity,
    );
    const doc = parseYaml(manifests[0]!.yaml);
    const decoded = doc.stringData
      ? doc.stringData.K
      : Buffer.from(doc.data.K, "base64").toString("utf-8");
    expect(decoded).toBe(plaintext);
  });

  it("round-trips arbitrary binary-ish bytes (control chars, tabs)", async () => {
    const { identity, recipient } = await makeKey();
    const plaintext = "\x00\x01\x02\t\rmix\n\x7f end";
    const ct = await encryptValue(plaintext, recipient);
    const manifests = await buildSecretManifestsForServices(
      [{ id: "svc", overlay: makeRuntime("default", { K: ct }) }],
      "ns",
      async () => identity,
    );
    const doc = parseYaml(manifests[0]!.yaml);
    const decoded = doc.stringData
      ? doc.stringData.K
      : Buffer.from(doc.data.K, "base64").toString("utf-8");
    expect(decoded).toBe(plaintext);
  });
});

describe("buildSecretManifestsForServices — service id validation", () => {
  it("rejects a service id with a newline (would inject into Secret name)", async () => {
    const { identity, recipient } = await makeKey();
    const ct = await encryptValue("ok", recipient);
    await expect(
      buildSecretManifestsForServices(
        [
          {
            id: "ok\n  metadata: { name: pwn }",
            overlay: makeRuntime("default", { K: ct }),
          },
        ],
        "ns",
        async () => identity,
      ),
    ).rejects.toThrow(/invalid service id/i);
  });

  it("rejects a service id that is not a DNS-1123 label", async () => {
    const { identity, recipient } = await makeKey();
    const ct = await encryptValue("ok", recipient);
    for (const bad of ["UPPER", "a/b", "../foo", "foo.bar", ""]) {
      await expect(
        buildSecretManifestsForServices(
          [{ id: bad, overlay: makeRuntime("default", { K: ct }) }],
          "ns",
          async () => identity,
        ),
      ).rejects.toThrow(/invalid service id/i);
    }
  });

  it("rejects a namespace that is not a DNS-1123 label", async () => {
    const { identity, recipient } = await makeKey();
    const ct = await encryptValue("ok", recipient);
    for (const bad of ["UPPER", "a/b", "../foo", ""]) {
      await expect(
        buildSecretManifestsForServices(
          [{ id: "svc", overlay: makeRuntime("default", { K: ct }) }],
          bad,
          async () => identity,
        ),
      ).rejects.toThrow(/invalid namespace/i);
    }
  });
});

describe("buildSecretManifestsForServices — error-message hygiene", () => {
  it("does not include identity in any thrown error from a decrypt failure", async () => {
    const { identity, recipient } = await makeKey();
    const otherRecipient = (await makeKey()).recipient;
    void recipient;
    const wrong = await encryptValue("payload", otherRecipient);

    let caught: unknown = null;
    try {
      await buildSecretManifestsForServices(
        [{ id: "svc", overlay: makeRuntime("default", { K: wrong }) }],
        "ns",
        async () => identity,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).not.toContain(identity);
    // Also check the identity prefix doesn't appear (in case lib chops).
    expect(msg).not.toContain(identity.slice(0, 32));
  });

  it("does not include any plaintext in a decrypt failure error", async () => {
    /** A malformed envelope: well-formed shape but ciphertext bytes that decrypt to nothing meaningful when
     * the data key unwraps. The error message must not leak the surrounding service's other plaintexts —
     * build the test so the identity DOES decrypt the wrappedKey but the tag fails, simulating tampered
     * ciphertext.
     */
    const { identity, recipient } = await makeKey();
    const ct = await encryptValue("the-real-secret", recipient);
    // Tamper: flip a byte in the data field of the envelope.
    const tampered = ct.replace(
      /data:([^,]+),/,
      (_m, b64: string) => `data:${"A" + b64.slice(1)},`,
    );

    let caught: unknown = null;
    try {
      await buildSecretManifestsForServices(
        [{ id: "svc", overlay: makeRuntime("default", { K: tampered }) }],
        "ns",
        async () => identity,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).not.toContain("the-real-secret");
  });

  it("error from a non-envelope value names the service + key but not surrounding values", async () => {
    const { identity, recipient } = await makeKey();
    const goodCt = await encryptValue("real-pw-other-key", recipient);
    let caught: unknown = null;
    try {
      await buildSecretManifestsForServices(
        [
          {
            id: "svc",
            overlay: makeRuntime("default", {
              GOOD: goodCt,
              BAD: "literally-not-an-envelope",
            }),
          },
        ],
        "ns",
        async () => identity,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    const msg = caught instanceof Error ? caught.message : String(caught);
    // Pinpoints the offending key
    expect(msg).toContain("BAD");
    expect(msg).toContain("svc");
    // But must NOT leak unrelated decrypted plaintext from the same service
    expect(msg).not.toContain("real-pw-other-key");
  });
});

describe("buildSecretManifestsForServices — manifest hygiene", () => {
  it("emits no per-service entries for empty / undeclared overlays", async () => {
    const manifests = await buildSecretManifestsForServices(
      [],
      "ns",
      async () => {
        throw new Error("loader should never be called with no inputs");
      },
    );
    expect(manifests).toEqual([]);
  });

  it("manifest YAML parses to exactly one Secret document with the expected name + namespace", async () => {
    const { identity, recipient } = await makeKey();
    const ct = await encryptValue("v", recipient);
    const manifests = await buildSecretManifestsForServices(
      [{ id: "svc", overlay: makeRuntime("default", { K: ct }) }],
      "test-ns",
      async () => identity,
    );
    const doc = parseYaml(manifests[0]!.yaml);
    expect(doc.kind).toBe("Secret");
    expect(doc.apiVersion).toBe("v1");
    expect(doc.metadata.name).toBe("svc-secrets");
    expect(doc.metadata.namespace).toBe("test-ns");
    expect(doc.metadata.labels.app).toBe("svc");
    expect(doc.metadata.labels["app.kubernetes.io/managed-by"]).toBe("nopo");
  });
});

describe("redactSecretManifest — adversarial inputs", () => {
  it("never emits original plaintext, even with bizarre value bytes", async () => {
    const { identity, recipient } = await makeKey();
    const plaintext = "supersecret-AAAA-newline\nsupersecret-BBBB-tab\tEND";
    const ct = await encryptValue(plaintext, recipient);
    const [m] = await buildSecretManifestsForServices(
      [{ id: "svc", overlay: makeRuntime("default", { K: ct }) }],
      "ns",
      async () => identity,
    );
    const out = redactSecretManifest(m!.yaml);
    expect(out).not.toContain("supersecret-AAAA");
    expect(out).not.toContain("supersecret-BBBB");
    expect(out).toContain("[REDACTED]");
  });

  it("rejects a multi-doc input rather than silently using the first", () => {
    const yamlIn = `kind: Secret
apiVersion: v1
metadata:
  name: a
stringData:
  K: v
---
kind: Secret
apiVersion: v1
metadata:
  name: b
stringData:
  K: v
`;
    expect(() => redactSecretManifest(yamlIn)).toThrow(/single document/i);
  });
});

describe("secretKeysForRuntime — defensive", () => {
  it("returns own enumerable keys only (does not surface inherited prototype props)", () => {
    const overlay = makeRuntime("default", { OK: "ENC[..]" });
    // Pollute Object.prototype temporarily; the function must not surface it.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mutating prototype for the test only
    const proto = Object.prototype as Record<string, unknown>;
    const sentinel = "__sec_test_sentinel__";
    proto[sentinel] = "leaked";
    try {
      const keys = secretKeysForRuntime(overlay);
      expect(keys).toEqual(["OK"]);
      expect(keys).not.toContain(sentinel);
    } finally {
      delete proto[sentinel];
    }
  });
});
