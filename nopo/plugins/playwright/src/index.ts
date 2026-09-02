import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { promisify } from "node:util";
import type { NormalizedService } from "@more-nopo/nopo/config";
import type { HookContext, NopoPluginFactory } from "@more-nopo/nopo/plugin";
import { ScriptArgs } from "@more-nopo/nopo/script-args";

/** Type alias so we don't import the IO interface twice — `HookContext.io`
 * is already typed; using it here keeps the plugin's import surface small
 * and avoids reaching for a non-exported nopo internal.
 */
type IO = HookContext["io"];

const execFileAsync = promisify(execFile);

export interface PlaywrightConfig {
  url?: string;
  testDir?: string;
  configFile?: string;
  project?: string;
}

/**
 * Extract playwright plugin config from a service.
 */
export function getServicePlaywrightConfig(
  service: NormalizedService,
): PlaywrightConfig {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- pluginData is passthrough
  const raw = (service.pluginData?.playwright ?? {}) as Record<string, unknown>;
  return {
    url: typeof raw.url === "string" ? raw.url : undefined,
    testDir: typeof raw.testDir === "string" ? raw.testDir : undefined,
    configFile: typeof raw.configFile === "string" ? raw.configFile : undefined,
    project: typeof raw.project === "string" ? raw.project : undefined,
  };
}

/** Check if a service has playwright tests configured.
 * A service is considered to have tests if either:
 *   - It declares pluginData.playwright in nopo.yml
 *   - A playwright.config.ts exists at the service root
 */
export function hasPlaywrightTests(service: NormalizedService): boolean {
  if (service.pluginData?.playwright !== undefined) return true;
  const configPath = path.join(service.paths.root, "playwright.config.ts");
  return fs.existsSync(configPath);
}

/** Resolve the target URL for E2E tests. pluginData.playwright.url is the default. Env var and --url
 * are explicit overrides for the current invocation (used by CI to point at the deployed URL instead
 * of the dev default). Priority: --url CLI arg > URL env var > pluginData.playwright.url > default.
 */
export function resolveUrl(args: ScriptArgs, config: PlaywrightConfig): string {
  const cliUrl = args.get<string | undefined>("url");
  if (typeof cliUrl === "string" && cliUrl.startsWith("http")) {
    return cliUrl;
  }
  if (process.env.URL) {
    return process.env.URL;
  }
  if (config.url) {
    return config.url;
  }
  return "http://localhost:3000";
}

/**
 * Resolve the test directory.
 */
export function resolveTestDir(
  serviceRoot: string,
  config: PlaywrightConfig,
): string {
  return path.resolve(serviceRoot, config.testDir ?? "playwright");
}

let browserInstallPromise: Promise<void> | null = null;

async function ensureBrowsersInstalled(io: IO): Promise<void> {
  if (browserInstallPromise === null) {
    /** Drop `--with-deps`: the apt-get layer is now baked into the self-hosted runner image (see
     * infrastructure/runner/Dockerfile.arc). `--with-deps` triggers `apt-get update` which hangs for 15min
     * on Talos runners that can't reach Ubuntu mirrors. Browsers themselves are also pre-baked at
     * /usr/local/share/ms-playwright in the runner image, so this call is effectively a no-op there.
     */
    diagnoseBrowserInstall(io);
    browserInstallPromise = new Promise<void>((resolve, reject) => {
      const child = spawn("bunx", ["playwright", "install", "chromium"], {
        stdio: "inherit",
      });
      child.on("error", (err) => {
        browserInstallPromise = null;
        reject(
          new Error(`Failed to install playwright browsers: ${err.message}`),
        );
      });
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          browserInstallPromise = null;
          reject(
            new Error(
              `Failed to install playwright browsers: exit code ${String(code)}`,
            ),
          );
        }
      });
    });
  }
  return browserInstallPromise;
}

