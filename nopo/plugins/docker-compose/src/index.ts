import compose from "docker-compose";
import path from "node:path";
import { isBuildCommandDeps } from "@more-nopo/nopo/config";
import { chalk, createLogger, type Runner } from "@more-nopo/nopo/lib";
import type { HookContext, NopoPluginFactory } from "@more-nopo/nopo/plugin";

import { generateComposeFile, writeRedactedComposeFile } from "./generate.ts";

function getEnv(runner: Runner): Record<string, string> {
  return {
    ...runner.environment.processEnv,
    ...runner.environment.env,
    ...runner.environment.extraEnv,
  };
}

function log(runner: Runner, ...message: unknown[]) {
  runner.logger.log(chalk.yellow(...message));
}

/** Generate the compose YAML in memory and return options for docker-compose commands. The generated
 * YAML carries decrypted runtime-overlay secrets, so it MUST NOT be written to disk. Each
 * `compose.<verb>` invocation receives `configAsString` and the docker-compose subprocess reads the
 * document from its stdin (`-f -`).
 */
async function prepareComposeOptions(
  runner: Runner,
  runtimeName: string,
): Promise<{
  configAsString: string;
  env: Record<string, string>;
}> {
  const configAsString = await generateComposeFile(runner, runtimeName);
  const env = getEnv(runner);
  log(runner, `Using in-memory compose document (runtime=${runtimeName})`);
  return { configAsString, env };
}

/** The docker-compose plugin owns up/down/status only via docker-compose. Runtime selection now happens
 * in the CLI dispatcher: the root `runtimes:` map names the plugin to invoke per runtime (`default:
 * docker-compose`, `prod: terraform`, ...). Plugins do not sniff `process.env.CI` /
 * `process.env.NOPO_NAMESPACE` to decide which one runs — that decision belongs to the user, expressed
 */
const dockerComposePlugin: NopoPluginFactory = () => {
  return {
    name: "docker-compose",
    description: "Docker Compose runtime for local development",

    overrides: {
      up: async (context: HookContext) => {
        await composeUp(context);
      },
      down: async (context: HookContext) => {
        await composeDown(context);
      },
      status: async (context: HookContext) => {
        await composeStatus(context);
      },
    },
  };
};

export default dockerComposePlugin;

// Re-export generation utilities for testing and external use
export {
  generateComposeFile,
  REDACTED_PLACEHOLDER,
  writeRedactedComposeFile,
} from "./generate.ts";

async function composeUp(context: HookContext): Promise<void> {
  const { runner, args, runtime } = context;

  if (!runner.environment.env.DOCKER_TAG) {
    throw new Error("DOCKER_TAG is required but was empty");
  }

  // `--print`: emit a redacted compose document to disk for human review,
  // then exit. Decrypted plaintext is never produced on this path.
  if (args.get<boolean>("print")) {
    const composePath = await writeRedactedComposeFile(runner, runtime);
    log(
      runner,
      `Wrote redacted compose document for runtime=${runtime} to ${composePath}`,
    );
    return;
  }

  const isProduction = runner.environment.env.DOCKER_TARGET === "production";
  const { configAsString, env } = await prepareComposeOptions(runner, runtime);

  // Find services that use the root DOCKER_TAG image (for down before up)
  const { data } = await compose.config({
    configAsString,
    cwd: runner.config.root,
    env,
  });
  const downServices: string[] = [];

  for (const [name, service] of Object.entries(data.config.services)) {
    if (typeof service === "string") continue;
    if (service.image !== runner.environment.env.DOCKER_TAG) continue;
    downServices.push(name);
  }

  /** Sync package managers inside the base container so Linux-specific
   * native binaries land on the bind-mounted host volumes.
   * Sync is only needed in dev mode where host source is bind-mounted.
   */
  const pmSync = async () => {
    if (isProduction) return;
    const targets = runner.getResolvedTargets() ?? runner.config.targets;
    const pms = runner.getAllPackageManagers(targets);

    for (const pm of pms) {
      const pmRoot = path.relative(runner.config.root, pm.cwd);
      const workdir = pmRoot ? `/app/${pmRoot}` : "/app";

      const syncCmd = ["sh", "-c", `cd ${workdir} && ${pm.sync}`];
      const syncOpts = {
        configAsString,
        cwd: runner.config.root,
        callback: createLogger(`sync_${pm.name}`, "blue"),
        commandOptions: ["--rm", "--no-deps", "--remove-orphans"],
        env,
      };

      try {
        await compose.run("base", syncCmd, syncOpts);
      } catch {
        log(runner, `Offline ${pm.name} sync failed, retrying online...`);
        await compose.run("base", syncCmd, syncOpts);
      }
    }
  };

  // In production mode, run each buildable service's build command inside
  // Docker so built files land on the host via the bind mount.
  const buildSync = async () => {
    if (!isProduction) return;
    const services = runner.config.project.services.entries;
    for (const [id, service] of Object.entries(services)) {
      if (!service.build?.command || !service.runtime) continue;
      if (!(id in data.config.services)) continue;

      const buildCommand = service.build.command;
      /** The deps-form (`build.command: { deps: [...] }`) is resolved by
       * plugins that build via Dockerfile (docker plugin). The compose
       * production-build path here only supports raw shell strings —
       * skip deps-form services to keep runtime behavior unchanged.
       */
      if (isBuildCommandDeps(buildCommand)) continue;

      const buildEnv = { CI: "true", ...service.build.env };
      const envFlags = Object.entries(buildEnv).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]);

      log(runner, `Building ${id} in production mode...`);
      await compose.run(id, ["sh", "-c", buildCommand], {
        configAsString,
        cwd: runner.config.root,
        callback: createLogger(`build:${id}`, "cyan"),
        commandOptions: ["--rm", "--no-deps", "--remove-orphans", ...envFlags],
        env,
      });
    }
  };

  // Run PM sync sequentially before the parallel down/pull block
  await pmSync();

  await Promise.all([
    compose.downMany(downServices, {
      configAsString,
      cwd: runner.config.root,
      callback: createLogger("down", "yellow"),
      commandOptions: ["--remove-orphans"],
      env,
    }),
    compose.pullAll({
      configAsString,
      cwd: runner.config.root,
      callback: createLogger("pull", "blue"),
      commandOptions: ["--ignore-pull-failures"],
      env,
    }),
  ]);

  // buildSync runs after down/pull so the Docker network exists for compose.run.
  await buildSync();

  // Docker build commands install Linux-specific native packages (e.g. rollup)
  // into node_modules via the bind mount. Restore host-compatible packages.
  if (isProduction) {
    log(runner, "Restoring host node_modules after Docker build...");
    await context.exec("bun", ["install", "--frozen-lockfile"], {
      cwd: runner.config.root,
      env: { ...env, CI: "true" },
    });
  }

  /** The compose file was already filtered to the resolved targets during generation (via `targetSet` in
   * generateComposeFile). For multi-process services (e.g. af-api → af-api-web + af-api-worker), compose
   * service names don't match nopo service IDs — upMany(nopo-ids) would fail with "no such service". Use
   * upAll so docker compose starts every service in the (pre-filtered) document.
   */
  const composeServiceNames = Object.keys(data.config.services);

  try {
    await compose.upAll({
      configAsString,
      cwd: runner.config.root,
      callback: createLogger("up"),
      commandOptions: ["--remove-orphans", "-d", "--no-build", "--wait"],
      env,
    });
  } catch (error) {
    await Promise.all(
      composeServiceNames.map((service: string) =>
        compose.logs(service, {
          configAsString,
          cwd: runner.config.root,
          callback: createLogger(`log:${service}`),
          commandOptions: ["--no-log-prefix"],
          env,
        }),
      ),
    );
    throw new Error("Failed to start services", { cause: error });
  }

  // Find the first host-mapped port from the resolved compose config.
  // docker-compose resolves env vars, so ${AF_PORT:-8080}:80 becomes "8080:80".
  let visitPort: string | undefined;
  if (data.config.services) {
    for (const svc of Object.values(data.config.services)) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- compose config is untyped JSON
      const s = svc as Record<string, unknown>;
      if (!Array.isArray(s.ports)) continue;
      for (const p of s.ports) {
        const parts = String(p).split(":");
        if (parts.length >= 2) {
          visitPort = parts[0];
          break;
        }
      }
      if (visitPort) break;
    }
  }
  if (visitPort) {
    log(runner, `\n🚀 Services are up! Visit: http://localhost:${visitPort}\n`);
  } else {
    log(runner, `\n🚀 Services are up!\n`);
  }
}

