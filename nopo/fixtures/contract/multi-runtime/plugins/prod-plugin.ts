/**
 * Test plugin "prod-plugin" — no-op stub for the multi-runtime contract
 * fixture. Used as the target for `--runtime prod` dispatch.
 */
import type { NopoPluginFactory } from "../../../../../packages/nopo/src/plugin.ts";

const prod: NopoPluginFactory = () => ({
  name: "prod-plugin",
  description: "Multi-runtime fixture: prod plugin",
  overrides: {},
});

export default prod;
