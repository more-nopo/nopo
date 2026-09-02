import { describe, expect, it, vi } from "vitest";

import { Environment } from "../src/parse-env.ts";
import { createFixtureConfig, createTmpEnv, dockerTag } from "./utils.ts";

vi.mock("../src/git-info", () => ({
  GitInfo: {
    exists: () => false,
    parse: vi.fn(() => ({
      repo: "unknown",
      branch: "unknown",
      commit: "unknown",
    })),
  },
}));

vi.mock("node:net", () => ({
  default: {
    createServer: vi.fn().mockImplementation(() => ({
      listen: vi.fn(),
      address: vi.fn().mockReturnValue({ port: 80 }),
      close: vi.fn(),
    })),
  },
}));

describe("parseEnv", () => {
  it("should parse the env", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv(),
      processEnv: {},
      silent: true,
    });
    const {
      env: { GIT_BRANCH, GIT_COMMIT, GIT_REPO, DOCKER_PORT, ...env },
    } = new Environment(config);
    expect(GIT_REPO).toStrictEqual("unknown");
    expect(GIT_BRANCH).toStrictEqual("unknown");
    expect(GIT_COMMIT).toStrictEqual("unknown");
    expect(DOCKER_PORT).toBe("80");
    expect(env).toMatchSnapshot();
  });

  it("should override from file", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        NODE_ENV: "production",
      }),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.NODE_ENV).toBe("production");
  });

  it("should override from process", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        NODE_ENV: "production",
      }),
      processEnv: {
        NODE_ENV: "development",
      },
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects invalid NODE_ENV", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        NODE_ENV: "invalid",
      }),
      processEnv: {},
      silent: true,
    });
    expect(() => new Environment(config)).toThrow("Invalid enum value");
  });

  it("rejects invalid DOCKER_TARGET", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TARGET: "invalid",
      }),
      processEnv: {},
      silent: true,
    });
    expect(() => new Environment(config)).toThrow("Invalid enum value");
  });

  it("should use provided DOCKER_TAG if present", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TAG: dockerTag.fullTag,
      }),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.DOCKER_TAG).toBe(dockerTag.fullTag);
    expect(env.DOCKER_REGISTRY).toBe(dockerTag.parsed.registry);
    expect(env.DOCKER_IMAGE).toBe(dockerTag.parsed.image);
    expect(env.DOCKER_VERSION).toBe(dockerTag.parsed.version);
  });

  it("should construct tag from components if DOCKER_TAG not present", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_REGISTRY: dockerTag.parsed.registry,
        DOCKER_IMAGE: dockerTag.parsed.image,
        DOCKER_VERSION: dockerTag.parsed.version,
        DOCKER_DIGEST: dockerTag.parsed.digest,
      }),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.DOCKER_TAG).toBe(dockerTag.fullTag);
  });

  it("should ignore empty DOCKER_TAG when components are provided", async () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TAG: "",
        DOCKER_REGISTRY: dockerTag.parsed.registry,
        DOCKER_IMAGE: dockerTag.parsed.image,
        DOCKER_VERSION: dockerTag.parsed.version,
        DOCKER_DIGEST: dockerTag.parsed.digest,
      }),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.DOCKER_TAG).toBe(dockerTag.fullTag);
  });

  it("should use base tag when no docker config provided", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv(),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.DOCKER_TAG).toBe(Environment.baseTag.fullTag);
  });

  it("should force production target for non-local image", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TAG: "docker.io/base/repo:1.0.0",
        DOCKER_TARGET: "development",
      }),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.DOCKER_TARGET).toBe("production");
  });

  it("should also force NODE_ENV to production for non-local image", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TAG: "docker.io/base/repo:1.0.0",
        NODE_ENV: "development",
      }),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.NODE_ENV).toBe("production");
  });

  it.each(["development", "production"])(
    "should allow either target for local image",
    (target) => {
      const config = createFixtureConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "docker.io/base/repo:local",
          DOCKER_TARGET: target,
        }),
        processEnv: {},
        silent: true,
      });
      const { env } = new Environment(config);
      expect(env.DOCKER_TARGET).toBe(target);
    },
  );

  it.each(["development", "production"])(
    "should preserve NODE_ENV for local image (%s)",
    (nodeEnv) => {
      const config = createFixtureConfig({
        envFile: createTmpEnv({
          DOCKER_TAG: "base/repo:local",
          NODE_ENV: nodeEnv,
        }),
        processEnv: {},
        silent: true,
      });
      const { env } = new Environment(config);
      expect(env.NODE_ENV).toBe(nodeEnv);
    },
  );

  it("should throw error when digest provided without version", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TAG: `${dockerTag.parsed.digest}`,
      }),
      processEnv: {},
      silent: true,
    });
    expect(() => new Environment(config)).toThrow(
      "Cannot parse image with only a digest:",
    );
  });

  it("should handle version-only input correctly", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TAG: "3.0.0",
      }),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.DOCKER_TAG).toBe("nopo:3.0.0");
  });

  it("should handle version and digest input correctly", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TAG: `1.0.0@${dockerTag.parsed.digest}`,
      }),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.DOCKER_TAG).toBe(
      `nopo:1.0.0@${dockerTag.parsed.digest}`,
    );
  });

  it("should handle image-only input correctly", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TAG: "custom/image:1.0.0",
      }),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.DOCKER_TAG).toBe("custom/image:1.0.0");
  });

  it("should handle basic image:tag input correctly", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TAG: "nginx:latest",
      }),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.DOCKER_TAG).toBe("nginx:latest");
    expect(env.DOCKER_REGISTRY).toBe("");
    expect(env.DOCKER_IMAGE).toBe("nginx");
    expect(env.DOCKER_VERSION).toBe("latest");
  });

  it("should handle image:tag@digest input correctly", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TAG: `nginx:latest@${dockerTag.parsed.digest}`,
      }),
      processEnv: {},
      silent: true,
    });
    const { env } = new Environment(config);
    expect(env.DOCKER_TAG).toBe(`nginx:latest@${dockerTag.parsed.digest}`);
    expect(env.DOCKER_REGISTRY).toBe("");
    expect(env.DOCKER_IMAGE).toBe("nginx");
    expect(env.DOCKER_VERSION).toBe("latest");
    expect(env.DOCKER_DIGEST).toBe(dockerTag.parsed.digest);
  });

  it("should throw an error for an invalid tag format", () => {
    const config = createFixtureConfig({
      envFile: createTmpEnv({
        DOCKER_TAG: "invalid:tag:format:with:many:colons",
      }),
      processEnv: {},
      silent: true,
    });
    expect(() => new Environment(config)).toThrow("Invalid image tag:");
  });

  describe("processEnv overrides", () => {
    describe("DOCKER_TAG takes precedence", () => {
      it("processEnv DOCKER_TAG overrides cached DOCKER_TAG from file", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_TAG: "cached/image:old-version",
          }),
          processEnv: {
            DOCKER_TAG: "new/image:new-version",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_TAG).toBe("new/image:new-version");
        expect(env.DOCKER_IMAGE).toBe("new/image");
        expect(env.DOCKER_VERSION).toBe("new-version");
      });

      it("processEnv DOCKER_TAG overrides all component values from file", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_REGISTRY: "old.registry.io",
            DOCKER_IMAGE: "old/image",
            DOCKER_VERSION: "old-version",
          }),
          processEnv: {
            DOCKER_TAG: "new.registry.io/new/image:new-version",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_TAG).toBe("new.registry.io/new/image:new-version");
        expect(env.DOCKER_REGISTRY).toBe("new.registry.io");
        expect(env.DOCKER_IMAGE).toBe("new/image");
        expect(env.DOCKER_VERSION).toBe("new-version");
      });
    });

    describe("individual component overrides", () => {
      it("processEnv DOCKER_VERSION alone overrides cached DOCKER_TAG", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_TAG: "example/app:cached-version",
          }),
          processEnv: {
            DOCKER_VERSION: "new-version",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_VERSION).toBe("new-version");
        expect(env.DOCKER_IMAGE).toBe("example/app");
        expect(env.DOCKER_TAG).toBe("example/app:new-version");
      });

      it("processEnv DOCKER_IMAGE alone overrides cached DOCKER_TAG", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_TAG: "old/image:cached-version",
          }),
          processEnv: {
            DOCKER_IMAGE: "new/image",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_IMAGE).toBe("new/image");
        expect(env.DOCKER_VERSION).toBe("cached-version");
        expect(env.DOCKER_TAG).toBe("new/image:cached-version");
      });

      it("processEnv DOCKER_REGISTRY alone overrides cached DOCKER_TAG", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_TAG: "old.registry.io/image:version",
          }),
          processEnv: {
            DOCKER_REGISTRY: "new.registry.io",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_REGISTRY).toBe("new.registry.io");
        expect(env.DOCKER_IMAGE).toBe("image");
        expect(env.DOCKER_VERSION).toBe("version");
        expect(env.DOCKER_TAG).toBe("new.registry.io/image:version");
      });

      it("processEnv DOCKER_VERSION overrides component from file", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_IMAGE: "cached/image",
            DOCKER_VERSION: "cached-version",
          }),
          processEnv: {
            DOCKER_VERSION: "new-version",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_VERSION).toBe("new-version");
        expect(env.DOCKER_IMAGE).toBe("cached/image");
        expect(env.DOCKER_TAG).toBe("cached/image:new-version");
      });

      it("processEnv DOCKER_IMAGE overrides component from file", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_IMAGE: "cached/image",
            DOCKER_VERSION: "cached-version",
          }),
          processEnv: {
            DOCKER_IMAGE: "new/image",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_IMAGE).toBe("new/image");
        expect(env.DOCKER_VERSION).toBe("cached-version");
        expect(env.DOCKER_TAG).toBe("new/image:cached-version");
      });

      it("processEnv DOCKER_REGISTRY overrides component from file", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_REGISTRY: "old.registry.io",
            DOCKER_IMAGE: "image",
            DOCKER_VERSION: "version",
          }),
          processEnv: {
            DOCKER_REGISTRY: "new.registry.io",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_REGISTRY).toBe("new.registry.io");
        expect(env.DOCKER_TAG).toBe("new.registry.io/image:version");
      });
    });

    describe("multiple component overrides", () => {
      it("processEnv DOCKER_VERSION and DOCKER_IMAGE override cached DOCKER_TAG", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_TAG: "old.registry.io/old/image:old-version",
          }),
          processEnv: {
            DOCKER_IMAGE: "new/image",
            DOCKER_VERSION: "new-version",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_IMAGE).toBe("new/image");
        expect(env.DOCKER_VERSION).toBe("new-version");
        expect(env.DOCKER_REGISTRY).toBe("old.registry.io");
        expect(env.DOCKER_TAG).toBe("old.registry.io/new/image:new-version");
      });

      it("processEnv all components override cached DOCKER_TAG", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_TAG: "old.registry.io/old/image:old-version",
          }),
          processEnv: {
            DOCKER_REGISTRY: "new.registry.io",
            DOCKER_IMAGE: "new/image",
            DOCKER_VERSION: "new-version",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_REGISTRY).toBe("new.registry.io");
        expect(env.DOCKER_IMAGE).toBe("new/image");
        expect(env.DOCKER_VERSION).toBe("new-version");
        expect(env.DOCKER_TAG).toBe("new.registry.io/new/image:new-version");
      });

      it("processEnv components with digest", () => {
        const digest =
          "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_TAG: "old/image:old-version",
          }),
          processEnv: {
            DOCKER_VERSION: "new-version",
            DOCKER_DIGEST: digest,
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_VERSION).toBe("new-version");
        expect(env.DOCKER_DIGEST).toBe(digest);
        expect(env.DOCKER_TAG).toBe(`old/image:new-version@${digest}`);
      });
    });

    describe("no cached values (fresh environment)", () => {
      it("processEnv DOCKER_VERSION alone uses base image", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({}),
          processEnv: {
            DOCKER_VERSION: "my-version",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_VERSION).toBe("my-version");
        expect(env.DOCKER_IMAGE).toBe("nopo");
        expect(env.DOCKER_TAG).toBe("nopo:my-version");
      });

      it("processEnv DOCKER_IMAGE alone uses local version", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({}),
          processEnv: {
            DOCKER_IMAGE: "custom/image",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_IMAGE).toBe("custom/image");
        expect(env.DOCKER_VERSION).toBe("local");
        expect(env.DOCKER_TAG).toBe("custom/image:local");
      });

      it("processEnv DOCKER_REGISTRY alone uses base defaults", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({}),
          processEnv: {
            DOCKER_REGISTRY: "my.registry.io",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_REGISTRY).toBe("my.registry.io");
        expect(env.DOCKER_IMAGE).toBe("nopo");
        expect(env.DOCKER_VERSION).toBe("local");
        expect(env.DOCKER_TAG).toBe("my.registry.io/nopo:local");
      });
    });

    describe("edge cases", () => {
      it("empty string processEnv values are ignored", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({
            DOCKER_TAG: "cached/image:cached-version",
          }),
          processEnv: {
            DOCKER_VERSION: "",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_TAG).toBe("cached/image:cached-version");
      });

      it("DOCKER_TAG in processEnv takes precedence over other processEnv components", () => {
        const config = createFixtureConfig({
          envFile: createTmpEnv({}),
          processEnv: {
            DOCKER_TAG: "tag/wins:always",
            DOCKER_IMAGE: "ignored/image",
            DOCKER_VERSION: "ignored-version",
            DOCKER_REGISTRY: "ignored.registry.io",
          },
          silent: true,
        });
        const { env } = new Environment(config);
        expect(env.DOCKER_TAG).toBe("tag/wins:always");
        expect(env.DOCKER_IMAGE).toBe("tag/wins");
        expect(env.DOCKER_VERSION).toBe("always");
        expect(env.DOCKER_REGISTRY).toBe("");
      });
    });
  });
});
