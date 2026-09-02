/** Tests for `loadIdentity` — the operator-supplied-command path that fetches the age
 * private key without persisting it to nopo storage. The command is run via `shell: true`
 * so we use real shell snippets: `printf '%s' <identity>` → success path (identity comes
 * back) `false` → non-zero exit `printf '%s' not-an-identity` → wrong format `sleep 5`
 */
import { generateIdentity } from "age-encryption";
import { describe, expect, it } from "vitest";

import { loadIdentity } from "../../src/secrets/identity.ts";

describe("loadIdentity", () => {
  it("returns the trimmed identity emitted by the command", async () => {
    // Use a freshly-generated identity so we never bake a real-looking literal into source.
    // printf '%s\n' adds a trailing newline that the loader is required to trim.
    const identity = await generateIdentity();
    const env = {
      NOPO_AGE_IDENTITY_COMMAND: `printf '%s\\n' '${identity}'`,
    };
    const result = await loadIdentity({ env });
    expect(result).toBe(identity);
  });

  it("trims surrounding whitespace from stdout", async () => {
    const identity = await generateIdentity();
    // In practice they go to stderr — but trimming whitespace is the documented contract and
    // it should at least handle a trailing newline cleanly.
    const env = {
      NOPO_AGE_IDENTITY_COMMAND: `printf '%s' '${identity}\n\n'`,
    };
    const result = await loadIdentity({ env });
    expect(result).toBe(identity);
  });

  it("throws an actionable error when NOPO_AGE_IDENTITY_COMMAND is unset", async () => {
    await expect(loadIdentity({ env: {} })).rejects.toThrow(
      /NOPO_AGE_IDENTITY_COMMAND is not set/,
    );
  });

  it("throws an actionable error when the env var is empty", async () => {
    // Whitespace-only is treated the same as unset — operator clearly didn't
    // intend to point at any real command.
    await expect(
      loadIdentity({ env: { NOPO_AGE_IDENTITY_COMMAND: "   " } }),
    ).rejects.toThrow(/NOPO_AGE_IDENTITY_COMMAND is not set/);
  });

  it("throws including the exit code on non-zero exit", async () => {
    // `false` is a built-in that exits 1 — perfect for asserting the
    // exit-code path.
    await expect(
      loadIdentity({ env: { NOPO_AGE_IDENTITY_COMMAND: "false" } }),
    ).rejects.toThrow(/exited with code 1/);
  });

  it("throws when the output doesn't look like an age identity", async () => {
    await expect(
      loadIdentity({
        env: {
          NOPO_AGE_IDENTITY_COMMAND: "printf '%s' not-an-identity",
        },
      }),
    ).rejects.toThrow(
      /does not? produce a value that looks like an age identity|did not produce/i,
    );
  });

  // The kill+await dance can take 1-2s on a slow shared runner before the wall-clock check
  // fires — raise the outer budget so vitest doesn't trip first.
  it("kills the subprocess and throws when the command exceeds the timeout", async () => {
    // A 100ms budget against a 5-second sleep — the subprocess should be
    // SIGTERM'd and the loader must surface a timeout error.
    const start = Date.now();
    await expect(
      loadIdentity({
        env: { NOPO_AGE_IDENTITY_COMMAND: "sleep 5" },
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/took longer than 100ms/);
    // Wall-clock sanity: should NOT take anywhere near 5s. Allow generous
    // headroom for slow CI machines.
    expect(Date.now() - start).toBeLessThan(4_000);
  }, 15_000);
});
