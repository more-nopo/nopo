import type { DocsProjectConfig } from "./types.ts";

export function generateDocusaurusConfig(config: DocsProjectConfig): string {
  return `import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: ${JSON.stringify(config.title)},
  tagline: "Project documentation",
  url: ${JSON.stringify(config.url || "https://example.com")},
  baseUrl: ${JSON.stringify(config.baseUrl)},
  onBrokenLinks: "warn",
  markdown: {
    format: "md",
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },
  i18n: { defaultLocale: "en", locales: ["en"] },
  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    navbar: {
      title: ${JSON.stringify(config.title)},
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Docs",
        },
        {
          href: ${JSON.stringify(config.githubUrl || "https://github.com")},
          label: "GitHub",
          position: "right",
        },
      ],
    },
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
`;
}