async function composeDown(context: HookContext): Promise<void> {
  const { runner, args: _args, runtime } = context;

  /** Regenerate the compose document on demand. We can't read it from disk anymore — the runtime path no
   * longer persists it (and persisting decrypted plaintext is exactly what we're guarding against). For
   * pure `down` we don't actually need decrypted secrets — docker compose only inspects service shape,
   * image, and volumes — so generate in redact mode to avoid spawning the operator's identity command on
   */
  const configAsString = await generateComposeFile(runner, runtime, {
    secretMode: "redact",
  });

  /** The compose file is pre-filtered to the resolved targets. Use downAll so
   * multi-process services (e.g. af-api → af-api-web + af-api-worker) are
   * torn down correctly — passing nopo service IDs would fail with "no such
   * service" for any service whose compose name differs from its nopo ID.
   */
  await compose.downAll({
    configAsString,
    cwd: runner.config.root,
    callback: createLogger("down", "yellow"),
    commandOptions: ["--rmi", "local", "--volumes"],
  });
}

async function composeStatus(context: HookContext): Promise<void> {
  const { runner, runtime, exec } = context;
  /** status doesn't actually read decrypted env values — `docker compose ps`
   * just queries container state. Generate in redact mode so we don't
   * burn an identity-command spawn on every status invocation.
   */
  const configAsString = await generateComposeFile(runner, runtime, {
    secretMode: "redact",
  });

  const { data } = await compose.ps({
    configAsString,
    cwd: runner.config.root,
  });

  const platform = `${process.platform} ${process.arch}`;
  const node = (
    await exec("node", ["--version"], {
      cwd: runner.config.root,
      silent: true,
    })
  ).stdout.trim();
  const pnpm = (
    await exec("bun", ["--version"], {
      cwd: runner.config.root,
      silent: true,
    })
  ).stdout.trim();

  const project = runner.config.project;

  interface ServiceInfo {
    name: string;
    state: string;
    ports: unknown;
  }

  log(
    runner,
    JSON.stringify(
      {
        project: {
          name: project.name,
          configPath: project.configPath,
          servicesDirs: project.services.dirs,
          serviceCount: project.services.targets.length,
        },
        os: {
          base: project.os.base.from,
          user: project.os.user,
        },
        system: {
          platform,
          node,
          pnpm,
        },
        containers: data.services.reduce(
          (
            acc: Record<string, unknown>,
            { name, state, ports }: ServiceInfo,
          ) => ({
            ...acc,
            [name]: { name, state, ports },
          }),
          {},
        ),
      },
      null,
      2,
    ),
  );
}
