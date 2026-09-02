import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitInfo } from "../src/git-info.ts";

// We need to mock the $ function from lib.ts to test GitInfo without real git
vi.mock("../src/lib.ts", () => ({
  $: {
    sync: vi.fn(),
  },
}));

import { $ } from "../src/lib.ts";

describe("GitInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getDefaultBranch", () => {
    it("returns branch from symbolic-ref when available", () => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
      vi.mocked($.sync).mockReturnValueOnce({
        stdout: "refs/remotes/origin/main\n",
      } as ReturnType<typeof $.sync>);

      expect(GitInfo.getDefaultBranch()).toBe("origin/main");
    });

    it("returns master when symbolic-ref shows origin/master", () => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
      vi.mocked($.sync).mockReturnValueOnce({
        stdout: "refs/remotes/origin/master\n",
      } as ReturnType<typeof $.sync>);

      expect(GitInfo.getDefaultBranch()).toBe("origin/master");
    });

    it("falls back to main when symbolic-ref fails but origin/main exists", () => {
      vi.mocked($.sync)
        // First call: symbolic-ref fails
        .mockImplementationOnce(() => {
          throw new Error(
            "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref",
          );
        })
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
        .mockReturnValueOnce({
          stdout: "abc123\n",
        } as ReturnType<typeof $.sync>);

      expect(GitInfo.getDefaultBranch()).toBe("origin/main");
    });

    it("falls back to master when symbolic-ref fails and origin/main does not exist", () => {
      vi.mocked($.sync)
        // First call: symbolic-ref fails
        .mockImplementationOnce(() => {
          throw new Error(
            "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref",
          );
        })
        // Second call: rev-parse origin/main fails
        .mockImplementationOnce(() => {
          throw new Error("fatal: Needed a single revision");
        })
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
        .mockReturnValueOnce({
          stdout: "def456\n",
        } as ReturnType<typeof $.sync>);

      expect(GitInfo.getDefaultBranch()).toBe("origin/master");
    });

    it("defaults to main when all detection methods fail", () => {
      vi.mocked($.sync)
        // All calls fail
        .mockImplementation(() => {
          throw new Error("git command failed");
        });

      expect(GitInfo.getDefaultBranch()).toBe("origin/main");
    });
  });

  describe("getChangedFiles", () => {
    it("returns list of changed files using merge-base", () => {
      vi.mocked($.sync)
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
        .mockReturnValueOnce({
          stdout: "abc123\n",
        } as ReturnType<typeof $.sync>)
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
        .mockReturnValueOnce({
          stdout: "apps/backend/src/index.ts\napps/backend/src/lib.ts\n",
        } as ReturnType<typeof $.sync>);

      const result = GitInfo.getChangedFiles("origin/main");

      expect(result).toEqual([
        "apps/backend/src/index.ts",
        "apps/backend/src/lib.ts",
      ]);
    });

    it("returns empty array when no files changed", () => {
      vi.mocked($.sync)
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
        .mockReturnValueOnce({
          stdout: "abc123\n",
        } as ReturnType<typeof $.sync>)
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
        .mockReturnValueOnce({
          stdout: "",
        } as ReturnType<typeof $.sync>);

      const result = GitInfo.getChangedFiles("origin/main");

      expect(result).toEqual([]);
    });

    it("filters out empty lines from diff output", () => {
      vi.mocked($.sync)
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
        .mockReturnValueOnce({
          stdout: "abc123\n",
        } as ReturnType<typeof $.sync>)
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
        .mockReturnValueOnce({
          stdout: "file1.ts\n\nfile2.ts\n\n",
        } as ReturnType<typeof $.sync>);

      const result = GitInfo.getChangedFiles("origin/main");

      expect(result).toEqual(["file1.ts", "file2.ts"]);
    });

    it("falls back to direct diff when merge-base fails", () => {
      vi.mocked($.sync)
        // First call: merge-base fails
        .mockImplementationOnce(() => {
          throw new Error("fatal: Not a valid object name");
        })
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
        .mockReturnValueOnce({
          stdout: "apps/web/src/App.tsx\n",
        } as ReturnType<typeof $.sync>);

      const result = GitInfo.getChangedFiles("origin/main");

      expect(result).toEqual(["apps/web/src/App.tsx"]);
    });

    it("returns empty array when both merge-base and direct diff fail", () => {
      vi.mocked($.sync).mockImplementation(() => {
        throw new Error("git command failed");
      });

      const result = GitInfo.getChangedFiles("origin/main");

      expect(result).toEqual([]);
    });
  });

  describe("exists", () => {
    it("returns true when git is available", () => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock partial return value for testing
      vi.mocked($.sync).mockReturnValueOnce({
        stdout: "git version 2.39.0\n",
      } as ReturnType<typeof $.sync>);

      expect(GitInfo.exists()).toBe(true);
    });

    it("returns false when git is not available", () => {
      vi.mocked($.sync).mockImplementationOnce(() => {
        throw new Error("command not found: git");
      });

      expect(GitInfo.exists()).toBe(false);
    });
  });
});
