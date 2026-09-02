import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type {
  Healthcheck,
  NormalizedProcess,
  NormalizedProjectConfig,
  NormalizedService,
  ResolvedRuntime,
  Volume,
} from "@more-nopo/nopo/config";
import {
  healthcheckDurationToSeconds,
  resolveRuntime,
  resolveRuntimeNamespace,
} from "@more-nopo/nopo/config";
import { expandEnvValues } from "@more-nopo/nopo/expand-env";
import { chalk } from "@more-nopo/nopo/lib";
import type { HookContext, NopoPluginFactory, RunContext } from "@more-nopo/nopo/plugin";
import {
  decryptValue,
  isEnvelope,
  loadIdentity,
  withProcessKeepAlive,
} from "@more-nopo/nopo/secrets";
import {
  projectServiceRegistry,
  type ServiceRegistry,
  svcDepEnvVars,
} from "@more-nopo/nopo/svc-env";
import { parseAllDocuments, stringify as yamlStringify } from "yaml";

import { createLinePrefixer } from "./line-prefixer.ts";

const NGINX_NODE_PORT = 30080;
const DB_NODE_PORT = 30432;

/** Whether a service runs as a Kubernetes workload (Deployment) during `nopo up`. A service is
 * deployable only if it has SOMETHING to run: a built image (its own Dockerfile → `service.build`) or
 * a pinned upstream `image`. CLI-only control-plane services — `infrastructure/cloudflare-tf`,
 * `infrastructure/stripe-tf` — have NEITHER.
 */
export function isDeployableWorkload(service: NormalizedService): boolean {
  return Boolean(service.build || service.image);
}

/** Does a service opt into preview deploys? A preview environment (nopo-prev) runs ONLY the product
 * plane — services that declare a `runtime.preview` overlay.
 */
export function optsIntoPreview(service: NormalizedService): boolean {
  return Boolean(
    service.runtimes &&
      Object.prototype.hasOwnProperty.call(service.runtimes, "preview"),
  );
}

/** Resolve the k8s namespace to deploy into. Precedence (most specific first): 1. `NOPO_NAMESPACE` —
 * caller named it explicitly. CI sets this to `nopo-ci-${GITHUB_RUN_ID}` in workflow YAML; production
 * deploys set it to `nopo-prod`. The runner doesn't synthesize it any more.
 */
export function resolveNamespace(
  project: NormalizedProjectConfig,
  runtime: string,
): string {
  const envNamespace = process.env.NOPO_NAMESPACE;
  const runtimeNs = resolveRuntimeNamespace(project, runtime);

  if (envNamespace && runtimeNs && envNamespace !== runtimeNs) {
    throw new Error(
      `Namespace conflict: NOPO_NAMESPACE="${envNamespace}" does not match ` +
        `the runtime-derived namespace "${runtimeNs}" from ` +
        `runtimes.\`${runtime}\`. Remove NOPO_NAMESPACE to use the ` +
        `runtime-derived namespace, or update the runtime entry to match.`,
    );
  }

  if (envNamespace) return envNamespace;
  if (runtimeNs) return runtimeNs;
  return "nopo-dev";
}

/** Derive the SERVICE name from a pod's `app` label and `nopo.process` label. Multi-process services
 * label each pod `<service>-<process>` (e.g. `af-api-web`, `af-api-worker`, `af-api-admin`) and stamp
 * the process name on `nopo.process` (`web` / `worker` / `admin`). `deployed-sha` MUST key its SHA map
 * by SERVICE so the keys match `nopo build --changed --since`'s service ids.
 */
export function serviceFromPodLabels(
  appLabel: string,
  process: string,
): string {
  if (process && process !== "default" && appLabel.endsWith(`-${process}`)) {
    return appLabel.slice(0, appLabel.length - process.length - 1);
  }
  return appLabel;
}

export interface ServiceManifest {
  id: string;
  service: NormalizedService;
  image: string;
  port: number;
  env: Record<string, string>;
  secrets: NormalizedService["secrets"];
  isInfra: boolean;
  /**
   * Resolved runtime overlay for the active runtime name (e.g. `default` or
   * `prod`). Plugins should read scalar fields (cpu/memory/preCommand/...)
   * from here, not from `service.runtime` (legacy view of `default` only).
   */
  overlay: ResolvedRuntime;
}

const terraformDevPlugin: NopoPluginFactory = () => {
  return {
    name: "terraform",
    description:
      "Deploy services to a Kubernetes cluster (local Docker Desktop or remote)",

    /** up/down/status/run all operate against k8s via K8sDeployer. The CLI dispatcher decides whether this
     * plugin is invoked at all by looking up the requested runtime in the root `runtimes:` map. There is
     * no longer any `process.env.CI` / `NOPO_NAMESPACE` sniff here — if the user wants k8s for a given
     * runtime, they say so in nopo.yml.
     */
    overrides: {
      up: async (context: HookContext) => {
        const deployer = new K8sDeployer(context);
        const resolved = context.runner.getResolvedTargets();
        const targets =
          resolved !== null
            ? resolved
            : (context.args.get<string[]>("targets") ?? []);
        await deployer.up(targets);
      },
      down: async (context: HookContext) => {
        const deployer = new K8sDeployer(context);
        await deployer.down();
      },
      status: async (context: HookContext) => {
        const deployer = new K8sDeployer(context);
        await deployer.status();
      },
      run: async (context: HookContext) => {
        const deployer = new K8sDeployer(context);
        await deployer.run(context.runContext!);
      },
    },

    commands: [
      {
        name: "deployed-sha",
        description:
          "Print deployed commit SHAs from k8s (oldest by default, --json for per-service map)",
        fn: async (context: HookContext) => {
          const namespace = resolveNamespace(
            context.runner.config.project,
            context.runtime,
          );
          const logger = context.runner.logger;
          const jsonMode = process.argv.includes("--json");

          /** Query RUNNING pods (not deployment spec) to get what's actually
           * deployed. A failed rollout may leave deployment.spec pointing to
           * a new image while the old pod keeps running.
           */
          const result = execFileSync(
            "kubectl",
            [
              "get",
              "pods",
              "-n",
              namespace,
              "--field-selector=status.phase=Running",
              "-o",
              'jsonpath={range .items[*]}{.metadata.labels.app}{"|"}{.metadata.labels.nopo\\.process}{"|"}{.spec.containers[0].image}{"\\n"}{end}',
            ],
            { encoding: "utf-8" },
          );

          /** Two flavours of "what's deployed" depending on how the service got its image: • built service —
           * image tag is `…:sha-XXXX`, resolve to the full git commit. Identity is the git sha. • infra /
           * upstream service — image tag is whatever nopo.yml pinned (e.g. Identity is that full image
           * reference. Callers compare it against the current nopo.yml image string to decide whether anything
           */
          const shaCache = new Map<
            string,
            { sha: string; ts: number } | null
          >();
          const perServiceSha: Record<string, { sha: string; ts: number }> = {};
          const perServiceImage: Record<string, string> = {};

          for (const line of result.split("\n")) {
            /** Pod row: `<app>|<nopo.process>|<image>`. `|` separates (not a
             * space) because an empty `nopo.process` — single-process services
             * — must still yield three fields, and labels / image refs never
             * contain `|`.
             */
            const parts = line.split("|");
            if (parts.length < 3) continue;
            const appLabel = parts[0];
            const procLabel = parts[1];
            // Image refs never contain `|`; rejoin defensively all the same.
            const image = parts.slice(2).join("|");
            if (!appLabel || !image) continue;
            /** Key by SERVICE, not the per-process `app` label, so the map
             * matches `nopo build --changed --since`'s service ids. See the
             * deploy-gap note on `serviceFromPodLabels`.
             */
            const service = serviceFromPodLabels(appLabel, procLabel);

            if (image.includes("sha-")) {
              const short = image.replace(/.*sha-/, "");
              if (!shaCache.has(short)) {
                try {
                  const full = execFileSync("git", ["rev-parse", short], {
                    encoding: "utf-8",
                  }).trim();
                  const ts = parseInt(
                    execFileSync("git", ["log", "-1", "--format=%ct", full], {
                      encoding: "utf-8",
                    }).trim(),
                    10,
                  );
                  shaCache.set(short, { sha: full, ts });
                } catch {
                  logger.log(`Warning: could not resolve sha ${short}`);
                  shaCache.set(short, null);
                }
              }
              const cached = shaCache.get(short);
              if (cached) {
                // For multi-replica rollouts keep the oldest sha so the
                // diff covers every running version.
                const existing = perServiceSha[service];
                if (!existing || cached.ts < existing.ts) {
                  perServiceSha[service] = cached;
                }
              }
            } else {
              // Upstream image — take the first one; replicas of the same
              // deployment share a tag, so picking any is fine.
              if (!(service in perServiceImage)) {
                perServiceImage[service] = image;
              }
            }
          }

          const hasAny =
            Object.keys(perServiceSha).length > 0 ||
            Object.keys(perServiceImage).length > 0;
          if (!hasAny) {
            throw new Error(`No running pods found in namespace ${namespace}`);
          }

          if (jsonMode) {
            const output: Record<string, string> = {};
            for (const [svc, val] of Object.entries(perServiceSha)) {
              output[svc] = val.sha;
            }
            // Merge; built services win over upstream entries of the same
            // name, though the two sets don't actually overlap in practice.
            for (const [svc, ref] of Object.entries(perServiceImage)) {
              if (!(svc in output)) output[svc] = ref;
            }
            context.io.stdout.write(JSON.stringify(output) + "\n");
          } else {
            // Legacy mode: single oldest git sha across all BUILT services.
            // Upstream tags have no timestamp, so they're ignored here.
            let oldest: { sha: string; ts: number } | null = null;
            for (const r of Object.values(perServiceSha)) {
              if (!oldest || r.ts < oldest.ts) oldest = r;
            }
            if (!oldest) {
              throw new Error(
                `No built services (with sha- tags) found in ${namespace}; pass --json to include upstream images.`,
              );
            }
            context.io.stdout.write(oldest.sha + "\n");
          }
        },
      },
    ],
  };
};

export default terraformDevPlugin;

/** The namespaced workload kinds a preview teardown (`nopo down --runtime preview`) deletes. This list
 * MUST contain only ephemeral workload resources and MUST NEVER include `namespace`, `role`,
 * `rolebinding`, `resourcequota`, or `priorityclass` — those are the namespace shell that survives
 * across preview cycles.
 */
export const PREVIEW_DOWN_RESOURCE_KINDS = [
  "deployment",
  "service",
  "secret",
  "configmap",
  "pvc",
  "poddisruptionbudget",
] as const;

export class K8sDeployer {
  private ctx: HookContext;

  constructor(context: HookContext) {
    this.ctx = context;
  }

  private get runner() {
    return this.ctx.runner;
  }

  private get env() {
    return {
      ...this.runner.environment.processEnv,
      ...this.runner.environment.env,
      ...this.runner.environment.extraEnv,
    };
  }

  private get projectRoot() {
    return this.runner.config.root;
  }

  private get project(): NormalizedProjectConfig {
    return this.runner.config.project;
  }

  /** "Cluster-internal" mode: services are reachable via cluster DNS, not via host-mapped NodePorts. True
   * for every namespace except the local `nopo-dev` default. This used to read `process.env.CI` /
   * `NOPO_NAMESPACE` directly to flip dispatch; that logic is gone — only the namespace identity matters
   * now, and the runtime/plugin selection is owned by the root `runtimes:` map.
   */
  private get isClusterInternal(): boolean {
    return this.namespace !== "nopo-dev";
  }

  /**
   * Is the current namespace a preview namespace (derived from a runtime
   * entry with `namespace:` declared)? Preview namespaces get workload-only
   * down and exclude dev-only tagged services.
   */
  private get isPreviewNamespace(): boolean {
    return this.namespace === "nopo-prev";
  }

  /**
   * PriorityClass for pods in this namespace: `nopo-preview` in a preview
   * namespace (evicted before production), else null (inherits the
   * globalDefault `workload` class). Threaded into every Deployment's opts.
   */
  private get podPriorityClassName(): string | null {
    return this.isPreviewNamespace ? "nopo-preview" : null;
  }

  private get namespace(): string {
    return resolveNamespace(this.project, this.ctx.runtime);
  }

  private log(...message: unknown[]) {
    this.runner.logger.log(chalk.cyan(...message));
  }

  private get shell() {
    return this.ctx.shell({
      cwd: this.projectRoot,
      stdio: "pipe",
      env: this.env,
    });
  }

  private get quietShell() {
    return this.ctx.shell({
      cwd: this.projectRoot,
      stdio: "pipe",
      silent: true,
      env: this.env,
    });
  }

