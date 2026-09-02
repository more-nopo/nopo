import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // The contract suite boots the CLI per case (mkdtemp + recursive fixture copy + plugin
    // load via `runCli`). Those take ~400ms locally but can blow past the default 5s
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  server: {
    fs: {
      // Plugin tests in tests/plugin.test.ts dynamic-import .cjs files from os.tmpdir()
      // (mkdtemp). Vite's fs.allow defaults to the workspace root and rejects /tmp/*
      strict: false,
    },
  },
});
