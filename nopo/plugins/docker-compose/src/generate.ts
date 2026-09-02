import fs from "node:fs";
import path from "node:path";
import type {
  Healthcheck,
  NormalizedProcess,
  NormalizedService,
  ResolvedRuntime,
} from "@more-nopo/nopo/config";
import { healthcheckDurationToSeconds, resolveRuntime } from "@more-nopo/nopo/config";
import { DockerTag } from "@more-nopo/nopo/docker-tag";
import { expandEnvValues } from "@more-nopo/nopo/expand-env";
import type { Runner } from "@more-nopo/nopo/lib";
import { decryptValue, isEnvelope, loadIdentity } from "@more-nopo/nopo/secrets";
import {
  projectServiceRegistry,
  type ServiceRegistry,
  svcDepEnvVars,
} from "@more-nopo/nopo/svc-env";
import { stringify as yamlStringify } from "yaml";

interface ComposeHealthcheck {
  test: string[];
  interval: string;
  timeout: string;
  retries: number;
  start_period: string;
}

interface ComposeDependsOn {
  [service: string]: {
    condition: "service_healthy" | "service_started";
  };
}

interface ComposeServiceDef {
  image: string;
  pull_policy?: string;
  restart?: string;
  working_dir?: string;
  environment?: Record<string, string>;
  ports?: string[];
  healthcheck?: ComposeHealthcheck;
  depends_on?: ComposeDependsOn;
  command?: string | string[];
  volumes?: string[];
}

interface ComposeFile {
  services: Record<string, ComposeServiceDef>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, unknown>;
}

/** Per-process overrides inside `plugins.docker-compose.processes.<name>:`. */
interface DockerComposeProcessPluginConfig {
  environment?: Record<string, string>;
}

interface DockerComposePluginConfig {
  healthcheck?: ComposeHealthcheck;
  volumes?: string[];
  environment?: Record<string, string>;
  ports?: string[];
  /**
   * Per-process overrides keyed by process name (e.g. `web`, `worker`).
   * Currently supports `environment:` only. Per-process `volumes:` is not
   * yet supported — use the service-level `volumes:` for now.
   */
  processes?: Record<string, DockerComposeProcessPluginConfig>;
}

/** Reserved process name used by the normalizer for single-process services. */
const DEFAULT_PROCESS_NAME = "default";

/** Compose service name for a given process. - The synthesized `default` process keeps the bare service
 * id (zero-diff for single-process services). - Named processes are suffixed with `-${name}` so
 * cross-service references (e.g. nginx upstream `api`) keep resolving to the default/web process.
 */
function composeServiceName(serviceId: string, processName: string): string {
  return processName === DEFAULT_PROCESS_NAME
    ? serviceId
    : `${serviceId}-${processName}`;
}

function getNopoDir(root: string): string {
  return path.join(root, ".nopo");
}

function getPluginDir(root: string, pluginName: string): string {
  return path.join(getNopoDir(root), pluginName);
}

function getGeneratedComposePath(root: string): string {
  return path.join(getPluginDir(root, "docker-compose"), "docker-compose.yml");
}

/** The `yaml@2` Document API used here quotes weird scalars on emit, so a crafted KEY or VALUE will not
 * directly inject sibling YAML nodes. But it WILL flow to `docker compose` via stdin; the subprocess
 * then validates the manifest itself and may echo the offending text in stderr.
 */

/** POSIX-portable env var name: leading letter or underscore, then alnum/underscore. */
const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** NUL byte () as a one-char string — kept separate to dodge editors that strip it. */
const NUL = String.fromCharCode(0);

/** Reject env names that aren't POSIX-portable. This catches: - leading digit (`1FOO`) - YAML-special
 * prefixes (`&FOO`, `*FOO`, `!FOO`) - newline / NUL / whitespace inside the key (the YAML-injection
 * class) - dash, dot, slash, and other shell-unfriendly chars
 */
