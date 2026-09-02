import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { NormalizedService } from "@more-nopo/nopo/config";
import type { HookContext, NopoPluginFactory } from "@more-nopo/nopo/plugin";
import { ScriptArgs } from "@more-nopo/nopo/script-args";

/** Plugin-level config from root nopo.yml `plugins.sonar.config`. The `url` is taken as-is from the
 * YAML — plugin config is NOT run through `expandEnvValues`, so `${SVC_*}` tokens would NOT be
 * substituted here. Callers that need a different URL per environment set the `SONAR_URL` env var (see
 * the scan command below); the plugin config `url` is the local-dev default.
 */
export interface SonarPluginConfig {
  url: string;
  scannerVersion: string;
}

const DEFAULT_SCANNER_VERSION = "6.2.1.4610";
const DEFAULT_URL = "http://localhost/sonar";

/**
 * Type guard for an opaque-object passthrough block. Replaces `as Record<…>`
 * casts at boundaries where we accept user-shaped YAML and pick out
 * individual string-typed fields by name.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePluginConfig(raw: unknown): SonarPluginConfig {
  const obj = isRecord(raw) ? raw : {};
  const url = typeof obj.url === "string" ? obj.url : DEFAULT_URL;
  const scannerVersion =
    typeof obj.scannerVersion === "string"
      ? obj.scannerVersion
      : DEFAULT_SCANNER_VERSION;
  return { url, scannerVersion };
}

/** What a workspace's nopo.yml may declare under `plugins.sonar`. */
export interface SonarPluginData {
  sources: string[];
  exclusions: string[];
  projectKey?: string;
  projectName?: string;
  projectVersion?: string;
  tests?: string[];
  testInclusions?: string[];
  coverage?: {
    format: "lcov" | "cobertura" | "jacoco";
    path: string;
  };
  properties?: Record<string, string>;
}

/**
 * Read the per-service `plugins.sonar` block out of a NormalizedService.
 * Returns `null` if the service hasn't opted in.
 */
export function getServiceSonarData(
  service: NormalizedService,
): SonarPluginData | null {
  const raw = service.pluginData?.sonar;
  if (!isRecord(raw)) return null;
  const obj = raw;
  const sources = stringList(obj.sources);
  const exclusions = stringList(obj.exclusions);
  if (sources === null || exclusions === null) {
    throw new Error(
      `[sonar] ${service.id}: plugins.sonar.sources and plugins.sonar.exclusions are required (string arrays)`,
    );
  }
  const data: SonarPluginData = { sources, exclusions };
  if (typeof obj.projectKey === "string") data.projectKey = obj.projectKey;
  if (typeof obj.projectName === "string") data.projectName = obj.projectName;
  if (typeof obj.projectVersion === "string")
    data.projectVersion = obj.projectVersion;
  const tests = stringList(obj.tests);
  if (tests !== null) data.tests = tests;
  const testInclusions = stringList(obj.testInclusions);
  if (testInclusions !== null) data.testInclusions = testInclusions;
  if (isRecord(obj.coverage)) {
    const cov = obj.coverage;
    if (
      (cov.format === "lcov" ||
        cov.format === "cobertura" ||
        cov.format === "jacoco") &&
      typeof cov.path === "string"
    ) {
      data.coverage = { format: cov.format, path: cov.path };
    }
  }
  if (isRecord(obj.properties)) {
    const props: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.properties)) {
      if (typeof v === "string") props[k] = v;
    }
    data.properties = props;
  }
  return data;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") return null;
    out.push(v);
  }
  return out;
}

/**
 * Fully-resolved scan config: declared + defaults applied.
 */
export interface ResolvedSonar {
  serviceId: string;
  serviceRoot: string;
  relativePath: string;
  data: SonarPluginData;
  projectKey: string;
  projectName: string;
  projectVersion: string;
  tsconfigExists: boolean;
}