  async up(targets: string[] = []): Promise<void> {
    this.log("Deploying services to local Kubernetes cluster...");

    // 1. Check k8s availability
    await this.checkK8sAvailable();

    // 2. Create namespace
    await this.ensureNamespace();

    // 3. Collect service manifests (filtered by targets if specified)
    this.log(
      `Collecting services for namespace '${this.namespace}'` +
        (targets.length > 0
          ? ` from targets: ${targets.join(", ")}`
          : " (all services)"),
    );
    const services = this.collectServices(targets);

    if (services.length === 0) {
      /** Silent success here previously left preview pods on a stale image
       * while CI reported a green deploy (run 29275997460). Fail loud with
       * enough context to see whether the runner handed us only platform
       * deps (filtered by optsIntoPreview) or unknown service ids.
       */
      const previewHint = this.isPreviewNamespace
        ? " In nopo-prev only services with a `runtime.preview` overlay are" +
          " deployable (platform deps like db/litellm/otel are shared from" +
          " nopo-prod and filtered out)."
        : "";
      const requested =
        targets.length > 0 ? targets.join(", ") : "(all services)";
      throw new Error(
        `No services found to deploy in namespace '${this.namespace}'` +
          ` (requested: ${requested}).${previewHint}`,
      );
    }
    this.log(
      `Deploying ${String(services.length)} service(s): ${services
        .map((s) => s.id)
        .join(", ")}`,
    );

    /** 4. `--print` mode: emit every manifest to stdout for review/diffing. Skip decryption entirely —
     * Secret manifests are emitted with `[REDACTED]` for every key based on what the runtime declares, so
     * the operator doesn't need NOPO_AGE_IDENTITY_COMMAND set just to preview a deploy.
     */
    if (this.printMode) {
      this.printManifests(services);
      return;
    }

    /** 5. Build per-service Secret manifests (decrypted from nopo.yml's inline ENC[...] envelopes) ahead of
     * writing the rest of the manifest tree. Plaintext lives only in this string + the kubectl subprocess
     * + the cluster's API server — never touches disk. Apply via `kubectl apply -f -` (stdin); bypassing
     * the manifest directory keeps decrypted plaintext out of any file nopo controls.
     */
    const secretManifests = await this.buildSecretManifests(services);
    await this.applySecretManifestsViaStdin(secretManifests);

    /** 6. Generate and apply non-secret manifests via the manifest directory.
     * Deployment / Service / ConfigMap / PVC don't carry sensitive data,
     * so the on-disk manifest path is fine for them and preserves any
     * `kubectl apply -f <dir>` debugging affordances.
     */
    const manifestDir = this.createManifestDir();
    this.generateManifests(services, manifestDir);
    await this.applyManifests(manifestDir);

    // 7. Wait for deployments to be ready
    await this.waitForDeployments(services);

    /** 8. Run deploy lifecycle hooks (e.g., database migrations)
     * pre_deploy: runs after pods are ready (migrations, schema changes)
     * post_deploy: runs after pre_deploy (cache warming, seed data)
     */
    await this.runDeployHooks(services, "pre_deploy");
    await this.runDeployHooks(services, "post_deploy");

    // 9. Print access info
    this.printAccessInfo(services);
  }

  /**
   * Read `--print` from the hook args. When set, `up` builds every manifest
   * (including the redacted Secret view) and emits the combined YAML to
   * stdout instead of touching the cluster. Useful for review / diffing.
   */
  private get printMode(): boolean {
    return this.ctx.args.get<boolean>("print") ?? false;
  }

  async run(runCtx: RunContext): Promise<void> {
    const namespace = `nopo-run-${String(Date.now()).slice(-8)}`;
    this.log(`Creating throwaway environment in namespace '${namespace}'...`);

    try {
      // 1. Create namespace
      const nsYaml = yamlNamespace(namespace);
      const tmpPath = this.writeTempFile("namespace.yaml", nsYaml);
      await this.shell`kubectl apply -f ${tmpPath}`;

      // 2. Deploy deps the target service needs
      await this.deployDeps(runCtx.service, namespace);

      // 3. Run the command as a throwaway pod
      await this.runInPod(runCtx, namespace);
    } finally {
      // 4. Always clean up — delete namespace kills everything
      this.log(`Cleaning up namespace '${namespace}'...`);
      try {
        await this
          .shell`kubectl delete namespace ${namespace} --ignore-not-found`;
      } catch {
        this.log(`Warning: Failed to clean up namespace '${namespace}'`);
      }
    }
  }