function assertValidEnvName(
  name: string,
  ctx: { service: string; source: "secrets" | "env" | "service-env" },
): void {
  if (!POSIX_ENV_NAME.test(name)) {
    throw new Error(
      `Invalid environment variable name "${name}" in service "${ctx.service}" (source: ${ctx.source}). ` +
        `Names must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
    );
  }
}

/** Reject env values that contain newlines or NUL bytes. Either would survive the `yaml@2` emit (as a
 * block scalar / `\0` escape) but cause `docker compose` to reject the manifest with stderr that may
 * echo the offending value. Tabs and other printable control chars pass — they're legal in env values
 * and shells handle them fine.
 */
function assertValidEnvValue(
  value: string,
  ctx: {
    service: string;
    key: string;
    source: "secrets" | "env" | "service-env";
  },
): void {
  // Newline (LF/CR) or NUL: the dangerous chars for compose stderr echo.
  if (value.includes("\n") || value.includes("\r") || value.includes(NUL)) {
    throw new Error(
      `Invalid environment variable value for "${ctx.key}" in service "${ctx.service}" (source: ${ctx.source}): ` +
        `value must not contain newline or NUL characters.`,
    );
  }
}

/**
 * Vendored static-curl binary path inside the container. Dotfile at root
 * — low collision risk, works on services with read-only-rootfs because
 * it's a separate bind mount.
 */
const PROBE_CONTAINER_PATH = "/.probe";

/** Resolve the host-side static-curl binary path for the current arch. `process.arch` returns Node's
 * arch string (`arm64` / `x64` / ...). We map `arm64` → arm64 and everything else (notably `x64`) →
 * amd64. Linux containers don't run Windows / Darwin binaries, so the only two relevant Linux
 * container architectures are the ones we vendor.
 */
const DEFAULT_PROBE_DIR = path.join("nopo", "bin", "probe");

function probeDirFromProject(
  pluginRefs: { name: string; config?: Record<string, unknown> }[],
): string {
  const ref = pluginRefs.find((entry) => entry.name === "docker-compose");
  const dir = ref?.config?.probeDir;
  return typeof dir === "string" && dir.length > 0 ? dir : DEFAULT_PROBE_DIR;
}

function probeHostPath(root: string, probeDir: string): string {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return path.join(root, probeDir, `probe-linux-${arch}`);
}

/**
 * Return value of {@link healthcheckToCompose}. The http variant needs to
 * inject a bind-mount volume into the service's `volumes:` list alongside
 * the standard compose `healthcheck:` block; exec returns `volume: undefined`.
 */
interface HealthcheckCompose {
  healthcheck: ComposeHealthcheck;
  /** Bind-mount string to merge into the service's volumes (http variant only). */
  volume?: string;
}

/** The Healthcheck is the single source of truth — declared once under `runtime.<env>.healthcheck:` —
 * and this function is its only consumer in this plugin. For `type: http`, the function also returns a
 * `volume` that the caller must merge into the service's `volumes:` list. The mount source is the
 * host-side static-curl binary for the current arch; the target is the fixed in-container path
 */
function healthcheckToCompose(
  hc: Healthcheck,
  ctx: {
    serviceId: string;
    /**
     * Active runtime port for the process this healthcheck attaches to.
     * Used as the fallback when an `http` healthcheck omits its own `port`.
     */
    processPort: number | undefined;
    /** Project root — used to construct the host-side probe binary path. */
    root: string;
    /** Directory under the project root that holds probe-linux-* binaries. */
    probeDir: string;
  },
): HealthcheckCompose {
  if (hc.type === "exec") {
    return {
      healthcheck: {
        test: ["CMD", ...hc.exec],
        interval: hc.interval,
        timeout: hc.timeout,
        retries: hc.retries,
        start_period: hc.delay,
      },
    };
  }

  /** hc.type === "http". Resolve the effective port: healthcheck.port wins,
   * otherwise fall back to the runtime's process.port. Neither set → throw
   * a clear, service-tagged error at YAML-generation time so the operator
   * sees it before the container is ever scheduled.
   */
  const port = hc.port ?? ctx.processPort;
  if (port === undefined) {
    throw new Error(
      `Service "${ctx.serviceId}": runtime.<env>.healthcheck declares type: http with no \`port:\` ` +
        `and the runtime block has no \`port:\` either. Set one of them — usually the runtime port is enough.`,
    );
  }

  /** curl args: `-fsS` fails on HTTP >= 400 (`-f`), silent (`-s`), but still
   * shows errors (`-S`); `--max-time` caps the per-probe wall time at the
   * healthcheck's own timeout so compose's `timeout:` and curl's wall
   * budget agree.
   */
  const url = `http://localhost:${String(port)}${hc.path}`;
  const timeoutSeconds = String(healthcheckDurationToSeconds(hc.timeout));
  return {
    healthcheck: {
      test: [
        "CMD",
        PROBE_CONTAINER_PATH,
        "-fsS",
        "--max-time",
        timeoutSeconds,
        url,
      ],
      interval: hc.interval,
      timeout: hc.timeout,
      retries: hc.retries,
      start_period: hc.delay,
    },
    volume: `${probeHostPath(ctx.root, ctx.probeDir)}:${PROBE_CONTAINER_PATH}:ro`,
  };
}

