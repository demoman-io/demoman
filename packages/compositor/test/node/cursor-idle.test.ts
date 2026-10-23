import { describe, expect, it } from "vitest";
import {
  CURSOR_IDLE_FADE_MS,
  CURSOR_IDLE_HIDE_MS,
  cursorIdleAlpha,
  cursorRestSpans,
} from "../../src/plan/resolve";
import type { Timeline } from "../../src/plan/timeline";

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
  // Hand-built timelines: these cases are about the camera, the
  // cursor's idle fade and its trail, none of which a cut touches.
  cuts: [],
  unplacedCuts: [],
  interruptions: [],
};

/**
 * The retimer's normal output: 1000ms of motion at rate 1, then a 1200ms
 * dwell compressed 6x into 200ms, then motion again.
 */
const compressed: Timeline = {
  segments: [
    {
      outStartMs: 0,
      outEndMs: 1000,
      srcStartMs: 0,
      srcEndMs: 1000,
      kind: "motion",
    },
    {
      outStartMs: 1000,
      outEndMs: 1200,
      srcStartMs: 1000,
      srcEndMs: 2200,
      kind: "idle",
    },
    {
      outStartMs: 1200,
      outEndMs: 2200,
      srcStartMs: 2200,
      srcEndMs: 3200,
      kind: "motion",
    },
  ],
  outputDurationMs: 2200,
  sourceDurationMs: 3200,
  unplacedPaces: 0,
  nonMonotonicPaces: 0,
  // Hand-built timelines: these cases are about the camera, the
  // cursor's idle fade and its trail, none of which a cut touches.
  cuts: [],
  unplacedCuts: [],
  interruptions: [],
};

/** Moves, sits perfectly still from 1000ms to 2200ms, then moves again. */
const dwelling = [
  { sourceTimeMs: 0, x: 100, y: 100 },
  { sourceTimeMs: 1000, x: 300, y: 300 },
  { sourceTimeMs: 2200, x: 300, y: 300 },
  { sourceTimeMs: 3200, x: 600, y: 400 },
];

describe("cursorRestSpans", () => {
  it("finds the dwell when nothing compresses it", () => {
    const spans = cursorRestSpans(dwelling, straight, []);
    expect(spans).toEqual([{ startMs: 1000, endMs: 2200 }]);
  });

  it("finds NO rest when the retimer compresses the dwell below the threshold", () => {
    // 1200ms of stillness that the viewer sees for 200ms. Hiding the cursor
    // there is a flicker, not a fade. This is the assertion that fails the
    // moment the spans are measured on the source axis.
    expect(cursorRestSpans(dwelling, compressed, [])).toEqual([]);
  });

  it("splits a rest at a click, so the press never fires on a faded cursor", () => {
    const spans = cursorRestSpans(dwelling, straight, [1600]);
    expect(spans).toEqual([
      { startMs: 1000, endMs: 1600 },
      { startMs: 1600, endMs: 2200 },
    ]);
  });

  it("reports no rest at all when there are no samples, leaving the cursor visible", () => {
    expect(cursorRestSpans([], straight, [])).toEqual([]);
  });
});

describe("cursorIdleAlpha", () => {
  const rests = [{ startMs: 1000, endMs: 4000 }];

  it("is fully opaque before the threshold", () => {
    expect(cursorIdleAlpha(rests, 1000)).toBe(1);
    expect(cursorIdleAlpha(rests, 1000 + CURSOR_IDLE_HIDE_MS - 1)).toBe(1);
  });

  it("fades out across the fade window once the threshold passes", () => {
    const start = 1000 + CURSOR_IDLE_HIDE_MS;
    expect(cursorIdleAlpha(rests, start + CURSOR_IDLE_FADE_MS / 2)).toBeCloseTo(
      0.5,
      2,
    );
    expect(cursorIdleAlpha(rests, start + CURSOR_IDLE_FADE_MS)).toBe(0);
  });

  it("fades back in from the end of the rest", () => {
    expect(cursorIdleAlpha(rests, 4000)).toBe(0);
    expect(cursorIdleAlpha(rests, 4000 + CURSOR_IDLE_FADE_MS / 2)).toBeCloseTo(
      0.5,
      2,
    );
    expect(cursorIdleAlpha(rests, 4000 + CURSOR_IDLE_FADE_MS)).toBe(1);
  });

  it("resumes the fade-in from the opacity the fade-out reached", () => {
    // A rest only a little past the threshold is still mid-ramp when it
    // ends. Starting the fade-in at 0 put the pointer at fully transparent
    // on the frame it began moving again; the point of the fade is that it
    // never does that.
    const midRampRests = [{ startMs: 1000, endMs: 2200 }]; // D = 1200, mid-ramp at its end
    const justInside = cursorIdleAlpha(midRampRests, 2199);
    const atEnd = cursorIdleAlpha(midRampRests, 2200);
    expect(justInside).toBeGreaterThan(0);
    expect(atEnd).toBeCloseTo(justInside, 2);
    expect(cursorIdleAlpha(midRampRests, 2200 + CURSOR_IDLE_FADE_MS)).toBe(1);
  });

  it("is fully opaque outside every rest", () => {
    expect(cursorIdleAlpha(rests, 500)).toBe(1);
    expect(cursorIdleAlpha([], 2500)).toBe(1);
  });

  it("does not fade IN from a rest that never faded out", () => {
    // `cursorRestSpans` filters these out, but this function is public and
    // is asserted on its own contract: a rest shorter than the threshold
    // never dimmed, so there is nothing to come back from, and a fade-in
    // there would be a pointer brightening out of full opacity.
    const brief = [{ startMs: 1000, endMs: 1000 + CURSOR_IDLE_HIDE_MS / 2 }];
    const briefEndMs = brief[0]?.endMs;
    if (briefEndMs === undefined) throw new Error("brief span missing");
    expect(cursorIdleAlpha(brief, briefEndMs + 50)).toBe(1);
  });
});

describe("cursorRestSpans and cursorIdleAlpha together", () => {
  it("produces no fade at all when a click splits a dwell into sub-threshold halves", () => {
    // Documents the consequence of "a click re-arms the idle timer", on the
    // opacity a viewer would actually see rather than on the spans in
    // between. This does NOT guard the threshold-before-split placement in
    // `cursorRestSpans`: it would also read 1 throughout if that placement
    // regressed to filtering after the split, because the regression makes
    // `spans` empty and an empty rest list is 1 everywhere. The guard for
    // that regression is "splits a rest at a click, so the press never
    // fires on a faded cursor" above, which fails outright (`[]` vs two
    // spans) the moment the placement moves.
    const spans = cursorRestSpans(dwelling, straight, [1600]);
    for (const t of [1200, 1500, 1599, 1700, 2100, 2199, 2250]) {
      expect(cursorIdleAlpha(spans, t)).toBe(1);
    }
  });
});
