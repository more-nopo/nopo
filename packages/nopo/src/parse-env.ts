import fs from "node:fs";
import net from "node:net";
import { z } from "zod";

import { DockerTag } from "./docker-tag.ts";
import { GitInfo, type GitInfoType } from "./git-info.ts";
import type { Config } from "./lib.ts";
import { dotenv } from "./lib.ts";

const nodeEnv = z.enum(["development", "production", "test"]);
const dockerTarget = nodeEnv.or(z.enum(["base", "build"]));

type EnvironmentDiffType = {
  added: EnvironmentDiffTupleType[];
  updated: EnvironmentDiffTupleType[];
  removed: EnvironmentDiffTupleType[];
  unchanged: EnvironmentDiffTupleType[];
};
type EnvironmentDiffTupleType = [string, string | undefined];

function defaultTagFromProject(project: Config["project"]): DockerTag {
  const docker = project.pluginRefs.find((ref) => ref.name === "docker");
  const image = docker?.config?.image;
  if (typeof image === "string" && image.length > 0) {
    return new DockerTag(`${image}:local`);
  }
  return Environment.baseTag;
}

export class Environment {
  static baseTag = new DockerTag("nopo:local");
  #defaultTag: DockerTag;

  static schema = z.object({
    DOCKER_PORT: z.string(),
    DOCKER_TAG: z.string(),
    DOCKER_REGISTRY: z.string(),
    DOCKER_IMAGE: z.string(),
    DOCKER_VERSION: z.string(),
    GIT_REPO: z.string(),
    GIT_BRANCH: z.string(),
    GIT_COMMIT: z.string(),
    DOCKER_DIGEST: z.string().optional().default(""),
    DOCKER_TARGET: dockerTarget,
    NODE_ENV: nodeEnv,
  });

  static readonly baseKeys = new Set(Object.keys(Environment.schema.shape));

  envFile: string;
  processEnv: Record<string, string>;
  hasPrevEnv: boolean;
  prevEnv: Record<string, string>;
  env: z.infer<typeof Environment.schema>;
  extraEnv: Record<string, string>;
  diff: EnvironmentDiffType;

  constructor(config: Config) {
    const { envFile, processEnv } = config;
    if (!envFile) {
      throw new Error("Missing envFile");
    }

    this.envFile = envFile;
    this.processEnv = processEnv;
    this.#defaultTag = defaultTagFromProject(config.project);
    this.hasPrevEnv = fs.existsSync(this.envFile);
    this.prevEnv = this.#getPrevEnv();
    this.env = this.#getCurrEnv();
    this.extraEnv = this.#collectExtraEnv();
    this.diff = this.#diff();
  }

