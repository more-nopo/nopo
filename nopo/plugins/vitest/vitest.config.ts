import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // CLI smoke tests launch real nopo and Vitest processes on CI runners.
    testTimeout: 30_000,
  },
});
