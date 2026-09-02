import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { Environment } from "../../src/parse-env.ts";
import EnvScript from "../../src/scripts/env.ts";
import {
  createFixtureConfig,
  createTestConfig,
  createTmpEnv,
  dockerTag,
  runScript,
} from "../utils.ts";

vi.mock("../../src/git-info", () => ({
  GitInfo: {
    exists: () => false,
    parse: vi.fn(() => ({
      repo: "unknown",
      branch: "unknown",
      commit: "unknown",
    })),
  },
}));

/** `DOCKER_TAG` is the only input. Env parses it, writes `.env`, validates the tag and env
 * vars, and logs added/updated/removed/unchanged keys.
 */

describe("env", () => {
  it("prioritiszes file input over base tag", async () => {
    const testEnv = createTmpEnv({ DOCKER_TAG: dockerTag.fullTag });
    const config = createTestConfig({
      envFile: testEnv,
      processEnv: {},
      silent: true,
    });
    await runScript(EnvScript, config);
    const { env } = new Environment(config);
    expect(env.DOCKER_TAG).toStrictEqual(dockerTag.fullTag);
  });

  it("prioritizes environment over file input", async () => {
    const testEnv = createTmpEnv({ DOCKER_TAG: dockerTag.fullTag });
    const config = createTestConfig({
      envFile: testEnv,
      processEnv: { DOCKER_TAG: "registry/repo:tag" },
      silent: true,
    });

    await runScript(EnvScript, config);
    const { env } = new Environment(config);
    expect(env.DOCKER_TAG).toStrictEqual("registry/repo:tag");
  });

  it("extracts docker tag components from DOCKER_TAG", async () => {
    const testEnv = createTmpEnv({ DOCKER_TAG: dockerTag.fullTag });
    const config = createTestConfig({
      envFile: testEnv,
      processEnv: {},
      silent: true,
    });
    await runScript(EnvScript, config);
    const { env } = new Environment(config);
    expect(env.DOCKER_REGISTRY).toStrictEqual(dockerTag.parsed.registry);
    expect(env.DOCKER_IMAGE).toStrictEqual(dockerTag.parsed.image);
    expect(env.DOCKER_VERSION).toStrictEqual(dockerTag.parsed.version);
    expect(env.DOCKER_DIGEST).toStrictEqual(dockerTag.parsed.digest);
  });

  describe("error states", () => {
    it("Corrects invalid NODE_ENV to default on remote images", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv(),
        processEnv: {
          NODE_ENV: "invalid",
          DOCKER_TAG: dockerTag.fullTag,
        },
        silent: true,
      });
      await runScript(EnvScript, config);
      const { env } = new Environment(config);
      // Default for dockerTag is production since this is a remote image
      expect(env.NODE_ENV).toStrictEqual("production");
    });

    it("Corrects invalid DOCKER_TARGET to default on remote images", async () => {
      const config = createTestConfig({
        envFile: createTmpEnv(),
        processEnv: {
          DOCKER_TARGET: "invalid",
          DOCKER_TAG: dockerTag.fullTag,
        },
        silent: true,
      });
      await runScript(EnvScript, config);
      const { env } = new Environment(config);
      expect(env.DOCKER_TARGET).toStrictEqual("production");
    });
  });

  describe("defaults and inference", () => {
    it("uses default .env file when none is provided", async () => {
      const config = createTestConfig({
        envFile: undefined,
        processEnv: {},
        silent: true,
      });
      await runScript(EnvScript, config);
      expect(config.envFile).toStrictEqual(path.resolve(config.root, ".env"));
    });

    it('sets missing NODE_ENV and DOCKER_TARGET to "development" for local images', async () => {
      const config = createTestConfig({
        envFile: createTmpEnv(),
        processEnv: {
          DOCKER_TAG: "example/app:local",
        },
        silent: true,
      });
      await runScript(EnvScript, config);
      const { env } = new Environment(config);
      expect(env.NODE_ENV).toStrictEqual("development");
      expect(env.DOCKER_TARGET).toStrictEqual("development");
    });

    it("uses base tag when no DOCKER_TAG is provided", async () => {
      const tmpFile = createTmpEnv();
      const config = createFixtureConfig({
        envFile: tmpFile,
        processEnv: {},
        silent: true,
      });
      await runScript(EnvScript, config);
      const { env } = new Environment(config);
      expect(env.DOCKER_TAG).toStrictEqual(Environment.baseTag.fullTag);
    });
  });

  describe("file operations", () => {
    it("creates new .env file when none exists", async () => {
      const tmpFile = createTmpEnv();
      fs.rmSync(tmpFile);
      const config = createTestConfig({
        envFile: tmpFile,
        processEnv: {},
        silent: true,
      });
      await runScript(EnvScript, config);
      expect(fs.existsSync(tmpFile)).toBe(true);
    });

    it("updates existing .env file with new values", async () => {
      const tmpFile = createTmpEnv({
        DOCKER_TAG: dockerTag.fullTag,
        NODE_ENV: "production",
      });
      const config = createTestConfig({
        envFile: tmpFile,
        processEnv: {},
        silent: true,
      });
      const { env: prevEnv } = new Environment(config);
      await runScript(EnvScript, config);
      const { env: newEnv } = new Environment(config);
      expect(newEnv.DOCKER_TAG).toStrictEqual(prevEnv.DOCKER_TAG);
      expect(newEnv.NODE_ENV).toStrictEqual(prevEnv.NODE_ENV);
    });

    it("sorts environment variables alphabetically in output file", async () => {
      const tmpFile = createTmpEnv();
      const config = createTestConfig({
        envFile: tmpFile,
        processEnv: {},
        silent: true,
      });
      await runScript(EnvScript, config);
      const str = fs.readFileSync(tmpFile, "utf8");
      const actualKeys = str.split("\n").map((line) => line.split("=")[0]);
      const sortedKeys = [...actualKeys].sort();
      expect(actualKeys).toStrictEqual(sortedKeys);
    });

    it('formats output as KEY="value" pairs', async () => {
      const tmpFile = createTmpEnv();
      const config = createTestConfig({
        envFile: tmpFile,
        processEnv: {
          NODE_ENV: "production",
        },
        silent: true,
      });
      await runScript(EnvScript, config);
      const str = fs.readFileSync(tmpFile, "utf8");
      expect(str).toContain('NODE_ENV="production"');
    });
  });
});
