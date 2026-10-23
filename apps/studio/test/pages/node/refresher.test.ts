// apps/studio/test/pages/node/refresher.test.ts
import { describe, expect, it, vi } from "vitest";
import { createRefresher } from "../../../pages/src/shell/refresher";

/** A paint that records each call and stays open until released. */
function heldPaints() {
  const calls: { keepNotice: boolean; release: () => void }[] = [];
  const paint = (keepNotice: boolean) =>
    new Promise<void>((resolve) => {
      calls.push({ keepNotice, release: resolve });
    });
  return { calls, paint };
}

/** Lets every promise already settled run its handlers. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createRefresher", () => {
  it("a burst of refreshes costs one paint in flight and one after it", async () => {
    const { calls, paint } = heldPaints();
    const r = createRefresher({ paint, onRefreshFailed: vi.fn() });
    r.soon();
    await flush();
    // The premise: the first is in flight (its read began), and the rest
    // are asked while it runs — after its read, so it cannot cover them.
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 4; i++) r.soon();
    await flush();
    expect(calls).toHaveLength(1);
    calls[0]?.release();
    await flush();
    // Red: drop `again` — the four asked during the first are lost.
    expect(calls).toHaveLength(2);
    calls[1]?.release();
    await flush();
    // Red: start one per `soon` — five paints, not two.
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.keepNotice)).toEqual([true, true]);
  });

  it("a refresh asked before an action's render began is covered by it, and skipped", async () => {
    const { calls, paint } = heldPaints();
    const r = createRefresher({ paint, onRefreshFailed: vi.fn() });
    const action = r.render();
    await flush();
    // The premise: the action's paint has begun, and clears the notice.
    expect(calls.map((c) => c.keepNotice)).toEqual([false]);
    calls[0]?.release();
    await action;
    // Asked after that read began: not covered, so it paints.
    r.soon();
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]?.release();
    await flush();
    // Asked, then an action's render begins reading before the refresh's
    // turn comes: the refresh is covered.
    const blocker = r.render();
    r.soon();
    const after = r.render();
    await flush();
    calls[2]?.release();
    await blocker;
    await flush();
    // Red: drop the `readFrom >= unlessReadSince` skip — the refresh paints
    // here (keepNotice true) ahead of the second action's render.
    expect(calls.map((c) => c.keepNotice)).toEqual([false, true, false, false]);
    calls[3]?.release();
    await after;
    await flush();
    expect(calls).toHaveLength(4);
  });

  it("holds a refresh while hold() is true, and resume() runs it once", async () => {
    const { calls, paint } = heldPaints();
    let editing = true;
    const r = createRefresher({
      paint,
      onRefreshFailed: vi.fn(),
      hold: () => editing,
    });
    r.soon();
    r.soon();
    await flush();
    // Red: drop the hold check in start — it paints under the edit.
    expect(calls).toHaveLength(0);
    // Still editing: resume does nothing.
    r.resume();
    await flush();
    expect(calls).toHaveLength(0);
    editing = false;
    r.resume();
    await flush();
    expect(calls).toHaveLength(1);
    calls[0]?.release();
    await flush();
    // Both asks folded into the one read.
    expect(calls).toHaveLength(1);
    r.resume();
    await flush();
    // Nothing held now: resume is a no-op.
    expect(calls).toHaveLength(1);
  });

  it("a refresh that fails is said, and a later one still runs", async () => {
    const failed = vi.fn();
    let n = 0;
    const r = createRefresher({
      paint: async () => {
        n += 1;
        if (n === 1) throw new Error("the store would not open");
      },
      onRefreshFailed: failed,
    });
    r.soon();
    await flush();
    // Red: drop the `.catch(o.onRefreshFailed)` — an unhandled rejection.
    expect(failed).toHaveBeenCalledWith(new Error("the store would not open"));
    r.soon();
    await flush();
    expect(n).toBe(2);
  });

  it("an action's render rejects with its paint's error, and the next render still runs", async () => {
    let n = 0;
    const r = createRefresher({
      paint: async () => {
        n += 1;
        if (n === 1) throw new Error("first");
      },
      onRefreshFailed: vi.fn(),
    });
    await expect(r.render()).rejects.toThrow("first");
    await expect(r.render()).resolves.toBeUndefined();
    expect(n).toBe(2);
  });
});