/** Track deprecated `plugins.docker-compose.healthcheck:` declarations so
 * the deprecation warning fires at most once per (service, runtime) pass.
 * Module-scoped because `generateComposeFile` is invoked once per nopo
 * command — the cache resets when the process exits.
 */
const deprecatedHealthcheckWarned = new Set<string>();

interface StderrSink {
  write(chunk: string): void;
}

function warnDeprecatedComposeHealthcheck(
  io: StderrSink,
  serviceId: string,
): void {
  if (deprecatedHealthcheckWarned.has(serviceId)) return;
  deprecatedHealthcheckWarned.add(serviceId);
  io.write(
    `[nopo] deprecation: service "${serviceId}" declares its healthcheck under ` +
      `plugins.docker-compose.healthcheck:. Move it to runtime.<env>.healthcheck: ` +
      `using the unified schema (exec / interval / timeout / retries / delay). ` +
      `The same block then drives k8s readinessProbe via the terraform plugin.\n`,
  );
}

function serviceImageTag(
  serviceId: string,
  env: {
    DOCKER_REGISTRY: string;
    DOCKER_IMAGE: string;
    DOCKER_VERSION: string;
  },
): string {
  const baseImage = `${env.DOCKER_IMAGE}-${serviceId}`;
  const parsed = new DockerTag({
    registry: env.DOCKER_REGISTRY,
    image: baseImage,
    version: env.DOCKER_VERSION,
  });
  return parsed.fullTag;
}

function getPluginConfig(
  service: NormalizedService,
): DockerComposePluginConfig {
  const raw = service.pluginData?.["docker-compose"];
  if (!raw || typeof raw !== "object") return {};
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- pluginData is untyped passthrough from YAML; runtime shape validated by plugin configSchema
  const config: DockerComposePluginConfig = raw as DockerComposePluginConfig;

  /** Guard: `volumes:` must be a flat list (string[]), not a per-process map. A per-process map shape `{
   * web: [...] }` is not yet supported and would cause `for...of` to throw `TypeError: {} is not
   * iterable` at runtime. Reject it early with a clear message so operators see the problem instead of a
   * cryptic TypeError.
   */
  if (config.volumes !== undefined && !Array.isArray(config.volumes)) {
    throw new Error(
      `plugins.docker-compose.volumes for service "${service.id}" must be a flat list of volume mount strings ` +
        `(e.g. "- data_postgres:/var/lib/postgresql/data"). ` +
        `Per-process volume maps (volumes: { web: [...] }) are not yet supported — ` +
        `use the service-level flat list instead.`,
    );
  }

  return config;
}

/** Resolver applied to each ENC[...] envelope encountered in a runtime
 * overlay's `secrets:` block. Returns either decrypted plaintext
 * (production / `nopo up` path) or the redaction marker (`--print` path,
 * which must never expose plaintext).
 */
type SecretResolver = (
  envelope: string,
  ctx: { service: string; key: string },
) => Promise<string>;

/** Multi-process services (e.g. api with `processes.web` and `processes.worker`) call this once per
 * process. Single-process services pass the synthesized `default` process, preserving zero-diff
 * behaviour.
 */
