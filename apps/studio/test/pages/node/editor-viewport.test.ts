import { describe, expect, it } from "vitest";
import {
  fitAll,
  MIN_SPAN_MS,
  pan,
  spanToZoom,
  toFraction,
  toMs,
  zoomAt,
  zoomTo,
  zoomToSpan,
} from "../../../pages/src/editor/viewport";

const DURATION = 16_000;

describe("viewport", () => {
  it("fits the whole take", () => {
    expect(fitAll(DURATION)).toEqual({ startMs: 0, endMs: DURATION });
  });

  it("keeps the instant under the pointer under the pointer", () => {
    // Away from both edges, where clamping is not in play. At an edge the
    // clamp wins by design and this invariant does not hold — that case is
    // the next test.
    const start = { startMs: 4000, endMs: 12_000 };
    const before = toMs(start, 0.5);
    const after = zoomAt(start, DURATION, 2, 0.5);
    expect(toMs(after, 0.5)).toBeCloseTo(before, 6);

    // Off-centre case to ensure fraction is actually weighted, not ignored.
    const offCentre = toMs(start, 0.25);
    const afterOffCentre = zoomAt(start, DURATION, 2, 0.25);
    expect(toMs(afterOffCentre, 0.25)).toBeCloseTo(offCentre, 6);
  });

  it("never scrolls past either end of the take", () => {
    const zoomed = zoomAt(fitAll(DURATION), DURATION, 4, 0);
    const panned = pan(zoomed, DURATION, -99_999);
    expect(panned.startMs).toBe(0);
    const far = pan(zoomed, DURATION, 99_999);
    expect(far.endMs).toBeLessThanOrEqual(DURATION);
  });

  it("refuses to zoom out past the whole take", () => {
    expect(zoomAt(fitAll(DURATION), DURATION, 0.25, 0.5)).toEqual({
      startMs: 0,
      endMs: DURATION,
    });
  });

  it("stops zooming in at the minimum span", () => {
    let viewport = fitAll(DURATION);
    for (let i = 0; i < 20; i++) {
      viewport = zoomAt(viewport, DURATION, 2, 0.5);
    }
    expect(viewport.endMs - viewport.startMs).toBe(MIN_SPAN_MS);
  });

  it("converts both ways", () => {
    const viewport = { startMs: 2000, endMs: 6000 };
    expect(toFraction(viewport, 4000)).toBeCloseTo(0.5, 6);
    expect(toMs(viewport, 0.25)).toBe(3000);
  });
});

describe("zoom to a span", () => {
  it("shows the span it is asked for, about the fraction it is given", () => {
    const start = { startMs: 4000, endMs: 12_000 };
    // The positive control: the window this starts from is NOT the span
    // asked for, so an implementation that returned its input unchanged
    // would fail the first assertion below.
    expect(start.endMs - start.startMs).not.toBe(2000);
    const after = zoomTo(start, DURATION, 2000, 0.5);
    expect(after.endMs - after.startMs).toBe(2000);
    // And the instant under that fraction stayed there.
    expect(toMs(after, 0.5)).toBeCloseTo(toMs(start, 0.5), 6);
  });

  it("clamps to the take and to the floor", () => {
    expect(zoomTo(fitAll(DURATION), DURATION, 99_999, 0.5)).toEqual({
      startMs: 0,
      endMs: DURATION,
    });
    const tight = zoomTo(fitAll(DURATION), DURATION, 1, 0.5);
    expect(tight.endMs - tight.startMs).toBe(MIN_SPAN_MS);
  });

  it("widens again from a window sitting on the floor", () => {
    // The slider's leftward travel: every step of it starts from wherever
    // the knob already is, including the end of its own range.
    const floored = zoomTo(fitAll(DURATION), DURATION, MIN_SPAN_MS, 0.5);
    expect(floored.endMs - floored.startMs).toBe(MIN_SPAN_MS);
    const wider = zoomTo(floored, DURATION, 4000, 0.5);
    expect(wider.endMs - wider.startMs).toBe(4000);
  });
});

describe("the zoom slider's travel", () => {
  it("runs from the whole take to the floor", () => {
    expect(zoomToSpan(DURATION, 0)).toBe(DURATION);
    expect(zoomToSpan(DURATION, 1)).toBeCloseTo(MIN_SPAN_MS, 6);
  });

  it("gives every doubling the same distance", () => {
    // Geometric, not linear: the span at the midpoint is the geometric mean
    // of the ends, which for a linear map would be their average instead.
    const mid = zoomToSpan(DURATION, 0.5);
    expect(mid).toBeCloseTo(Math.sqrt(DURATION * MIN_SPAN_MS), 6);
    expect(mid).not.toBeCloseTo((DURATION + MIN_SPAN_MS) / 2, 0);
  });

  it("round-trips, so the wheel and the knob agree", () => {
    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
      expect(spanToZoom(DURATION, zoomToSpan(DURATION, value))).toBeCloseTo(
        value,
        6,
      );
    }
  });

  it("parks the knob at the whole take when the take is shorter than the floor", () => {
    const tiny = 100;
    expect(tiny).toBeLessThan(MIN_SPAN_MS);
    expect(spanToZoom(tiny, MIN_SPAN_MS)).toBe(0);
    expect(Number.isFinite(spanToZoom(tiny, MIN_SPAN_MS))).toBe(true);
  });
});
