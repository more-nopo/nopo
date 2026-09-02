import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "build",
    emptyOutDir: true,
    ssr: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "nopo-plugin-sonar",
      fileName: "index",
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "node:child_process",
        "node:fs",
        "node:os",
        "node:path",
        "node:process",
        "node:url",
        "node:util",
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
