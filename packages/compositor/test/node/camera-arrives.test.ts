import { describe, expect, it } from "vitest";
import {
  CAMERA_DEFAULTS,
  motionTimings,
  returnsBetween,
  solveCamera,
} from "../../src/plan/camera";
import type { Timeline } from "../../src/plan/timeline";
import type { CameraIntent } from "../../src/plan/types";

// Output time is source time, so every number below reads as it is.
const timeline: Timeline = {
  segments: [
    {
      outStartMs: 0,
      outEndMs: 30_000,
      srcStartMs: 0,
      srcEndMs: 30_000,
      kind: "motion",
    },
  ],
  outputDurationMs: 30_000,
  sourceDurationMs: 30_000,
  unplacedPaces: 0,
  nonMonotonicPaces: 0,
  cuts: [],
  unplacedCuts: [],
  interruptions: [],
};
const viewport = { width: 1280, height: 800 };
const rectOf = () => ({ x: 600, y: 380, width: 200, height: 120 });
const timings = motionTimings(1);
const zoomOn = (
  id: string,
  actionId: string,
  arrives?: "pan" | "return",
): CameraIntent => ({
  id,
  kind: "zoom",
  anchorId: "an",
  point: null,
  actionId,
  offsetMs: CAMERA_DEFAULTS.leadInMs,
  scale: 1.8,
  end: null,
  ...(arrives === undefined ? {} : { arrives }),
});

// Two zooms: `first` at 1000, `second` at PAN_AT (too close to return
// between) or RETURN_AT (room for both moves).
const PAN_AT = 2_600;
const RETURN_AT = 9_000;
/** What the renderer's own clock says for the pair; no drag, so the first
 *  zoom is held only until its own arrival. */
const clockReturns = (secondMs: number) =>
  returnsBetween(
    1000 + CAMERA_DEFAULTS.leadInMs,
    secondMs + CAMERA_DEFAULTS.leadInMs,
    timings,
  );

const solve = (
  secondMs: number,
  arrives: "pan" | "return" | undefined,
  gapAfterActionIds: string[] = [],
) =>
  solveCamera(
    [zoomOn("z1", "first"), zoomOn("z2", "second", arrives)],
    rectOf,
    timeline,
    new Map([
      ["first", 1000],
      ["second", secondMs],
    ]),
    viewport,
    null,
    undefined,
    undefined,
    [],
    gapAfterActionIds,
  );
const scales = (r: ReturnType<typeof solve>) => r.keys.map((k) => k.scale);
const PANNED = [1, 1.8, 1.8, 1];
const RETURNED = [1, 1.8, 1, 1.8, 1];

describe("a zoom that records how the camera arrives", () => {
  // Red when `arrivesOf` ignores `seed.arrives` (its
  // `if (seed.arrives !== null && !edited(before, seed))` branch): the clock
  // would return here.
  it("pans on a recorded pan where the clock would return", () => {
    expect(clockReturns(RETURN_AT)).toBe(true);
    expect(scales(solve(RETURN_AT, undefined))).toEqual(RETURNED);
    expect(scales(solve(RETURN_AT, "pan"))).toEqual(PANNED);
  });

  // Final review, Important 1: a recorded return with no room for one used
  // to be obeyed, and the pull-out left 25 ms after the arrival, so the
  // camera was a third of the way out at the click. Red if `arrivesOf`
  // follows a recorded return that does not fit (its `!fits` test goes):
  // the scales would be RETURNED and the keys the squeezed return's.
  it("pans on a recorded return the gap has no room for, exactly as the clock does", () => {
    // Premise: the clock pans here (a 1600 ms gap against 3250 at this
    // smoothness), so the record and the clock disagree.
    expect(clockReturns(PAN_AT)).toBe(false);
    const clock = solve(PAN_AT, undefined);
    expect(scales(clock)).toEqual(PANNED);
    const recorded = solve(PAN_AT, "return");
    expect(recorded.keys).toEqual(clock.keys);
    // And the camera is settled at the first click: the pan to the second
    // departs a plateau after the first beat has arrived and acted.
    const [, first, second] = recorded.keys;
    if (first === undefined || second === undefined)
      throw new Error(JSON.stringify(recorded.keys));
    expect(second.outputTimeMs - second.transitionMs).toBeGreaterThanOrEqual(
      Math.max(first.outputTimeMs, 1000) + CAMERA_DEFAULTS.neutral.minPlateauMs,
    );
  });

  // Red if the record's return is dropped where it fits (the guard turned
  // into `return "pan"`): the scales would be PANNED. The plateaus are what
  // a squeezed return lacked.
  it("returns on a recorded return that fits, holding a plateau at each end", () => {
    expect(clockReturns(RETURN_AT)).toBe(true); // premise
    const recorded = solve(RETURN_AT, "return");
    expect(scales(recorded)).toEqual(RETURNED);
    const [, firstIn, pullOut, secondIn] = recorded.keys;
    if (
      firstIn === undefined ||
      pullOut === undefined ||
      secondIn === undefined
    )
      throw new Error(JSON.stringify(recorded.keys));
    const { minPlateauMs } = CAMERA_DEFAULTS.neutral;
    expect(
      pullOut.outputTimeMs - pullOut.transitionMs - firstIn.outputTimeMs,
    ).toBeGreaterThanOrEqual(minPlateauMs);
    expect(
      secondIn.outputTimeMs - secondIn.transitionMs - pullOut.outputTimeMs,
    ).toBeGreaterThanOrEqual(minPlateauMs);
  });

  // Red when `arrivesOf` drops its `!edited` test: the recorded pan would
  // stand across an authored gap that moved the beats it was decided on.
  it("ignores the record when an authored gap follows the earlier step", () => {
    expect(clockReturns(RETURN_AT)).toBe(true);
    expect(scales(solve(RETURN_AT, "pan"))).toEqual(PANNED); // premise
    expect(scales(solve(RETURN_AT, "pan", ["first"]))).toEqual(RETURNED);
  });

  // Red when the range loses its upper bound (`ms < seed.actionMs`): a gap
  // after the later step does not touch this pair.
  it("keeps the record when the gap follows the later step", () => {
    expect(scales(solve(RETURN_AT, "pan", ["second"]))).toEqual(PANNED);
  });
});

