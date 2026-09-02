# secret

Manage encrypted runtime secrets stored inline in service `nopo.yml` files.

## Overview

`nopo secret` is the operator interface for the `runtime.<name>.secrets:` map on every service. It wraps an age-based encryption envelope so values stay encrypted at rest in source control. Operators never invoke `sops` (or any other crypto tool) directly — every read/write of a secret goes through this verb cluster.

## Identity model — operator-supplied command

The age private key (the "identity", a string starting with `AGE-SECRET-KEY-`) is **never persisted to nopo-controlled storage**. There is no default `.nopo/sops-age.key` path, no `--key-file` flag, no `NOPO_ENCRYPTION_KEY_PATH` env var. Persisting the key on disk or in a plaintext env var exposes it to:

- malicious npm postinstall scripts running during `bun install`
- process listings (`ps`, `/proc/self/environ`)
- terminal scrollback / shell history
- accidental commits of the file

Instead, you store the identity in your existing secret manager and tell nopo how to fetch it. Set `NOPO_AGE_IDENTITY_COMMAND` to a **shell command** that emits the identity on stdout. nopo spawns the command on every secret operation, captures stdout, decrypts in-process, and discards the bytes when the operation finishes. stdin and stderr inherit so interactive prompts (1Password biometrics, GPG passphrase) and error output reach your terminal directly.

The shell-execute path is intentional — operators write pipelines like `op read 'op://...' | tail -1`. Injection isn't a concern because the operator chose the command.

### Setup recipes

**1Password CLI** (`op`):
```bash
export NOPO_AGE_IDENTITY_COMMAND="op read 'op://Vault/nopo/age-identity'"
```

**macOS Keychain** (`security`):
```bash
# Store once
security add-generic-password -a "$USER" -s nopo-age-identity -w 'AGE-SECRET-KEY-1...'
# Then export
export NOPO_AGE_IDENTITY_COMMAND="security find-generic-password -w -s nopo-age-identity"
```

**`pass`** (the standard unix password manager):
```bash
echo 'AGE-SECRET-KEY-1...' | pass insert -m nopo/age-identity
export NOPO_AGE_IDENTITY_COMMAND="pass nopo/age-identity"
```

**Kubernetes** (mounted Secret):
```bash
# Mount the Secret at /run/secrets/nopo-age-identity
export NOPO_AGE_IDENTITY_COMMAND="cat /run/secrets/nopo-age-identity"
```

**GitHub Actions / CI** (the secret stored in repo / org secrets):
```yaml
env:
  NOPO_AGE_IDENTITY: ${{ secrets.NOPO_AGE_IDENTITY }}
  # Set the command to read from a transient file written at job start.
  # Avoid putting the identity directly in NOPO_AGE_IDENTITY_COMMAND -
  # the command line is visible in `ps` for the lifetime of the spawn.
steps:
  - name: Configure age identity
    run: |
      printf '%s' "$NOPO_AGE_IDENTITY" > /tmp/age-identity
      chmod 600 /tmp/age-identity
      echo "NOPO_AGE_IDENTITY_COMMAND=cat /tmp/age-identity" >> "$GITHUB_ENV"
  - run: nopo secret list af-api
```

**Cloud secret managers** (AWS Secrets Manager, GCP Secret Manager, Vault):
```bash
export NOPO_AGE_IDENTITY_COMMAND="aws secretsmanager get-secret-value --secret-id nopo/age-identity --query SecretString --output text"
export NOPO_AGE_IDENTITY_COMMAND="gcloud secrets versions access latest --secret=nopo-age-identity"
export NOPO_AGE_IDENTITY_COMMAND="vault kv get -field=identity secret/nopo/age"
```

### Subprocess behavior

- **Timeout:** 60 seconds. If your command needs interactive auth (1Password biometrics, GPG passphrase, `kubelogin`), set up the auth session before running nopo.
- **Non-zero exit:** nopo aborts with the exit code in the error. The command's stderr was already streamed to your terminal — fix that and retry.
- **Wrong format:** if the captured stdout doesn't start with `AGE-SECRET-KEY-`, nopo aborts. Most often this means the command is fetching the wrong secret.

## Verbs

```bash
nopo secret keygen                                       # generate + print a fresh age identity (writes nothing)
nopo secret set   <svc> <KEY> [<value>] [--runtime <n>]  # encrypt + write ENC[...] in place
nopo secret list  <svc>                                  # show keys per runtime (no values)
nopo secret unset <svc> <KEY>          [--runtime <n>]   # remove a key from a runtime
nopo secret get   <svc> <KEY> --unsafe [--runtime <n>]   # decrypt + print + audit-log
nopo secret rotate-key                                   # re-encrypt every secret to a new identity
```

`--runtime` defaults to `default`. Targeting a non-default runtime on a flat-shape service auto-reshapes its `runtime:` block into the map form (`{ default: { ... }, <name>: { ... } }`).

### `keygen` — bootstrap a fresh identity

`keygen` generates a new age identity using cryptographic randomness and prints both the private identity and its derived recipient to stdout, along with copy-paste-ready setup snippets for the major secret managers. **It does not write any file.** You're expected to copy the printed identity into your secret manager and configure `NOPO_AGE_IDENTITY_COMMAND` to read it back.

