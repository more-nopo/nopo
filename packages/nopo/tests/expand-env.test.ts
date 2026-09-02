import { describe, expect, it } from "vitest";

import { expandEnvValues, expandString } from "../src/expand-env.ts";

describe("expandString", () => {
  describe("${VAR} — simple braced expansion", () => {
    it("expands a variable that exists", () => {
      expect(expandString("${HOME}", { HOME: "/Users/me" })).toBe("/Users/me");
    });

    it("returns empty string for unset variable", () => {
      expect(expandString("${MISSING}", {})).toBe("");
    });

    it("keeps empty string value (not treated as unset)", () => {
      expect(expandString("${EMPTY}", { EMPTY: "" })).toBe("");
    });
  });

  describe("$VAR — simple unbraced expansion", () => {
    it("expands a variable that exists", () => {
      expect(expandString("$HOME", { HOME: "/Users/me" })).toBe("/Users/me");
    });

    it("returns empty string for unset variable", () => {
      expect(expandString("$MISSING", {})).toBe("");
    });

    it("only matches valid identifier characters", () => {
      expect(expandString("$HOME/path", { HOME: "/Users/me" })).toBe(
        "/Users/me/path",
      );
    });

    it("does not match bare $ followed by non-identifier", () => {
      expect(expandString("cost is $5", {})).toBe("cost is $5");
    });
  });

  describe("${VAR:-default} — default if unset or empty", () => {
    it("uses value when set and non-empty", () => {
      expect(expandString("${HOST:-localhost}", { HOST: "192.168.1.1" })).toBe(
        "192.168.1.1",
      );
    });

    it("uses default when unset", () => {
      expect(expandString("${HOST:-localhost}", {})).toBe("localhost");
    });

    it("uses default when empty", () => {
      expect(expandString("${HOST:-localhost}", { HOST: "" })).toBe(
        "localhost",
      );
    });

    it("supports complex default values", () => {
      expect(expandString("${PATH:-/usr/bin:/bin}", {})).toBe("/usr/bin:/bin");
    });

    it("supports empty default", () => {
      expect(expandString("${VAR:-}", {})).toBe("");
    });
  });

  describe("${VAR-default} — default only if unset", () => {
    it("uses value when set and non-empty", () => {
      expect(expandString("${HOST-localhost}", { HOST: "192.168.1.1" })).toBe(
        "192.168.1.1",
      );
    });

    it("uses default when unset", () => {
      expect(expandString("${HOST-localhost}", {})).toBe("localhost");
    });

    it("keeps empty string (not treated as unset)", () => {
      expect(expandString("${HOST-localhost}", { HOST: "" })).toBe("");
    });
  });

  describe("mixed content", () => {
    it("expands multiple variables in one string", () => {
      expect(
        expandString("${PROTO}://${HOST}:${PORT}", {
          PROTO: "https",
          HOST: "example.com",
          PORT: "443",
        }),
      ).toBe("https://example.com:443");
    });

    it("handles mix of braced and unbraced", () => {
      expect(
        expandString("$USER@${HOST:-localhost}", {
          USER: "admin",
        }),
      ).toBe("admin@localhost");
    });

    it("passes through plain strings untouched", () => {
      expect(expandString("no variables here", {})).toBe("no variables here");
    });

    it("handles adjacent variables", () => {
      expect(expandString("$A$B${C}", { A: "1", B: "2", C: "3" })).toBe("123");
    });

    it("preserves surrounding text", () => {
      expect(expandString("prefix-${VAR:-default}-suffix", {})).toBe(
        "prefix-default-suffix",
      );
    });
  });

  describe("edge cases", () => {
    it("handles empty input", () => {
      expect(expandString("", {})).toBe("");
    });

    it("handles string with only a variable", () => {
      expect(expandString("${X}", { X: "value" })).toBe("value");
    });

    it("does not recurse into expanded values", () => {
      // If VAR expands to something containing ${...}, it should NOT be re-expanded
      expect(expandString("${VAR}", { VAR: "${OTHER}" })).toBe("${OTHER}");
    });

    it("handles variable names with underscores and numbers", () => {
      expect(expandString("${MY_VAR_2}", { MY_VAR_2: "works" })).toBe("works");
    });
  });
});