  private async deployDeps(
    serviceId: string,
    namespace: string,
  ): Promise<void> {
    const project = this.runner.config.project;
    const service = project.services.entries[serviceId];
    if (!service) return;

    /** Deploy declared dependencies (e.g., db) for the ACTIVE runtime. Reading `service.runtimeDeps` here
     * uses the DEFAULT block's deps — so under a preview runtime it would pull the shared platform
     * services (db, litellm, otel-collector) that the preview overlay deliberately drops from `deps` (they
     * run once in nopo-prod and are reached cross-namespace).
     */
    const serviceOverlay = resolveRuntime(service.runtimes, this.ctx.runtime);
    const runtimeDeps = serviceOverlay.deps ?? service.runtimeDeps;
    const deps = [...new Set([...service.buildDeps, ...runtimeDeps])];
    if (deps.length === 0) return;

    for (const id of deps) {
      const svc = project.services.entries[id];
      if (!svc?.runtimes) continue;

      this.log(`Deploying dependency: ${id}`);
      const image = this.resolveImage(id, svc, !svc.build);
      /** Read overlay (default block, since this is dep deploy not main
       * service) — DefaultRuntimeBlockSchema baked port=3000, but the
       * legacy fallback to 5432 is kept for db services that don't
       * declare a port (they rely on POSTGRES_PORT defaulting).
       */
      const depRuntime = resolveRuntime(svc.runtimes, this.ctx.runtime);
      const port = depRuntime.port;
      const env = this.resolveEnv(id, svc, project, image);
      const manifest: ServiceManifest = {
        id,
        service: svc,
        image,
        port,
        env,
        secrets: [],
        isInfra: true,
        overlay: depRuntime,
      };

      /** If the dep declares secrets (e.g. db's POSTGRES_PASSWORD now comes from a Secret in prod),
       * materialize a namespace-scoped Secret from the test: values so the dep Deployment can start. Without
       * this, Postgres's docker-entrypoint refuses to initdb because POSTGRES_PASSWORD is unset, and the
       * rollout wait at line below times out at 120s — breaking every test run.
       */
      let depSecretName: string | null = null;
      if (svc.secrets.length > 0) {
        const depSecretData: Record<string, string> = {};
        for (const secret of svc.secrets) {
          depSecretData[secret.name] =
            process.env[secret.name] ??
            secret.test ??
            `test-placeholder-${secret.name.toLowerCase()}`;
        }
        depSecretName = `${id}-dep-env`;
        const depSecretManifest = yamlSecret(
          depSecretName,
          namespace,
          depSecretData,
        );
        const depSecretPath = this.writeTempFile(
          `${depSecretName}.yaml`,
          depSecretManifest,
        );
        await this.shell`kubectl apply -f ${depSecretPath}`;
      }

      const manifestDir = this.createManifestDir();
      // Deps are infra services (db, redis) — in practice always single-
      // process. Iterate `processes` for forward-compat.
      const depProcesses = resolveProcesses(svc.runtime, depRuntime);
      const allManifests: string[] = [yamlPvc(id, namespace)];
      for (const proc of Object.values(depProcesses)) {
        allManifests.push(
          yamlDeployment(manifest, namespace, {
            isDb: true,
            isNginx: false,
            isDev: false,
            isCI: this.isClusterInternal,
            projectRoot: this.projectRoot,
            nginxTemplatePath: null,
            secretName: depSecretName,
            configMounts: [],
            process: proc,
            port: proc.port,
            priorityClassName: this.podPriorityClassName,
          }),
        );
      }
      // Emit a Service for each port-bearing dep process.
      for (const proc of Object.values(depProcesses)) {
        if (proc.port === undefined) continue;
        allManifests.push(
          yamlService(manifest, namespace, {
            isNginx: false,
            isDb: true,
            isBackend: false,
            isCI: true,
            process: proc,
            port: proc.port,
          }),
        );
      }
      fs.writeFileSync(
        path.join(manifestDir, "deps.yaml"),
        allManifests.join("\n---\n"),
        "utf-8",
      );
      await this
        .shell`kubectl apply -f ${manifestDir} --namespace ${namespace}`;

      /** Wait for every dep-process Deployment (fan-out). Dep services are
       * usually single-process (db, redis) but we iterate for forward-compat.
       * A dep service is considered healthy only when ALL its process
       * Deployments are ready.
       */
      const depProcessNames = Object.values(depProcesses);
      for (const proc of depProcessNames) {
        const depDeployName = deploymentName(id, proc.name);
        this.log(`Waiting for ${depDeployName} to be ready...`);
        await this
          .shell`kubectl rollout status deployment/${depDeployName} -n ${namespace} --timeout=300s`;
        this.log(`${depDeployName} is ready.`);
      }
      // Wait for postgres to accept connections (rollout != ready to serve).
      // Always check via the default process (postgres has only one).
      const isPostgres = depRuntime.port === 5432;
      if (isPostgres) {
        this.log(`Waiting for ${id} to accept connections...`);
        for (let attempt = 0; attempt < 10; attempt++) {
          const check = await this
            .quietShell`kubectl exec -n ${namespace} deployment/${id} -- pg_isready -U nopo`.nothrow();
          if (check.exitCode === 0) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      this.log(`${id} is ready.`);
    }
  }

  private async runInPod(runCtx: RunContext, namespace: string): Promise<void> {
    const project = this.runner.config.project;
    const service = project.services.entries[runCtx.service];
    if (!service) {
      throw new Error(`Service '${runCtx.service}' not found`);
    }

    const image = this.resolveImage(runCtx.service, service, !service.build);
    const podName = `run-${runCtx.service}`;

    // Build env vars
    const serviceEnv = this.resolveEnv(runCtx.service, service, project, image);
    /** Resolve secrets for throwaway test pods. `process.env[KEY]` if the runner set it (explicit
     * override). The `test` value declared in the service's nopo.yml secret entry — format-valid dummies,
     * committed to git. A last-resort placeholder for secrets that didn't bother to spell out a test
     * value. Services that parse those secrets on boot will fail loudly, which is the right signal for
     */
    const secretEnv: Record<string, string> = {};
    for (const secret of service.secrets) {
      secretEnv[secret.name] =
        process.env[secret.name] ??
        secret.test ??
        `test-placeholder-${secret.name.toLowerCase()}-${Date.now()}`;
    }
    const allEnv = { ...serviceEnv, ...secretEnv, ...runCtx.env };

    const escapedWorkdir = runCtx.workdir.replace(/'/g, "'\\''");
    const fullCommand = `cd '${escapedWorkdir}' && ${runCtx.command}`;

    this.log(`Running in pod: ${runCtx.service} -> ${runCtx.command}`);

    const pullPolicy =
      this.runner.environment.env.DOCKER_VERSION === "local"
        ? "Never"
        : "IfNotPresent";

    /** Grant the runner's service account Secret CRUD inside this ephemeral namespace. The ClusterRole
     * intentionally has NO cluster-wide Secret access (security narrowing from INFRA-03). Instead we
     * bootstrap a namespace-scoped Role + RoleBinding immediately after the namespace is created.
     * Namespace deletion at the end of run() cascades these objects away automatically.
     */
    const runnerSa = {
      name: "nopo-runner-gha-rs-no-permission",
      namespace: "arc-runners",
    };
    const roleName = "nopo-run-secret-manager";
    const rbacManifest =
      yamlRole(roleName, namespace) +
      "\n---\n" +
      yamlRoleBinding(roleName, namespace, runnerSa);
    const rbacPath = this.writeTempFile("rbac.yaml", rbacManifest);
    await this.shell`kubectl apply -f ${rbacPath}`;
    this.log(
      `Created namespace-scoped Role+RoleBinding '${roleName}' in '${namespace}'`,
    );

    // Create a temporary K8s Secret to hold env vars — avoids leaking values
    // in the kubectl command line / CI logs via --overrides JSON.
    const secretSuffix = crypto.randomBytes(4).toString("hex");
    const secretName = `test-env-${secretSuffix}`;
    const secretManifest = yamlSecret(secretName, namespace, allEnv);
    const secretPath = this.writeTempFile(`${secretName}.yaml`, secretManifest);

    try {
      await this.shell`kubectl apply -f ${secretPath}`;
      this.log(
        `Created temporary secret '${secretName}' in namespace '${namespace}'`,
      );

      // Use --overrides JSON with envFrom.secretRef — no env values in the command line
      const overrides = JSON.stringify({
        spec: {
          containers: [
            {
              name: podName,
              image,
              command: ["sh", "-c", fullCommand],
              envFrom: [{ secretRef: { name: secretName } }],
            },
          ],
        },
      });

      // Build args array directly to avoid shell template escaping issues with JSON
      const args = [
        "run",
        podName,
        "--namespace",
        namespace,
        "--image",
        image,
        "--image-pull-policy",
        pullPolicy,
        "--restart=Never",
        "--rm",
        "-i",
        "--pod-running-timeout=10m",
        `--overrides=${overrides}`,
      ];

      // Use execFileSync to avoid shell escaping — passes args directly to kubectl
      this.log(
        `$ kubectl run ${podName} --namespace ${namespace} --image ${image} --image-pull-policy ${pullPolicy} --restart=Never --rm -i --pod-running-timeout=10m --overrides=<secret-ref:${secretName}>`,
      );
      execFileSync("kubectl", args, {
        cwd: this.projectRoot,
        stdio: "inherit",
        env: { ...process.env, ...this.env },
      });
    } finally {
      // Always clean up the temporary secret.
      // The Role + RoleBinding are swept by namespace deletion in run().
      this.log(`Cleaning up temporary secret '${secretName}'...`);
      try {
        await this
          .shell`kubectl delete secret ${secretName} -n ${namespace} --ignore-not-found`;
      } catch {
        this.log(`Warning: Failed to clean up secret '${secretName}'`);
      }
    }
  }

  async down(): Promise<void> {
    this.log("Tearing down local Kubernetes deployment...");

    if (this.isPreviewNamespace) {
      this.log(
        `Preview namespace '${this.namespace}' — deleting workloads but ` +
          "keeping the namespace (shell holds RBAC Role, ResourceQuota, PriorityClass).",
      );
      await this.downWorkloadsOnly();
      return;
    }

    try {
      await this
        .shell`kubectl delete namespace ${this.namespace} --ignore-not-found`;
      this.log("Namespace deleted successfully.");
    } catch (err) {
      this.log("Warning: Failed to delete namespace:", err);
    }
  }

  /** Delete workloads (Deployments, Services, Secrets, ConfigMaps, PVCs) from the current namespace
   * without deleting the namespace itself. Preserves namespace-level resources (RBAC Role,
   * ResourceQuota, PriorityClass) that keep the namespace shell reusable across preview lifecycle
   * cycles.
   */
  private async downWorkloadsOnly(): Promise<void> {
    for (const kind of PREVIEW_DOWN_RESOURCE_KINDS) {
      try {
        await this
          .shell`kubectl delete ${kind} --all -n ${this.namespace} --ignore-not-found`;
      } catch (err) {
        this.log(`Warning: Failed to delete ${kind}s:`, err);
      }
    }
  }

  async status(): Promise<void> {
    this.log("Checking local Kubernetes deployment status...\n");

    try {
      // Check if namespace exists
      const nsCheck = await this
        .quietShell`kubectl get namespace ${this.namespace}`.nothrow();
      if (nsCheck.exitCode !== 0) {
        this.log(
          `Namespace '${this.namespace}' does not exist. No deployment found.`,
        );
        return;
      }

      this.log(chalk.bold("=== Pods ==="));
      const pods = await this
        .quietShell`kubectl get pods -n ${this.namespace} -o wide`;
      this.runner.logger.log(pods.stdout);

      this.log(chalk.bold("\n=== Services ==="));
      const svcs = await this
        .quietShell`kubectl get services -n ${this.namespace}`;
      this.runner.logger.log(svcs.stdout);

      this.log(chalk.bold("\n=== Deployments ==="));
      const deployments = await this
        .quietShell`kubectl get deployments -n ${this.namespace}`;
      this.runner.logger.log(deployments.stdout);

      this.log(chalk.bold("\n=== PersistentVolumeClaims ==="));
      const pvcs = await this
        .quietShell`kubectl get pvc -n ${this.namespace}`.nothrow();
      if (pvcs.exitCode === 0) {
        this.runner.logger.log(pvcs.stdout);
      } else {
        this.runner.logger.log("  No PVCs found.");
      }
    } catch (err) {
      this.log("Error fetching status:", err);
    }
  }

  private async checkK8sAvailable(): Promise<void> {
    this.log("Checking Kubernetes cluster availability...");
    try {
      await this.quietShell`kubectl cluster-info`;
      this.log("Kubernetes cluster is available.");
    } catch {
      throw new Error(
        "Kubernetes cluster is not available. " +
          "Make sure Docker Desktop has Kubernetes enabled, or that your kubectl is configured.",
      );
    }
  }

  private async ensureNamespace(): Promise<void> {
    this.log(`Ensuring namespace '${this.namespace}' exists...`);
    const nsYaml = yamlNamespace(this.namespace);
    const tmpPath = this.writeTempFile("namespace.yaml", nsYaml);
    await this.shell`kubectl apply -f ${tmpPath}`;
  }

  private collectServices(targets: string[] = []): ServiceManifest[] {
    const project = this.runner.config.project;
    const services: ServiceManifest[] = [];
    const targetSet = new Set(targets);

    /** `dev-only` services are never deployed to the production namespace (nopo-prod) or preview namespaces
     * (nopo-prev), even when the caller names them explicitly — their k8s manifests aren't
     * production-ready yet (observability services need ConfigMap-mounted provisioning; tracked in
     * apps/observability/README.md). In any other namespace they go out normally so `nopo up grafana` in a
     */
    const isProdOrPreview =
      this.namespace === "nopo-prod" || this.isPreviewNamespace;

    for (const [id, service] of Object.entries(project.services.entries)) {
      // Skip packages (no runtime)
      if (!service.runtimes) continue;
      // If targets specified, only include matching services
      if (targetSet.size > 0 && !targetSet.has(id)) continue;
      if (isProdOrPreview && service.tags.includes("dev-only")) continue;
      /** Preview deploys the product plane ONLY — services that opt in with a runtime.preview overlay. The
       * runner expands explicit targets with each service's DEFAULT runtime deps (db, litellm, otel, …)
       * before the plugin runs, so those platform services arrive in `targetSet`; filter them out by overlay
       * opt-in so the preview doesn't clone the whole nopo-prod stack (and blow the namespace
       */
      if (this.isPreviewNamespace && !optsIntoPreview(service)) continue;
      /** CLI-only control-plane services (cloudflare-tf, stripe-tf): no build
       * AND no image, so there is nothing to run as a workload. Skip them so
       * the deploy doesn't synthesize a Deployment that pulls a nonexistent
       * `nopo-<id>` image (ImagePullBackOff). See isDeployableWorkload.
       */
      if (!isDeployableWorkload(service)) continue;

      const isInfra = !service.build;
      const isDev = this.runner.environment.env.DOCKER_TARGET === "development";
      const image = this.resolveImage(id, service, isInfra);
      const overlay = resolveRuntime(service.runtimes, this.ctx.runtime);
      /** In dev mode, app services run their dev command on port 80 (baked into Docker CMD), not the
       * production port from nopo.yml. TODO(deploy-gap): see svc-env.ts — this dev-collapse is a known hack
       * that should disappear once every dev CMD honours `${PORT}` and healthchecks are templated against
       * the runtime port.
       */
      const port = isDev && !isInfra ? 80 : overlay.port;
      const env = this.resolveEnv(id, service, project, image);
      // Set PORT env so containers bind to the correct port
      if (!isInfra) {
        env.PORT = String(port);
      }

      services.push({
        id,
        service,
        image,
        port,
        env,
        secrets: service.secrets,
        isInfra,
        overlay,
      });
    }

    return services;
  }

  private resolveImage(
    id: string,
    service: NormalizedService,
    isInfra: boolean,
  ): string {
    if (isInfra && service.image) {
      return service.image;
    }

    // Built image: use docker plugin convention
    const env = this.runner.environment.env;
    const tag = `${env.DOCKER_IMAGE}-${id}:${env.DOCKER_VERSION}`;

    // If a registry is configured, use it (CI uses in-cluster registry, local can too)
    if (env.DOCKER_REGISTRY) {
      return `${env.DOCKER_REGISTRY}/${tag}`;
    }

    return tag;
  }

  private resolveEnv(
    id: string,
    service: NormalizedService,
    project: NormalizedProjectConfig,
    image: string,
  ): Record<string, string> {
    const env: Record<string, string> = {
      ...baseServiceEnv(id, image, this.runner.environment.env),
    };

    /** Cross-service URL primitives. Every entry in this service's deps gets `SVC_<DEP>_HOST` and
     * `SVC_<DEP>_PORT` in env, so the service's own `env:` block can declare e.g. `WEB_PUBLIC_URL:
     * http://${SVC_WEB_HOST}:${SVC_WEB_PORT}` without the plugin needing to know what an nginx is.
     */
    const svcEnv = svcDepEnvVars(
      service.runtimeDeps,
      this.serviceRegistry(project),
    );
    Object.assign(env, svcEnv);

    /** Service-level env from nopo.yml — values may reference any var already in scope (process env,
     * SERVICE_NAME, NODE_ENV, SVC_*_HOST, SVC_*_PORT, …). Pre-expanding here means k8s containers see the
     * final string; without expansion `${SVC_WEB_HOST}` would reach the pod literally because k8s does no
     * shell substitution on env values.
     */
    if (service.env) {
      const scope = { ...this.runner.environment.env, ...env };
      Object.assign(env, expandEnvValues(service.env, scope));
    }

    /** Layer `runtime.<name>.env:` on top of service-level env so named
     * runtime overlays (e.g. preview BETTER_AUTH_URL) win — matches the
     * docker-compose plugin. Without this, only secret overlays reached
     * pods; plain env overlays were silently dropped on the k8s path.
     */
    if (service.runtimes) {
      const overlay = resolveRuntime(service.runtimes, this.ctx.runtime);
      if (overlay.envs.env) {
        const scope = { ...this.runner.environment.env, ...env };
        Object.assign(env, expandEnvValues(overlay.envs.env, scope));
      }
    }

    /** DB-specific env vars (static/non-secret only). POSTGRES_PASSWORD is intentionally omitted here — it
     * comes from the `db-secrets` k8s Secret via envFrom.secretRef (declared in apps/db/nopo.yml under
     * `secrets:`). Hardcoding it here would mean the Deployment always boots with "nopo" regardless of
     * what's in the Secret, causing auth failures after any credential rotation.
     */
    if (id === "db" || service.image?.startsWith("postgres")) {
      env.POSTGRES_USER = "nopo";
      env.POSTGRES_DB = "nopo";
    }

    return env;
  }

  /** Cache of the project-wide ServiceRegistry. The registry is purely a
   * function of the project + runtime + the dev-port collapse, so
   * building it once per `K8sDeployer` instance avoids re-walking the
   * processes graph for every service we deploy.
   */
  private _serviceRegistry?: ServiceRegistry;
  private serviceRegistry(project: NormalizedProjectConfig): ServiceRegistry {
    this._serviceRegistry ??= projectServiceRegistry(
      project,
      this.ctx.runtime,
      {
        devCollapseToPort80:
          this.runner.environment.env.DOCKER_TARGET === "development",
      },
    );
    return this._serviceRegistry;
  }

  private createManifestDir(): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-k8s-"));
    return tmpDir;
  }

  private generateManifests(
    services: ServiceManifest[],
    outputDir: string,
  ): void {
    this.log("Generating Kubernetes manifests...");

    /** ConfigMaps must land in the cluster BEFORE the Deployments that mount them. `kubectl apply -f
     * manifests.yaml` applies resources in file order; if a Deployment's pod-template hash changed (e.g.
     * via the `checksum/config` annotation), the new pod is scheduled immediately on the next reconcile
     * and runs its startup with whatever ConfigMap content the kubelet has at that moment.
     */
    const configMapManifests: string[] = [];
    const allManifests: string[] = [];

    for (const svc of services) {
      const isDb =
        svc.id === "db" || !!svc.service.image?.startsWith("postgres");
      const isNginx =
        svc.id === "nginx" || !!svc.service.image?.startsWith("nginx");
      const isDev = this.runner.environment.env.DOCKER_TARGET === "development";

      /** PVC for database. A sibling `pvc.yaml` next to the service's nopo.yml is the escape hatch for "I
       * need storage config beyond the default" (storage class, size, CSI params, access mode, …).
       */
      if (isDb) {
        const customPvcPath = path.join(svc.service.paths.root, "pvc.yaml");
        if (fs.existsSync(customPvcPath)) {
          allManifests.push(this.resolveCustomPvc(svc, customPvcPath));
        } else {
          allManifests.push(yamlPvc(svc.id, this.namespace));
        }
      }

      /** Manifests for declared `runtime.volumes:` entries. Each volume on the resolved runtime emits either
       * a PVC (size mode) or a ConfigMap (source mode) named `${serviceId}-${volumeName}`. Compute the
       * unique set per-service so multi-process services don't emit duplicate manifests when every process
       * inherits the same block-level volumes list.
       */
      const declaredVolumes = declaredVolumesForService(svc);
      for (const v of declaredVolumes) {
        if (v.source !== undefined) {
          /** Host-mount mode → ConfigMap. Files live next to the service's nopo.yml; resolve relative to
           * `svc.service.paths.root` (same anchor used by the `pvc.yaml` escape hatch). ConfigMap is bucketed
           * with the other CMs below so it applies before the Deployment that mounts it.
           */
          configMapManifests.push(
            yamlSourceConfigMap(
              this.namespace,
              svc.id,
              v.name,
              path.resolve(svc.service.paths.root, v.source),
            ),
          );
        } else {
          // Size mode → PVC. v.size is guaranteed defined by the XOR
          // validator on VolumeSchema (exactly one of size/source set).
          allManifests.push(
            yamlDeclaredPvc(svc.id, v.name, v.size!, this.namespace),
          );
        }
      }

      /** Secret: the Deployment references `${svc.id}-secrets` when the service has any runtime secrets
       * declared. The Secret's stringData is built + applied separately (in-memory, piped via stdin) so that
       * decrypted plaintext never lands in the manifest directory. See `buildSecretManifests` /
       * `applySecretManifestsViaStdin`.
       */
      const secretName =
        secretKeysForRuntime(svc.overlay).length > 0
          ? `${svc.id}-secrets`
          : null;

      /** Deployments — one per process. Single-process services land in
       * `processes.default` so they emit a single Deployment named `${svc.id}`
       * (back-compat). Multi-process services emit one Deployment per process;
       * the `default` process keeps the unsuffixed name.
       */
      const configMounts = resolveConfigMounts(
        svc.service,
        svc.id,
        this.projectRoot,
      );
      const processes = resolveProcesses(svc.service.runtime, svc.overlay);
      const nginxTemplatePath = isNginx
        ? (() => {
            const td = path.join(svc.service.paths.root, "templates");
            return fs.existsSync(td) ? td : null;
          })()
        : null;

      /** SHA-256 of every file that will land in a ConfigMap attached to this service. Same value across
       * every process of a multi-process service — all processes mount the same CMs. Emitted as a
       * `checksum/config` annotation on the pod template so a CM-only change triggers a Deployment rollout.
       * See DeploymentOptions.
       */
      const sourceVolumes = declaredVolumes
        .filter((v) => v.source !== undefined)
        .map((v) => ({
          name: v.name,
          sourceDir: path.resolve(svc.service.paths.root, v.source!),
        }));
      const configChecksum = computeConfigChecksum({
        nginxTemplatePath,
        configMounts,
        sourceVolumes,
      });

      for (const proc of Object.values(processes)) {
        /** Per-process port: the port-bearing process uses its own port;
         * in dev mode for app services it's overridden to 80 (matches
         * the legacy back-compat behavior). Worker processes have
         * `proc.port === undefined` and emit no containerPort / Service.
         */
        let procPort = proc.port;
        if (procPort !== undefined && isDev && !svc.isInfra) {
          procPort = 80;
        }

        allManifests.push(
          yamlDeployment(svc, this.namespace, {
            isDb,
            isNginx,
            isDev,
            isCI: this.isClusterInternal,
            projectRoot: this.projectRoot,
            nginxTemplatePath,
            secretName,
            configMounts,
            configChecksum,
            process: proc,
            port: procPort,
            priorityClassName: this.podPriorityClassName,
          }),
        );

        const pdb = yamlPodDisruptionBudget(
          deploymentName(svc.id, proc.name),
          this.namespace,
          Math.max(proc.minInstances, 1),
        );
        if (pdb) allManifests.push(pdb);
      }

      for (const mount of configMounts) {
        configMapManifests.push(
          yamlConfigMap(
            this.namespace,
            svc.id,
            mount.configMapName,
            mount.sourceDir,
          ),
        );
      }

      /** Services — one per port-bearing process. Any process that declares a
       * `port:` gets its own Service. The `default` process keeps the unsuffixed
       * Service name for back-compat; non-default processes get `${svc.id}-${proc.name}`.
       * Two processes with ports → two Services. Zero port-bearing processes → no Service.
       */
      const isBackend = svc.id === "backend";
      for (const proc of Object.values(processes)) {
        if (proc.port === undefined) continue;
        let svcPort = proc.port;
        if (isDev && !svc.isInfra) svcPort = 80;
        allManifests.push(
          yamlService(svc, this.namespace, {
            isNginx,
            isDb,
            isBackend,
            isCI: this.isClusterInternal,
            process: proc,
            port: svcPort,
          }),
        );
      }
    }

    /** ConfigMap for nginx templates (one per nginx service). Bucketed
     * with the rest of the ConfigMaps so it gets applied before the
     * nginx Deployment — see the comment at the top of this function.
     */
    for (const svc of services) {
      if (svc.id === "nginx" || svc.service.image?.startsWith("nginx")) {
        const templateDir = path.join(svc.service.paths.root, "templates");
        if (fs.existsSync(templateDir)) {
          configMapManifests.push(
            yamlNginxConfigMap(this.namespace, templateDir, svc.id),
          );
        }
      }
    }

    // ConfigMaps first, then everything else. kubectl apply -f processes
    // resources in file order.
    const combined = [...configMapManifests, ...allManifests].join("\n---\n");
    const manifestPath = path.join(outputDir, "manifests.yaml");
    fs.writeFileSync(manifestPath, combined, "utf-8");

    this.log(`Manifests written to ${manifestPath}`);
  }

  private async applyManifests(manifestDir: string): Promise<void> {
    this.log("Applying Kubernetes manifests...");
    await this
      .shell`kubectl apply -f ${manifestDir} --namespace ${this.namespace}`;
    this.log("Manifests applied successfully.");
  }

  /** Load a service-provided `pvc.yaml` escape-hatch manifest, validate the shape, and merge plugin-owned
   * identity fields on top of whatever the user wrote. Returns the resulting YAML string ready for
   * apply.
   */
  private resolveCustomPvc(
    svc: ServiceManifest,
    customPvcPath: string,
  ): string {
    const content = fs.readFileSync(customPvcPath, "utf8");
    return mergeCustomPvcManifest(content, customPvcPath, svc.id, (msg) =>
      this.log(msg),
    );
  }

  /** Build the per-service Secret manifests for the active runtime by decrypting every `ENC[...]` value
   * declared under `runtime.<runtime>.secrets:` in each service's nopo.yml. The age identity is loaded
   * once (lazily — only when at least one service has secrets) via the operator's
   * `NOPO_AGE_IDENTITY_COMMAND`. Returned strings are *plaintext* k8s Secret YAML — they MUST NOT be
   */
  private async buildSecretManifests(
    services: ServiceManifest[],
  ): Promise<SecretManifest[]> {
    return buildSecretManifestsForServices(
      services.map((s) => ({ id: s.id, overlay: s.overlay })),
      this.namespace,
      loadIdentity,
    );
  }

  /**
   * Apply each Secret manifest via `kubectl apply -f -` (stdin). The
   * decrypted YAML never lands on disk — kubectl reads it from stdin and
   * sends it to the cluster API server over the cluster's own TLS.
   */
  private async applySecretManifestsViaStdin(
    manifests: SecretManifest[],
  ): Promise<void> {
    if (manifests.length === 0) return;
    this.log(
      `Applying ${String(manifests.length)} Secret manifest(s) via stdin (no plaintext on disk)...`,
    );
    for (const m of manifests) {
      // Log the kubectl command line WITHOUT echoing the manifest content.
      // The manifest reaches kubectl over stdin only.
      this.log(
        `$ kubectl apply -n ${this.namespace} -f - <<<${m.secretName} (stdin)`,
      );
      const result = await this.ctx.exec(
        "kubectl",
        ["apply", "-n", this.namespace, "-f", "-"],
        {
          cwd: this.projectRoot,
          stdio: "pipe",
          input: m.yaml,
          /** We already logged a redacted form above; suppress automatic streaming so kubectl's input echo (if
           * any) can't surface the manifest body. The buffered stdout is still available via `result.stdout` and
           * we log a trimmed form below.
           */
          silent: true,
        },
      );
      /** Echo kubectl's own output (e.g. `secret/<name> configured`) so the
       * operator sees the apply confirmation. kubectl never prints the
       * manifest body itself, only metadata.
       */
      if (result.stdout.trim()) {
        this.runner.logger.log(result.stdout.trim());
      }
    }
  }

  /** `--print` mode: emit every manifest to stdout for review/diffing, with Secret values replaced by
   * `[REDACTED]`. Other manifest kinds (Deployment / Service / ConfigMap / PVC) are emitted verbatim —
   * they don't carry sensitive data.
   */
  private printManifests(services: ServiceManifest[]): void {
    // Non-secret manifests: write to a tmp dir, read them back, emit. This
    // keeps the same single source of truth as the apply path.
    const manifestDir = this.createManifestDir();
    this.generateManifests(services, manifestDir);
    const nonSecretYaml = fs.readFileSync(
      path.join(manifestDir, "manifests.yaml"),
      "utf-8",
    );

    const out: string[] = [nonSecretYaml];
    for (const svc of services) {
      const keys = secretKeysForRuntime(svc.overlay);
      if (keys.length === 0) continue;
      const redactedData: Record<string, string> = {};
      for (const k of keys) redactedData[k] = "[REDACTED]";
      out.push(
        yamlSecret(`${svc.id}-secrets`, this.namespace, redactedData, svc.id),
      );
    }
    this.ctx.io.stdout.write(out.join("\n---\n") + "\n");
  }

  private async waitForDeployments(services: ServiceManifest[]): Promise<void> {
    this.log("Waiting for deployments to be ready...");

    /** Stream live signal during the wait: one cluster-wide warning-event watcher per namespace, plus one
     * container-log follower per unique service. Started before any `rollout status` blocks, torn down in
     * the finally below.
     */
    const abort = new AbortController();
    const uniqueSvcIds = Array.from(new Set(services.map((s) => s.id)));
    const streams: Promise<unknown>[] = [
      this.streamNamespaceEvents(abort.signal),
      ...uniqueSvcIds.map((id) => this.streamServiceLogs(id, abort.signal)),
    ];

    try {
      /** Iterate every process Deployment of every service. Single-process
       * services have one process (`default`) → one rollout to wait on,
       * identical to the legacy behavior. Multi-process services wait on
       * all per-process Deployments before the deploy is green.
       */
      for (const svc of services) {
        const processes = resolveProcesses(svc.service.runtime, svc.overlay);
        for (const proc of Object.values(processes)) {
          const name = deploymentName(svc.id, proc.name);
          this.log(`  Waiting for ${name}...`);
          try {
            /** 600s (not 300s): on the constrained prod cluster a freshly built image can take several minutes to
             * pull + schedule before the pod is even Running, and that wait counts against `rollout status`. 300s
             * was failing deploys whose pods were healthy but slow to schedule (e.g. litellm pulling a rebuilt
             * image), so the bound tracks worst-case pull+boot, not just boot.
             */
            await this
              .shell`kubectl rollout status deployment/${name} -n ${this.namespace} --timeout=600s`;
            this.log(`  ${name} is ready.`);
          } catch {
            /** Stop the watchers BEFORE dumping diagnostics so their
             * line-streaming output can't interleave with the
             * post-mortem dump.
             */
            abort.abort();
            await Promise.allSettled(streams);
            await this.dumpRolloutFailureDiagnostics(name, svc.id);
            throw new Error(
              `${name} did not become ready within timeout. See diagnostics above.`,
            );
          }
        }
      }
    } finally {
      abort.abort();
      await Promise.allSettled(streams);
    }
  }

  /** Tail cluster events of `type!=Normal` in the active namespace. Each line is line-buffered and
   * prefixed with `[events]` so it interleaves sanely with the per-service log streams and the
   * rollout-status progress lines. `kubectl get events --watch` keeps a long-poll watch open against the
   * API server; we tear it down via `signal`.
   */
  private async streamNamespaceEvents(signal: AbortSignal): Promise<void> {
    await this.streamPrefixedKubectl(
      [
        "get",
        "events",
        "-n",
        this.namespace,
        "--watch",
        "--field-selector",
        "type!=Normal",
      ],
      "[events]",
      signal,
    );
  }

  /** Follow container logs for every pod matching `app=<serviceId>` — `--all-containers` covers
   * sidecars/init containers, `--prefix` tags each line with `[pod/<name>/<container>]` so multi-pod and
   * multi-container output is disambiguated. `--max-log-requests` caps the watcher's fan-out so a
   * service with many replicas can't exhaust kubectl's default 5-stream limit.
   */
  private async streamServiceLogs(
    serviceId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.streamPrefixedKubectl(
      [
        "logs",
        "-n",
        this.namespace,
        "-l",
        `app=${serviceId}`,
        "-f",
        "--all-containers=true",
        "--prefix=true",
        "--max-log-requests=20",
        "--tail=10",
      ],
      `[${serviceId}]`,
      signal,
    );
  }

  /** Run a kubectl subcommand, splitting its stdout/stderr into lines and prefixing each with `prefix`
   * before writing through `this.log`. The chunk → line split holds partial lines across chunks so a
   * mid-line buffer boundary doesn't fragment a single log entry into two prefixed half-lines. Carries
   * the same `nothrow` semantics as the diagnostic dumps — a watcher exiting non-zero (e.g.
   */
  private async streamPrefixedKubectl(
    args: string[],
    prefix: string,
    signal: AbortSignal,
  ): Promise<void> {
    const stdoutPrefixer = createLinePrefixer(prefix, (l) => this.log(l));
    const stderrPrefixer = createLinePrefixer(prefix, (l) => this.log(l));
    await this.ctx.io.spawn("kubectl", args, {
      env: this.env,
      signal,
      onChunk: (chunk, source) => {
        (source === "stdout" ? stdoutPrefixer : stderrPrefixer).feed(chunk);
      },
    });
    // Flush any tail line that didn't end in a newline. Common on
    // abort — kubectl might be mid-line when SIGTERMed.
    stdoutPrefixer.flush();
    stderrPrefixer.flush();
  }

  /** Dump everything an operator would want when a rollout times out: the Deployment's conditions, every
   * pod's state + events, recent cluster events, and the last 200 lines of logs from each container
   * (current AND previous, since a probe failure often kicks a crash loop).
   */
  private async dumpRolloutFailureDiagnostics(
    deployName: string,
    serviceId: string,
  ): Promise<void> {
    this.log(`━━━ Rollout failure diagnostics: ${deployName} ━━━`);

    this.log(`─── kubectl describe deployment/${deployName} ───`);
    await this
      .shell`kubectl describe deployment/${deployName} -n ${this.namespace}`.nothrow();

    this.log(`─── kubectl get pods -l app=${serviceId} ───`);
    await this
      .shell`kubectl get pods -n ${this.namespace} -l app=${serviceId} -o wide`.nothrow();

    this.log(`─── kubectl describe pods -l app=${serviceId} ───`);
    await this
      .shell`kubectl describe pods -n ${this.namespace} -l app=${serviceId}`.nothrow();

    /** Cluster-wide events scoped to this namespace, sorted newest-first.
     * We don't field-select on involvedObject because pod names change
     * across ReplicaSets and the deploy name doesn't match the pod
     * names; filter by type!=Normal to drop the noise instead.
     */
    this.log(`─── kubectl get events (non-Normal, sorted) ───`);
    await this
      .shell`kubectl get events -n ${this.namespace} --sort-by=.lastTimestamp --field-selector type!=Normal`.nothrow();

    /** Logs from the failing app's pods. --all-containers covers
     * sidecars / init containers; --previous catches crash-looping
     * pods whose current container has no logs yet.
     */
    this.log(`─── kubectl logs -l app=${serviceId} (current, 200 lines) ───`);
    await this
      .shell`kubectl logs -n ${this.namespace} -l app=${serviceId} --tail=200 --all-containers=true`.nothrow();

    this.log(`─── kubectl logs -l app=${serviceId} (previous, 200 lines) ───`);
    await this
      .shell`kubectl logs -n ${this.namespace} -l app=${serviceId} --tail=200 --all-containers=true --previous`.nothrow();

    this.log(`━━━ End diagnostics: ${deployName} ━━━`);
  }

  /** Run deploy lifecycle hooks for services. Reads pre_deploy/post_deploy from pluginData.terraform in
   * the service's nopo.yml. Example nopo.yml: plugins: terraform: pre_deploy: - bunx prisma migrate
   * deploy
   */
  private async runDeployHooks(
    services: ServiceManifest[],
    phase: "pre_deploy" | "post_deploy",
  ): Promise<void> {
    for (const svc of services) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- accessing passthrough plugin data
      const tfConfig = (svc.service.pluginData?.terraform ?? {}) as Record<
        string,
        unknown
      >;
      const raw = tfConfig[phase];
      const hooks: string[] = Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === "string")
        : [];

      /** Deploy hooks (kubectl exec) target the `default` process by convention.
       * These are service-level hooks declared in plugins.terraform.pre_deploy /
       * post_deploy — they run in one pod per release. If there is no `default`
       * process (unusual), we fall back to the first declared process.
       */
      const processes = resolveProcesses(svc.service.runtime, svc.overlay);
      const hookProcessName =
        "default" in processes
          ? "default"
          : (Object.keys(processes)[0] ?? "default");
      const targetDeploy = deploymentName(svc.id, hookProcessName);
      const containerName = targetDeploy;

      for (const command of hooks) {
        this.log(`[${svc.id}] ${phase}: ${command}`);

        /** Wait for the container to be ready before exec-ing.
         * After rollout, the old pod may still be terminating while
         * the new pod's container hasn't started yet.
         */
        for (let attempt = 0; attempt < 10; attempt++) {
          const ready = await this
            .quietShell`kubectl exec -n ${this.namespace} -c ${containerName} deployment/${targetDeploy} -- true`.nothrow();
          if (ready.exitCode === 0) break;
          await new Promise((r) => setTimeout(r, 3000));
        }

        try {
          await this.ctx.exec(
            "kubectl",
            [
              "exec",
              "-n",
              this.namespace,
              "-c",
              containerName,
              `deployment/${targetDeploy}`,
              "--",
              "sh",
              "-c",
              command,
            ],
            { cwd: this.projectRoot, stdio: "pipe" },
          );
          this.log(`  ${svc.id} ${phase} complete.`);
        } catch (err) {
          throw new Error(
            `Failed ${phase} for ${svc.id} (${command}): ${String(err)}`,
          );
        }
      }
    }
  }

