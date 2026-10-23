import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import {
  cursorMotionSpans,
  holdThroughRests,
  resolvePlan,
  sampleCursor,
} from "../../src/plan/resolve";
import { CURSOR_REST_MS } from "../../src/plan/smooth";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

/**
 * A hand that moves for two frames, stops for two seconds, then moves again.
 *
 * The stop records NOTHING. Chrome fires no `pointermove` while the mouse is
 * untouched, and `createPointerSampler` would dedupe a repeat anyway, so a
 * pause is a hole between two real samples rather than a run of equal ones.
 * That is the same shape `holdAcrossGaps` exists for and a different reason:
 * there the position was unknown, here it is known and unchanged.
 */
const pausing = [
  { sourceTimeMs: 0, x: 100, y: 100 },
  { sourceTimeMs: 16, x: 108, y: 102 },
  { sourceTimeMs: 2016, x: 300, y: 400 },
];

/** Two frames' worth of ordinary 60Hz movement. Nothing here is a pause. */
const moving = Array.from({ length: 40 }, (_, i) => ({
  sourceTimeMs: i * 16,
  x: 100 + i * 6,
  y: 100 + i * 2,
}));

describe("holdThroughRests", () => {
  it("keeps the cursor where it was through the pause", () => {
    const held = holdThroughRests(pausing, CURSOR_REST_MS);
    expect(sampleCursor(held, 500)).toEqual({ x: 108, y: 102 });
    expect(sampleCursor(held, 1000)).toEqual({ x: 108, y: 102 });
    expect(sampleCursor(held, 2000)).toEqual({ x: 108, y: 102 });
  });

  it("is holding a pause that otherwise renders as a two-second glide", () => {
    // Fixture guard. Unheld, the same samples interpolate the cursor the
    // whole way to the next target while the hand sits still — if this stops
    // being true the assertion above is passing for free.
    // 984ms into a 2000ms hole: 49.2% of the way from (108,102) to
    // (300,400), i.e. most of the distance to a target the hand has not
    // started moving towards yet.
    expect(sampleCursor(pausing, 1000)?.x).toBeCloseTo(202.46, 1);
    expect(sampleCursor(pausing, 1000)?.y).toBeCloseTo(248.62, 1);
  });

  it("leaves the real samples in place and in order", () => {
    const held = holdThroughRests(pausing, CURSOR_REST_MS);
    for (const sample of pausing) expect(held).toContainEqual(sample);
    const times = held.map((s) => s.sourceTimeMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("does not hold anywhere in ordinary 60Hz movement", () => {
    // The threshold must not eat motion. While the pointer moves,
    // `pointermove` coalesces to at least one sample per frame, so a stream
    // this dense contains no pause at all and must come back untouched.
    expect(holdThroughRests(moving, CURSOR_REST_MS)).toEqual(moving);
  });

  it("is a no-op at a zero threshold", () => {
    expect(holdThroughRests(pausing, 0)).toEqual(pausing);
  });
});

describe("cursorMotionSpans across a pause", () => {
  it("stops reporting a held pause as cursor travel", () => {
    // The retimer passes cursor-motion spans at rate 1.0, so an unheld pause
    // is two seconds of a static page protected from compression — the
    // author's dead air, preserved because the interpolator thought the
    // pointer was crossing it.
    const spans = cursorMotionSpans(holdThroughRests(pausing, CURSOR_REST_MS));
    expect(spans).not.toContainEqual({ startMs: 16, endMs: 2016 });
    expect(spans.some((s) => s.endMs - s.startMs > 100)).toBe(false);
  });

  it("is measuring a pause the unheld samples really do protect", () => {
    // Fixture guard for the assertion above.
    expect(cursorMotionSpans(pausing)).toContainEqual({
      startMs: 16,
      endMs: 2016,
    });
  });
});

// Exercising the helper proves nothing about whether `resolvePlan` calls it.
// This goes through resolve itself, the way `cursor-gaps.test.ts` does, so an
// unwired call is caught.
describe("resolvePlan", () => {
  const captureBundle = () =>
    proceduralBundle({
      source: "capture",
      cursorSamples: [
        { sourceTimeMs: 0, x: 100, y: 100 },
        { sourceTimeMs: 16, x: 108, y: 102 },
        { sourceTimeMs: 32, x: 116, y: 104 },
        { sourceTimeMs: 2032, x: 700, y: 600 },
        { sourceTimeMs: 2048, x: 708, y: 602 },
      ],
    });

  it("holds the resolved cursor through a pause in a capture take", () => {
    const scene = readonlyScene();
    const bundle = captureBundle();
    const resolved = resolvePlan(planScene(scene), bundle, scene);

    const drawn = sampleCursor(resolved.cursor, 1000);
    const before = sampleCursor(bundle.cursorSamples, 32);
    expect(drawn).not.toBeNull();
    expect(before).not.toBeNull();
    if (!drawn || !before) throw new Error("no cursor position");
    expect(Math.hypot(drawn.x - before.x, drawn.y - before.y)).toBeLessThan(2);
  });

  it("is resolving a bundle whose raw samples glide across that pause", () => {
    // Fixture guard: the raw path really does cross most of the screen here.
    const raw = sampleCursor(captureBundle().cursorSamples, 1000);
    expect(raw?.x).toBeGreaterThan(300);
  });
});
