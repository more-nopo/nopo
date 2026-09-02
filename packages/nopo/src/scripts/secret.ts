/** `nopo secret` — wrapper verbs for managing service-runtime secrets. Operators never
 * invoke sops directly. This command set is the only supported entry point for working
 * with the encrypted `runtime.<name>.secrets:` map in a service nopo.yml. keygen —
 * generate a fresh age identity, print it (no file written) set <svc> <KEY> [<value>]
 */
import { generateIdentity, identityToRecipient } from "age-encryption";
import os from "node:os";
import process from "node:process";

import { baseArgs } from "../args.ts";
import type { NormalizedService } from "../config/index.ts";
import type { IO } from "../io.ts";
import { Script } from "../lib.ts";
import { type Plan, planFromNodes } from "../plan.ts";
import { ScriptArgs } from "../script-args.ts";
import {
  decryptValue,
  encryptValue,
  isEnvelope,
  listSecrets,
  loadIdentity,
  readSecretCiphertext,
  setSecretCiphertext,
  unsetSecretCiphertext,
} from "../secrets/index.ts";

export interface ParsedSecretArgs {
  verb: string | undefined;
  positionals: string[];
  runtime: string;
  fromStdin: boolean;
  unsafe: boolean;
}

const VALID_VERBS = [
  "keygen",
  "set",
  "list",
  "unset",
  "get",
  "rotate-key",
] as const;
type Verb = (typeof VALID_VERBS)[number];

function isVerb(value: string): value is Verb {
  // Widen by element check rather than asserting the array's type — keeps
  // the lint rule (no type assertions) happy and is equivalent at runtime.
  for (const v of VALID_VERBS) {
    if (v === value) return true;
  }
  return false;
}

const KEYGEN_INSTRUCTIONS = (identity: string, recipient: string): string =>
  [
    "A new age identity has been generated. Save it in your secret manager NOW —",
    "this output will not be repeated.",
    "",
    `  ${identity}`,
    `  Recipient: ${recipient}`,
    "",
    "Then set NOPO_AGE_IDENTITY_COMMAND to a shell command that emits the",
    "identity on stdout. Examples:",
    "",
    "  # 1Password",
    "  export NOPO_AGE_IDENTITY_COMMAND=\"op read 'op://Vault/nopo/age-identity'\"",
    "",
    "  # macOS Keychain",
    '  export NOPO_AGE_IDENTITY_COMMAND="security find-generic-password -w -s nopo-age-identity"',
    "",
    "  # pass",
    '  export NOPO_AGE_IDENTITY_COMMAND="pass nopo/age-identity"',
    "",
    "  # k8s mount / CI",
    '  export NOPO_AGE_IDENTITY_COMMAND="cat /run/secrets/nopo-age-identity"',
    "",
    "If you lose this identity you'll need to rotate (`nopo secret rotate-key`).",
    "",
  ].join("\n");

/* -------------------------------------------------------------------------- */
/*  Handler context                                                             */
/* -------------------------------------------------------------------------- */

/** Minimal logger surface — matches `Runner#logger` (lib.ts:Logger). */
export interface SecretLogger {
  log(...args: unknown[]): void;
}

/**
 * Project surface every verb handler reaches into to look up a service by
 * id and walk the full service map (rotate-key). Mirrors the relevant slice
 * of `Runner#config.project.services`.
 */
export interface SecretProject {
  getService(id: string): NormalizedService;
  services: Record<string, NormalizedService>;
}

/**
 * Inputs to every `secret:<verb>` builtin. The parsed argv is pre-resolved
 * by the caller (scope builder) so handlers stay free of argv mechanics.
 */
export interface SecretRunContext {
  parsed: ParsedSecretArgs;
  project: SecretProject;
  io: IO;
  logger: SecretLogger;
}

/* -------------------------------------------------------------------------- */
/*  Verb handlers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Generate a new age identity and print it to stdout with installation
 * instructions. The identity is NOT written to any file — operators copy
 * it into their secret manager.
 */
export async function secretKeygen(ctx: SecretRunContext): Promise<void> {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  ctx.io.stdout.write(KEYGEN_INSTRUCTIONS(identity, recipient));
}

