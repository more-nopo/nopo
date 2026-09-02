import type { HookContext, NopoPluginFactory } from "@more-nopo/nopo/plugin";
import type { ScriptArgs } from "@more-nopo/nopo/script-args";

import { DocsCollector } from "./collect.ts";
import { parseProjectConfig } from "./types.ts";

const docsPlugin: NopoPluginFactory = (config) => {
  const projectConfig = parseProjectConfig(config);

  return {
    name: "docs",
    description: "Build aggregated documentation site from distributed sources",

    commands: [
      {
        name: "build",
        description: "Collect docs and build the Docusaurus site",
        fn: async (context: HookContext, _args: ScriptArgs) => {
          const collector = new DocsCollector(context, projectConfig);
          collector.collect();
          await collector.build();
        },
      },
      {
        name: "dev",
        description: "Start Docusaurus dev server with hot reload",
        fn: async (context: HookContext, _args: ScriptArgs) => {
          const collector = new DocsCollector(context, projectConfig);
          collector.collect();
          await collector.dev();
        },
      },
      {
        name: "serve",
        description: "Serve the built documentation site",
        fn: async (context: HookContext, _args: ScriptArgs) => {
          const collector = new DocsCollector(context, projectConfig);
          await collector.serve();
        },
      },
    ],
  };
};

export default docsPlugin;
