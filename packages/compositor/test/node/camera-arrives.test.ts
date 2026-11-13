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
  // Red when `arrivesOf` ignores `seed.arrives` (the line
  // `if (seed.arrives !== null && !edited) return seed.arrives;`): the clock
  // would return here.
  it("pans on a recorded pan where the clock would return", () => {
    expect(clockReturns(RETURN_AT)).toBe(true);
    expect(scales(solve(RETURN_AT, undefined))).toEqual(RETURNED);
    expect(scales(solve(RETURN_AT, "pan"))).toEqual(PANNED);
  });

  // The reverse, red on the same line: the clock would pan here.
  it("returns on a recorded return where the clock would pan", () => {
    expect(clockReturns(PAN_AT)).toBe(false);
    expect(scales(solve(PAN_AT, undefined))).toEqual(PANNED);
    expect(scales(solve(PAN_AT, "return"))).toEqual(RETURNED);
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