async function buildServiceDef(
  service: NormalizedService,
  process: NormalizedProcess,
  allServices: Record<string, NormalizedService>,
  env: {
    DOCKER_TAG: string;
    DOCKER_REGISTRY: string;
    DOCKER_IMAGE: string;
    DOCKER_VERSION: string;
    DOCKER_TARGET: string;
  },
  root: string,
  probeDir: string,
  runtimeName: string,
  resolveSecret: SecretResolver,
  serviceRegistry: ServiceRegistry,
  stderr: StderrSink,
): Promise<ComposeServiceDef> {
  const pluginConfig = getPluginConfig(service);
  const isDev = env.DOCKER_TARGET === "development";
  const isDefaultProcess = process.name === DEFAULT_PROCESS_NAME;

  /** Resolve the active runtime overlay once. Every per-service config
   * read (port, command, etc.) goes through this so per-runtime overrides
   * (e.g. `prod: { port: 8080 }`) flow through the compose file.
   * service.runtimes is undefined for packages — short-circuit there.
   */
  const overlay: ResolvedRuntime | undefined = service.runtimes
    ? resolveRuntime(service.runtimes, runtimeName)
    : undefined;

  /** Determine image (service-level — every process uses the same image).
   * In dev mode, services that declare a `dev:` runtime overlay use the
   * base image (bind-mounted code). Services without a dev overlay (e.g.,
   * nginx with a custom Dockerfile) need their own built image even in dev.
   */
  const canUseBaseImage =
    isDev && !service.image && service.runtimes?.dev !== undefined;

  let image: string;
  if (service.image) {
    // External image (e.g., postgres:16)
    image = service.image;
  } else if (canUseBaseImage) {
    // Dev mode with dev command: use base image + bind mount
    image = env.DOCKER_TAG;
  } else {
    // Production, or dev without dev command: use per-service built image
    image = serviceImageTag(service.id, env);
  }

  const def: ComposeServiceDef = { image };

  // Set pull_policy and restart
  if (!service.image) {
    def.pull_policy = "never";
    def.restart = "always";
  } else {
    def.restart = "always";
  }

  // Environment variables: service-level env merged with per-process env.
  const envVars: Record<string, string> = {};

  /** SERVICE_NAME is service-level. PORT is process-level: only the
   * port-bearing process advertises PORT. For back-compat with single-process
   * services, the synthesized default process inherits the runtime port.
   */
  if (overlay) {
    envVars.SERVICE_NAME = service.id;
    if (process.port !== undefined) {
      envVars.PORT = String(process.port);
    } else if (isDefaultProcess) {
      // Back-compat: default process uses the runtime-level port fallback.
      envVars.PORT = String(overlay.port);
    }
  }

  /** Cross-service URL primitives. Every dep — the union of service-level runtime.deps and process-level
   * deps, mirroring depends_on — gets `SVC_<DEP>_HOST` and `SVC_<DEP>_PORT`. The service's own `env:`
   * block can then declare URLs without the plugin needing to know what an nginx is.
   */
  const allDeps = [...new Set([...service.runtimeDeps, ...process.deps])];
  const svcEnv = svcDepEnvVars(allDeps, serviceRegistry);
  Object.assign(envVars, svcEnv);

  /** Service-level env from nopo.yml — values may reference any var
   * already in scope (PORT, SERVICE_NAME, SVC_*_HOST, SVC_*_PORT, …).
   * Pre-expanding here matches the terraform plugin so nopo.yml `env:`
   * values port across compose and k8s with identical semantics.
   */
  if (service.env) {
    const expanded = expandEnvValues(service.env, envVars);
    for (const [k, v] of Object.entries(expanded)) {
      assertValidEnvName(k, { service: service.id, source: "service-env" });
      assertValidEnvValue(v, {
        service: service.id,
        key: k,
        source: "service-env",
      });
      envVars[k] = v;
    }
  }

  // Layer in runtime overlay env values from `runtime.<name>.env:`. These
  // are plain (non-secret) per-runtime overrides and flow in verbatim.
  if (overlay?.envs.env) {
    for (const [k, v] of Object.entries(overlay.envs.env)) {
      assertValidEnvName(k, { service: service.id, source: "env" });
      assertValidEnvValue(v, {
        service: service.id,
        key: k,
        source: "env",
      });
      envVars[k] = v;
    }
  }

  /** Add legacy secrets (NormalizedSecret list) as pass-through env vars (${VAR_NAME:-test-default}).
   * Kept for back-compat with services that still declare `secrets: [{ name: ... }]` at the service
   * level. The inline `test` value becomes the shell default so docker-compose up works without every
   * developer having to export real secrets.
   */
  for (const secret of service.secrets) {
    const fallback = secret.test ?? "";
    envVars[secret.name] = `\${${secret.name}:-${fallback}}`;
  }

  /** Decrypt runtime-overlay ENC[...] secrets from `runtime.<name>.secrets:`. Each value is either an
   * envelope (the standard case, enforced by the runtime parser) or a `${VAR}` placeholder for plaintext
   * that has not yet been migrated. Envelopes go through the resolver — production paths decrypt; the
   * `--print` path swaps in `[REDACTED]`.
   */
  if (overlay?.envs.secrets) {
    for (const [key, value] of Object.entries(overlay.envs.secrets)) {
      assertValidEnvName(key, { service: service.id, source: "secrets" });
      let resolved: string;
      if (isEnvelope(value)) {
        resolved = await resolveSecret(value, {
          service: service.id,
          key,
        });
      } else {
        resolved = value;
      }
      /** Skip post-resolve value validation for the redact placeholder — the marker is fixed (`[REDACTED]`)
       * and contains no newlines / NUL, but treating it as a normal value would be confusing if we ever
       * wanted to allow `[` in real values. The check below catches newlines/NUL only, so `[REDACTED]`
       * passes anyway, but skipping makes the intent explicit.
       */
      if (resolved !== REDACTED_PLACEHOLDER) {
        assertValidEnvValue(resolved, {
          service: service.id,
          key,
          source: "secrets",
        });
      }
      envVars[key] = resolved;
    }
  }

  // Add service-level plugin environment overrides (applied before
  // per-process overrides so per-process keys win).
  if (pluginConfig.environment) {
    for (const [k, v] of Object.entries(pluginConfig.environment)) {
      assertValidEnvName(k, { service: service.id, source: "service-env" });
      assertValidEnvValue(v, {
        service: service.id,
        key: k,
        source: "service-env",
      });
      envVars[k] = v;
    }
  }

  /** Add per-process plugin environment overrides from
   * `plugins.docker-compose.processes.<name>.environment:`. These take the
   * highest priority, overriding both runtime env and service-level plugin env.
   */
  const processPluginConfig = pluginConfig.processes?.[process.name];
  if (processPluginConfig?.environment) {
    for (const [k, v] of Object.entries(processPluginConfig.environment)) {
      assertValidEnvName(k, { service: service.id, source: "service-env" });
      assertValidEnvValue(v, {
        service: service.id,
        key: k,
        source: "service-env",
      });
      envVars[k] = v;
    }
  }

  if (Object.keys(envVars).length > 0) {
    def.environment = envVars;
  }

  // Ports — only the port-bearing process maps a host port. For back-compat,
  // the default/single process always gets ports from plugin config.
  if (pluginConfig.ports && (process.port !== undefined || isDefaultProcess)) {
    def.ports = pluginConfig.ports;
  }

  /** Healthcheck resolution (precedence — highest first): 1. `runtime.<env>.healthcheck:` (new unified
   * schema, drives both compose AND k8s readinessProbe — translated from the typed shape).
   * `plugins.docker-compose.healthcheck:` (deprecated, compose-only) — emits a deprecation warning the
   * first time it's used per service. Auto-generated `/health` probe for built services with a port.
   */
  const isPortBearingProcess = isDefaultProcess || process.port !== undefined;
  /** Captured here, merged into `def.volumes` below — `type: http` healthchecks
   * bind-mount a vendored static curl so probes work on images that lack curl
   * / wget. Exec healthchecks leave this `undefined`.
   */
  let probeVolume: string | undefined;
  if (process.healthcheck && isPortBearingProcess) {
    /** Process port for the http fallback: process.port if declared, otherwise the runtime block's port
     * (which the synthesized default process inherits for single-process services). Both surface as
     * `process.port` on non-default processes; for the default process we fall back to the resolved
     * overlay's port.
     */
    const processPort =
      process.port ?? (isDefaultProcess ? overlay?.port : undefined);
    const result = healthcheckToCompose(process.healthcheck, {
      serviceId: service.id,
      processPort,
      root,
      probeDir,
    });
    def.healthcheck = result.healthcheck;
    probeVolume = result.volume;
  } else if (pluginConfig.healthcheck && isPortBearingProcess) {
    if (!service.image) {
      /** Only warn for first-party services. External images
       * (e.g. postgres) keep using plugins.docker-compose.healthcheck:
       * because they need shell-quoting forms (CMD-SHELL) and probes the
       * unified schema doesn't yet model.
       */
      warnDeprecatedComposeHealthcheck(stderr, service.id);
    }
    def.healthcheck = pluginConfig.healthcheck;
  } else if (process.port !== undefined && !service.image) {
    // Default healthcheck for built services with a port
    def.healthcheck = {
      test: ["CMD", "curl", "-f", `http://localhost:${process.port}/health`],
      interval: "20s",
      timeout: "10s",
      retries: 3,
      start_period: "30s",
    };
  }

  /** depends_on: union of service-level cross-service edges and process deps.
   * For single-process services, process.deps === runtime.deps and runtimeDeps
   * is a superset, so the union equals runtimeDeps — zero-diff.
   */
  const depIds = [...new Set([...service.runtimeDeps, ...process.deps])];
  if (depIds.length > 0) {
    const dependsOn: ComposeDependsOn = {};
    for (const depId of depIds) {
      const depService = allServices[depId];
      // Use service_healthy if the dependency has a healthcheck. Cross-service
      // deps reference the default/port-bearing process where the healthcheck lives.
      const depPluginConfig = depService ? getPluginConfig(depService) : {};
      // Read dep's port from the resolved overlay so per-runtime port
      // overrides cascade through dependency edges too.
      const depOverlay = depService?.runtimes
        ? resolveRuntime(depService.runtimes, runtimeName)
        : undefined;
      const depHasHealthcheck =
        !!depOverlay?.healthcheck ||
        !!depPluginConfig.healthcheck ||
        (depOverlay?.port && !depService?.image);
      dependsOn[depId] = {
        condition: depHasHealthcheck ? "service_healthy" : "service_started",
      };
    }
    def.depends_on = dependsOn;
  }

  // Working directory: in dev mode with base image, services need their workdir set.
  // Service-level — every process runs in the same working directory.
  if (isDev && !service.image) {
    const relPath = path.relative(root, service.paths.root);
    def.working_dir = `/app/${relPath}`;
  }

  /** Command: build the full lifecycle: pre_command && command && post_command. pre/post commands are
   * process-level (each process owns its own migration or postStart hook). Dev hot-reload is
   * process-level too — look for a dev command on the process itself (via the `dev:` overlay's
   * processes).
   */
  const preCmd = process.preCommand;
  const postCmd = process.postCommand;
  let mainCmd: string | undefined;

  if (isDev && service.runtimes?.dev !== undefined) {
    const devOverlay = resolveRuntime(service.runtimes, "dev");
    // Dev: process command, then overlay top-level, then production command.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- ResolvedRuntime.processes is unknown-typed; runtime ResolvedRuntime guarantees command is a string when present
    const devProcessCmd = devOverlay.processes?.[process.name]?.command as
      | string
      | undefined;
    mainCmd = devProcessCmd ?? devOverlay.command ?? process.command;
  } else {
    mainCmd = process.command;
  }

  if (mainCmd) {
    const parts = [preCmd, mainCmd, postCmd].filter(Boolean);
    if (parts.length === 1 && !preCmd && !postCmd) {
      def.command = mainCmd;
    } else {
      def.command = ["sh", "-c", parts.join(" && ")];
    }
  }

  // Volumes: base dev volumes for built services, plus service-level plugin config.
  // Volumes are service-level — every process mounts the same codebase.
  const volumes: string[] = [];

  if (!service.image) {
    /** Built services get the monorepo bind mount and cache volumes in dev. Use the absolute project root
     * path — the YAML is always generated in-memory and piped via stdin to docker compose, which resolves
     * relative paths from the subprocess cwd (the project root), not from the path where the YAML would be
     * written. Absolute paths work correctly for both stdin and the on-disk redacted file.
     */
    if (isDev) {
      volumes.push(`${root}:/app:cached`);
      volumes.push("nopo_uv_cache:/home/nopoapp/.uv");
      volumes.push("nopo_pnpm_store:/home/nopoapp/.local/share/pnpm/store");
      volumes.push("nopo_venv:/home/nopoapp/.venv");
    }
  }

  if (pluginConfig.volumes) {
    for (const vol of pluginConfig.volumes) {
      const colonIdx = vol.indexOf(":");
      if (colonIdx <= 0) {
        volumes.push(vol);
        continue;
      }
      const hostPath = vol.slice(0, colonIdx);
      const containerPath = vol.slice(colonIdx);
      // Relative host paths (starting with ./ or ../) are resolved relative
      // to the project root (the subprocess cwd when compose runs via stdin).
      if (hostPath.startsWith("./") || hostPath.startsWith("../")) {
        volumes.push(`${path.resolve(root, hostPath)}${containerPath}`);
      } else {
        volumes.push(vol);
      }
    }
  }

  /** Declared `runtime.volumes:` entries — two modes selected by the source/size discriminator (see
   * {@link VolumeSchema}): - size mode (PVC / named volume): emit `<name>:<mountPath>` and let the
   * top-level `volumes:` block (collected by the caller) register the named volume. Compose `size:` is
   * ignored (named docker volumes auto-grow).
   */
  for (const v of process.volumes ?? []) {
    if (v.source !== undefined) {
      const suffix = v.readOnly ? ":ro" : "";
      const resolved = path.isAbsolute(v.source)
        ? v.source
        : path.resolve(service.paths.root, v.source);
      volumes.push(`${resolved}:${v.mountPath}${suffix}`);
    } else {
      volumes.push(`${v.name}:${v.mountPath}`);
    }
  }

  /** type: http healthcheck — bind-mount the vendored static curl at /.probe
   * so the in-container `test:` argv can invoke it on images without
   * curl/wget. Appended last; the dotfile target avoids collisions with the
   * codebase bind mount and any service-declared volumes above.
   */
  if (probeVolume) {
    volumes.push(probeVolume);
  }

  if (volumes.length > 0) {
    def.volumes = volumes;
  }

  return def;
}