export async function secretSet(ctx: SecretRunContext): Promise<void> {
  const args = ctx.parsed;
  const [svc, key, maybeValue] = args.positionals;
  if (!svc || !key) {
    throw new Error(
      "Usage: nopo secret set <svc> <KEY> [<value>] [--runtime <name>] [--from-stdin]",
    );
  }
  const service = ctx.project.getService(svc);

  const sources = [
    args.fromStdin ? "--from-stdin" : null,
    maybeValue !== undefined ? "<value>" : null,
  ].filter((v): v is string => v !== null);
  if (sources.length === 0) {
    throw new Error(
      "Provide a value: pass it positionally, or pipe via --from-stdin (e.g. `cat file | nopo secret set svc KEY --from-stdin`).",
    );
  }
  if (sources.length > 1) {
    throw new Error(
      `Specify exactly one value source — got: ${sources.join(", ")}.`,
    );
  }

  let plaintext: string;
  if (args.fromStdin) {
    plaintext = await readStdin(ctx.io);
  } else {
    plaintext = maybeValue!;
  }

  const identity = await loadIdentity({ env: ctx.io.env });
  const recipient = await identityToRecipient(identity);
  const ciphertext = await encryptValue(plaintext, recipient);

  setSecretCiphertext(service.configPath, args.runtime, key, ciphertext);
  ctx.logger.log(`Wrote ${svc} ${args.runtime}/${key} → ${service.configPath}`);
}

export async function secretList(ctx: SecretRunContext): Promise<void> {
  const args = ctx.parsed;
  const [svc] = args.positionals;
  if (!svc) {
    throw new Error("Usage: nopo secret list <svc>");
  }
  const service = ctx.project.getService(svc);
  const view = listSecrets(service.configPath);
  if (view.length === 0) {
    ctx.logger.log(`(no runtimes declared on ${svc})`);
    return;
  }
  for (const entry of view) {
    ctx.logger.log(`${entry.runtime}:`);
    if (entry.keys.length === 0) {
      ctx.logger.log("  (none)");
    } else {
      for (const key of entry.keys) {
        ctx.logger.log(`  - ${key}`);
      }
    }
  }
}

export async function secretUnset(ctx: SecretRunContext): Promise<void> {
  const args = ctx.parsed;
  const [svc, key] = args.positionals;
  if (!svc || !key) {
    throw new Error("Usage: nopo secret unset <svc> <KEY> [--runtime <name>]");
  }
  const service = ctx.project.getService(svc);
  const removed = unsetSecretCiphertext(service.configPath, args.runtime, key);
  if (!removed) {
    ctx.logger.log(
      `No such secret: ${svc} ${args.runtime}/${key} (nothing to remove).`,
    );
    return;
  }
  ctx.logger.log(`Removed ${svc} ${args.runtime}/${key}.`);
}

export async function secretGet(ctx: SecretRunContext): Promise<void> {
  const args = ctx.parsed;
  const [svc, key] = args.positionals;
  if (!svc || !key) {
    throw new Error(
      "Usage: nopo secret get <svc> <KEY> --unsafe [--runtime <name>]",
    );
  }
  if (!args.unsafe) {
    throw new Error(
      "Refusing to print plaintext: pass --unsafe to acknowledge the audit log entry written to stderr.",
    );
  }
  const service = ctx.project.getService(svc);
  const ciphertext = readSecretCiphertext(
    service.configPath,
    args.runtime,
    key,
  );
  if (ciphertext === undefined) {
    throw new Error(
      `No secret declared at ${svc} ${args.runtime}/${key} in ${service.configPath}.`,
    );
  }
  if (!isEnvelope(ciphertext)) {
    throw new Error(
      `Value at ${svc} ${args.runtime}/${key} is not an ENC[...] envelope; refusing to read.`,
    );
  }

  const identity = await loadIdentity({ env: ctx.io.env });
  const plaintext = await decryptValue(ciphertext, identity);

  // Audit log to stderr BEFORE printing plaintext to stdout. The chronology
  // matters: a downstream `tee`-style pipeline still records the access.
  const ts = new Date().toISOString();
  const user =
    ctx.io.env.USER ||
    ctx.io.env.USERNAME ||
    os.userInfo().username ||
    "unknown";
  ctx.io.stderr.write(
    `[secret-read] ${svc}/${args.runtime}/${key} read by ${user} at ${ts}\n`,
  );
  // EPIPE on stdout is normal here (`nopo secret get ... | head` closes the pipe after the
  // first line). The audit log already fired above, so a partial write is still
  writeStdoutTolerantly(plaintext, ctx.io);
  if (!plaintext.endsWith("\n")) writeStdoutTolerantly("\n", ctx.io);
}

/** Re-encrypt every ENC[...] value in the project to a freshly-generated age identity,
 * atomically across files. 1. Load the OLD identity via NOPO_AGE_IDENTITY_COMMAND. 2.
 * Generate a NEW identity (held only in process memory). 3. Pass A: walk every service's
 * nopo.yml; for every (runtime, key) in its `secrets:` blocks, decrypt with the old
 */