function diagnoseBrowserInstall(io: IO): void {
  const pwbPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "(unset)";
  const log = (line: string): void => {
    io.stdout.write(line + "\n");
  };
  log("=== playwright install diagnostics ===");
  log(`PLAYWRIGHT_BROWSERS_PATH=${pwbPath}`);
  log(`HOME=${process.env.HOME ?? "(unset)"}`);
  log(`PWD=${process.cwd()}`);
  log(`uid=${String(process.getuid?.() ?? "n/a")}`);
  if (pwbPath !== "(unset)") {
    try {
      const entries = fs.readdirSync(pwbPath);
      log(`${pwbPath} contents (${String(entries.length)}):`);
      for (const entry of entries) {
        log(`  ${entry}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`${pwbPath} unreadable: ${message}`);
    }
  }
  log("======================================");
}

/** Ask playwright itself for the set of projects this service's config defines. Runs `bunx playwright
 * test --list` (no `--project` filter) and parses the `[project-name]` prefix from each listed test
 * line.
 */
export async function listAvailableProjects(
  configPath: string,
  cwd: string,
): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync(
      "bunx",
      ["playwright", "test", "--list", "--config", configPath],
      { cwd, maxBuffer: 50 * 1024 * 1024 },
    );
    const projects = new Set<string>();
    for (const line of stdout.split("\n")) {
      const match = /^\s*\[([^\]]+)\]/.exec(line);
      if (match?.[1]) projects.add(match[1]);
    }
    return projects;
  } catch {
    return null;
  }
}

async function runE2EForService(
  service: NormalizedService,
  args: ScriptArgs,
  log: (msg: string) => void,
): Promise<void> {
  const config = getServicePlaywrightConfig(service);
  const url = resolveUrl(args, config);
  const testDir = resolveTestDir(service.paths.root, config);
  const configPath = path.join(
    service.paths.root,
    config.configFile ?? "playwright.config.ts",
  );

  log(`[${service.id}] start → ${url} (${testDir})`);

  /** Note: we deliberately DON'T use `--bun` here. Running playwright through bun's own runtime hangs
   * silently on fresh spawns — playwright spawns node workers internally and the IPC pipe between bun
   * and those workers stalls. Plain `bunx playwright` uses node for playwright itself, which works.
   */
  const playwrightArgs = [
    "playwright",
    "test",
    "--config",
    configPath,
    /** `list` reporter emits one line per test (title + duration) as each
     * test finishes. The default `line` reporter rewrites in place which
     * doesn't interleave well when we're multiplexing multiple services.
     */
    "--reporter=list",
  ];

  /** Project selection priority:
   * 1. --project <name> CLI flag (comma-separated → multiple --project args)
   * 2. pluginData.playwright.project from nopo.yml (single)
   * 3. nothing → playwright runs every project defined in the config
   */
  const cliProject = args.get<string | undefined>("project");
  const requestedProjects = (cliProject ?? config.project ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  let projectsToRun = requestedProjects;
  if (requestedProjects.length > 0) {
    /** Intersect the requested list with what this service actually
     * defines. If a service only ships `smoke` but the caller asked
     * for `smoke,critical`, drop `critical` for this service rather
     * than erroring out the whole run.
     */
    const available = await listAvailableProjects(
      configPath,
      service.paths.root,
    );
    if (available !== null) {
      const missing = requestedProjects.filter((p) => !available.has(p));
      projectsToRun = requestedProjects.filter((p) => available.has(p));
      for (const m of missing) {
        log(
          `[${service.id}] skip project '${m}' — not defined in ${path.basename(configPath)}`,
        );
      }
      if (projectsToRun.length === 0) {
        log(
          `[${service.id}] no requested projects defined for this service, skipping`,
        );
        return;
      }
    }
  }
  for (const project of projectsToRun) {
    playwrightArgs.push("--project", project);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("bunx", playwrightArgs, {
      cwd: service.paths.root,
      env: {
        ...process.env,
        PUBLIC_URL: url,
        NODE_ENV: "test",
        // Force unbuffered output from the child process.
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Stream stdout/stderr line-by-line, prefixed with the service id so
    // parallel output across multiple services stays readable.
    const stdout = readline.createInterface({ input: proc.stdout });
    const stderr = readline.createInterface({ input: proc.stderr });
    stdout.on("line", (line) => {
      if (line.length > 0) log(`[${service.id}] ${line}`);
    });
    stderr.on("line", (line) => {
      if (line.length > 0) log(`[${service.id}] ${line}`);
    });

    proc.on("error", (err) => {
      reject(
        new Error(`[${service.id}] failed to spawn playwright: ${err.message}`),
      );
    });
    proc.on("close", (code) => {
      stdout.close();
      stderr.close();
      if (code === 0) {
        log(`[${service.id}] done`);
        resolve();
      } else {
        reject(new Error(`[${service.id}] E2E tests failed (exit ${code})`));
      }
    });
  });
}

const playwrightPlugin: NopoPluginFactory = () => {
  return {
    name: "playwright",
    description: "Run Playwright E2E tests for services",

    commands: [
      {
        name: "e2e",
        description:
          "Run E2E tests. Usage: nopo playwright e2e [service] [--url <url>] [--print] [--no-fail-fast]",
        args: new ScriptArgs({
          url: {
            type: "string",
            description: "Override the URL all services target",
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- undefined default for optional arg
            default: undefined as unknown as string,
          },
          print: {
            type: "boolean",
            description: "Print discovered services as JSON without running",
            default: false,
          },
          "no-fail-fast": {
            type: "boolean",
            description: "Continue running remaining services after one fails",
            default: false,
          },
          project: {
            type: "string",
            description:
              "Playwright project to run (e.g. smoke, critical, extended). Comma-separated for multiple. Overrides pluginData.playwright.project.",
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- undefined default for optional arg
            default: undefined as unknown as string,
          },
        }),
        fn: async (context: HookContext, args: ScriptArgs) => {
          const runner = context.runner;
          const log = (msg: string) => runner.logger.log(msg);

          /** Auto-discover every service with playwright tests. Each
           * service uses its own URL from pluginData.playwright.url (with
           * --url CLI flag as a global override escape hatch).
           */
          const allEntries = runner.config.project.services.entries;
          const allWithTests = Object.values(allEntries)
            .filter(hasPlaywrightTests)
            .sort((a, b) => a.id.localeCompare(b.id));

          /** Optional positional service filter: `nopo playwright e2e <id>` narrows the run to a single service.
           * Useful for iterating on one service's tests without waiting for the rest. The runner strips the
           * subcommand before handing positionals to plugins, so the first positional here is the service id (if
           * any).
           */
          const positionals = context.positionals ?? [];
          const target = positionals[0];

          const services = target
            ? allWithTests.filter((s) => s.id === target)
            : allWithTests;

          if (target && services.length === 0) {
            const available = allWithTests.map((s) => s.id).join(", ");
            throw new Error(
              `Service '${target}' has no Playwright tests. Available: ${available || "(none)"}`,
            );
          }
          if (services.length === 0) {
            throw new Error(
              "No services with Playwright tests found. " +
                "Add `plugins.playwright: { url, testDir? }` to a service " +
                "nopo.yml or place a playwright.config.ts at the service root.",
            );
          }

          log(
            `Discovered ${services.length} service(s) with Playwright tests: ${services.map((s) => s.id).join(", ")}`,
          );
          for (const service of services) {
            const config = getServicePlaywrightConfig(service);
            log(`  ${service.id} → ${resolveUrl(args, config)}`);
          }

          if (args.get<boolean>("print")) {
            const output = JSON.stringify({
              services: services.map((s) => ({
                id: s.id,
                url: resolveUrl(args, getServicePlaywrightConfig(s)),
              })),
            });
            context.io.stdout.write(output + "\n");
            return;
          }

          await ensureBrowsersInstalled(context.io);

          // Run every service in parallel. Promise.allSettled so we collect
          // every failure instead of bailing on the first one.
          const results = await Promise.allSettled(
            services.map((s) => runE2EForService(s, args, log)),
          );

          const failures = results
            .map((r, i) => ({ r, service: services[i]!.id }))
            .filter(
              (
                x,
              ): x is {
                r: PromiseRejectedResult;
                service: string;
              } => x.r.status === "rejected",
            );

          if (failures.length > 0) {
            const summary = failures
              .map(({ service, r }) => {
                const message =
                  r.reason instanceof Error
                    ? r.reason.message
                    : String(r.reason);
                return `  ${service}: ${message}`;
              })
              .join("\n");
            throw new Error(
              `${failures.length}/${services.length} service(s) failed E2E tests:\n${summary}`,
            );
          }

          log(`All ${services.length} service(s) passed E2E tests`);
        },
      },
    ],
  };
};

export default playwrightPlugin;
