import { describe, expect, it } from "vitest";

import { withProcessKeepAlive } from "./keep-alive.ts";

describe("withProcessKeepAlive", () => {
  it("returns the callback result", async () => {
    await expect(withProcessKeepAlive(async () => 7)).resolves.toBe(7);
  });

  it("rethrows and still releases the handle", async () => {
    await expect(
      withProcessKeepAlive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withProcessKeepAlive(async () => "ok")).resolves.toBe("ok");
  });
});