export function applyDefaults(
  data: SonarPluginData,
  service: NormalizedService,
  projectRoot: string,
): ResolvedSonar {
  const relativePath = path
    .relative(projectRoot, service.paths.root)
    .split(path.sep)
    .join("/");
  const tsconfigExists = fs.existsSync(
    path.join(service.paths.root, "tsconfig.json"),
  );
  return {
    serviceId: service.id,
    serviceRoot: service.paths.root,
    relativePath,
    data,
    projectKey: data.projectKey ?? `nopo-${service.id}`,
    projectName: data.projectName ?? `nopo / ${relativePath}`,
    projectVersion: data.projectVersion ?? "1.0",
    tsconfigExists,
  };
}

const COVERAGE_KEY: Record<"lcov" | "cobertura" | "jacoco", string> = {
  lcov: "sonar.javascript.lcov.reportPaths",
  cobertura: "sonar.python.coverage.reportPaths",
  jacoco: "sonar.coverage.jacoco.xmlReportPaths",
};

/**
 * Generate the `sonar-project.properties` body for a resolved workspace.
 * The output is deterministic — pure function of input — so tests can
 * snapshot it per opt-in shape.
 */
export function generateProperties(resolved: ResolvedSonar): string {
  const lines: string[] = [];
  const push = (k: string, v: string): void => {
    lines.push(`${k}=${v}`);
  };

  push("sonar.projectKey", resolved.projectKey);
  push("sonar.projectName", resolved.projectName);
  push("sonar.projectVersion", resolved.projectVersion);
  push("sonar.sources", resolved.data.sources.join(","));
  if (resolved.data.tests !== undefined && resolved.data.tests.length > 0) {
    push("sonar.tests", resolved.data.tests.join(","));
  }
  if (
    resolved.data.testInclusions !== undefined &&
    resolved.data.testInclusions.length > 0
  ) {
    push("sonar.test.inclusions", resolved.data.testInclusions.join(","));
  }
  push("sonar.exclusions", resolved.data.exclusions.join(","));
  push("sonar.sourceEncoding", "UTF-8");
  if (resolved.tsconfigExists) {
    push("sonar.typescript.tsconfigPath", "tsconfig.json");
  }
  if (resolved.data.coverage !== undefined) {
    push(
      COVERAGE_KEY[resolved.data.coverage.format],
      resolved.data.coverage.path,
    );
  }
  if (resolved.data.properties !== undefined) {
    for (const [k, v] of Object.entries(resolved.data.properties)) {
      push(k, v);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Reject ambiguous configs — two workspaces deriving the same projectKey
 * would silently overwrite each other's analysis on the SonarQube server.
 */
/** Parse the `SONAR_SCANNER_EXTRA_ARGS` environment variable into an argv list to append to the scanner
 * CLI. Whitespace-split — correct for the common single-flag case `-Dsonar.scm.disabled=true`. Returns
 * an empty array when unset / empty, so the call site can spread the result unconditionally.
 */
export function parseScannerExtraArgs(raw: string | undefined): string[] {
  return (raw ?? "").split(/\s+/).filter((s) => s.length > 0);
}

export function findDuplicateProjectKeys(
  resolved: ResolvedSonar[],
): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const r of resolved) {
    const list = byKey.get(r.projectKey) ?? [];
    list.push(r.serviceId);
    byKey.set(r.projectKey, list);
  }
  const dupes = new Map<string, string[]>();
  for (const [k, list] of byKey) {
    if (list.length > 1) dupes.set(k, list);
  }
  return dupes;
}

export interface ScannerLocation {
  archSuffix: string;
  zipName: string;
  url: string;
  installDir: string;
  binPath: string;
}

/**
 * Resolve where the scanner archive lives + where the binary will be after
 * extraction. Pure — does no I/O.
 */
export function resolveScannerPath(
  platform: string,
  arch: string,
  cacheRoot: string,
  version: string,
): ScannerLocation {
  const archSuffix = detectArchSuffix(platform, arch);
  const zipName = `sonar-scanner-cli-${version}-${archSuffix}.zip`;
  const url = `https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/${zipName}`;
  const installDir = path.join(cacheRoot, version);
  const binPath = path.join(
    installDir,
    `sonar-scanner-${version}-${archSuffix}`,
    "bin",
    "sonar-scanner",
  );
  return { archSuffix, zipName, url, installDir, binPath };
}

function detectArchSuffix(platform: string, arch: string): string {
  if (platform === "linux") {
    if (arch === "x64" || arch === "x86_64") return "linux-x64";
    if (arch === "arm64" || arch === "aarch64") return "linux-aarch64";
    throw new Error(`Unsupported Linux arch for sonar-scanner: ${arch}`);
  }
  if (platform === "darwin") {
    if (arch === "x64" || arch === "x86_64") return "macosx-x64";
    if (arch === "arm64" || arch === "aarch64") return "macosx-aarch64";
    throw new Error(`Unsupported Darwin arch for sonar-scanner: ${arch}`);
  }
  throw new Error(`Unsupported platform for sonar-scanner: ${platform}`);
}

type Logger = (msg: string) => void;

async function ensureScannerDownloaded(
  loc: ScannerLocation,
  log: Logger,
): Promise<void> {
  if (fs.existsSync(loc.binPath)) return;
  log(`Installing sonar-scanner to ${loc.installDir}`);
  fs.mkdirSync(loc.installDir, { recursive: true });
  const zipPath = path.join(loc.installDir, "scanner.zip");
  await downloadFile(loc.url, zipPath);
  await unzip(zipPath, loc.installDir);
  if (!fs.existsSync(loc.binPath)) {
    throw new Error(
      `sonar-scanner binary missing after unzip: expected ${loc.binPath}`,
    );
  }
  fs.chmodSync(loc.binPath, 0o755);
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download ${url}: ${res.status.toString()} ${res.statusText}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

async function unzip(zipPath: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("unzip", ["-q", "-o", zipPath, "-d", dest], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`unzip exited with ${String(code)}`));
    });
  });
}

