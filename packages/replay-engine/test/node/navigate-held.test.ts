import { describe, expect, it } from "vitest";
import { HELD_FRAME_MS } from "../../src/held-clock.js";
import { createNavigatingGuard } from "../../src/navigate.js";
import { createCdpFake } from "../helpers/cdp-fake";

/** On a held clock the page loads only as page time moves (measured
 *  2026-11-15: no document parses while it is held), so the start
 *  navigation's load is waited for a frame at a time. */
describe("the navigating guard on a held clock", () => {
  const guardOn = (loadAtMs: number | null, frameMs = HELD_FRAME_MS) => {
    const cdp = createCdpFake();
    let now = 0;
    const slept: number[] = [];
    const held = {
      frameMs,
      now: () => now,
      sleep: async (ms: number) => {
        slept.push(ms);
        now += ms;
        if (loadAtMs !== null && now >= loadAtMs)
          cdp.emit("Page.loadEventFired", {});
      },
    };
    const guard = createNavigatingGuard({
      guard: {
        install: async () => undefined,
        ensureVisible: async () => true,
        pauses: () => 0,
        pausedMs: () => 0,
        stalledSince: () => null,
      },
      cdp,
      url: "https://app.example.com/",
      timeoutMs: 1000,
      sleep: async () => {
        throw new Error("the real clock was slept on a held load");
      },
      held,
    });
    return { guard, slept, now: () => now };
  };

  it("plays page time a frame at a time until the page loads", async () => {
    const { guard, slept, now } = guardOn(150);
    await guard.install();
    expect(slept.every((ms) => ms === HELD_FRAME_MS)).toBe(true);
    // The first frame at or past the load, and not one more.
    expect(now()).toBeCloseTo(5 * HELD_FRAME_MS, 6);
    expect(guard.navigated()).toBe(true);
  });

  // DEM-265: a frame of its own clock, at 60 fps too.
  it("plays a frame of its clock's length at 60", async () => {
    const F60 = 1000 / 60;
    const { guard, slept, now } = guardOn(150, F60);
    await guard.install();
    expect(slept.length).toBeGreaterThan(0);
    expect(slept.every((ms) => ms === F60)).toBe(true);
    expect(now()).toBeCloseTo(9 * F60, 6);
  });

  it("stops at its bound, in page time, when the page never loads", async () => {
    const { guard, now } = guardOn(null);
    await guard.install();
    expect(now()).toBeGreaterThanOrEqual(1000);
    expect(now()).toBeLessThan(1000 + HELD_FRAME_MS);
  });
});
