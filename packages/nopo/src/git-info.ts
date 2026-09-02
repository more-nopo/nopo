import { z } from "zod";

import { $ } from "./lib.ts";

const ParsedGitInfo = z.object({
  repo: z.string(),
  branch: z.string(),
  commit: z.string(),
});

export type GitInfoType = z.infer<typeof ParsedGitInfo>;

export class GitInfo {
  static exists(): boolean {
    try {
      this.git("--version");
      return true;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return false;
    }
  }

  static git(...pieces: string[]): string {
    return $.sync`git ${pieces}`.stdout.trim();
  }

  static get repo(): string {
    return this.git("remote", "get-url", "origin");
  }

  static get branch(): string {
    return this.git("rev-parse", "--abbrev-ref", "HEAD");
  }

  static get commit(): string {
    return this.git("rev-parse", "HEAD");
  }

  static parse(): GitInfoType {
    return ParsedGitInfo.parse({
      repo: this.repo,
      branch: this.branch,
      commit: this.commit,
    });
  }

  /** Resolve the default branch as a **remote-tracking ref (`origin/main` / `origin/master`).
   * Returning the remote form matters because CI checkouts often don't have the local branch
   * created — only `origin/<branch>`. `git merge-base main HEAD` against a non-existent
   * local branch silently errors
   */
  static getDefaultBranch(): string {
    try {
      // Primary: read remote HEAD's symbolic ref
      const ref = this.git("symbolic-ref", "refs/remotes/origin/HEAD");
      const match = ref.match(/refs\/remotes\/(origin\/.+)/);
      if (match && match[1]) {
        return match[1];
      }
    } catch {
      // Ignore errors, fall back to probing common defaults
    }

    // Fallback: probe common remote branches directly
    try {
      this.git("rev-parse", "--verify", "origin/main");
      return "origin/main";
    } catch {
      try {
        this.git("rev-parse", "--verify", "origin/master");
        return "origin/master";
      } catch {
        return "origin/main";
      }
    }
  }

  /**
   * Return the commit timestamp (UNIX seconds) for a sha, or null on error.
   */
  static getCommitTimestamp(sha: string): number | null {
    try {
      const ts = parseInt(this.git("log", "-1", "--format=%ct", sha), 10);
      return Number.isFinite(ts) ? ts : null;
    } catch {
      return null;
    }
  }

  /**
   * Get the list of files that have changed compared to a reference.
   * @param since - Git reference to compare against (branch, commit, tag)
   * @returns Array of file paths relative to the repository root
   */
  static getChangedFiles(since: string): string[] {
    try {
      // Get the merge base between the current HEAD and the reference
      // This handles cases where the branch has diverged from the reference
      const mergeBase = this.git("merge-base", since, "HEAD");
      const output = this.git("diff", "--name-only", mergeBase, "HEAD");
      if (!output) return [];
      return output.split("\n").filter((line) => line.length > 0);
    } catch {
      // If merge-base fails (e.g., no common ancestor), fall back to direct diff
      try {
        const output = this.git("diff", "--name-only", since, "HEAD");
        if (!output) return [];
        return output.split("\n").filter((line) => line.length > 0);
      } catch {
        // If all else fails, return empty array (no changes detected)
        return [];
      }
    }
  }
}
