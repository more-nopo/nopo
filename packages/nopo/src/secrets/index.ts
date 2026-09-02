/** Deploy plugins (docker-compose, terraform) call `secrets.get(svcId, runtime, key)` at
 * deploy invocation to decrypt one secret value at a time. The CLI verbs (`nopo secret
 * keygen|set|list|unset|get|rotate-key`) live in `../scripts/secret.ts` and reuse the same
 * primitives. Identity resolution: the age private key is loaded by spawning
 */
import type { NormalizedProjectConfig } from "../config/index.ts";
import { withProcessKeepAlive } from "../keep-alive.ts";
import { decryptValue, isEnvelope } from "./envelope.ts";
import { loadIdentity } from "./identity.ts";
import { readSecretCiphertext } from "./yaml-edit.ts";

export { withProcessKeepAlive } from "../keep-alive.ts";
export { decryptValue, encryptValue, isEnvelope } from "./envelope.ts";
export { loadIdentity } from "./identity.ts";
export {
  listSecrets,
  readSecretCiphertext,
  setSecretCiphertext,
  unsetSecretCiphertext,
} from "./yaml-edit.ts";

interface SecretsContext {
  /** The loaded project config — resolves service paths and project root. */
  project: NormalizedProjectConfig;
  /**
   * Optional env override (test injection / IO threading). Defaults to
   * `process.env` for plugin call sites that pre-date the IO layer; nopo
   * CLI verbs pass `io.env` here.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Decrypt a single ENC[...] envelope using the operator's
 * `NOPO_AGE_IDENTITY_COMMAND`. Throws with operator-friendly errors for a
 * missing/failing command or a bad envelope.
 */
async function decryptSecretValue(
  ciphertext: string,
  ctx: SecretsContext,
): Promise<string> {
  if (!isEnvelope(ciphertext)) {
    throw new Error(
      `Value is not an ENC[...] envelope: cannot decrypt. (Got: "${ciphertext.slice(0, 20)}...")`,
    );
  }
  return withProcessKeepAlive(async () => {
    const identity = await loadIdentity({ env: ctx.env });
    return decryptValue(ciphertext, identity);
  });
}

/** Fetch and decrypt a single secret value for a service runtime. Lookup chain: (1) Locate
 * the service by id in `ctx.project.services.entries`. 2. Read
 * `runtime.<runtime>.secrets.<key>` directly from its nopo.yml
 */
async function getSecret(
  serviceId: string,
  runtime: string,
  key: string,
  ctx: SecretsContext,
): Promise<string | undefined> {
  const service = ctx.project.services.entries[serviceId];
  if (!service) {
    throw new Error(
      `Unknown service "${serviceId}". Define it in nopo.yml before requesting its secrets.`,
    );
  }
  const ciphertext = readSecretCiphertext(service.configPath, runtime, key);
  if (ciphertext === undefined) return undefined;
  return decryptSecretValue(ciphertext, ctx);
}

/** Bound `secrets` namespace, intended for ergonomic use: import { secrets } from
 * "nopo/secrets"; const v = await secrets.get("api", "default", "BROKER_KEK", { project
 * }); The shape mirrors the spec acceptance criterion verbatim ("`secrets.get(svcId,
 * runtime, key)` decrypts one value via configured key").
 */
export const secrets = {
  get: getSecret,
  decrypt: decryptSecretValue,
};
