export interface DocsProjectConfig {
  title: string;
  url: string;
  githubUrl?: string;
  baseUrl: string;
  include: string[];
  sidebar?: {
    order?: string[];
    labels?: Record<string, string>;
  };
}

interface DocsServiceConfig {
  include?: string[];
  label?: string;
  exclude?: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseProjectConfig(raw: unknown): DocsProjectConfig {
  const config = isRecord(raw) ? raw : {};
  const sidebar = isRecord(config.sidebar) ? config.sidebar : undefined;
  return {
    title: typeof config.title === "string" ? config.title : "Nopo Docs",
    url: typeof config.url === "string" ? config.url : "",
    githubUrl:
      typeof config.githubUrl === "string" ? config.githubUrl : undefined,
    baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : "/",
    include: Array.isArray(config.include)
      ? config.include.map(String)
      : ["./docs"],
    sidebar: sidebar
      ? {
          order: Array.isArray(sidebar.order)
            ? sidebar.order.map(String)
            : undefined,
          labels: isRecord(sidebar.labels)
            ? Object.fromEntries(
                Object.entries(sidebar.labels).map(([k, v]) => [k, String(v)]),
              )
            : undefined,
        }
      : undefined,
  };
}

export function parseServiceConfig(raw: unknown): DocsServiceConfig {
  if (!isRecord(raw)) return {};
  return {
    include: Array.isArray(raw.include) ? raw.include.map(String) : undefined,
    label: typeof raw.label === "string" ? raw.label : undefined,
    exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : undefined,
  };
}
