/** - `redactSecretManifest` — pure helper for `--print` mode. - `buildSecretManifestsForServices` —
 * decrypts inline `ENC[...]` envelopes from a service's resolved runtime, builds an in-memory k8s
 * Secret manifest. The age identity is loaded via an injected async function so tests don't need to
 * set `NOPO_AGE_IDENTITY_COMMAND`.
 */
import { generateIdentity, identityToRecipient } from "age-encryption";
import type { ResolvedRuntime } from "@more-nopo/nopo/config";
import { encryptValue } from "@more-nopo/nopo/secrets";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  buildSecretManifestsForServices,
  redactSecretManifest,
  secretKeysForRuntime,
} from "./index.ts";

/** Build a minimal `ResolvedRuntime` for a test fixture. Only the fields
 * the secret-manifest path actually reads (`name`, `envs.secrets`) need
 * real values; the rest are stubbed with sane defaults so callers can
 * compose runtimes without setting up a full project config.
 */
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

describe("secretKeysForRuntime", () => {
  it("returns the keys declared on a runtime overlay", () => {
    const overlay = makeRuntime("default", {
      API_KEY: "ENC[...]",
      DB_PASS: "ENC[...]",
    });
    expect(secretKeysForRuntime(overlay).sort()).toEqual([
      "API_KEY",
      "DB_PASS",
    ]);
  });

  it("returns an empty array when no secrets are declared", () => {
    const overlay = makeRuntime("default", {});
    expect(secretKeysForRuntime(overlay)).toEqual([]);
  });
});

/** Decode a `data:` map (base64 values) back to plaintext. The decrypt path
 * emits `data:` not `stringData:` because base64 round-trips arbitrary
 * bytes (newlines, control chars, quotes) safely — see comment in
 * `yamlSecret`. Tests decode here to assert the round-trip invariant.
 */
function decodeData(data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = Buffer.from(v, "base64").toString("utf-8");
  }
  return out;
}

describe("buildSecretManifestsForServices — default runtime", () => {
  it("decrypts ENC[...] values into base64 data on a single-service input", async () => {
    const { identity, recipient } = await makeKey();
    const ciphertext = await encryptValue("super-sekret", recipient);

    const manifests = await buildSecretManifestsForServices(
      [
        {
          id: "af-api",
          overlay: makeRuntime("default", { API_KEY: ciphertext }),
        },
      ],
      "nopo-test",
      async () => identity,
    );

    expect(manifests).toHaveLength(1);
    const m = manifests[0]!;
    expect(m.serviceId).toBe("af-api");
    expect(m.secretName).toBe("af-api-secrets");

    const doc = parseYaml(m.yaml);
    expect(doc.kind).toBe("Secret");
    expect(doc.metadata.name).toBe("af-api-secrets");
    expect(doc.metadata.namespace).toBe("nopo-test");
    expect(doc.metadata.labels.app).toBe("af-api");
    expect(decodeData(doc.data)).toEqual({ API_KEY: "super-sekret" });
  });

  it("emits no manifest for services with no secrets declared", async () => {
    const manifests = await buildSecretManifestsForServices(
      [
        { id: "nginx", overlay: makeRuntime("default", {}) },
        { id: "web", overlay: makeRuntime("default", {}) },
      ],
      "nopo-test",
      async () => "AGE-SECRET-KEY-UNUSED",
    );
    expect(manifests).toEqual([]);
  });

  it("loads the identity exactly once across multiple services", async () => {
    const { identity, recipient } = await makeKey();
    const c1 = await encryptValue("a", recipient);
    const c2 = await encryptValue("b", recipient);
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls++;
      return identity;
    };

    await buildSecretManifestsForServices(
      [
        { id: "svc1", overlay: makeRuntime("default", { K1: c1 }) },
        { id: "svc2", overlay: makeRuntime("default", { K2: c2 }) },
      ],
      "nopo-test",
      loader,
    );

    expect(calls).toBe(1);
  });

  it("does not invoke the identity loader when no service has secrets", async () => {
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls++;
      return "AGE-SECRET-KEY-UNUSED";
    };
    await buildSecretManifestsForServices(
      [{ id: "nginx", overlay: makeRuntime("default", {}) }],
      "nopo-test",
      loader,
    );
    expect(calls).toBe(0);
  });
});

