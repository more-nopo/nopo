import type {
  NormalizedProcess,
  NormalizedService,
  ResolvedRuntime,
} from "@more-nopo/nopo/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  baseServiceEnv,
  imageVersionTag,
  type ServiceManifest,
  yamlDeployment,
} from "./index.ts";

/** Pod env carried `GIT_COMMIT`, so every Deployment's pod-template hash changed on every commit and
 * every service rolled — including `db`, which uses `Recreate` on an RWO PVC and therefore dropped
 * Postgres for 20-40s per deploy. `SERVICE_VERSION` (the image tag) only changes when the image does.
 */

function makeProcess(o: Partial<NormalizedProcess> = {}): NormalizedProcess {
  return {
    name: "default",
    cpu: "1",
    memory: "512Mi",
    minInstances: 1,
    maxInstances: 1,
    deps: [],
    ...o,
  };
}

function makeManifest(
  id: string,
  image: string,
  env: Record<string, string>,
  proc: NormalizedProcess,
): ServiceManifest {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub: only the runtime fields the YAML emitter reads matter
  const svc = {
    id,
    name: id,
    tags: [],
    secrets: [],
    runtime: {
      processes: { [proc.name]: proc },
      cpu: proc.cpu,
      memory: proc.memory,
      port: proc.port ?? 3000,
      deps: proc.deps,
    },
  } as unknown as NormalizedService;

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal overlay stub
  const overlay = {
    name: "default",
    cpu: proc.cpu,
    memory: proc.memory,
    port: proc.port ?? 3000,
    replicas: proc.minInstances,
    deps: proc.deps,
    envs: { env, secrets: {}, effective: env },
  } as unknown as ResolvedRuntime;

  return {
    id,
    service: svc,
    image,
    port: proc.port ?? 3000,
    env,
    secrets: [],
    isInfra: false,
    overlay,
  };
}

const BUILT_IMAGE = "registry.local:5000/nopo-web:tree-9f2c1ab";

function renderWith(gitCommit: string): string {
  const proc = makeProcess({ port: 3000 });
  const env = baseServiceEnv("web", BUILT_IMAGE, {
    NODE_ENV: "production",
    DOCKER_TARGET: "production",
    GIT_COMMIT: gitCommit,
  });
  return yamlDeployment(
    makeManifest("web", BUILT_IMAGE, env, proc),
    "nopo-prod",
    {
      isDb: false,
      isNginx: false,
      isDev: false,
      isCI: false,
      projectRoot: "/proj",
      nginxTemplatePath: null,
      secretName: null,
      configMounts: [],
      process: proc,
      port: 3000,
    },
  );
}

describe("imageVersionTag", () => {
  it("reads the tag of a built image behind a registry with a port", () => {
    expect(imageVersionTag(BUILT_IMAGE)).toBe("tree-9f2c1ab");
  });

  it("reads the tag of a pinned upstream image", () => {
    expect(imageVersionTag("pgvector/pgvector:pg16")).toBe("pg16");
    expect(imageVersionTag("redis:7")).toBe("7");
  });
});

describe("pod env — SERVICE_VERSION replaces GIT_COMMIT", () => {
  it("sets SERVICE_VERSION to the image tag and emits no GIT_COMMIT", () => {
    const yaml = renderWith("9f2c1ab0000000000000000000000000000000aa");
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- yaml parse returns unknown
    const doc = parse(yaml) as {
      spec: {
        template: {
          spec: { containers: { env: { name: string; value: string }[] }[] };
        };
      };
    };
    const env = doc.spec.template.spec.containers[0]!.env;

    expect(env).toContainEqual({
      name: "SERVICE_VERSION",
      value: "tree-9f2c1ab",
    });
    expect(env.map((e) => e.name)).not.toContain("GIT_COMMIT");
  });

  it("renders byte-identical Deployment YAML across two GIT_COMMIT values", () => {
    /** The outage fix: an unchanged image must produce an unchanged pod
     * template, so `db` (Recreate + RWO PVC) is not destroyed per deploy.
     */
    const first = renderWith("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const second = renderWith("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    expect(first).toBe(second);
  });
});