  private printAccessInfo(services: ServiceManifest[]): void {
    this.log("\n" + chalk.bold("=== Deployment Complete ==="));
    this.log("");

    const hasNginx = services.some(
      (s) => s.id === "nginx" || s.service.image?.startsWith("nginx"),
    );
    const hasDb = services.some(
      (s) => s.id === "db" || s.service.image?.startsWith("postgres"),
    );

    if (this.isClusterInternal) {
      // Cluster-internal namespace (CI / prod): services are accessed via
      // cluster DNS, not host-mapped NodePorts. The runner lives in-cluster.
      const ns = this.namespace;
      if (hasNginx) {
        const url = `http://nginx.${ns}.svc.cluster.local`;
        this.log(chalk.green(`Application: ${url}`));
        // Export for downstream steps (e.g. smoketest)
        process.env.NOPO_PUBLIC_URL = url;
        this.log(chalk.green(`  (exported NOPO_PUBLIC_URL=${url})`));
      }
      if (hasDb) {
        this.log(
          chalk.green(
            `Database:    db.${ns}.svc.cluster.local:5432 (user: nopo, password: nopo, db: nopo)`,
          ),
        );
      }
    } else {
      // Local dev: services are accessed via NodePort on localhost
      if (hasNginx) {
        this.log(
          chalk.green(
            `Application: http://localhost:${String(NGINX_NODE_PORT)}`,
          ),
        );
      }
      if (hasDb) {
        this.log(
          chalk.green(
            `Database:    localhost:${String(DB_NODE_PORT)} (user: nopo, password: nopo, db: nopo)`,
          ),
        );
      }
    }

    this.log("");
    this.log("Useful commands:");
    this.log(`  kubectl get pods -n ${this.namespace}`);
    this.log(`  kubectl logs -n ${this.namespace} -l app=<service>`);
    this.log(`  kubectl exec -it -n ${this.namespace} deploy/<service> -- sh`);
    this.log(`  nopo status   # Check deployment status`);
    this.log(`  nopo down     # Tear down deployment`);
  }

