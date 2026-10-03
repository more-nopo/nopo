import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments, stringify } from "yaml";

import type { RuntimeEntry } from "../../src/config/index.ts";
import main from "../../src/index.ts";
import {
  MockExitError,
  mockIO,
  type MockIOInput,
} from "../../src/test-utils/mock-io.ts";

const env = {
  DOCKER_TAG: "registry.test/example:sha-candidate",
  DOCKER_TARGET: "production",
};

async function runCanary(
  argv: string[],
  onSpawn?: MockIOInput["onSpawn"],
  policy: Partial<RuntimeEntry> = {},
) {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nopo-canary-contract-"));
  fs.cpSync(path.join(root, "nopo/fixtures/contract/canary"), cwd, {
    recursive: true,
  });
  const configPath = path.join(cwd, "nopo.yml");
  const config = parse(fs.readFileSync(configPath, "utf8"));
  Object.assign(config.runtimes.canary, policy);
  config.plugins[0].path = path.join(
    root,
    "nopo/plugins/terraform/src/index.ts",
  );
  fs.writeFileSync(configPath, stringify(config));
  const io = mockIO({ cwd, argv: ["bun", "nopo", ...argv], env, onSpawn });
  try {
    await main(io);
  } catch (error) {
    if (!(error instanceof MockExitError)) throw error;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  return io;
}

describe("reserved canary namespace", () => {
  it("cannot disable the built-in preview namespace protection", async () => {
    const io = await runCanary(["down", "--runtime", "canary"], undefined, {
      namespace: "nopo-prev",
      preserveNamespace: false,
    });
    expect(io.exitCode ?? 0).toBe(0);
    const commands = io.spawns
      .map((call) => [call.cmd, ...call.args].join(" "))
      .join("\n");
    expect(commands).toMatch(/kubectl delete deployment/);
    expect(commands).not.toMatch(/kubectl delete namespace/);
  });

  it("requires a bound namespace before enabling shell preservation", async () => {
    await expect(
      runCanary(["up", "--runtime", "canary"], undefined, {
        namespace: undefined,
      }),
    ).rejects.toThrow(/preserveNamespace requires an explicit namespace/);
  });

  it("deploys opted-in services at canary priority without applying the namespace", async () => {
    const manifests: string[] = [];
    const io = await runCanary(["up", "--runtime", "canary"], (cmd, args) => {
      const command = [cmd, ...args].join(" ");
      const directory = command.match(/kubectl apply -f ([^\s]+) --namespace/);
      if (directory)
        manifests.push(
          fs.readFileSync(path.join(directory[1]!, "manifests.yaml"), "utf8"),
        );
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    expect(io.exitCode ?? 0).toBe(0);
    expect(manifests).toHaveLength(1);
    const docs = parseAllDocuments(manifests[0]!).map((doc) => doc.toJSON());
    const deployments = docs.filter((doc) => doc.kind === "Deployment");
    expect(deployments.map((doc) => doc.metadata.name)).toEqual(["app"]);
    expect(deployments[0].spec.template.spec.priorityClassName).toBe(
      "nopo-canary",
    );
    expect(docs.every((doc) => doc.metadata.namespace === "nopo-canary")).toBe(
      true,
    );
    expect(
      io.spawns.map((call) => [call.cmd, ...call.args].join(" ")).join("\n"),
    ).not.toMatch(/apply.*namespace\.yaml/);
  });

  it("deletes workloads without deleting the namespace", async () => {
    const io = await runCanary(["down", "--runtime", "canary"]);
    expect(io.exitCode ?? 0).toBe(0);
    const commands = io.spawns
      .map((call) => [call.cmd, ...call.args].join(" "))
      .join("\n");
    expect(commands).toMatch(/kubectl delete deployment/);
    expect(commands).toMatch(/kubectl delete job/);
    expect(commands).toMatch(/kubectl delete pod /);
    expect(commands).not.toMatch(/kubectl delete namespace/);
    expect(commands).toMatch(/nopo-canary/);
  });

  it("reports cleanup failure instead of a successful teardown", async () => {
    const io = await runCanary(
      ["down", "--runtime", "canary"],
      (cmd, args) => ({
        exitCode: /delete pvc/.test([cmd, ...args].join(" ")) ? 1 : 0,
        stdout: "",
        stderr: "",
      }),
    );
    expect(io.exitCode).toBe(1);
    const commands = io.spawns
      .map((call) => [call.cmd, ...call.args].join(" "))
      .join("\n");
    expect(commands).toMatch(/delete secret/);
    expect(commands).not.toMatch(
      /delete (namespace|role|rolebinding|resourcequota)/,
    );
  });

  it("fails when the reserved namespace is absent instead of creating it", async () => {
    const io = await runCanary(["up", "--runtime", "canary"], (cmd, args) => {
      const command = [cmd, ...args].join(" ");
      return {
        exitCode: /get namespace/.test(command) ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    });
    expect(io.exitCode).toBe(1);
    expect(
      io.spawns.map((call) => [call.cmd, ...call.args].join(" ")).join("\n"),
    ).not.toMatch(/kubectl apply/);
  });
});