async function preflightServerUp(url: string, log: Logger): Promise<void> {
  const probeUrl = `${url.replace(/\/$/, "")}/api/system/status`;
  let body: string;
  try {
    const res = await fetch(probeUrl);
    body = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status.toString()}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Sonar preflight failed at ${probeUrl}: ${msg}. Is the server reachable?`,
    );
  }
  if (!/"status"\s*:\s*"UP"/.test(body)) {
    throw new Error(
      `Sonar at ${probeUrl} did not report UP. Response: ${body.slice(0, 200)}`,
    );
  }
  log(`Sonar host: ${url} (UP)`);
}

async function runScannerForService(
  resolved: ResolvedSonar,
  scannerBin: string,
  sonarUrl: string,
  workspaceCacheRoot: string,
  log: Logger,
): Promise<void> {
  // Generate the properties file under .nopo/sonar/<id>/
  const outDir = path.join(workspaceCacheRoot, resolved.serviceId);
  fs.mkdirSync(outDir, { recursive: true });
  const propsPath = path.join(outDir, "sonar-project.properties");
  fs.writeFileSync(propsPath, generateProperties(resolved));

  log(`[${resolved.serviceId}] scan: ${resolved.relativePath} → ${propsPath}`);
  const extraArgs = parseScannerExtraArgs(process.env.SONAR_SCANNER_EXTRA_ARGS);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      scannerBin,
      [
        `-Dproject.settings=${propsPath}`,
        `-Dsonar.host.url=${sonarUrl}`,
        ...extraArgs,
      ],
      {
        cwd: resolved.serviceRoot,
        env: { ...process.env, SONAR_HOST_URL: sonarUrl },
        stdio: "inherit",
      },
    );
    child.on("error", (err) => {
      reject(
        new Error(
          `[${resolved.serviceId}] failed to spawn sonar-scanner: ${err.message}`,
        ),
      );
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `[${resolved.serviceId}] sonar-scanner exited with ${String(code)}`,
          ),
        );
      }
    });
  });
}

const sonarPlugin: NopoPluginFactory = (rawConfig) => {
  const pluginConfig = parsePluginConfig(rawConfig);
  return {
    name: "sonar",
    description: "Run SonarQube scans on opt-in workspaces",
    commands: [
      {
        name: "scan",
        description:
          "Scan opt-in workspaces against SonarQube. Usage: nopo sonar scan [target] [--print] [--no-fail-fast]",
        args: new ScriptArgs({
          print: {
            type: "boolean",
            description: "Print discovered workspaces as JSON without scanning",
            default: false,
          },
          "no-fail-fast": {
            type: "boolean",
            description: "Continue scanning after a workspace fails",
            default: false,
          },
        }),
        fn: async (context: HookContext, args: ScriptArgs) => {
          const runner = context.runner;
          const projectRoot = runner.config.root;
          const log = (msg: string): void => {
            runner.logger.log(msg);
          };

          const allServices = Object.values(
            runner.config.project.services.entries,
          );

          // Build resolved list of opt-in workspaces — those declaring
          // plugins.sonar in their nopo.yml.
          const optedIn: ResolvedSonar[] = [];
          for (const svc of allServices) {
            const data = getServiceSonarData(svc);
            if (data === null) continue;
            optedIn.push(applyDefaults(data, svc, projectRoot));
          }
          optedIn.sort((a, b) => a.serviceId.localeCompare(b.serviceId));

          // Reject duplicate projectKeys before any side effects.
          const dupes = findDuplicateProjectKeys(optedIn);
          if (dupes.size > 0) {
            const summary = [...dupes.entries()]
              .map(([k, ids]) => `  ${k}: ${ids.join(", ")}`)
              .join("\n");
            throw new Error(
              `Ambiguous Sonar projectKey across workspaces:\n${summary}`,
            );
          }

          // Targeting: positional or --target via getResolvedTargets()
          const resolvedTargets = runner.getResolvedTargets();
          const positionals = context.positionals ?? [];
          const positionalTarget = positionals[0];

          let targets: ResolvedSonar[];
          if (positionalTarget !== undefined) {
            targets = optedIn.filter((r) => r.serviceId === positionalTarget);
            if (targets.length === 0) {
              const available = optedIn.map((r) => r.serviceId).join(", ");
              throw new Error(
                `No opt-in workspace named '${positionalTarget}'. Available: ${available || "(none)"}`,
              );
            }
          } else if (resolvedTargets !== null) {
            const idSet = new Set(resolvedTargets);
            targets = optedIn.filter((r) => idSet.has(r.serviceId));
          } else {
            targets = optedIn;
          }

          if (targets.length === 0) {
            log("No opt-in workspaces matched.");
            return;
          }

          if (args.get<boolean>("print")) {
            const output = JSON.stringify(
              {
                services: targets.map((t) => ({
                  id: t.serviceId,
                  projectKey: t.projectKey,
                  relativePath: t.relativePath,
                })),
              },
              null,
              2,
            );
            context.io.stdout.write(output + "\n");
            return;
          }

          // Resolve URL: env override > plugin config
          const sonarUrl = process.env.SONAR_URL ?? pluginConfig.url;

          await preflightServerUp(sonarUrl, log);

          const scannerLoc = resolveScannerPath(
            process.platform,
            process.arch,
            path.join(projectRoot, ".nopo", "cache", "sonar-scanner"),
            pluginConfig.scannerVersion,
          );
          await ensureScannerDownloaded(scannerLoc, log);

          const workspaceCacheRoot = path.join(projectRoot, ".nopo", "sonar");
          fs.mkdirSync(workspaceCacheRoot, { recursive: true });

          const failFast = !args.get<boolean>("no-fail-fast");
          const failures: { id: string; reason: string }[] = [];

          for (const target of targets) {
            try {
              await runScannerForService(
                target,
                scannerLoc.binPath,
                sonarUrl,
                workspaceCacheRoot,
                log,
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              failures.push({ id: target.serviceId, reason: msg });
              if (failFast) {
                throw new Error(
                  `Sonar scan failed for ${target.serviceId}: ${msg}`,
                );
              }
              log(`[${target.serviceId}] FAILED: ${msg}`);
            }
          }

          if (failures.length > 0) {
            const summary = failures
              .map((f) => `  ${f.id}: ${f.reason}`)
              .join("\n");
            throw new Error(
              `${String(failures.length)}/${String(targets.length)} workspace(s) failed Sonar scans:\n${summary}`,
            );
          }

          log(`All ${String(targets.length)} workspace(s) scanned cleanly.`);
        },
      },
    ],
  };
};

export default sonarPlugin;
