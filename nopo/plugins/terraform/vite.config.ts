import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "build",
    emptyOutDir: true,
    ssr: true,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "nopo-plugin-terraform-dev",
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
        "node:os",
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
