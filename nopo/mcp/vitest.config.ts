import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "md-raw",
      transform(_code: string, id: string) {
        if (id.endsWith(".md")) {
          const content = readFileSync(id, "utf-8");
          return `export default ${JSON.stringify(content)};`;
        }
      },
    },
  ],
  test: {
    globals: true,
  },
});