```bash
nopo secret keygen
```

The output is intentionally one-shot — there's no idempotent re-read. If you lose the identity before installing it, run `keygen` again and use the new value.

### `set` — store an encrypted value

```bash
# One-line value (positional)
nopo secret set af-api API_KEY "tok-abcdef..."

# Multiline value or anything sensitive — pipe via stdin
op read 'op://Vault/svc/api-key' | nopo secret set af-api API_KEY --from-stdin
cat ./prod-tls.pem | nopo secret set --runtime prod af-api TLS_KEY --from-stdin
```

There is **no `--from-file` flag**. Reading plaintext from a path tempts operators to drop secrets into temp files that can leak via shell history, editor swap files, or accidental commits. Pipe via stdin instead — the bytes never touch a path nopo controls.

### `list` — show declared keys (never values)

```bash
nopo secret list af-api
# default:
#   - API_KEY
# prod:
#   - DB_PASS
#   - TLS_KEY
```

### `unset` — remove a key

```bash
nopo secret unset af-api API_KEY --runtime prod
```

### `get --unsafe` — read back plaintext (audit-logged)

`get` is the only read-back path. Without `--unsafe` it errors with usage. With `--unsafe`, it writes a single audit line to **stderr** before printing the plaintext to **stdout**:

```text
[secret-read] <svc>/<runtime>/<key> read by <user> at <iso-timestamp>
```

Pipelines that redirect or `tee` stdout still record the access, since the audit line is on a separate stream and is emitted before the plaintext.

```bash
nopo secret get af-api API_KEY --unsafe --runtime prod
```

### `rotate-key` — re-encrypt to a new identity

When you suspect the active identity has leaked, when revoking a contributor's access, or as a routine hygiene step:

```bash
nopo secret rotate-key
```

`rotate-key` loads the OLD identity via `NOPO_AGE_IDENTITY_COMMAND`, generates a NEW identity in process memory, decrypts every `ENC[...]` value in every service's `nopo.yml`, then re-encrypts each one to the new recipient and writes the file atomically. Finally it prints the new identity to stdout for you to install in your secret manager.

If decryption fails on any value (key mismatch, tampered data), `rotate-key` aborts BEFORE any writes — no partial rotation. The error names the offending file.

After a successful rotate, **revoke the old identity from your secret manager**. nopo can't do this for you — only you have access to your secret manager.

## Operator footguns

- **Bash history.** `nopo secret set svc KEY 'plaintext-value'` records the plaintext in your shell history. Use `--from-stdin` or set `HISTCONTROL=ignorespace` and prefix the line with a space.
- **Terminal scrollback.** `nopo secret get --unsafe` prints plaintext to your terminal. The next time you copy/paste from scrollback or share a screenshot, that plaintext goes with it. Treat `get --unsafe` like `cat ~/.ssh/id_rsa` — only when you actually need it, in a scrollback you control.
- **Clipboard managers.** Some clipboard managers (Alfred, Maccy, Klipper) keep history. If you copy a value out of `get --unsafe` they'll retain it.
- **Process listings.** Putting the identity directly in `NOPO_AGE_IDENTITY_COMMAND` (e.g. `export NOPO_AGE_IDENTITY_COMMAND='echo AGE-SECRET-KEY-...'`) leaks the identity to anyone who can read your env (`/proc/<pid>/environ`) or process args during the spawn. Always use a fetcher command, never an inline value.
- **CI environments.** Don't hand-roll the same setup that your secret manager already provides. Most cloud CI systems have first-class secret-fetching CLIs (`aws secretsmanager`, `gcloud secrets`, `vault read`) — wire those into `NOPO_AGE_IDENTITY_COMMAND` rather than passing the identity itself as a CI secret.

## Programmatic decrypt (plugin authors)

Deploy plugins that need to decrypt one secret at a time:

```ts
import { secrets } from "nopo/secrets";

const value = await secrets.get(serviceId, runtimeName, "BROKER_KEK", {
  project, // NormalizedProjectConfig
});
```

`secrets.get` returns `undefined` if the key isn't declared, throws on unknown service id, missing `NOPO_AGE_IDENTITY_COMMAND`, or decryption failure. The identity is loaded fresh per call — there is no in-process cache; each call spawns the operator's command.

## How it works

Each value is sealed in a self-contained envelope of the form:

```
ENC[AES256_GCM,data:<b64>,iv:<b64>,tag:<b64>,key:<b64>,type:str]
```

- A fresh 256-bit data key + 96-bit IV are generated per value.
- AES-256-GCM encrypts the value with that data key.
- The data key is wrapped to the configured age recipient using the standard age binary format and stored in the `key:` field.
- Decryption needs only the value and the matching age private key — no document-level metadata, no separate `.sops.yaml`.

The schema enforces that every entry under any `runtime.<name>.secrets:` is `ENC[...]` ciphertext. Plaintext values are rejected at parse time with a clear error.

## See also

- File-level sops (for example a cluster bootstrap `.sops.yaml`) is a separate pattern from inline service secrets.
