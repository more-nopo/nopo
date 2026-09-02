/**
 * Test plugin "dev-plugin" — no-op stub for the multi-runtime contract
 * fixture. Records nothing; existence is sufficient for the runtimes:
 * map to resolve.
 */
import type { NopoPluginFactory } from "../../../../../packages/nopo/src/plugin.ts";

const dev: NopoPluginFactory = () => ({
  name: "dev-plugin",
  description: "Multi-runtime fixture: default plugin",
  overrides: {},
});

export default dev;