  #getPrevEnv(): Record<string, string> {
    return this.hasPrevEnv ? dotenv.load(this.envFile) : {};
  }

  #resolveDockerTag(): DockerTag {
    // Check if user explicitly set any docker component in processEnv
    const hasExplicitOverride =
      this.processEnv.DOCKER_TAG ||
      this.processEnv.DOCKER_IMAGE ||
      this.processEnv.DOCKER_VERSION ||
      this.processEnv.DOCKER_REGISTRY ||
      this.processEnv.DOCKER_DIGEST;

    if (this.processEnv.DOCKER_TAG) {
      return new DockerTag(this.processEnv.DOCKER_TAG);
    }

    if (hasExplicitOverride) {
      const cachedTag = this.prevEnv.DOCKER_TAG
        ? new DockerTag(this.prevEnv.DOCKER_TAG)
        : null;

      const registry =
        this.processEnv.DOCKER_REGISTRY ||
        this.prevEnv.DOCKER_REGISTRY ||
        cachedTag?.parsed.registry ||
        "";
      const image =
        this.processEnv.DOCKER_IMAGE ||
        this.prevEnv.DOCKER_IMAGE ||
        cachedTag?.parsed.image ||
        this.#defaultTag.parsed.image;
      const version =
        this.processEnv.DOCKER_VERSION ||
        this.prevEnv.DOCKER_VERSION ||
        cachedTag?.parsed.version ||
        "local";
      const digest =
        this.processEnv.DOCKER_DIGEST ||
        this.prevEnv.DOCKER_DIGEST ||
        cachedTag?.parsed.digest ||
        "";

      return new DockerTag({ registry, image, version, digest });
    }

    if (this.prevEnv.DOCKER_TAG) {
      return new DockerTag(this.prevEnv.DOCKER_TAG);
    } else if (this.prevEnv.DOCKER_IMAGE && this.prevEnv.DOCKER_VERSION) {
      return new DockerTag({
        registry: this.prevEnv.DOCKER_REGISTRY || "",
        image: this.prevEnv.DOCKER_IMAGE,
        version: this.prevEnv.DOCKER_VERSION,
        digest: this.prevEnv.DOCKER_DIGEST || "",
      });
    } else {
      return this.#defaultTag;
    }
  }

  #resolveGitInfo(
    repo = "unknown",
    branch = "unknown",
    commit = "unknown",
  ): GitInfoType {
    if (GitInfo.exists()) {
      return GitInfo.parse();
    } else {
      return {
        repo,
        branch,
        commit,
      };
    }
  }

  #resolveDockerPort(): string {
    if (this.processEnv.DOCKER_PORT) {
      return String(this.processEnv.DOCKER_PORT);
    }

    const server = net.createServer();
    server.listen(0);
    const address = server.address();
    if (address && typeof address === "object" && "port" in address) {
      const freePort = address.port;
      server.close();
      return String(freePort);
    }
    server.close();
    return "80";
  }

  #getCurrEnv(): z.infer<typeof Environment.schema> {
    const inputEnv = { ...this.prevEnv, ...this.processEnv };
    const env: Record<string, string> = { ...inputEnv };
    const { parsed, fullTag } = this.#resolveDockerTag();
    let registry = parsed.registry;
    let image = parsed.image;
    let version = parsed.version;
    const digest = parsed.digest;

    if (
      image &&
      !version &&
      !digest &&
      !image.includes(":") &&
      !image.includes("@")
    ) {
      version = image;
      image = this.#defaultTag.parsed.image;
    } else if (image && !version && digest && !image.includes(":")) {
      version = image;
      image = this.#defaultTag.parsed.image;
    }

    if (digest && !version) {
      throw new Error(
        `Invalid image tag: ${fullTag} (when specifying a digest, a version is required)`,
      );
    }

    if (!registry) {
      registry = this.#defaultTag.parsed.registry;
    }

    const isLocal = version === "local";
    const defaultTarget = isLocal ? "development" : "production";

    for (const key of ["DOCKER_TARGET", "NODE_ENV"]) {
      const current = env[key];
      const isMissing = !current;
      const isWrong = !isLocal && current !== defaultTarget;
      if (isMissing || isWrong) {
        env[key] = defaultTarget;
      }
    }

    const gitInfo = this.#resolveGitInfo(
      env.GIT_REPO,
      env.GIT_BRANCH,
      env.GIT_COMMIT,
    );

    env.DOCKER_PORT = this.#resolveDockerPort();
    env.DOCKER_TAG = new DockerTag({
      registry,
      image,
      version,
      digest: digest || "",
    }).fullTag;
    env.DOCKER_TARGET = env.DOCKER_TARGET || defaultTarget;
    env.DOCKER_REGISTRY = registry;
    env.DOCKER_IMAGE = image;
    env.DOCKER_VERSION = version;
    env.DOCKER_DIGEST = digest || "";
    env.GIT_REPO = gitInfo.repo;
    env.GIT_BRANCH = gitInfo.branch;
    env.GIT_COMMIT = gitInfo.commit;
    env.NODE_ENV = env.NODE_ENV || defaultTarget;

    return Environment.schema.parse(env);
  }

  static #isAllowedExtraKey(key: string): boolean {
    return /^[A-Z0-9_]+_IMAGE$/.test(key);
  }

  static #isSafeValue(value: string): boolean {
    return !value.includes("\n");
  }

  #collectExtraEnv(): Record<string, string> {
    const extras: Record<string, string> = {};
    const candidateSources = [{ ...this.prevEnv }, { ...this.processEnv }];
    for (const source of candidateSources) {
      for (const [key, value] of Object.entries(source)) {
        if (
          Environment.baseKeys.has(key) ||
          !Environment.#isAllowedExtraKey(key) ||
          !value
        ) {
          continue;
        }
        if (!Environment.#isSafeValue(value)) continue;
        extras[key] = value;
      }
    }
    return extras;
  }

  setExtraEnv(key: string, value: string): void {
    if (!Environment.#isAllowedExtraKey(key)) {
      throw new Error(
        `Unsupported environment override "${key}". Only *_IMAGE keys are allowed.`,
      );
    }
    if (!Environment.#isSafeValue(value)) {
      throw new Error(`Value for "${key}" cannot contain newline characters.`);
    }
    this.extraEnv[key] = value;
  }

  #diff(): EnvironmentDiffType {
    const result: EnvironmentDiffType = {
      added: [],
      updated: [],
      removed: [],
      unchanged: [],
    };

    const keys = Object.keys(Environment.schema.shape);

    for (const key of keys) {
      const prevValue = this.prevEnv[key];
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- iterating schema keys that are valid keyof env
      const currValue = this.env[key as keyof typeof this.env];

      if (!prevValue && currValue) {
        result.added.push([key, String(currValue)]);
      } else if (prevValue && !currValue) {
        result.removed.push([key, prevValue]);
      } else if (currValue && prevValue !== currValue) {
        result.updated.push([key, String(currValue)]);
      } else if (currValue) {
        result.unchanged.push([key, prevValue]);
      }
    }
    return result;
  }

  save(): void {
    const combinedEntries: Record<string, string> = {
      ...this.env,
      ...this.extraEnv,
    };

    const sortedEnv = Object.entries(combinedEntries)
      .filter(([, value]) => !!value)
      .sort((a, b) => a[0].localeCompare(b[0]));

    const sortedEnvString = sortedEnv
      .map(([key, value]) => `${key}="${value}"`)
      .join("\n");

    fs.writeFileSync(this.envFile, sortedEnvString);
  }
}
