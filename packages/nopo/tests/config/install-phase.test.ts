import { describe, expect, it } from "vitest";

import {
  INSTALL_PHASES,
  type InstallCommands,
  resolveInstallCommand,
} from "../../src/config/install-phase.ts";

describe("INSTALL_PHASES", () => {
  it("is the platform's phase vocabulary, in lifecycle order", () => {
    // Plugins name one of these and are handed a command. Adding a phase
    // is a platform decision, not a package-manager one.
    expect(INSTALL_PHASES).toEqual(["dev", "build", "prod"]);
  });
});

describe("resolveInstallCommand — fallback chain", () => {
  const devOnly: InstallCommands = { dev: "uv sync --locked" };

  it("resolves every phase to dev when only dev is declared", () => {
    // This is what keeps `install: <string>` meaning what it always meant, so a package
    // manager with nothing to say about phases stays a one-liner.
    for (const phase of INSTALL_PHASES) {
      expect(resolveInstallCommand(devOnly, phase)).toBe("uv sync --locked");
    }
  });

  it("falls prod back to build before dev", () => {
    const commands: InstallCommands = { dev: "d", build: "b" };
    expect(resolveInstallCommand(commands, "prod")).toBe("b");
  });

  it("does not fall build back to prod", () => {
    // The chain runs one direction only. A prod-only declaration must not
    // leak a production install into the build stage.
    const commands: InstallCommands = { dev: "d", prod: "p" };
    expect(resolveInstallCommand(commands, "build")).toBe("d");
  });

  it("prefers an explicit phase over any fallback", () => {
    const commands: InstallCommands = { dev: "d", build: "b", prod: "p" };
    expect(resolveInstallCommand(commands, "dev")).toBe("d");
    expect(resolveInstallCommand(commands, "build")).toBe("b");
    expect(resolveInstallCommand(commands, "prod")).toBe("p");
  });
});

describe("resolveInstallCommand — {service_dir}", () => {
  const scoped: InstallCommands = {
    dev: "bun install",
    build: "bun install --frozen-lockfile --filter './{service_dir}'",
  };

  it("expands the token so callers never post-process the command", () => {
    expect(
      resolveInstallCommand(scoped, "build", {
        serviceDir: "products/example/api",
      }),
    ).toBe(
      "bun install --frozen-lockfile --filter './products/example/api'",
    );
  });

  it("expands every occurrence", () => {
    const commands: InstallCommands = {
      dev: "x",
      build: "a {service_dir} b {service_dir}",
    };
    expect(
      resolveInstallCommand(commands, "build", { serviceDir: "svc" }),
    ).toBe("a svc b svc");
  });

  it("throws rather than emit a literal token when no service is given", () => {
    // A literal `{service_dir}` reaching a RUN line would fail deep inside
    // a docker build with an unrelated-looking error.
    expect(() => resolveInstallCommand(scoped, "build")).toThrowError(
      /no service was provided/,
    );
  });

  it("leaves a command without the token alone", () => {
    expect(resolveInstallCommand(scoped, "dev")).toBe("bun install");
  });
});
