import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    passWithNoTests: true,
  },
  build: {
    outDir: "build",
    emptyOutDir: true,
    ssr: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "nopo-plugin-docs",
      fileName: "index",
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "node:child_process",
        "node:fs",
        "node:path",
        "node:url",
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