  private writeTempFile(filename: string, content: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-k8s-"));
    const tmpPath = path.join(tmpDir, filename);
    fs.writeFileSync(tmpPath, content, "utf-8");
    return tmpPath;
  }
}

function yamlNamespace(namespace: string): string {
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
  labels:
    app.kubernetes.io/managed-by: nopo
`;
}

/** Validate + merge plugin-owned identity onto a user-supplied PVC manifest. Pure function — extracted
 * from K8sDeployer.resolveCustomPvc so it can be tested without constructing a deployer.
 */
export function mergeCustomPvcManifest(
  content: string,
  sourcePath: string,
  serviceId: string,
  log: (msg: string) => void,
): string {
  const parsed = parseAllDocuments(content);

  if (parsed.length !== 1) {
    throw new Error(
      `${sourcePath}: expected a single PersistentVolumeClaim manifest, got ${parsed.length} documents. Put additional resources elsewhere.`,
    );
  }
  const [first] = parsed;
  if (!first) {
    // Unreachable after the length check above, but narrows `first` for TS.
    throw new Error(`${sourcePath}: parseAllDocuments returned no documents.`);
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime-shaped YAML document
  const doc = first.toJSON() as {
    apiVersion?: string;
    kind?: string;
    metadata?: {
      name?: string;
      namespace?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    };
    spec?: unknown;
  };

  if (doc.kind !== "PersistentVolumeClaim") {
    throw new Error(
      `${sourcePath}: expected kind=PersistentVolumeClaim, got kind=${doc.kind ?? "(unset)"}.`,
    );
  }

  doc.metadata = doc.metadata ?? {};

  const expectedName = `${serviceId}-data`;
  if (doc.metadata.name && doc.metadata.name !== expectedName) {
    log(
      chalk.yellow(
        `${sourcePath}: metadata.name=${doc.metadata.name} ignored — plugin owns this field, forcing to ${expectedName}.`,
      ),
    );
  }
  doc.metadata.name = expectedName;

  if (doc.metadata.namespace) {
    log(
      chalk.yellow(
        `${sourcePath}: metadata.namespace=${doc.metadata.namespace} ignored — plugin injects namespace at apply time. Omit this field so the manifest works across nopo-prod, ephemeral test namespaces, and local dev.`,
      ),
    );
    delete doc.metadata.namespace;
  }

  const userLabels = { ...(doc.metadata.labels ?? {}) };
  const managedByKey = "app.kubernetes.io/managed-by";

  if (userLabels.app !== undefined && userLabels.app !== serviceId) {
    log(
      chalk.yellow(
        `${sourcePath}: metadata.labels.app=${userLabels.app} ignored — plugin owns this label, forcing to ${serviceId}.`,
      ),
    );
  }
  if (
    userLabels[managedByKey] !== undefined &&
    userLabels[managedByKey] !== "nopo"
  ) {
    log(
      chalk.yellow(
        `${sourcePath}: metadata.labels['${managedByKey}']=${userLabels[managedByKey]} ignored — plugin owns this label, forcing to 'nopo'.`,
      ),
    );
  }

  doc.metadata.labels = {
    ...userLabels,
    app: serviceId,
    [managedByKey]: "nopo",
  };

  return yamlStringify(doc);
}

function yamlPvc(serviceId: string, namespace: string): string {
  return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${serviceId}-data
  namespace: ${namespace}
  labels:
    app: ${serviceId}
    app.kubernetes.io/managed-by: nopo
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`;
}

/** Emit a PVC for a declared `runtime.volumes:` entry. PVC name is scoped by serviceId + volume name,
 * so two services declaring volume `data` never collide. Access mode is hardcoded to ReadWriteOnce —
 * the only mode every cloud + Talos CSI driver supports out of the box.
 */