/** `timeline` with the source stretch `(startMs, endMs]` removed, as
 *  `buildTimeline` resolves an author's removed piece. */
const cutOut = (startMs: number, endMs: number): Timeline => ({
  ...timeline,
  segments: [
    {
      outStartMs: 0,
      outEndMs: startMs,
      srcStartMs: 0,
      srcEndMs: startMs,
      kind: "motion",
    },
    {
      outStartMs: startMs,
      outEndMs: 30_000 - (endMs - startMs),
      srcStartMs: endMs,
      srcEndMs: 30_000,
      kind: "motion",
    },
  ],
  outputDurationMs: 30_000 - (endMs - startMs),
  cuts: [
    { ids: ["piece"], srcStartMs: startMs, srcEndMs: endMs, trailing: false },
  ],
});

const solveCut = (cut: Timeline, arrives: "pan" | "return" | undefined) =>
  solveCamera(
    [zoomOn("z1", "first"), zoomOn("z2", "second", arrives)],
    rectOf,
    cut,
    new Map([
      ["first", 1000],
      ["second", RETURN_AT],
    ]),
    viewport,
  );

describe("a zoom with a removed piece before it", () => {
  // Red when `solveCamera`'s `edited` drops its removed-piece test
  // (`timeline.cuts.some(...)`): the recorded pan would stand across a
  // piece the author removed, which moved the beats it was decided on.
  it("decides a recorded pan again when a removed piece lies between the two zooms", () => {
    // Between the two, and over the earlier zoom's own step.
    for (const [start, end] of [
      [3_000, 5_000],
      [900, 1_100],
    ] as const) {
      const cut = cutOut(start, end);
      // Premise: the gap left after the cut is still on the return side of
      // the clock, so the record and the clock disagree.
      expect(clockReturns(RETURN_AT - (end - start))).toBe(true);
      expect(scales(solveCut(timeline, "pan"))).toEqual(PANNED);
      expect(scales(solveCut(cut, "pan"))).toEqual(RETURNED);
    }
  });

  // Red when the overlap test loses its upper bound
  // (`cut.srcStartMs < seed.sourceMs`): a piece removed after the later
  // zoom does not touch this pair.
  it("keeps the record when the removed piece follows the later zoom", () => {
    const cut = cutOut(RETURN_AT + 1_000, RETURN_AT + 3_000);
    // Premise: there is a cut, and the clock would return.
    expect(cut.cuts).toHaveLength(1);
    expect(clockReturns(RETURN_AT)).toBe(true);
    expect(scales(solveCut(cut, "pan"))).toEqual(PANNED);
  });
});

describe("a zoom with no record", () => {
  // Red when the fallback stops calling `returnsBetween` with the pair's own
  // numbers. Keys captured from the code before `arrivesOf` existed.
  it("asks the clock exactly as before", () => {
    expect(solve(PAN_AT, undefined).keys).toEqual([
      key(0, 640, 400, 1, 0),
      key(650, 700, 440, 1.8, 1300),
      key(2250, 700, 440, 1.8, 1000),
      key(4375, 700, 440, 1, 925),
    ]);
    expect(solve(RETURN_AT, undefined).keys).toEqual([
      key(0, 640, 400, 1, 0),
      key(650, 700, 440, 1.8, 1300),
      key(2775, 700, 440, 1, 925),
      key(8650, 700, 440, 1.8, 1300),
      key(10775, 700, 440, 1, 925),
    ]);
  });
});

function key(
  outputTimeMs: number,
  x: number,
  y: number,
  scale: number,
  transitionMs: number,
) {
  return {
    outputTimeMs,
    center: { x, y },
    scale,
    transitionMs,
    stiffness: 6.75,
  };
}
