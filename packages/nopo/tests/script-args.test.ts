import { describe, expect, it } from "vitest";

import { type ScriptArgConfig, ScriptArgs } from "../src/script-args.ts";

describe("ScriptArgs", () => {
  describe("parse and get", () => {
    it("should parse boolean flags", () => {
      const schema: Record<string, ScriptArgConfig> = {
        verbose: {
          type: "boolean",
          description: "Verbose output",
          default: false,
        },
      };

      const args = new ScriptArgs(schema);
      args.parse(["--verbose"]);

      expect(args.get("verbose")).toBe(true);
    });

    it("should parse string values", () => {
      const schema: Record<string, ScriptArgConfig> = {
        output: {
          type: "string",
          description: "Output file",
          default: "out.txt",
        },
      };

      const args = new ScriptArgs(schema);
      args.parse(["--output", "result.txt"]);

      expect(args.get("output")).toBe("result.txt");
    });

    it("should parse number values", () => {
      const schema: Record<string, ScriptArgConfig> = {
        port: {
          type: "number",
          description: "Port number",
          default: 3000,
        },
      };

      const args = new ScriptArgs(schema);
      args.parse(["--port", "8080"]);

      expect(args.get("port")).toBe(8080);
    });

    it("should parse string[] values", () => {
      const schema: Record<string, ScriptArgConfig> = {
        tags: {
          type: "string[]",
          description: "Tags",
          default: [],
        },
      };

      const args = new ScriptArgs(schema);
      args.parse(["--tags", "foo", "--tags", "bar"]);

      expect(args.get("tags")).toEqual(["foo", "bar"]);
    });

    it("should use default values when arg not provided", () => {
      const schema: Record<string, ScriptArgConfig> = {
        verbose: {
          type: "boolean",
          description: "Verbose",
          default: false,
        },
        output: {
          type: "string",
          description: "Output",
          default: "default.txt",
        },
      };

      const args = new ScriptArgs(schema);
      args.parse([]);

      expect(args.get("verbose")).toBe(false);
      expect(args.get("output")).toBe("default.txt");
    });
  });

  describe("aliases", () => {
    it("should support single character aliases", () => {
      const schema: Record<string, ScriptArgConfig> = {
        output: {
          type: "string",
          description: "Output file",
          alias: ["o"],
          default: "out.txt",
        },
      };

      const args = new ScriptArgs(schema);
      args.parse(["-o", "result.txt"]);

      expect(args.get("output")).toBe("result.txt");
    });

    it("should support multiple aliases", () => {
      const schema: Record<string, ScriptArgConfig> = {
        noCache: {
          type: "boolean",
          description: "Disable cache",
          alias: ["no-cache", "nc"],
          default: false,
        },
      };

      const args1 = new ScriptArgs(schema);
      args1.parse(["--no-cache"]);
      expect(args1.get("noCache")).toBe(true);

      const args2 = new ScriptArgs(schema);
      args2.parse(["--nc"]);
      expect(args2.get("noCache")).toBe(true);
    });
  });

  describe("extend", () => {
    it("should extend schema with additional args", () => {
      const baseSchema: Record<string, ScriptArgConfig> = {
        verbose: {
          type: "boolean",
          description: "Verbose",
          default: false,
        },
      };

      const base = new ScriptArgs(baseSchema);
      const extended = base.extend({
        output: {
          type: "string",
          description: "Output file",
          default: "out.txt",
        },
      });

      extended.parse(["--verbose", "--output", "result.txt"]);

      expect(extended.get("verbose")).toBe(true);
      expect(extended.get("output")).toBe("result.txt");
    });

    it("should override base schema values when extending", () => {
      const baseSchema: Record<string, ScriptArgConfig> = {
        verbose: {
          type: "boolean",
          description: "Base verbose",
          default: false,
        },
      };

      const base = new ScriptArgs(baseSchema);
      const extended = base.extend({
        verbose: {
          type: "boolean",
          description: "Extended verbose",
          default: true,
        },
      });

      extended.parse([]);

      expect(extended.get("verbose")).toBe(true);
    });
  });

  describe("set", () => {
    it("should allow setting values programmatically", () => {
      const schema: Record<string, ScriptArgConfig> = {
        targets: {
          type: "string[]",
          description: "Targets",
          default: [],
        },
      };

      const args = new ScriptArgs(schema);
      args.set("targets", ["backend", "web"]);

      expect(args.get("targets")).toEqual(["backend", "web"]);
    });

    it("should override parsed values when set", () => {
      const schema: Record<string, ScriptArgConfig> = {
        output: {
          type: "string",
          description: "Output",
          default: "default.txt",
        },
      };

      const args = new ScriptArgs(schema);
      args.parse(["--output", "parsed.txt"]);
      args.set("output", "override.txt");

      expect(args.get("output")).toBe("override.txt");
    });
  });

  describe("isExplicit", () => {
    it("should return true for explicitly parsed args", () => {
      const schema: Record<string, ScriptArgConfig> = {
        verbose: {
          type: "boolean",
          description: "Verbose",
          default: false,
        },
      };

      const args = new ScriptArgs(schema);
      args.parse(["--verbose"]);

      expect(args.isExplicit("verbose")).toBe(true);
    });

    it("should return false for args using defaults", () => {
      const schema: Record<string, ScriptArgConfig> = {
        verbose: {
          type: "boolean",
          description: "Verbose",
          default: false,
        },
      };

      const args = new ScriptArgs(schema);
      args.parse([]);

      expect(args.isExplicit("verbose")).toBe(false);
    });

    it("should return true for args set via set()", () => {
      const schema: Record<string, ScriptArgConfig> = {
        targets: {
          type: "string[]",
          description: "Targets",
          default: [],
        },
      };

      const args = new ScriptArgs(schema);
      args.set("targets", ["backend"]);

      expect(args.isExplicit("targets")).toBe(true);
    });
  });

  describe("generateHelp", () => {
    it("should generate help text for all visible args", () => {
      const schema: Record<string, ScriptArgConfig> = {
        verbose: {
          type: "boolean",
          description: "Enable verbose output",
          alias: ["v"],
          default: false,
        },
        output: {
          type: "string",
          description: "Output file path",
          alias: ["o"],
          default: "out.txt",
        },
      };

      const args = new ScriptArgs(schema);
      const help = args.generateHelp();

      expect(help).toContain("--verbose");
      expect(help).toContain("-v");
      expect(help).toContain("Enable verbose output");
      expect(help).toContain("default: false");

      expect(help).toContain("--output");
      expect(help).toContain("-o");
      expect(help).toContain("<value>");
      expect(help).toContain("Output file path");
    });

    it("should not show hidden args in help", () => {
      const schema: Record<string, ScriptArgConfig> = {
        targets: {
          type: "string[]",
          description: "Target services",
          default: [],
          hidden: true,
        },
        verbose: {
          type: "boolean",
          description: "Verbose output",
          default: false,
        },
      };

      const args = new ScriptArgs(schema);
      const help = args.generateHelp();

      expect(help).not.toContain("targets");
      expect(help).toContain("verbose");
    });
  });

  describe("validation", () => {
    it("should call validate function when parsing", () => {
      let validatedValue: unknown;

      const schema: Record<string, ScriptArgConfig> = {
        port: {
          type: "number",
          description: "Port number",
          default: 3000,
          validate: (value) => {
            validatedValue = value;
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- validate callback receives unknown, narrowing to number for range check
            const v = value as number;
            if (v < 1 || v > 65535) {
              throw new Error("Port must be between 1 and 65535");
            }
          },
        },
      };

      const args = new ScriptArgs(schema);
      args.parse(["--port", "8080"]);

      expect(validatedValue).toBe(8080);
      expect(args.get("port")).toBe(8080);
    });

    it("should throw error from validate function", () => {
      const schema: Record<string, ScriptArgConfig> = {
        port: {
          type: "number",
          description: "Port number",
          default: 3000,
          validate: (value) => {
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- validate callback receives unknown, narrowing to number for range check
            const v = value as number;
            if (v < 1 || v > 65535) {
              throw new Error("Port must be between 1 and 65535");
            }
          },
        },
      };

      const args = new ScriptArgs(schema);

      expect(() => {
        args.parse(["--port", "99999"]);
      }).toThrow("Port must be between 1 and 65535");
    });
  });

  describe("getSchema", () => {
    it("should return a copy of the schema", () => {
      const schema: Record<string, ScriptArgConfig> = {
        verbose: {
          type: "boolean",
          description: "Verbose",
          default: false,
        },
      };

      const args = new ScriptArgs(schema);
      const returnedSchema = args.getSchema();

      expect(returnedSchema).toEqual(schema);
      expect(returnedSchema).not.toBe(schema); // Should be a copy
    });
  });
});