export function yamlDeclaredPvc(
  serviceId: string,
  volumeName: string,
  size: string,
  namespace: string,
): string {
  return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${serviceId}-${volumeName}
  namespace: ${namespace}
  labels:
    app: ${serviceId}
    app.kubernetes.io/managed-by: nopo
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: ${size}
`;
}

/** Collect the unique set of declared `runtime.volumes:` entries for a service across all processes.
 * PVCs are service-scoped, so two processes that both inherit the same block-level volumes list must
 * NOT emit two PVCs.
 */
export function declaredVolumesForService(
  svc: ServiceManifest,
): readonly Volume[] {
  const seen = new Map<string, Volume>();
  const processes = svc.service.runtime?.processes;
  if (processes) {
    for (const proc of Object.values(processes)) {
      for (const v of proc.volumes ?? []) {
        const existing = seen.get(v.name);
        if (existing) {
          if (
            existing.mountPath !== v.mountPath ||
            existing.size !== v.size ||
            existing.source !== v.source ||
            existing.readOnly !== v.readOnly
          ) {
            throw new Error(
              `Service "${svc.id}": volume "${v.name}" declared with conflicting shape across processes. ` +
                `Move the volume to the runtime-block level so every process inherits the same definition, ` +
                `or rename one of the per-process volumes.`,
            );
          }
          continue;
        }
        seen.set(v.name, v);
      }
    }
  } else {
    for (const v of svc.overlay.volumes ?? []) {
      seen.set(v.name, v);
    }
  }
  return [...seen.values()];
}

interface ConfigMount {
  /** Project-root-relative directory containing the files to mount. */
  sourceDir: string;
  /** Absolute container path to mount the ConfigMap at (read-only). */
  target: string;
  /** ConfigMap name — derived from service id + an index for uniqueness. */
  configMapName: string;
}

export interface DeploymentOptions {
  isDb: boolean;
  isNginx: boolean;
  isDev: boolean;
  isCI: boolean;
  projectRoot: string;
  nginxTemplatePath: string | null;
  secretName: string | null;
  configMounts: ConfigMount[];
  /** The process this Deployment belongs to. For multi-process services, one Deployment is emitted per
   * process. The synthesized `default` process keeps the legacy unsuffixed Deployment name (`${svc.id}`)
   * so existing in-cluster references (nginx, ingress, cross-service callers) keep working.
   */
  process: NormalizedProcess;
  /**
   * Per-process port. `undefined` for port-less processes (workers) —
   * omits the `ports:` block on the container entirely.
   */
  port?: number;
  /** SHA-256 of the content of any ConfigMaps this Deployment mounts (nginx templates +
   * plugins.terraform.config_mounts). When set, the value is emitted as a `checksum/config` annotation
   * on the Pod template, which makes the Deployment's pod-spec-hash change every time the ConfigMap
   * content changes and triggers a rollout.
   */
  configChecksum?: string | null;
  /** PriorityClass to schedule this pod under. Set to `nopo-preview` for preview-namespace deployments so
   * they sit below the globalDefault `workload` class (value 100) and are evicted first under node
   * pressure — a preview must never starve production. Null/undefined for prod, which inherits the
   * globalDefault.
   */
  priorityClassName?: string | null;
}

/**
 * Hash the content of every file under a directory (flat, non-recursive
 * — matches the ConfigMap emitters' read shape). Returns null for a
 * missing or empty dir so callers can skip the annotation cleanly.
 */
function hashConfigDir(dir: string, hash: crypto.Hash): boolean {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
  const files = fs.readdirSync(dir).sort(); // sort for determinism
  let any = false;
  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile()) continue;
    hash.update(`${f}\0`);
    hash.update(fs.readFileSync(p));
    hash.update("\0");
    any = true;
  }
  return any;
}

/** SHA-256 of every file content that will land in a ConfigMap attached to this service. Returns null
 * when no CMs are emitted (no annotation needed). Deterministic ordering: filename-sorted within each
 * source dir; nginxTemplatePath hashed first (when present), then each configMounts entry in
 * declaration order, then each source-mode `runtime.volumes` ConfigMap (name-sorted).
 */
export function computeConfigChecksum(opts: {
  nginxTemplatePath: string | null;
  configMounts: ConfigMount[];
  sourceVolumes?: { name: string; sourceDir: string }[];
}): string | null {
  const h = crypto.createHash("sha256");
  let any = false;
  if (opts.nginxTemplatePath) {
    if (hashConfigDir(opts.nginxTemplatePath, h)) any = true;
  }
  for (const m of opts.configMounts) {
    h.update(`${m.configMapName}\0`);
    if (hashConfigDir(m.sourceDir, h)) any = true;
  }
  for (const v of [...(opts.sourceVolumes ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    h.update(`vol:${v.name}\0`);
    if (hashConfigDir(v.sourceDir, h)) any = true;
  }
  return any ? h.digest("hex") : null;
}

/** Resolve the Kubernetes Deployment name for `(serviceId, processName)`. The `default` process is
 * unsuffixed so the Deployment name matches the service id — this is the back-compat contract.
 * Existing manifests, kubectl commands, ingress rules, and cross-service DNS lookups keep working
 * unchanged for single-process services.
 */
export function deploymentName(serviceId: string, processName: string): string {
  return processName === "default" ? serviceId : `${serviceId}-${processName}`;
}

/** Tag portion of an image reference — the substring after the final `:`, ignoring a `:port` that
 * belongs to the registry host (`registry:5000/foo` has no tag). Returns "unknown" for an untagged
 * reference so the emitted env value stays a stable, non-empty string.
 */
export function imageVersionTag(image: string): string {
  const colon = image.lastIndexOf(":");
  return colon > image.lastIndexOf("/") ? image.slice(colon + 1) : "unknown";
}

/** Seconds a port-bearing container sleeps in `preStop` when nothing declares `pre_stop_delay`. */
const DEFAULT_PRE_STOP_DELAY = 5;
/** `pre_stop_delay: 0` — emit no `preStop` hook at all. */
const DISABLED_PRE_STOP_DELAY = 0;
/** Explicit pod-level termination grace. k8s defaults to the same value; emitting it keeps the drain
 * budget visible next to the `preStop` sleep that consumes part of it.
 */
const TERMINATION_GRACE_SECONDS = 30;

/** Effective `pre_stop_delay` for one process: the process-level declaration wins, then the runtime
 * block's, then the built-in default. Only called for port-bearing processes.
 */
function preStopDelaySeconds(
  overlay: ResolvedRuntime,
  processName: string,
): number {
  const perProcess = overlay.processes?.[processName]?.pre_stop_delay;
  return perProcess ?? overlay.preStopDelay ?? DEFAULT_PRE_STOP_DELAY;
}

/** Deploy-identity env injected into every pod. `SERVICE_VERSION` is the IMAGE TAG, never the commit:
 * a per-commit value rewrites every Deployment's pod template on every deploy, which recreates `db`
 * (Recreate strategy on an RWO PVC) and drops Postgres for the length of the PVC handoff.
 */
export function baseServiceEnv(
  id: string,
  image: string,
  processEnv: { NODE_ENV: string; DOCKER_TARGET: string },
): Record<string, string> {
  return {
    SERVICE_NAME: id,
    NODE_ENV: processEnv.NODE_ENV,
    DOCKER_TARGET: processEnv.DOCKER_TARGET,
    SERVICE_VERSION: imageVersionTag(image),
  };
}

// primaryProcessName removed — pre_command/post_command are now process-level.
// Each process declares its own hooks; no "primary" anchor needed.

/**
 * Synthesize a `NormalizedProcess` from a `ResolvedRuntime`. Used when
 * `service.runtime.processes` is absent (legacy flat-runtime services) so
 * the deployer always has a process map to iterate.
 */
function synthesizeDefaultProcess(
  overlay: ResolvedRuntime,
  /** `extra_ports` is structural (not per-env), so it isn't carried on the resolved overlay — thread it
   * from the normalized runtime block. Without this a flat service's extra ports (e.g. jaeger's
   * 4317/4318 OTLP) silently vanish in the deploy path, since flat services re-synthesize their
   * `default` process from the overlay.
   */
  extraPorts?: number[],
): NormalizedProcess {
  return {
    name: "default",
    command: overlay.command,
    /** pre/post hooks and declared volumes MUST ride through the re-synthesis. */
    preCommand: overlay.preCommand,
    postCommand: overlay.postCommand,
    volumes: overlay.volumes,
    cpu: overlay.cpu,
    memory: overlay.memory,
    port: overlay.port,
    extraPorts,
    minInstances: overlay.replicas,
    maxInstances: overlay.replicas,
    env: overlay.envs.env,
    deps: overlay.deps,
    healthcheck: overlay.healthcheck,
  };
}

/** Return the per-process map for a service. Falls back to synthesizing a
 * single `default` process from the runtime overlay when `processes` is
 * absent — ensures the deployer can always iterate without a back-compat
 * branch per call-site.
 */
export function resolveProcesses(
  runtime: NormalizedService["runtime"],
  overlay: ResolvedRuntime,
): Record<string, NormalizedProcess> {
  if (runtime?.processes && Object.keys(runtime.processes).length > 0) {
    const keys = Object.keys(runtime.processes);
    /** A lone `default` process is one `normalizeRuntime` SYNTHESIZED for a flat (no `processes:`) service
     * — and it bakes in the legacy DEFAULT-block cpu/memory/replicas, ignoring any named-runtime override.
     * Re-synthesize it from the RESOLVED `overlay` so the active runtime's scalars actually apply:
     * otherwise a flat service's prod resource override (e.g.
     */
    if (keys.length === 1 && keys[0] === "default") {
      return { default: synthesizeDefaultProcess(overlay, runtime.extraPorts) };
    }
    /** Explicit multi-process services are normalized from the DEFAULT block only
     * (`service.runtime.processes`).
     */
    const out: Record<string, NormalizedProcess> = {};
    for (const [name, base] of Object.entries(runtime.processes)) {
      const pOverlay = overlay.processes?.[name];
      const replicas = pOverlay?.replicas;
      out[name] = {
        ...base,
        ...(pOverlay?.cpu !== undefined ? { cpu: pOverlay.cpu } : {}),
        ...(pOverlay?.memory !== undefined ? { memory: pOverlay.memory } : {}),
        ...(replicas !== undefined
          ? { minInstances: replicas, maxInstances: replicas }
          : {}),
        env: {
          ...(base.env ?? {}),
          ...overlay.envs.env,
          ...(pOverlay?.env ?? {}),
        },
      };
    }
    return out;
  }
  return { default: synthesizeDefaultProcess(overlay, runtime?.extraPorts) };
}

/** Read `plugins.terraform.config_mounts` from a service's nopo.yml and
 * return a validated list. Each entry declares a flat source directory
 * (no recursion — one ConfigMap per listed mount) and the absolute
 * container path to mount it at.
 */
function resolveConfigMounts(
  service: NormalizedService,
  serviceId: string,
  projectRoot: string,
): ConfigMount[] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- passthrough plugin data
  const tf = (service.pluginData?.terraform ?? {}) as Record<string, unknown>;
  const raw = tf.config_mounts;
  if (!Array.isArray(raw)) return [];

  const mounts: ConfigMount[] = [];
  raw.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") return;
    const source =
      "source" in entry && typeof entry.source === "string"
        ? entry.source
        : null;
    const target =
      "target" in entry && typeof entry.target === "string"
        ? entry.target
        : null;
    if (!source || !target) return;
    const resolved = path.isAbsolute(source)
      ? source
      : path.resolve(projectRoot, source);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return;
    }
    mounts.push({
      sourceDir: resolved,
      target,
      configMapName: `${serviceId}-cfg-${idx}`,
    });
  });
  return mounts;
}

/** Render a k8s `readinessProbe` block (12-space indent — sits under `containers[0]:`) from the unified
 * nopo `Healthcheck` shape. Returns an empty string when the input is undefined so the caller can
 * string- concatenate it unconditionally and preserve back-compat YAML for services that never declare
 * a healthcheck. Two variants: - `type: exec` → `exec.command[]`.
 */
function renderReadinessProbe(
  hc: Healthcheck | undefined,
  ctx: { serviceId: string; processPort: number | undefined },
): string {
  if (!hc) return "";
  const periodSeconds = String(healthcheckDurationToSeconds(hc.interval));
  const timeoutSeconds = String(healthcheckDurationToSeconds(hc.timeout));
  const initialDelaySeconds = String(healthcheckDurationToSeconds(hc.delay));
  return `          readinessProbe:
${renderProbeTarget(hc, ctx)}            initialDelaySeconds: ${initialDelaySeconds}
            periodSeconds: ${periodSeconds}
            timeoutSeconds: ${timeoutSeconds}
            failureThreshold: ${String(hc.retries)}
`;
}

/** The `exec:` / `httpGet:` half of a probe block (12-space indent), shared by the readiness and
 * startup probes so both always point at the same target.
 */
function renderProbeTarget(
  hc: Healthcheck,
  ctx: { serviceId: string; processPort: number | undefined },
): string {
  if (hc.type === "exec") {
    /** YAML quoting: each exec command part is rendered as a quoted scalar so
     * spaces and shell metacharacters survive YAML round-trip unchanged.
     * `curl -f http://...` lives in argv[2..] as a single token — never
     * shell-split — so escaping double quotes in each part is sufficient.
     */
    const cmdLines = hc.exec
      .map((part) => `              - "${part.replace(/"/g, '\\"')}"`)
      .join("\n");
    return `            exec:
              command:
${cmdLines}
`;
  }

  /** hc.type === "http". Resolve the effective port: healthcheck.port wins,
   * otherwise fall back to the process port. The schema can't enforce the
   * "one of them must be set" rule because the fallback lives outside the
   * healthcheck object, so error here with a service-tagged message.
   */
  const port = hc.port ?? ctx.processPort;
  if (port === undefined) {
    throw new Error(
      `Service "${ctx.serviceId}": runtime.<env>.healthcheck declares type: http with no \`port:\` ` +
        `and the runtime block has no \`port:\` either. Set one of them — usually the runtime port is enough.`,
    );
  }
  return `            httpGet:
              path: ${hc.path}
              port: ${String(port)}
`;
}