describe("buildSecretManifestsForServices — default → named override", () => {
  it("uses the prod-runtime ciphertext when the prod overlay overrides a key", async () => {
    const { identity, recipient } = await makeKey();
    const prodApi = await encryptValue("prod-api", recipient);
    const prodDb = await encryptValue("prod-db", recipient);

    // Resolver upstream would have layered default + prod; we feed the
    // already-resolved overlay (`name: "prod"`, secrets: { merged }) here.
    const overlay = makeRuntime("prod", {
      API_KEY: prodApi,
      DB_PASS: prodDb,
    });

    const manifests = await buildSecretManifestsForServices(
      [{ id: "af-api", overlay }],
      "nopo-prod",
      async () => identity,
    );

    expect(manifests).toHaveLength(1);
    const doc = parseYaml(manifests[0]!.yaml);
    expect(doc.metadata.namespace).toBe("nopo-prod");
    expect(decodeData(doc.data)).toEqual({
      API_KEY: "prod-api",
      DB_PASS: "prod-db",
    });
  });

  it("uses the default-runtime ciphertext when no prod overlay is requested", async () => {
    const { identity, recipient } = await makeKey();
    const defaultApi = await encryptValue("default-api", recipient);

    const overlay = makeRuntime("default", { API_KEY: defaultApi });
    const manifests = await buildSecretManifestsForServices(
      [{ id: "af-api", overlay }],
      "nopo-dev",
      async () => identity,
    );

    const doc = parseYaml(manifests[0]!.yaml);
    expect(decodeData(doc.data)).toEqual({ API_KEY: "default-api" });
  });
});

describe("buildSecretManifestsForServices — failure paths", () => {
  it("throws naming svc + key when an envelope is corrupt", async () => {
    const { identity, recipient } = await makeKey();
    /** Encrypt with a fresh DIFFERENT key, then attempt to decrypt with the
     * first identity — the inner age unwrap fails. Guarantees a real
     * crypto-level mismatch (not just a syntactic ENC[] tweak).
     */
    const otherRecipient = (await makeKey()).recipient;
    void recipient; // keep variable name above for symmetry
    const wrongCiphertext = await encryptValue("payload", otherRecipient);

    await expect(
      buildSecretManifestsForServices(
        [
          {
            id: "af-api",
            overlay: makeRuntime("default", { BROKER_KEK: wrongCiphertext }),
          },
        ],
        "nopo-test",
        async () => identity,
      ),
    ).rejects.toThrow(/BROKER_KEK.*af-api.*default/);
  });

  it("rejects a non-envelope value with an actionable error", async () => {
    await expect(
      buildSecretManifestsForServices(
        [
          {
            id: "af-api",
            overlay: makeRuntime("default", {
              BROKER_KEK: "this-is-not-an-envelope",
            }),
          },
        ],
        "nopo-test",
        async () => "AGE-SECRET-KEY-UNUSED",
      ),
    ).rejects.toThrow(/af-api.*BROKER_KEK.*ENC\[/);
  });

  it("propagates a loadIdentity failure unchanged", async () => {
    const overlay = makeRuntime("default", {
      K: "ENC[AES256_GCM,placeholder]",
    });
    await expect(
      buildSecretManifestsForServices(
        [{ id: "svc", overlay }],
        "nopo-test",
        async () => {
          throw new Error(
            "NOPO_AGE_IDENTITY_COMMAND is not set. Set it to a shell command...",
          );
        },
      ),
    ).rejects.toThrow(/NOPO_AGE_IDENTITY_COMMAND is not set/);
  });
});

describe("redactSecretManifest", () => {
  it("replaces every data value with [REDACTED]", async () => {
    const { identity, recipient } = await makeKey();
    const c1 = await encryptValue("very-secret", recipient);
    const c2 = await encryptValue("also-secret", recipient);

    const [m] = await buildSecretManifestsForServices(
      [
        {
          id: "af-api",
          overlay: makeRuntime("default", { K1: c1, K2: c2 }),
        },
      ],
      "nopo-test",
      async () => identity,
    );

    const redacted = redactSecretManifest(m!.yaml);
    const doc = parseYaml(redacted);
    expect(doc.kind).toBe("Secret");
    expect(doc.metadata.name).toBe("af-api-secrets");
    // The decrypt path emits `data:` (base64). redactSecretManifest
    // overwrites every `data[k]` with the literal "[REDACTED]" too.
    const map = doc.data ?? doc.stringData ?? {};
    expect(map).toEqual({
      K1: "[REDACTED]",
      K2: "[REDACTED]",
    });
    /** The original plaintexts must NOT appear anywhere in the redacted
     * string — strict containment check, not just key-by-key. Also
     * check the base64 of the plaintexts isn't lurking (defense against
     * a future bug where the data field is left base64-encoded).
     */
    expect(redacted).not.toContain("very-secret");
    expect(redacted).not.toContain("also-secret");
    expect(redacted).not.toContain(
      Buffer.from("very-secret", "utf-8").toString("base64"),
    );
    expect(redacted).not.toContain(
      Buffer.from("also-secret", "utf-8").toString("base64"),
    );
  });

  it("throws on a non-Secret manifest (defensive — only ever called on Secrets)", () => {
    const cm = `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
data:
  k: v
`;
    expect(() => redactSecretManifest(cm)).toThrow(/expected kind=Secret/);
  });
});