/** Marker substituted in for ENC[...] secrets when generating in `--print` mode. */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Options that govern how runtime-overlay `secrets:` ENC[...] envelopes
 * are turned into compose `environment:` values.
 */
interface ComposeGenerateOptions {
  /** - `"decrypt"` (default): load the operator's age identity via `NOPO_AGE_IDENTITY_COMMAND` and
   * decrypt each envelope. Fails fast with a service+key-tagged error if the identity is missing or any
   * envelope can't be decrypted. - `"redact"`: never load the identity, never decrypt — every envelope
   * becomes `[REDACTED]`. The output is safe to share / log / commit to a debug bundle.
   */
  secretMode?: "decrypt" | "redact";
}

/** Generate a docker-compose.yml from nopo.yml service configuration. @link ComposeGenerateOptions}.
 * Defaults to decrypt mode — callers handling `--print` flip it to `"redact"`.
 */
export async function generateComposeFile(
  runner: Runner,
  runtimeName: string,
  options: ComposeGenerateOptions = {},
): Promise<string> {
  const entries = runner.config.project.services.entries;
  const env = runner.environment.env;
  const root = runner.config.root;
  const probeDir = probeDirFromProject(runner.config.project.pluginRefs);
  const isDev = env.DOCKER_TARGET === "development";
  const secretMode = options.secretMode ?? "decrypt";

  const resolved = runner.getResolvedTargets();
  const targetSet =
    resolved !== null && resolved.length > 0 ? new Set(resolved) : null;

  const composeServices: Record<string, ComposeServiceDef> = {};
  const namedVolumes: Record<string, unknown> = {};

  /** (Cross-service deps can name a process that isn't being deployed in this run; the env var should
   * still hold the right DNS name + port.) The compose plugin doesn't apply the dev-mode port collapse —
   * its PORT env follows `process.port` directly, and dev CMDs that hardcode :80 are out of scope to fix
   * here.
   */
  const serviceRegistry = projectServiceRegistry(
    runner.config.project,
    runtimeName,
  );

  // Collect all services that should be in the compose file
  const includedServices = new Set<string>();

  for (const [id, service] of Object.entries(entries)) {
    // Only include services with runtime config (not packages)
    if (!service.runtimes && !service.image) continue;

    // If targets are specified, only include those (and their deps are
    // already resolved by the runner's target DAG)
    if (targetSet && !targetSet.has(id)) continue;

    includedServices.add(id);
  }

  /** Lazily load the age identity — only when at least one service has an
   * ENC[...] secret to decrypt. Cached locally so a single compose-gen pass
   * runs the operator's NOPO_AGE_IDENTITY_COMMAND at most once even if
   * many services pull from secrets.
   */
  let cachedIdentity: string | undefined;
  const getIdentity = async (): Promise<string> => {
    if (cachedIdentity === undefined) {
      cachedIdentity = await loadIdentity();
    }
    return cachedIdentity;
  };

  const resolveSecret: SecretResolver =
    secretMode === "redact"
      ? async () => REDACTED_PLACEHOLDER
      : async (envelope, ctx) => {
          const identity = await getIdentity();
          try {
            return await decryptValue(envelope, identity);
          } catch (cause) {
            const reason =
              cause instanceof Error ? cause.message : String(cause);
            throw new Error(
              `Failed to decrypt secret "${ctx.key}" for service "${ctx.service}" (runtime "${runtimeName}"): ${reason}`,
              { cause },
            );
          }
        };

  /** Generate service definitions — one compose entry per process. Single-process services have a
   * synthesized `default` process so they emit one entry under the bare service id (zero-diff).
   * Multi-process services (e.g. api with web + worker) emit `${id}` for the first named process and
   * `${id}-${name}` for subsequent ones.
   */
  for (const id of includedServices) {
    const service = entries[id]!;

    /** Collect the processes to emit. For services with an explicit
     * `processes:` map on their runtime, iterate those. For services
     * without (or packages/image-only services), emit a single stub so
     * the per-process builder handles them uniformly.
     */
    const overlay = service.runtimes
      ? resolveRuntime(service.runtimes, runtimeName)
      : undefined;

    let processes: NormalizedProcess[];
    /** Prefer the pre-normalized NormalizedProcess objects from service.runtime.processes
     * (populated by the config loader for multi-process services). Fall back
     * to overlay.processes (RuntimeBlock shape) or synthesize a single-process
     * stub from the scalar fields for back-compat.
     */
    if (
      service.runtime?.processes &&
      Object.keys(service.runtime.processes).length > 0
    ) {
      // Multi-process service via the back-compat view (already NormalizedProcess[]).
      processes = Object.values(service.runtime.processes);
    } else if (
      overlay?.processes &&
      Object.keys(overlay.processes).length > 0
    ) {
      // Multi-process service via the runtimes map (RuntimeBlock shape — may
      // not have NormalizedProcess yet if the config loader path is new).
      processes = Object.entries(overlay.processes).map(([name, block]) => ({
        name,
        command: block.command,
        preCommand: block.pre_command,
        postCommand: block.post_command,
        cpu: block.cpu ?? "1",
        memory: block.memory ?? "512Mi",
        port: block.port,
        minInstances: 1,
        maxInstances: 1,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- block.deps is validated by RuntimeBlockSchema upstream
        deps: Array.isArray(block.deps) ? (block.deps as string[]) : [],
        /** Per-process healthcheck override; otherwise fall back to the
         * runtime-block-level healthcheck so a single declaration applies
         * to every port-bearing process.
         */
        healthcheck: block.healthcheck ?? overlay.healthcheck,
        // Per-process volumes follow the same fallback shape — process-level
        // override wins, otherwise inherit the block-level list.
        volumes: block.volumes ?? overlay.volumes,
      }));
    } else {
      // Single-process or image-only service: synthesize a `default` process
      // from the back-compat scalar fields on the runtime block.
      const stub: NormalizedProcess = {
        name: DEFAULT_PROCESS_NAME,
        command: overlay?.command,
        preCommand: overlay?.preCommand,
        postCommand: overlay?.postCommand,
        cpu: overlay?.cpu ?? "1",
        memory: overlay?.memory ?? "512Mi",
        port: overlay?.port,
        minInstances: 1,
        maxInstances: 1,
        deps: overlay?.deps ?? [],
        healthcheck: overlay?.healthcheck,
        volumes: overlay?.volumes,
      };
      processes = [stub];
    }

    for (const proc of processes) {
      const composeName = composeServiceName(id, proc.name);
      const serviceDef = await buildServiceDef(
        service,
        proc,
        entries,
        env,
        root,
        probeDir,
        runtimeName,
        resolveSecret,
        serviceRegistry,
        runner.io.stderr,
      );
      composeServices[composeName] = serviceDef;

      // Collect named volumes from service volumes
      if (serviceDef.volumes) {
        for (const vol of serviceDef.volumes) {
          // Named volume format: "name:/path" (not starting with . or /)
          const colonIdx = vol.indexOf(":");
          if (colonIdx > 0) {
            const volumeName = vol.slice(0, colonIdx);
            if (!volumeName.startsWith(".") && !volumeName.startsWith("/")) {
              namedVolumes[volumeName] = {};
            }
          }
        }
      }
    }
  }

  // Add the "base" utility service for dev mode (sync commands need it)
  if (isDev && Object.keys(composeServices).length > 0) {
    composeServices["base"] = {
      image: env.DOCKER_TAG,
      pull_policy: "never",
      restart: "always",
      command: ["sleep", "infinity"],
      volumes: [
        `${root}:/app:cached`,
        "nopo_uv_cache:/home/nopoapp/.uv",
        "nopo_pnpm_store:/home/nopoapp/.local/share/pnpm/store",
        "nopo_venv:/home/nopoapp/.venv",
      ],
      environment: {
        CHOKIDAR_USEPOLLING: "true",
      },
    };

    // Ensure dev cache volumes are included
    namedVolumes["nopo_uv_cache"] = {};
    namedVolumes["nopo_pnpm_store"] = {};
    namedVolumes["nopo_venv"] = {};
  }

  const composeFile: ComposeFile = {
    services: composeServices,
  };

  if (Object.keys(namedVolumes).length > 0) {
    composeFile.volumes = namedVolumes;
  }

  // Default network
  composeFile.networks = {
    default: {
      driver: "bridge",
      enable_ipv6: false,
    },
  };

  return (
    "# Generated by nopo docker-compose plugin. Do not edit.\n" +
    yamlStringify(composeFile, { lineWidth: 120 })
  );
}

/** Write a REDACTED compose document to .nopo/docker-compose/docker-compose.yml. Used only by debug
 * paths (`nopo up --print`) that want the document persisted for human inspection. The output
 * substitutes every runtime-overlay secret value with `[REDACTED]` so the file is safe to share /
 * commit to a bug report. Plain env values come through verbatim.
 */
export async function writeRedactedComposeFile(
  runner: Runner,
  runtimeName: string,
): Promise<string> {
  const composePath = getGeneratedComposePath(runner.config.root);
  const composeDir = path.dirname(composePath);

  // Ensure the directory exists
  fs.mkdirSync(composeDir, { recursive: true });

  const content = await generateComposeFile(runner, runtimeName, {
    secretMode: "redact",
  });
  fs.writeFileSync(composePath, content, "utf-8");

  return composePath;
}