export function yamlDeployment(
  svc: ServiceManifest,
  namespace: string,
  opts: DeploymentOptions,
): string {
  const { id, image } = svc;
  const proc = opts.process;
  const deployName = deploymentName(id, proc.name);

  // Per-process env: service-level env merged with process-level env
  // (process keys win, matching the normalizer's inheritance rule).
  const mergedEnv: Record<string, string> = { ...svc.env, ...(proc.env ?? {}) };

  /** Per-process port: if this process exposes a port, set PORT to it.
   * Port-less processes (workers) keep whatever PORT the service-level
   * resolveEnv injected — harmless since they don't bind it.
   */
  if (opts.port !== undefined) {
    mergedEnv.PORT = String(opts.port);
  }

  /** In-cluster TLS for Bun runtimes that talk to the k8s API. Background: af-api's worker uses
   * @kubernetes/client-node, which calls `loadFromCluster()`, reads /var/run/secrets/kubernetes.io/
   * serviceaccount/ca.crt, and attaches an `https.Agent({ ca })` to the request context.
   */
  mergedEnv.NODE_EXTRA_CA_CERTS =
    "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

  // Environment variables — emitted as plain `value:` entries.
  const envLines = Object.entries(mergedEnv)
    .map(
      ([key, value]) =>
        `            - name: ${key}\n              value: "${escapeYamlValue(value)}"`,
    )
    .join("\n");

  /** Per-Pod NOPO_NAMESPACE via downward API. Production blocker: KubernetesProvider in af-api falls back
   * to the literal "default" namespace when NOPO_NAMESPACE is unset, so it tries to manage agent pods in
   * `default` instead of the deploy namespace (e.g. `nopo-prod`) and gets a 403 from the API server.
   */
  const downwardEnvLines = `            - name: NOPO_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace`;

  /** Resource requests — per-process. Single-process services land in
   * `processes.default` via synthesis, so this produces identical YAML to
   * the legacy path for back-compat services.
   */
  const cpu = proc.cpu;
  const memory = proc.memory;

  /** Replicas — per-process scaling. Floor at 1 so services that don't
   * declare min_instances (schema default is 0 / normalizer synthesizes 1)
   * still get a single replica — matches the legacy hardcoded `replicas: 1`.
   */
  const replicas = Math.max(proc.minInstances, 1);

  // Volume mounts
  const volumeMounts: string[] = [];
  const volumes: string[] = [];

  // Database data volume — service-level concern (PVC is per-service).
  if (opts.isDb) {
    volumeMounts.push(`            - name: data
              mountPath: /var/lib/postgresql/data
              subPath: pgdata`);
    volumes.push(`        - name: data
          persistentVolumeClaim:
            claimName: ${id}-data`);
  }

  // Nginx config volume
  if (opts.isNginx && opts.nginxTemplatePath) {
    volumeMounts.push(`            - name: ${id}-templates
              mountPath: /etc/nginx/templates
              readOnly: true`);
    volumes.push(`        - name: ${id}-templates
          configMap:
            name: ${id}-templates`);
  }

  // Declared config_mounts (one ConfigMap + volume per mount).
  opts.configMounts.forEach((mount, idx) => {
    const volName = `${id}-cfg-${idx}`;
    volumeMounts.push(`            - name: ${volName}
              mountPath: ${mount.target}
              readOnly: true`);
    volumes.push(`        - name: ${volName}
          configMap:
            name: ${mount.configMapName}`);
  });

  /** Declared `runtime.volumes:` entries — process-level. Each entry mounts the corresponding
   * service-scoped backing resource at the declared `mountPath`. Two modes: - size mode (PVC): pod
   * volume references `persistentVolumeClaim`. - source mode (ConfigMap): pod volume references
   * `configMap` with `defaultMode: 0755` so shell scripts under e.g.
   */
  for (const v of proc.volumes ?? []) {
    const roLine = v.readOnly ? `\n              readOnly: true` : "";
    volumeMounts.push(`            - name: ${v.name}
              mountPath: ${v.mountPath}${roLine}`);
    if (v.source !== undefined) {
      /** defaultMode is the file permission mode for the projected files. 0o755 (decimal 493) makes shell
       * scripts executable — matches what postgres' init dir expects for `.sh` files under
       * `/docker-entrypoint-initdb.d/`. We emit the decimal value to dodge YAML 1.2's ambiguous octal
       * handling (yaml.parse("0755") → 755). k8s accepts both forms; readers parse the int and apply it as a
       */
      volumes.push(`        - name: ${v.name}
          configMap:
            name: ${id}-${v.name}
            defaultMode: 493`);
    } else {
      volumes.push(`        - name: ${v.name}
          persistentVolumeClaim:
            claimName: ${id}-${v.name}`);
    }
  }

  /** Source mounting disabled for k8s — host macOS node_modules have
   * platform-specific binaries that don't work in Linux containers.
   * Pods use the code built into the Docker image instead.
   */

  const volumeMountsBlock =
    volumeMounts.length > 0
      ? `          volumeMounts:\n${volumeMounts.join("\n")}\n`
      : "";

  const volumesBlock =
    volumes.length > 0 ? `      volumes:\n${volumes.join("\n")}\n` : "";

  const envFromBlock = opts.secretName
    ? `          envFrom:
            - secretRef:
                name: ${opts.secretName}
                optional: true
`
    : "";

  const imagePullPolicy =
    image.includes("/") || svc.isInfra ? "IfNotPresent" : "Never";

  /** Container port block — only emitted for processes that expose a port.
   * Worker pods have no port, so `ports:` is omitted entirely (matches k8s
   * convention; selectors don't depend on container ports).
   */
  const containerPortsBlock =
    opts.port !== undefined
      ? `          ports:
            - containerPort: ${String(opts.port)}
`
      : "";

  /** `pre_command` runs in an initContainer using the same image + env so the main container is
   * guaranteed to start only after the hook has succeeded. Pre-command is now process-level — only
   * emitted for processes that declare it. A worker process does NOT inherit the web process's migration
   * command.
   */
  const preCmd = proc.preCommand?.trim();
  const initContainersBlock = preCmd
    ? `      initContainers:
        - name: ${id}-pre
          image: ${image}
          imagePullPolicy: ${imagePullPolicy}
          command: ["sh", "-c", "${preCmd.replace(/"/g, '\\"')}"]
          env:
${envLines}
${downwardEnvLines}
${envFromBlock}          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
${volumeMountsBlock}`
    : "";

  /** `post_command` runs as a `lifecycle.postStart.exec` hook on the main container. kubelet fires it
   * once the container starts and (per the k8s docs) blocks "Running" until the hook returns — which is
   * exactly the semantics needed for one-shot post-boot bootstrap scripts (e.g. seeding anonymous
   * permission grants on a freshly-booted SonarQube). The hook is wrapped in `sh -c` so authors can
   */
  const postCmd = proc.postCommand?.trim();
  const postStartHook = postCmd
    ? `            postStart:
              exec:
                command:
                  - sh
                  - -c
                  - |-
${postCmd
  .split("\n")
  .map((line) => `                    ${line}`)
  .join("\n")}
`
    : "";

  /** `preStop` holds the container open while kubelet's pod deletion and the Endpoints controller's
   * removal race — without it nginx keeps routing to a process that already exited. Port-less
   * processes are not routed to, so they get no hook. See {@link preStopDelaySeconds}.
   */
  const preStopDelay =
    opts.port !== undefined
      ? preStopDelaySeconds(svc.overlay, proc.name)
      : DISABLED_PRE_STOP_DELAY;
  const preStopHook =
    preStopDelay > 0
      ? `            preStop:
              exec:
                command: ["sh", "-c", "sleep ${String(preStopDelay)}"]
`
      : "";

  // One `lifecycle:` key carries both hooks — two keys is invalid.
  const lifecycleBlock =
    postStartHook || preStopHook
      ? `          lifecycle:\n${postStartHook}${preStopHook}`
      : "";

  /** Probes only make sense on a port-bearing process: a port-less worker has no Service to gate
   * routing on. Both probes come from the same declaration, so they appear and disappear together.
   */
  const probeCtx = { serviceId: id, processPort: opts.port };
  const probeBlocks =
    opts.port !== undefined
      ? renderReadinessProbe(proc.healthcheck, probeCtx)
      : "";

  /** Pod template labels: - `app: ${deployName}` so per-process Deployments don't collide on selectors
   * (default proc keeps `app: ${id}` since deployName === id; non-default processes get `app:
   * ${id}-${proc}`). - `nopo.process: ${proc.name}` for observability filtering (`kubectl get pods -l
   * nopo.process=worker`).
   */
  const podLabels = `        app: ${deployName}
        nopo.process: ${proc.name}`;
  /** Deployment selector: `app: ${deployName}` only. MUST NOT include nopo.process — k8s rejects any
   * change to spec.selector on a live Deployment ("field is immutable"). For default-process Deployments
   * (deployName === id), this matches the legacy selector exactly, so existing rolled-out Deployments
   * apply cleanly.
   */
  const selectorLabels = `      app: ${deployName}`;

  // Container name: the deployment name (service id for default, suffixed for
  // non-default) so `kubectl logs` / `kubectl exec -c` is unambiguous.
  const containerName = deployName;

  /** Per-process ServiceAccount binding. Emitted only when the process declares
   * `kubernetes.serviceAccountName` in nopo.yml — otherwise the key is omitted entirely and k8s falls
   * back to the namespace's `default` SA (legacy behavior, every other Deployment). The af-api worker
   * process needs `af-runner` here so its RBAC covers pods/create + pods/delete (the runtime spawn path
   */
  const sa = proc.kubernetes?.serviceAccountName;
  const serviceAccountBlock = sa ? `      serviceAccountName: ${sa}\n` : "";

  /** Preview pods schedule under the `nopo-preview` PriorityClass (value 10,
   * below the globalDefault `workload` at 100) so they are evicted before
   * production workloads under node pressure. Omitted for prod, which inherits
   * the globalDefault.
   */
  const priorityClassBlock = opts.priorityClassName
    ? `      priorityClassName: ${opts.priorityClassName}\n`
    : "";

  /** Spread multi-replica Deployments across nodes so one node loss cannot take every replica.
   * PREFERRED, never required — on a 4-node cluster a required rule leaves the 5th replica Pending
   * forever, and a node drain would have nowhere to reschedule to.
   */
  const affinityBlock =
    replicas >= MULTI_REPLICA_THRESHOLD
      ? `      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  matchLabels:
                    app: ${deployName}
`
      : "";

  /** Rollout strategy. K8s default is RollingUpdate, which is a deadlock trap for services that mount a
   * `ReadWriteOnce` PersistentVolumeClaim (the db). The contract is "new pod becomes Ready before old
   * terminates", but the new pod can never become Ready because the old pod still holds the RWO PVC —
   * `MultiAttachError` blocks the new pod's volume attach.
   */
  const hasRwoVolumes =
    opts.isDb || (proc.volumes ?? []).some((v) => v.source === undefined);
  const strategyBlock =
    hasRwoVolumes || opts.priorityClassName === "nopo-preview"
      ? `  strategy:
    type: Recreate
`
      : "";

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${deployName}
  namespace: ${namespace}
  labels:
    app: ${id}
    app.kubernetes.io/managed-by: nopo
spec:
  replicas: ${String(replicas)}
${strategyBlock}  selector:
    matchLabels:
${selectorLabels}
  template:
    metadata:
      labels:
${podLabels}${
    opts.configChecksum
      ? `\n      annotations:\n        checksum/config: "${opts.configChecksum}"`
      : ""
  }
    spec:
      terminationGracePeriodSeconds: ${String(TERMINATION_GRACE_SECONDS)}
${affinityBlock}${priorityClassBlock}${serviceAccountBlock}${initContainersBlock}      containers:
        - name: ${containerName}
          image: ${image}
          imagePullPolicy: ${imagePullPolicy}
${proc.command ? `          command: ["sh", "-c", "${proc.command.replace(/"/g, '\\"')}"]\n` : ""}${containerPortsBlock}          env:
${envLines}
${downwardEnvLines}
${envFromBlock}          resources:
            requests:
              cpu: "${cpu}"
              memory: "${memory}"
            limits:
              cpu: "${cpu}"
              memory: "${memory}"
${lifecycleBlock}${probeBlocks}${volumeMountsBlock}${volumesBlock}`;
}

/** Replica floor for the multi-replica rollout guards (PDB + anti-affinity). Below it a PDB is
 * harmful, not protective: `maxUnavailable: 1` over one replica leaves zero allowed disruptions, so
 * `kubectl drain` (and every Talos node upgrade) blocks forever. Spreading one replica is a no-op.
 */
const MULTI_REPLICA_THRESHOLD = 2;

/** PodDisruptionBudget for a multi-replica Deployment — a voluntary-disruption floor so a node drain
 * never takes every replica at once. Returns null below {@link MULTI_REPLICA_THRESHOLD}, so the caller
 * can skip the manifest entirely.
 */
export function yamlPodDisruptionBudget(
  deployName: string,
  namespace: string,
  replicas: number,
): string | null {
  if (replicas < MULTI_REPLICA_THRESHOLD) return null;
  return `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${deployName}
  namespace: ${namespace}
  labels:
    app: ${deployName}
    app.kubernetes.io/managed-by: nopo
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: ${deployName}
`;
}

export interface ServiceOptions {
  isNginx: boolean;
  isDb: boolean;
  isBackend: boolean;
  isCI: boolean;
  /** The port-bearing process this Service routes to. Used to derive the
   * Service name (default → unsuffixed for back-compat) and to narrow the
   * selector with `nopo.process: ${process.name}` so multi-process services
   * don't accidentally route worker pods.
   */
  process: NormalizedProcess;
  /** Effective port (may be 80 in dev mode for app services). */
  port: number;
}

export function yamlService(
  svc: ServiceManifest,
  namespace: string,
  opts: ServiceOptions,
): string {
  const { id } = svc;
  const { port } = opts;

  /** Service name follows the same back-compat rule as Deployment name:
   * the `default` process gets the unsuffixed service id so existing DNS
   * lookups (`http://${svc.id}`) keep working. Non-default processes get
   * `${svc.id}-${process.name}`.
   */
  const serviceName = deploymentName(id, opts.process.name);

  /** Selector matches the per-process pod's `app` label (the deployment
   * name). Default proc keeps `app: ${id}` for back-compat; non-default
   * processes target `app: ${id}-${proc.name}`.
   */
  const selectorBlock = `    app: ${serviceName}`;

  // Nginx gets NodePort for external access (local dev only; CI uses ClusterIP)
  if (opts.isNginx && !opts.isCI) {
    return `apiVersion: v1
kind: Service
metadata:
  name: ${serviceName}
  namespace: ${namespace}
  labels:
    app: ${id}
    app.kubernetes.io/managed-by: nopo
spec:
  type: NodePort
  selector:
${selectorBlock}
  ports:
    - port: ${String(port)}
      targetPort: ${String(port)}
      nodePort: ${String(NGINX_NODE_PORT)}
`;
  }

  // Database gets NodePort for external access (local dev only; CI uses ClusterIP)
  if (opts.isDb && !opts.isCI) {
    return `apiVersion: v1
kind: Service
metadata:
  name: ${serviceName}
  namespace: ${namespace}
  labels:
    app: ${id}
    app.kubernetes.io/managed-by: nopo
spec:
  type: NodePort
  selector:
${selectorBlock}
  ports:
    - port: ${String(port)}
      targetPort: ${String(port)}
      nodePort: ${String(DB_NODE_PORT)}
`;
  }

  // Backend needs an extra port for Vite dev server (5173)
  const extraPorts = opts.isBackend
    ? `
    - name: vite
      port: 5173
      targetPort: 5173`
    : "";

  /** Additional Service ports declared via `runtime.extra_ports` — for containers that listen on more
   * than one port (e.g. jaeger's 16686 UI plus 4317/4318 OTLP ingress). k8s routes to a numeric
   * targetPort even when the container declares no matching containerPort, so these need no change to
   * the Deployment's `ports:` block.
   */
  const declaredExtraPorts = (opts.process.extraPorts ?? [])
    .map(
      (p) => `
    - name: extra-${String(p)}
      port: ${String(p)}
      targetPort: ${String(p)}`,
    )
    .join("");

  // Default: ClusterIP for internal services
  return `apiVersion: v1
kind: Service
metadata:
  name: ${serviceName}
  namespace: ${namespace}
  labels:
    app: ${id}
    app.kubernetes.io/managed-by: nopo
spec:
  selector:
${selectorBlock}
  ports:
    - name: http
      port: ${String(port)}
      targetPort: ${String(port)}${extraPorts}${declaredExtraPorts}
`;
}

/** Generate a ConfigMap from every top-level file in `sourceDir`. File name → key, file contents →
 * value (as a YAML block scalar). Non-recursive so one mount maps cleanly to one flat ConfigMap;
 * nested config directories are expressed by declaring multiple config_mounts in the service's
 * nopo.yml, each pointing at the leaf dir.
 */
function yamlConfigMap(
  namespace: string,
  serviceId: string,
  configMapName: string,
  sourceDir: string,
): string {
  const files = fs
    .readdirSync(sourceDir)
    .filter((f) => fs.statSync(path.join(sourceDir, f)).isFile());
  const dataEntries = files.map((file) => {
    const content = fs.readFileSync(path.join(sourceDir, file), "utf-8");
    const indented = content
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `  ${file}: |\n${indented}`;
  });

  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${configMapName}
  namespace: ${namespace}
  labels:
    app: ${serviceId}
    app.kubernetes.io/managed-by: nopo
data:
${dataEntries.join("\n")}
`;
}

/** Soft size limit (in bytes) on the combined contents of a host-mount `runtime.volumes:` source
 * directory. k8s rejects ConfigMaps whose serialized data exceeds 1 MiB; the headroom under that (~100
 * KiB) absorbs the YAML overhead of `data:` keys + base64-ish indentation. Beyond ~900 KiB, switch the
 * directory contents to a real volume (PVC / hostPath / CSI mount).
 */
export const SOURCE_CONFIGMAP_SIZE_LIMIT_BYTES = 900 * 1024;

/** Generate a ConfigMap for a host-mount `runtime.volumes:` entry. Each direct-child file under
 * `sourceDir` becomes one ConfigMap key (filename → contents). Subdirectories are intentionally
 * ignored — k8s ConfigMaps are flat, and a nested layout never round-trips cleanly. Authors with
 * nested layouts must restructure or reach for `pvc.yaml`.
 */
export function yamlSourceConfigMap(
  namespace: string,
  serviceId: string,
  volumeName: string,
  sourceDir: string,
): string {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(
      `Service "${serviceId}" volume "${volumeName}": source directory "${sourceDir}" does not exist. ` +
        `Resolve the path relative to the service's nopo.yml directory, or create the directory before applying.`,
    );
  }
  if (!fs.statSync(sourceDir).isDirectory()) {
    throw new Error(
      `Service "${serviceId}" volume "${volumeName}": source "${sourceDir}" is not a directory.`,
    );
  }

  /** Direct-child files only — non-recursive (matches yamlConfigMap's
   * shape). Subdirectories are silently excluded; if every entry is a
   * subdirectory the resulting ConfigMap is empty (still valid k8s).
   */
  const entries = fs.readdirSync(sourceDir).filter((f) => {
    return fs.statSync(path.join(sourceDir, f)).isFile();
  });

  // Read all files first so we can check the size before emitting any
  // YAML — fail fast on overflow.
  let totalBytes = 0;
  const fileContents: { file: string; content: string }[] = [];
  for (const file of entries) {
    const content = fs.readFileSync(path.join(sourceDir, file), "utf-8");
    totalBytes += Buffer.byteLength(content, "utf-8");
    fileContents.push({ file, content });
  }
  if (totalBytes > SOURCE_CONFIGMAP_SIZE_LIMIT_BYTES) {
    throw new Error(
      `Service "${serviceId}" volume "${volumeName}": source directory "${sourceDir}" ` +
        `combined size ${String(totalBytes)} bytes exceeds the ConfigMap soft limit ` +
        `${String(SOURCE_CONFIGMAP_SIZE_LIMIT_BYTES)} bytes (~900KiB; k8s ConfigMap hard limit is 1MiB). ` +
        `Move the large files out of the ConfigMap path — declare a PVC-mode volume (\`size:\`) and ` +
        `populate it via init container, or use the \`pvc.yaml\` escape hatch.`,
    );
  }

  const dataEntries = fileContents.map(({ file, content }) => {
    const indented = content
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `  ${file}: |\n${indented}`;
  });

  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${serviceId}-${volumeName}
  namespace: ${namespace}
  labels:
    app: ${serviceId}
    app.kubernetes.io/managed-by: nopo
