/** Format-preservation tests for `setSecretCiphertext`. `nopo secret set` rewrites a
 * service `nopo.yml` via the `yaml` Document API. The contract operators rely on: the diff
 * after `secret set` shows ONLY the runtime secret you just added — nothing else. Long
 * URLs don't get folded, flow sequences don't get re-padded, and the legacy root
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSecretCiphertext } from "../../src/secrets/yaml-edit.ts";

let tmpFiles: string[] = [];

beforeEach(() => {
  tmpFiles = [];
});

afterEach(() => {
  for (const f of tmpFiles) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // best effort
    }
  }
});

function writeFixture(contents: string): string {
  const file = path.join(
    os.tmpdir(),
    `nopo-yaml-edit-${process.pid}-${tmpFiles.length}-${Date.now()}.yml`,
  );
  fs.writeFileSync(file, contents);
  tmpFiles.push(file);
  return file;
}

const ENC_PLACEHOLDER =
  "ENC[AES256_GCM,data:Xbq4s,iv:urMem,tag:2aFrqyYPIo,type:str]";

describe("setSecretCiphertext format preservation", () => {
  it("does not re-fold long scalars elsewhere in the file", () => {
    const longUrl =
      "https://00000000000000000000000000000000@o0000000000000000.ingest.us.sentry.io/0000000000000000";
    const yml = [
      "name: api",
      "env:",
      `  SENTRY_DSN: "${longUrl}"`,
      "runtime:",
      "  default:",
      "    command: bun run src/index.ts",
      "    port: 3001",
      "",
    ].join("\n");
    const file = writeFixture(yml);

    setSecretCiphertext(file, "default", "BROKER_KEK", ENC_PLACEHOLDER);

    const after = fs.readFileSync(file, "utf-8");
    // The long URL must appear verbatim on a single line — no `\` line
    // continuation, no leading-whitespace wrap.
    expect(after).toContain(`SENTRY_DSN: "${longUrl}"`);
    expect(after).not.toContain("ingest.\\");
  });

  it("preserves flow-style sequences without re-padding", () => {
    const yml = [
      "name: api",
      "tags: [platform]",
      "package_managers: [bun]",
      "runtime:",
      "  default:",
      "    command: bun run src/index.ts",
      "",
    ].join("\n");
    const file = writeFixture(yml);

    setSecretCiphertext(file, "default", "BROKER_KEK", ENC_PLACEHOLDER);

    const after = fs.readFileSync(file, "utf-8");
    // No `[ platform ]` (extra spaces inside flow brackets).
    expect(after).toContain("tags: [platform]");
    expect(after).toContain("package_managers: [bun]");
  });

  it("does not write to the legacy root `secrets:` declaration list", () => {
    // Root-level `secrets:` is the legacy declaration array (env-var names services need at
    // runtime). The runtime envelope map lives under `runtime.<name>.secrets:`.
    const yml = [
      "name: api",
      "secrets:",
      "  - BETTER_AUTH_SECRET:",
      '      test: "test-secret-minimum-32-characters-long"',
      "  - DATABASE_URL:",
      '      test: "postgres://nopo:nopo@db:5432/nopo"',
      "  - GITHUB_CLIENT_ID",
      "runtime:",
      "  default:",
      "    command: bun run src/index.ts",
      "",
    ].join("\n");
    const file = writeFixture(yml);
    const before = fs.readFileSync(file, "utf-8");
    const beforeRootSecrets = extractRootSecretsBlock(before);

    setSecretCiphertext(file, "default", "BROKER_KEK", ENC_PLACEHOLDER);

    const after = fs.readFileSync(file, "utf-8");
    const afterRootSecrets = extractRootSecretsBlock(after);
    // Root `secrets:` block is byte-identical.
    expect(afterRootSecrets).toBe(beforeRootSecrets);
    // BROKER_KEK appears exactly once — under runtime.default.secrets.
    const occurrences = after.split("BROKER_KEK").length - 1;
    expect(occurrences).toBe(1);
    // And the legacy list still doesn't mention it.
    expect(afterRootSecrets).not.toContain("BROKER_KEK");
  });

  it("preserves comments and quoting style on existing values", () => {
    const yml = [
      "name: api",
      "# Top-level comment about env",
      "env:",
      '  BETTER_AUTH_URL: "https://app.example.com"',
      "  NOPO_ENV: local",
      "runtime:",
      "  default:",
      "    command: bun run src/index.ts",
      "",
    ].join("\n");
    const file = writeFixture(yml);

    setSecretCiphertext(file, "default", "BROKER_KEK", ENC_PLACEHOLDER);

    const after = fs.readFileSync(file, "utf-8");
    expect(after).toContain("# Top-level comment about env");
    expect(after).toContain(
      'BETTER_AUTH_URL: "https://app.example.com"',
    );
    expect(after).toContain("NOPO_ENV: local");
  });
});

/** Extract the lines that make up the root-level `secrets:` block (from the `secrets:` line
 * through the last list item before the next top-level key). Used to compare byte-equality
 * of the legacy declaration list across a `setSecretCiphertext` call.
 */
function extractRootSecretsBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "secrets:");
  if (start === -1) return "";
  const out: string[] = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Top-level key (no leading whitespace, ends in colon) ends the block.
    if (/^[A-Za-z_]/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}
