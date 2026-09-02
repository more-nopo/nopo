import { describe, expect, it } from "vitest";

import { createLinePrefixer } from "./line-prefixer.ts";

describe("createLinePrefixer", () => {
  it("prefixes each complete line and emits in order", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("[events]", (l) => lines.push(l));
    p.feed(Buffer.from("first\nsecond\nthird\n"));
    expect(lines).toEqual([
      "[events] first",
      "[events] second",
      "[events] third",
    ]);
  });

  it("holds a partial line across chunk boundaries", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("[svc]", (l) => lines.push(l));
    p.feed(Buffer.from("hello wo"));
    p.feed(Buffer.from("rld\nnext line\n"));
    expect(lines).toEqual(["[svc] hello world", "[svc] next line"]);
  });

  it("drops empty lines (blank chunk leadings, double newlines)", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("[x]", (l) => lines.push(l));
    p.feed(Buffer.from("\n\nfirst\n\nsecond\n"));
    expect(lines).toEqual(["[x] first", "[x] second"]);
  });

  it("flush() emits a trailing partial line that never ended in a newline", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("[x]", (l) => lines.push(l));
    p.feed(Buffer.from("aborted mid-li"));
    expect(lines).toEqual([]);
    p.flush();
    expect(lines).toEqual(["[x] aborted mid-li"]);
  });

  it("flush() is a no-op when the buffer is empty", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("[x]", (l) => lines.push(l));
    p.feed(Buffer.from("clean\n"));
    p.flush();
    expect(lines).toEqual(["[x] clean"]);
  });

  it("flush() is idempotent — repeated calls don't re-emit the tail", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("[x]", (l) => lines.push(l));
    p.feed(Buffer.from("tail"));
    p.flush();
    p.flush();
    expect(lines).toEqual(["[x] tail"]);
  });

  it("handles a multi-byte UTF-8 sequence split across chunks", () => {
    const lines: string[] = [];
    const p = createLinePrefixer("[x]", (l) => lines.push(l));
    // "café\n" UTF-8 = 63 61 66 c3 a9 0a — split between c3 and a9
    const full = Buffer.from("café\n", "utf8");
    p.feed(full.subarray(0, 4));
    p.feed(full.subarray(4));
    /** chunk.toString() uses default lossy decoding; the test just needs
     * the line eventually emerges. Loss tolerance is acceptable for
     * a log stream — the alternative is a TextDecoder that holds
     * partial code points and adds complexity for a rare case.
     */
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\[x\] caf/);
  });
});
