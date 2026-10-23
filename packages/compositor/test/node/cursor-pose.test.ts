import { describe, expect, it } from "vitest";
import type { CursorSample } from "../../src/bundle";
import { sampleCursor } from "../../src/plan/resolve";
import type { Timeline } from "../../src/plan/timeline";
import {
  cursorPressScale,
  cursorTiltRad,
  cursorTiltRawRad,
  PRESS_DEPTH,
  RELEASE_MS,
  TILT_MAX_RAD,
  TILT_SETTLE_MS,
} from "../../src/render/cursor-pose";
import { PRESS_DURATION_MS } from "../../src/render/draw-cursor";

describe("cursorPressScale", () => {
  const click = 1000;
  const depth = PRESS_DEPTH;

  it("meets itself at the click: the press arrives where the release leaves", () => {
    const before = cursorPressScale(click - 1e-9, [click], 1);
    const at = cursorPressScale(click, [click], 1);
    expect(Math.abs(before - (1 - depth))).toBeLessThan(1e-9);
    expect(Math.abs(at - (1 - depth))).toBeLessThan(1e-9);
  });

  it("keeps today's depth at bounce 1, and scales it with the bounce", () => {
    // 0.14 is what `PRESS_SHRINK` was; the default re-renders an old take
    // with the same squeeze.
    expect(PRESS_DEPTH).toBe(0.14);
    expect(cursorPressScale(click, [click], 1)).toBeCloseTo(0.86, 12);
    expect(cursorPressScale(click, [click], 2)).toBeCloseTo(0.72, 12);
  });

  it("springs past 1 on the release, once, at bounce 1", () => {
    // What makes it a bounce and not a plain ease back: somewhere after the
    // click the arrow is LARGER than its own size. A release written as an
    // ease from 1 − A to 1 never gets there, and this goes red.
    let peak = 0;
    let peakAt = 0;
    for (let t = click; t <= click + RELEASE_MS; t += 1) {
      const scale = cursorPressScale(t, [click], 1);
      if (scale > peak) {
        peak = scale;
        peakAt = t - click;
      }
    }
    expect(peak, `peak ${peak} at +${peakAt}ms`).toBeGreaterThan(1.01);
    // ≈ 2% at 160ms, as the plan states — not a wobble that keeps going.
    expect(peak).toBeLessThan(1.03);
    expect(peakAt).toBeGreaterThan(100);
    expect(peakAt).toBeLessThan(220);
  });

  it("is exactly 1 outside the press and the release", () => {
    for (const t of [
      0,
      click - PRESS_DURATION_MS - 1,
      click + RELEASE_MS + 1,
      5000,
    ]) {
      expect(cursorPressScale(t, [click], 1), `at ${t}`).toBe(1);
    }
    expect(cursorPressScale(click, [], 1)).toBe(1);
  });

  it("presses not at all at bounce 0", () => {
    for (let t = click - 200; t <= click + 600; t += 5) {
      expect(cursorPressScale(t, [click], 0), `at ${t}`).toBe(1);
    }
  });

  it("does not jump between the two presses of a double-click", () => {
    // 150ms apart: the second press begins while the first release is still
    // springing. Switching to whichever click is nearer jumped a fifth of
    // the depth in one step at the midpoint.
    const clicks = [click, click + 150];
    // The fixture premise: the release really is mid-spring when the second
    // press's window opens, so there is something to jump from.
    const releaseThere = cursorPressScale(click + 40, [click], 1);
    expect(Math.abs(releaseThere - 1)).toBeGreaterThan(0.02);
    let worst = 0;
    let prior = cursorPressScale(click - 200, clicks, 1);
    for (let t = click - 199; t <= click + 800; t += 1) {
      const now = cursorPressScale(t, clicks, 1);
      worst = Math.max(worst, Math.abs(now - prior));
      prior = now;
    }
    // A 1ms step: the steepest honest slope is the release's own at the
    // click, A·(1/80) per ms ≈ 0.0018.
    expect(worst).toBeLessThan(0.004);
    // And both clicks press all the way down.
    expect(cursorPressScale(click + 150, clicks, 1)).toBeCloseTo(1 - depth, 9);
  });
});

/** Source time and output time are the same thing: nothing is retimed. */
const straight: Timeline = {
  segments: [
    {
      outStartMs: 0,
      outEndMs: 4000,
      srcStartMs: 0,
      srcEndMs: 4000,
      kind: "motion",
    },
  ],
  outputDurationMs: 4000,
  sourceDurationMs: 4000,
  unplacedPaces: 0,
  nonMonotonicPaces: 0,
  cuts: [],
  unplacedCuts: [],
  interruptions: [],
};

/**
 * Still at (100, 300) until 500ms, then 600 CSS px to the right in 500ms —
 * 1200 px/s, under the full-lean speed of 1.1 × 1280 = 1408 px/s — then
 * still again from 1000ms. A start and a stop, both abrupt.
 */
function sweep(dx: number, dy = 0): CursorSample[] {
  return [
    { sourceTimeMs: 0, x: 100, y: 300 },
    { sourceTimeMs: 500, x: 100, y: 300 },
    { sourceTimeMs: 1000, x: 100 + dx, y: 300 + dy },
    { sourceTimeMs: 3000, x: 100 + dx, y: 300 + dy },
  ];
}

const plan = (cursor: CursorSample[], width = 1280) => ({
  cursor,
  timeline: straight,
  plan: { viewport: { width, height: 800 } },
});

const rightward = plan(sweep(600));
const deg = (rad: number) => (rad * 180) / Math.PI;