describe("expandEnvValues", () => {
  describe("basic expansion against process env", () => {
    it("expands values against provided env", () => {
      const result = expandEnvValues(
        { GREETING: "hello ${USER}" },
        { USER: "alice" },
      );
      expect(result).toEqual({ GREETING: "hello alice" });
    });

    it("uses defaults when env var is missing", () => {
      const result = expandEnvValues(
        { HOST: "${TALOS_NODE:-192.168.1.124}" },
        {},
      );
      expect(result).toEqual({ HOST: "192.168.1.124" });
    });

    it("prefers env value over default", () => {
      const result = expandEnvValues(
        { HOST: "${TALOS_NODE:-192.168.1.124}" },
        { TALOS_NODE: "10.0.0.1" },
      );
      expect(result).toEqual({ HOST: "10.0.0.1" });
    });
  });

  describe("cross-referencing within the same record", () => {
    it("later entries can reference earlier ones", () => {
      const result = expandEnvValues(
        {
          HOST: "192.168.1.124",
          URL: "https://${HOST}:6443",
        },
        {},
      );
      expect(result).toEqual({
        HOST: "192.168.1.124",
        URL: "https://192.168.1.124:6443",
      });
    });

    it("earlier entries cannot reference later ones", () => {
      const result = expandEnvValues(
        {
          URL: "https://${HOST}:6443",
          HOST: "192.168.1.124",
        },
        {},
      );
      expect(result).toEqual({
        URL: "https://:6443",
        HOST: "192.168.1.124",
      });
    });

    it("chain of references resolves correctly", () => {
      const result = expandEnvValues(
        {
          A: "hello",
          B: "${A} world",
          C: "${B}!",
        },
        {},
      );
      expect(result).toEqual({
        A: "hello",
        B: "hello world",
        C: "hello world!",
      });
    });
  });

  describe("env overlay precedence", () => {
    it("values in record override base env", () => {
      const result = expandEnvValues(
        {
          HOST: "override",
          MSG: "host is ${HOST}",
        },
        { HOST: "original" },
      );
      // HOST in the record is "override" (literal, no expansion needed) MSG references HOST — by
      // the time MSG is expanded, HOST is already resolved to "override" in the record
      expect(result).toEqual({
        HOST: "override",
        MSG: "host is override",
      });
    });

    it("base env is used when record doesn't define the var", () => {
      const result = expandEnvValues(
        { MSG: "user is $USER" },
        { USER: "alice" },
      );
      expect(result).toEqual({ MSG: "user is alice" });
    });
  });

  describe("plain values pass through", () => {
    it("values without variable syntax are unchanged", () => {
      const result = expandEnvValues({ PLAIN: "just a string", NUM: "42" }, {});
      expect(result).toEqual({ PLAIN: "just a string", NUM: "42" });
    });
  });

  describe("real-world: talos nopo.yml pattern", () => {
    it("TALOS_NODE with default, TALOSCONFIG using pwd-like expansion", () => {
      const result = expandEnvValues(
        {
          TALOS_NODE: "${TALOS_NODE:-192.168.1.124}",
          TALOSCONFIG: "${TALOSCONFIG:-/home/user/talos/talosconfig}",
        },
        {},
      );
      expect(result).toEqual({
        TALOS_NODE: "192.168.1.124",
        TALOSCONFIG: "/home/user/talos/talosconfig",
      });
    });

    it("respects user override from process env", () => {
      const result = expandEnvValues(
        {
          TALOS_NODE: "${TALOS_NODE:-192.168.1.124}",
          TALOSCONFIG: "${TALOSCONFIG:-/home/user/talos/talosconfig}",
        },
        {
          TALOS_NODE: "10.0.0.50",
        },
      );
      expect(result).toEqual({
        TALOS_NODE: "10.0.0.50",
        TALOSCONFIG: "/home/user/talos/talosconfig",
      });
    });
  });
});
