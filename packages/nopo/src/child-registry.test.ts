import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  type KillableChild,
  killTrackedChildren,
  trackChild,
  trackedChildCount,
} from "./child-registry.ts";

/** A fake child: an EventEmitter (for `once`/`emit`) with a spied `kill`.
 * Object.assign keeps the type inferred — no assertions needed. */
function fakeChild(): EventEmitter &
  KillableChild & { kill: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { kill: vi.fn() });
}

describe("child registry", () => {
  it("tracks a child and kills it with the given signal", () => {
    const a = fakeChild();
    const before = trackedChildCount();
    trackChild(a);
    expect(trackedChildCount()).toBe(before + 1);

    const killed = killTrackedChildren("SIGTERM");
    expect(killed).toBeGreaterThanOrEqual(1);
    expect(a.kill).toHaveBeenCalledWith("SIGTERM");

    a.emit("close"); // cleanup so the shared set doesn't leak into other tests
    expect(trackedChildCount()).toBe(before);
  });

  it("auto-removes a child when it closes", () => {
    const a = fakeChild();
    const before = trackedChildCount();
    trackChild(a);
    a.emit("close");
    expect(trackedChildCount()).toBe(before);
  });

  it("auto-removes a child when it errors", () => {
    const a = fakeChild();
    const before = trackedChildCount();
    trackChild(a);
    a.emit("error");
    expect(trackedChildCount()).toBe(before);
  });

  it("swallows kill errors and still counts the others", () => {
    const ok = fakeChild();
    const bad = fakeChild();
    bad.kill.mockImplementation(() => {
      throw new Error("already exited");
    });
    trackChild(ok);
    trackChild(bad);
    expect(() => killTrackedChildren()).not.toThrow();
    expect(ok.kill).toHaveBeenCalled();
    ok.emit("close");
    bad.emit("close");
  });
});
