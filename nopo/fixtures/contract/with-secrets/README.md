# contract/with-secrets

**Axis:** age-encrypted secrets — identity loading, decryption, overlay merge
of `secrets:`, redaction of secret values in compose / k8s output.

## DUMMY KEY — TEST USE ONLY

`dummy-identity.txt` is a checked-in age private key. **It is for fixture
tests only.** It guards no real data and is deliberately public. Do not
reuse this identity anywhere outside this fixture.

- Recipient (public): `age1qwht6ghc6mavd779upqs3chvq35nqgz9ja9hf2t98z8x53rtmv5qxjgxpf`
- Identity file: `./dummy-identity.txt`

To re-encrypt or add a value:

```bash
# Programmatic (preferred — matches the format nopo produces):
bun run -e 'import {encryptValue} from "@more-nopo/nopo/secrets"; console.log(await encryptValue("plaintext", "age1qwht6ghc6mavd779upqs3chvq35nqgz9ja9hf2t98z8x53rtmv5qxjgxpf"))'

# Or via the nopo CLI once the worktree is wired up:
NOPO_AGE_IDENTITY_FILE=./dummy-identity.txt nopo secret set api default API_KEY
```

The `nopo secret` CLI reads the identity from `NOPO_AGE_IDENTITY_FILE` (path)
or `NOPO_AGE_IDENTITY` (literal). Tests should set one of these to point
at `./dummy-identity.txt` before exercising decryption paths.

## Services

| Service | Runtime shape | Secrets                                              |
|---------|---------------|------------------------------------------------------|
| api     | map           | `default.API_KEY`, `prod.API_KEY`, `prod.DB_PASSWORD`|
| worker  | flat          | `QUEUE_TOKEN` (auto-wrapped to `default`)            |

## Plaintext values (asserted by tests after decryption)

| Path                                  | Plaintext                  |
|---------------------------------------|----------------------------|
| api / default / API_KEY               | `test-api-key-default`     |
| api / prod / API_KEY                  | `test-api-key-prod`        |
| api / prod / DB_PASSWORD              | `test-db-password-prod`    |
| worker / default / QUEUE_TOKEN        | `test-queue-token-default` |

## What contract tests will assert

- identity loaded from `./dummy-identity.txt` decrypts every envelope above
- `resolveRuntime(api.runtimes, "prod").envs.secrets.API_KEY` decrypts to
  `test-api-key-prod` (overlay overrides default)
- `resolveRuntime(api.runtimes, "prod").envs.secrets.DB_PASSWORD` decrypts to
  `test-db-password-prod` (key only present in prod overlay)
- worker flat shape auto-wraps: `resolveRuntime(worker.runtimes, "default")`
  yields `QUEUE_TOKEN` = `test-queue-token-default`
- compose / k8s output **redacts** decrypted values (no `test-api-key-prod`
  string in any rendered manifest, only env-from references)
- `nopo secret set` with the dummy identity writes a fresh ENC[...] envelope
  and round-trips back to the new plaintext
