import { resolve } from "node:path";
import { defineConfig } from "vite";

import pkg from "./package.json";

export default defineConfig({
  optimizeDeps: {
    force: true,
    include: ["*"],
  },
  build: {
    outDir: "build",
    emptyOutDir: true,
    ssr: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: pkg.name,
      fileName: "index",
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "node:child_process",
        "node:fs",
        "node:path",
        "node:url",
        "node:net",
        "node:process",
      ],
      output: {
        format: "esm",
        entryFileNames: "[name].js",
      },
    },
    minify: false,
    sourcemap: false,
  },
});