export async function secretRotateKey(ctx: SecretRunContext): Promise<void> {
  const oldIdentity = await loadIdentity({ env: ctx.io.env });
  const newIdentity = await generateIdentity();
  const newRecipient = await identityToRecipient(newIdentity);

  interface PendingRotation {
    configPath: string;
    runtime: string;
    key: string;
    plaintext: string;
  }
  const pending: PendingRotation[] = [];

  for (const service of Object.values(ctx.project.services)) {
    const view = listSecrets(service.configPath);
    for (const { runtime, keys } of view) {
      for (const key of keys) {
        const ciphertext = readSecretCiphertext(
          service.configPath,
          runtime,
          key,
        );
        if (ciphertext === undefined || !isEnvelope(ciphertext)) {
          // listSecrets only returns ENC[...] keys, so this is an invariant violation. Surface
          // explicitly rather than silently skipping — partial rotation is the failure mode we're
          throw new Error(
            `Aborting rotation: value at ${service.configPath} ${runtime}/${key} is not an ENC[...] envelope.`,
          );
        }
        let plaintext: string;
        try {
          plaintext = await decryptValue(ciphertext, oldIdentity);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Aborting rotation: failed to decrypt ${service.configPath} ${runtime}/${key} with the current NOPO_AGE_IDENTITY_COMMAND: ${msg}. No files were modified.`,
          );
        }
        pending.push({
          configPath: service.configPath,
          runtime,
          key,
          plaintext,
        });
      }
    }
  }

  if (pending.length === 0) {
    ctx.logger.log(
      "No encrypted secrets found in any service. Generated a new identity anyway:",
    );
    ctx.io.stdout.write(KEYGEN_INSTRUCTIONS(newIdentity, newRecipient));
    return;
  }

  // setSecretCiphertext is atomic per-file (temp + rename inside yaml-edit). If a write
  // fails partway, earlier writes remain — but the operator can re-run rotate-key safely
  for (const item of pending) {
    const ciphertext = await encryptValue(item.plaintext, newRecipient);
    setSecretCiphertext(item.configPath, item.runtime, item.key, ciphertext);
  }

  const fileCount = new Set(pending.map((p) => p.configPath)).size;
  ctx.logger.log(
    `Re-encrypted ${pending.length} secret value${pending.length === 1 ? "" : "s"} across ${fileCount} service file${fileCount === 1 ? "" : "s"}.`,
  );
  ctx.io.stdout.write(KEYGEN_INSTRUCTIONS(newIdentity, newRecipient));
  ctx.io.stdout.write(
    "The previous identity is now obsolete — revoke it from your secret manager.\n",
  );
}

/* -------------------------------------------------------------------------- */
/*  Plan                                                                       */
/* -------------------------------------------------------------------------- */

/** Map a parsed verb to its `secret:<verb>` builtin handler name. Throws the same error
 * messages the legacy `fn()` produced for missing or unknown verbs — these throws
 * propagate to the surrounding try/catch in `Runner.run` (and are caught by `tryBuildPlan`
 * during `--print` so the dry-run snapshot stays useful).
 */
function builtinNameForVerb(verb: string | undefined): string {
  if (!verb) {
    throw new Error(
      "Missing secret verb. Run `nopo secret --help` for the verb list.",
    );
  }
  if (!isVerb(verb)) {
    throw new Error(
      `Unknown secret verb "${verb}". Valid verbs: ${VALID_VERBS.join(", ")}. Run \`nopo secret --help\` for usage.`,
    );
  }
  return `secret:${verb}`;
}

export default class SecretScript extends Script {
  static override skipQueue = true; // instant, read-only — never wait
  static override name = "secret";
  static override description =
    "Manage service runtime secrets. Verbs: keygen, set, list, unset, get, rotate-key. Run `nopo secret --help` for flag details.";

  // Extend the global `baseArgs` so flags like `--filter`, `--since`, `--runtime` (the
  // dispatch one), etc. parse identically across scripts. The flag-level help generated
  static override args = baseArgs.extend({
    runtime: {
      type: "string",
      description:
        '[set/list/unset/get] Target runtime block inside the service nopo.yml (default: "default")',
      default: "default",
    },
    "from-stdin": {
      type: "boolean",
      description:
        "[set] Read the secret value from stdin (use this for multiline values: `cat file | nopo secret set ... --from-stdin`)",
      default: false,
    },
    unsafe: {
      type: "boolean",
      description: "[get] Required to print plaintext (writes audit log)",
      default: false,
    },
  });

  /** Single-node plan dispatching to the verb-specific `secret:<verb>` builtin. The parsed
   * argv is carried on `payload.parsed` so the dispatcher can forward it verbatim. Verb
   * validation happens here so an unknown / missing verb throws with the documented message
   * even before the plan runs (mirroring the legacy `fn()` order-of-operations). `--print`
   */
  static plan(_args: ScriptArgs, scope: { argv: readonly string[] }): Plan {
    const parsed = parseSecretArgs(scope.argv);
    const handlerName = builtinNameForVerb(parsed.verb);
    return planFromNodes([
      {
        id: `secret:${parsed.verb}`,
        handler: { kind: "builtin", name: handlerName },
        needs: [],
        payload: { parsed },
        meta: { script: "secret", verb: parsed.verb ?? null },
      },
    ]);
  }
}

/* -------------------------------------------------------------------------- */
/*  Argv parsing                                                               */
/* -------------------------------------------------------------------------- */

/** Custom parser for `nopo secret <verb> [positional ...] [flags]`. The default
 * ScriptArgs/parseTargetArgs flow is built around target IDs matching the discovered
 * services list — but here `set <svc> <KEY> <value>` has THREE positionals where only the
 * first is a service id, and the value is arbitrary. So we parse manually. Flags are
 */
export function parseSecretArgs(argv: readonly string[]): ParsedSecretArgs {
  // argv[0] should be the command name "secret" — confirm and skip it.
  // (When invoked outside the runner, callers pass argv starting at the verb.)
  let i = 0;
  if (argv[i] === "secret") i++;

  const verb = argv[i];
  if (verb !== undefined) i++;

  const flagWithValue = new Set(["--runtime"]);
  const flagBoolean = new Set(["--from-stdin", "--unsafe"]);
  // Boolean flags handled by the framework — silently consume so they don't
  // surface as positionals when the user passes them on the secret line.
  const flagBooleanIgnored = new Set(["--help", "--print", "--json"]);

  const positionals: string[] = [];
  let runtime = "default";
  let fromStdin = false;
  let unsafe = false;

  while (i < argv.length) {
    const tok = argv[i]!;
    // --flag=value form
    const eq = tok.startsWith("--") ? tok.indexOf("=") : -1;
    if (eq > 0) {
      const name = tok.slice(0, eq);
      const val = tok.slice(eq + 1);
      assignFlag(name, val);
      i++;
      continue;
    }
    if (flagWithValue.has(tok)) {
      const val = argv[i + 1];
      if (val === undefined) {
        throw new Error(`Flag ${tok} requires a value.`);
      }
      assignFlag(tok, val);
      i += 2;
      continue;
    }
    if (flagBoolean.has(tok)) {
      assignFlag(tok, "true");
      i++;
      continue;
    }
    if (flagBooleanIgnored.has(tok)) {
      i++;
      continue;
    }
    if (tok.startsWith("--") || tok.startsWith("-")) {
      // Unknown flag — reject so typos surface immediately.
      throw new Error(
        `Unknown flag ${tok}. Supported: --runtime, --from-stdin, --unsafe.`,
      );
    }
    positionals.push(tok);
    i++;
  }

  function assignFlag(name: string, value: string): void {
    switch (name) {
      case "--runtime":
        runtime = value;
        break;
      case "--from-stdin":
        fromStdin = value !== "false";
        break;
      case "--unsafe":
        unsafe = value !== "false";
        break;
    }
  }

  return {
    verb,
    positionals,
    runtime,
    fromStdin,
    unsafe,
  };
}

/** `nopo secret get ... | head` is the canonical way to peek at a long ENC value (PEM keys,
 * JSON blobs); when `head` closes its stdin the kernel raises EPIPE on subsequent writes.
 * The audit log already fired, so a partial write is still an authorized read — we don't
 * want a stack trace. Bun (and Node, in some modes) can deliver the EPIPE either
 */
function isEpipe(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  if (!("code" in err)) return false;
  return err.code === "EPIPE";
}
let stdoutEpipeNetInstalled = false;
function installStdoutEpipeNet(): void {
  if (stdoutEpipeNetInstalled) return;
  stdoutEpipeNetInstalled = true;
  // Process-level safety nets — see the doc above for why these stay on `process`.
  process.stdout.on("error", (err) => {
    if (isEpipe(err)) return;
    throw err;
  });
  process.on("uncaughtException", (err) => {
    if (isEpipe(err)) {
      process.exit(0);
    }
    throw err;
  });
}
function writeStdoutTolerantly(chunk: string, io: IO): void {
  installStdoutEpipeNet();
  try {
    io.stdout.write(chunk);
  } catch (err) {
    if (isEpipe(err)) return;
    throw err;
  }
}

async function readStdin(io: IO): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    io.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    io.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    io.stdin.on("error", reject);
  });
}