data:
${dataEntries.join("\n")}
`;
}

function yamlNginxConfigMap(
  namespace: string,
  templateDir: string,
  serviceId: string = "nginx",
): string {
  const files = fs
    .readdirSync(templateDir)
    .filter((f) => f.endsWith(".template") || f.endsWith(".conf"));
  const dataEntries: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(templateDir, file), "utf-8");
    // Indent each line of the file content for YAML block scalar
    const indented = content
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    dataEntries.push(`  ${file}: |\n${indented}`);
  }

  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${serviceId}-templates
  namespace: ${namespace}
  labels:
    app: ${serviceId}
    app.kubernetes.io/managed-by: nopo
data:
${dataEntries.join("\n")}
`;
}

function yamlSecret(
  name: string,
  namespace: string,
  data: Record<string, string>,
  appLabel?: string,
  opts: { encoding?: "stringData" | "base64" } = {},
): string {
  const encoding = opts.encoding ?? "stringData";
  /** Defense in depth: even though the only callers are internal, every key we drop into the YAML key
   * position must be a syntactically benign Secret data key. A key with a newline / colon / quote could
   * break out of `stringData:` and inject a sibling field. Validate at the emission boundary rather than
   * trusting every caller.
   */
  for (const key of Object.keys(data)) {
    assertValidSecretKey(key, name);
  }
  assertValidDnsLabel(name, "Secret name");
  assertValidDnsLabel(namespace, "namespace");
  if (appLabel !== undefined) {
    assertValidDnsLabel(appLabel, "app label");
  }

  const dataLines =
    encoding === "base64"
      ? Object.entries(data)
          .map(
            ([key, value]) =>
              `  ${key}: ${Buffer.from(value, "utf-8").toString("base64")}`,
          )
          .join("\n")
      : Object.entries(data)
          .map(([key, value]) => `  ${key}: "${escapeYamlValue(value)}"`)
          .join("\n");

  const labels = appLabel
    ? `    app: ${appLabel}\n    app.kubernetes.io/managed-by: nopo`
    : `    app.kubernetes.io/managed-by: nopo`;

  /** base64-encoded values go under `data:`, plaintext under `stringData:`. The two are equivalent at the
   * kubelet but `data:` is the only one that round-trips arbitrary bytes (newlines, control chars,
   * quotes) safely — `stringData:` quoting is fragile and a single newline in the value breaks the YAML
   * parser, which causes kubectl apply to dump the manifest body into stderr (and therefore CI logs).
   */
  const dataField = encoding === "base64" ? "data" : "stringData";

  return `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
${labels}
type: Opaque
${dataField}:
${dataLines}
`;
}

/** Namespace-scoped Role granting Secret CRUD within `namespace`.
 * Applied by runInPod immediately after namespace creation so the runner's
 * service account can create/delete the temporary env-var Secret without
 * needing cluster-wide Secret access.
 */
function yamlRole(roleName: string, namespace: string): string {
  return `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${roleName}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: nopo
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
`;
}

/**
 * Binds `roleName` in `namespace` to the runner's service account so the
 * namespace-scoped Secret CRUD granted by the Role is usable from CI pods.
 */
function yamlRoleBinding(
  roleName: string,
  namespace: string,
  sa: { name: string; namespace: string },
): string {
  return `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${roleName}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: nopo
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${roleName}
subjects:
  - kind: ServiceAccount
    name: ${sa.name}
    namespace: ${sa.namespace}
`;
}

function escapeYamlValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Kubernetes Secret data keys must match `[A-Za-z0-9._-]+`. We narrow that further to refuse a few
 * reserved-looking JS names (`__proto__`, `constructor`, `prototype`) so a malicious nopo.yml cannot
 * land a prototype-pollution surface in a downstream consumer that round-trips the secret through
 * `Object.assign({}, parsed.data)`.
 */
const SECRET_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const RESERVED_KEY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function assertValidSecretKey(key: string, contextName: string): void {
  if (RESERVED_KEY_NAMES.has(key)) {
    throw new Error(
      `Invalid secret key '${key}' for '${contextName}': key collides with a JavaScript reserved name (prototype-pollution surface).`,
    );
  }
  if (!SECRET_KEY_PATTERN.test(key)) {
    /** Don't echo the raw key into the error — newlines / control chars
     * would corrupt the CI log and a malicious key could splice a fake
     * log line. Show a hex preview of the first 16 bytes instead.
     */
    const preview = Buffer.from(key, "utf-8").slice(0, 16).toString("hex");
    throw new Error(
      `Invalid secret key for '${contextName}': key must match ${String(SECRET_KEY_PATTERN)} (hex preview of offending key: ${preview}, length: ${String(key.length)}).`,
    );
  }
}

/** DNS-1123 label: `[a-z0-9]([-a-z0-9]*[a-z0-9])?`, max 63 chars. Used for Secret names, namespaces,
 * app labels — anything that ends up as `metadata.name` / `metadata.namespace` in a manifest. We
 * reject before stringifying the manifest so a malicious service id can't introduce a newline that
 * breaks out of the YAML key position. The error message uses a hex preview to avoid splicing a fake
 */
const DNS_1123_LABEL_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function assertValidDnsLabel(value: string, kind: string): void {
  if (
    value.length === 0 ||
    value.length > 63 ||
    !DNS_1123_LABEL_PATTERN.test(value)
  ) {
    const preview = Buffer.from(value, "utf-8").slice(0, 16).toString("hex");
    throw new Error(
      `Invalid ${kind}: must be a DNS-1123 label (lowercase alphanumeric + '-', 1-63 chars). Hex preview: ${preview}, length: ${String(value.length)}.`,
    );
  }
}

/**
 * Per-service Secret manifest assembled from decrypted runtime envelopes.
 * Held in memory; never written to a file under the project root.
 */
interface SecretManifest {
  serviceId: string;
  secretName: string;
  /** Plaintext k8s Secret YAML — pipe to `kubectl apply -f -` only. */
  yaml: string;
}

/** Return the list of secret keys declared on a resolved runtime overlay.
 * Pure helper so callers don't have to remember the
 * `overlay.envs.secrets` shape and can test "does this service contribute
 * a Secret manifest?" cheaply.
 */
export function secretKeysForRuntime(overlay: ResolvedRuntime): string[] {
  return Object.keys(overlay.envs.secrets);
}

/**
 * Minimal projection a service needs to contribute a Secret manifest.
 * Decoupled from `ServiceManifest` (which carries image/env/etc) so the
 * pure decrypt logic is testable without constructing a full manifest.
 */
export interface SecretSourceService {
  id: string;
  overlay: ResolvedRuntime;
}

/** Decrypt every `ENC[...]` envelope on each service's runtime overlay and emit one in-memory Secret
 * manifest per service. Pure — takes the age identity loader as a parameter so tests can inject a
 * fixture identity without touching `NOPO_AGE_IDENTITY_COMMAND`.
 */
export async function buildSecretManifestsForServices(
  services: SecretSourceService[],
  namespace: string,
  loadIdentityFn: () => Promise<string>,
): Promise<SecretManifest[]> {
  return withProcessKeepAlive(() =>
    decryptSecretManifests(services, namespace, loadIdentityFn),
  );
}

async function decryptSecretManifests(
  services: SecretSourceService[],
  namespace: string,
  loadIdentityFn: () => Promise<string>,
): Promise<SecretManifest[]> {
  /** Validate the namespace and every service id BEFORE loading the
   * identity. We do not want to spawn the (potentially interactive)
   * identity loader just to refuse the input afterwards. The error names
   * the offending field with a hex preview — never the secret VALUE.
   */
  assertValidDnsLabel(namespace, "namespace");

  const servicesWithSecrets = services.filter(
    (s) => secretKeysForRuntime(s.overlay).length > 0,
  );
  if (servicesWithSecrets.length === 0) return [];

  /** Validate ids + keys up front (independent of identity, of decryption,
   * of side effects). A malicious PR adding a service with a hostile id
   * or key fails loudly here rather than at kubectl-apply time, so the
   * operator never ships a crafted manifest into the cluster API server.
   */
  for (const svc of servicesWithSecrets) {
    assertValidDnsLabel(svc.id, "service id");
    for (const key of Object.keys(svc.overlay.envs.secrets)) {
      assertValidSecretKey(key, `service '${svc.id}'`);
    }
  }

  /** Load the age identity exactly once — every subsequent decrypt reuses this string. `loadIdentity` may
   * spawn an interactive auth prompt (1Password biometrics, GPG passphrase, ...), so calling it per-key
   * would be insufferable. The identity is held in this single local `const`; nothing on the
   * module/global surface references it. It goes out of scope when the function returns.
   */
  const identity = await loadIdentityFn();

  const out: SecretManifest[] = [];
  for (const svc of servicesWithSecrets) {
    const ciphertexts = svc.overlay.envs.secrets;
    const stringData: Record<string, string> = {};
    for (const [key, value] of Object.entries(ciphertexts)) {
      if (!isEnvelope(value)) {
        /** Should be unreachable — RuntimeSecretsSchema rejects plaintext —
         * but a direct nopo.yml edit could in principle bypass the
         * validator chain, so we fail loudly here rather than silently
         * emitting a literal `ENC[...]`-shaped string into the cluster.
         */
        throw new Error(
          `Service '${svc.id}' secret '${key}' is not an ENC[...] envelope — refusing to apply. Run \`nopo secret set ${svc.id} ${key} <value>\` to encrypt it.`,
        );
      }
      try {
        stringData[key] = await decryptValue(value, identity);
      } catch (err) {
        /** Sanitize the inner error message before splicing it into ours: - if it accidentally embeds plaintext
         * from a sibling key already decrypted for this service, we'd be the leak channel. Drop everything
         * after the first newline (age / node:crypto errors are single-line) so a multi-line message can't
         * carry a base64 secret. - if it embeds the identity string, scrub it.
         */
        const rawMsg = err instanceof Error ? err.message : String(err);
        let safeMsg = rawMsg.split("\n")[0]!.slice(0, 200);
        if (identity.length >= 8 && safeMsg.includes(identity)) {
          safeMsg = safeMsg.split(identity).join("[identity]");
        }
        throw new Error(
          `Failed to decrypt secret '${key}' for service '${svc.id}' (runtime '${svc.overlay.name}'): ${safeMsg}. Verify NOPO_AGE_IDENTITY_COMMAND points at the right age identity, then retry.`,
        );
      }
    }

    out.push({
      serviceId: svc.id,
      secretName: `${svc.id}-secrets`,
      /** base64 (`data:`) — round-trips arbitrary bytes safely, including newlines and quotes. Avoids the
       * YAML-quoting injection surface entirely. A malicious plaintext can no longer break the manifest
       * parser (which would dump the manifest body into kubectl's stderr and therefore into CI logs).
       */
      yaml: yamlSecret(`${svc.id}-secrets`, namespace, stringData, svc.id, {
        encoding: "base64",
      }),
    });
  }
  return out;
}

/** Replace every value under a Secret manifest's `stringData:` block with `[REDACTED]`. Used by
 * `--print` mode so operators can share the output for review without leaking decrypted plaintext.
 * Implementation: parses the manifest YAML, validates kind=Secret, rewrites every `stringData[k]` to
 * the literal "[REDACTED]" string, and re-serializes.
 */
export function redactSecretManifest(yaml: string): string {
  const docs = parseAllDocuments(yaml);
  if (docs.length !== 1) {
    throw new Error(
      `redactSecretManifest: expected single document, got ${String(docs.length)}.`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime-shaped YAML document
  const doc = docs[0]!.toJSON() as {
    apiVersion?: string;
    kind?: string;
    metadata?: { name?: string; namespace?: string };
    stringData?: Record<string, string>;
    data?: Record<string, string>;
  };
  if (doc.kind !== "Secret") {
    throw new Error(
      `redactSecretManifest: expected kind=Secret, got kind=${doc.kind ?? "(unset)"}.`,
    );
  }
  if (doc.stringData) {
    for (const k of Object.keys(doc.stringData)) {
      doc.stringData[k] = "[REDACTED]";
    }
  }
  if (doc.data) {
    for (const k of Object.keys(doc.data)) {
      doc.data[k] = "[REDACTED]";
    }
  }
  return yamlStringify(doc);
}
