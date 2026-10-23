import { describe, expect, it } from "vitest";
import {
  CAMERA_DEFAULTS,
  sampleCamera,
  solveCamera,
} from "../../src/plan/camera";
import type { Timeline } from "../../src/plan/timeline";
import type { CameraIntent } from "../../src/plan/types";

// Excalidraw, 2026-10-21: a drag pressed at 5150 and let go at 6250 inside
// its zoom, with the next zoomed click at 8300. The zoom returned on a
// click's timing, counted from its arrival, and the camera was pulling back
// out while the rectangle was still being drawn.

// Output time is source time: an identity map keeps every number readable.
const timeline: Timeline = {
  segments: [
    {
      outStartMs: 0,
      outEndMs: 20_000,
      srcStartMs: 0,
      srcEndMs: 20_000,
      kind: "motion",
    },
  ],
  outputDurationMs: 20_000,
  sourceDurationMs: 20_000,
  unplacedPaces: 0,
  nonMonotonicPaces: 0,
  cuts: [],
  unplacedCuts: [],
  interruptions: [],
};
const viewport = { width: 1280, height: 800 };
const rectOf = () => ({ x: 600, y: 380, width: 200, height: 120 });
const zoomOn = (id: string, actionId: string): CameraIntent => ({
  id,
  kind: "zoom",
  anchorId: "an",
  point: null,
  actionId,
  offsetMs: CAMERA_DEFAULTS.leadInMs,
  scale: 1.8,
  end: null,
});
const markers = new Map([
  ["drag", 4800],
  ["next", 8300],
]);
const HOLD = { startMs: 5150, endMs: 6250 };

const solve = (holds: { startMs: number; endMs: number }[]) =>
  solveCamera(
    [zoomOn("z1", "drag"), zoomOn("z2", "next")],
    rectOf,
    timeline,
    markers,
    viewport,
    null,
    undefined,
    undefined,
    holds,
  );

describe("a zoom with a drag held in it", () => {
  it("stays zoomed until the button comes up", () => {
    const { keys } = solve([HOLD]);
    for (const t of [HOLD.startMs, 5800, HOLD.endMs]) {
      expect(sampleCamera(keys, t).scale, `at ${t}`).toBeGreaterThan(1.75);
    }
  });

  // The premise: on a click's timing this zoom is already going back out
  // during the hold, which is what the case above is red for.
  it("returns mid-hold without it", () => {
    const { keys } = solve([]);
    expect(sampleCamera(keys, HOLD.endMs).scale).toBeLessThan(1.5);
  });

  // Final review, finding 1: a drag with no zoom of its own, long after this
  // zoom would have gone back out, kept the camera in on the clicked button
  // for the whole stretch between. Only a drag pressed while the zoom is in
  // holds it.
  it("does not hold for a drag pressed after the zoom would have gone back out", () => {
    const far = { startMs: 7_000, endMs: 7_600 };
    const markersFar = new Map([
      ["drag", 1_000],
      ["next", 15_000],
    ]);
    const { keys } = solveCamera(
      [zoomOn("z1", "drag"), zoomOn("z2", "next")],
      rectOf,
      timeline,
      markersFar,
      viewport,
      null,
      undefined,
      undefined,
      [far],
    );
    // The premise: this zoom is in at its own click.
    expect(sampleCamera(keys, 1_200).scale).toBeGreaterThan(1.75);
    expect(sampleCamera(keys, 5_000).scale).toBeLessThan(1.05);
  });
});