describe("cursorTiltRad", () => {
  it("is read against a pointer that starts, moves right, and stops", () => {
    // The premise every case below leans on.
    expect(sampleCursor(rightward.cursor, 400)).toEqual({ x: 100, y: 300 });
    expect(sampleCursor(rightward.cursor, 750)?.x).toBeCloseTo(400, 9);
    expect(sampleCursor(rightward.cursor, 2000)).toEqual({ x: 700, y: 300 });
  });

  it("leans clockwise (positive) moving right, by the speed it moves at", () => {
    // 900ms: every tap of the kernel (back to 900 − 156) is mid-sweep, so the
    // smoothed lean equals the raw one exactly.
    const angle = cursorTiltRad(rightward, 900, 0.5);
    const expected = (1200 / (1.1 * 1280)) * TILT_MAX_RAD * 0.5;
    expect(angle).toBeGreaterThan(0);
    expect(angle).toBeCloseTo(expected, 9);
  });

  it("leans the other way moving left", () => {
    expect(cursorTiltRad(plan(sweep(-600)), 900, 0.5)).toBeLessThan(0);
  });

  it("stands upright at rest, before the move and once settled after it", () => {
    expect(cursorTiltRad(rightward, 300, 1)).toBe(0);
    expect(cursorTiltRad(rightward, 1000 + TILT_SETTLE_MS + 1, 1)).toBe(0);
    expect(cursorTiltRad(rightward, 2500, 1)).toBe(0);
    // ...and not before it is settled: the lean dies away, it does not snap.
    expect(
      cursorTiltRad(rightward, 1000 + TILT_SETTLE_MS - 30, 1),
    ).toBeGreaterThan(0);
  });

  it("does not lean at all at tilt 0", () => {
    expect(cursorTiltRad(rightward, 900, 0)).toBe(0);
  });

  it("never leans past 15° times the tilt, even fast and diagonal", () => {
    // Down-and-right, ten times the full-lean speed: the raw bias here is
    // (1 + 0.65)/√2 ≈ 1.17, which unclamped would lean ~17.5° at tilt 1.
    const diagonal = plan(sweep(6000, 6000));
    const vx = 6000 / 0.5;
    const unclampedBias = (vx + 0.65 * vx) / Math.hypot(vx, vx);
    expect(unclampedBias).toBeGreaterThan(1.1);
    for (const tilt of [0.25, 0.5, 1]) {
      const angle = cursorTiltRad(diagonal, 900, tilt);
      expect(angle).toBeGreaterThan(0);
      expect(angle).toBeLessThanOrEqual(TILT_MAX_RAD * tilt + 1e-12);
      // Saturated: at this speed the ceiling is what it reaches.
      expect(angle).toBeCloseTo(TILT_MAX_RAD * tilt, 9);
    }
    expect(deg(TILT_MAX_RAD)).toBeCloseTo(15, 12);
  });

  it("measures speed against the viewport, not in pixels", () => {
    // The same 1200 px/s across a page twice as wide is half as fast a move
    // across it. Both are under the saturation speed, so the halving shows.
    const narrow = cursorTiltRad(rightward, 900, 1);
    const wide = cursorTiltRad(plan(sweep(600), 2560), 900, 1);
    expect(narrow).toBeLessThan(TILT_MAX_RAD);
    expect(wide).toBeGreaterThan(0);
    expect(wide / narrow).toBeCloseTo(0.5, 9);
  });

  it("changes smoothly frame to frame through a start and a stop", () => {
    const frameMs = 1000 / 60;
    const jumps = (f: (t: number) => number) => {
      let worst = 0;
      let prior = f(0);
      for (let t = frameMs; t < 2000; t += frameMs) {
        const now = f(t);
        worst = Math.max(worst, Math.abs(now - prior));
        prior = now;
      }
      return worst;
    };
    const smoothed = jumps((t) => cursorTiltRad(rightward, t, 1));
    const raw = jumps((t) => cursorTiltRawRad(rightward, t, 1));
    const steady = cursorTiltRad(rightward, 900, 1);
    // The premise: unsmoothed, the stop really does throw the arrow upright
    // within about one frame — the raw lean falls from full to 0 over the
    // 16ms velocity window.
    expect(raw).toBeGreaterThan(0.9 * steady);
    // Smoothed, no frame moves it by more than a third of its lean; a kernel
    // reduced to its newest tap is the raw lean, and goes red here. Measured
    // 2026-10-09: 0.305 of it, which is the newest tap's own share of the
    // kernel's weight (1 / Σ e^(−k/3), k = 0..7) — the arithmetic floor for
    // a stop this abrupt, not a margin that will drift.
    expect(
      smoothed,
      `worst ${deg(smoothed)}°, steady ${deg(steady)}°`,
    ).toBeLessThan(steady / 3);
  });
});

describe("cursorPressScale through a hold", () => {
  const hold = { startMs: 1000, endMs: 1800 };
  const pressed = 1 - PRESS_DEPTH;

  it("stays pressed for the whole hold and springs back after it", () => {
    for (const t of [hold.startMs + 1, 1400, hold.endMs - 1]) {
      expect(cursorPressScale(t, [hold.startMs], 1, [hold])).toBeCloseTo(
        pressed,
        9,
      );
    }
    expect(
      cursorPressScale(hold.endMs + RELEASE_MS + 1, [hold.startMs], 1, [hold]),
    ).toBe(1);
    // The release is a spring from the hold's end, not from its press.
    expect(
      cursorPressScale(hold.endMs + 20, [hold.startMs], 1, [hold]),
    ).not.toBeCloseTo(1, 3);
  });

  // The positive control: the same instants with no hold are a click's
  // release, long since back to rest by the hold's middle.
  it("is a click, not a hold, without one", () => {
    expect(cursorPressScale(1400, [hold.startMs], 1)).toBe(1);
  });
});
