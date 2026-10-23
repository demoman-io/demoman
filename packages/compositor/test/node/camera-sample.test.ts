import { MOTION_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { springEase } from "../../src/easing";
import type { Vec } from "../../src/geometry";
import {
  CAMERA_DEFAULTS,
  type CameraKey,
  motionTimings,
  sampleCamera,
  solveCamera,
} from "../../src/plan/camera";
import type { Timeline } from "../../src/plan/timeline";
import { cssToOutput } from "../../src/render/compose";
import { cameraKey } from "../fixtures/camera-key";

const viewport = { width: 1280, height: 800 };
const frameRect = { x: 0, y: 0, width: 1920, height: 1200 };
const T = CAMERA_DEFAULTS.zoomInMs;
const A = CAMERA_DEFAULTS.stiffness;

/** A push-in from full frame onto a point up and to the right. */
const pushIn = [
  cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1 }),
  cameraKey({ outputTimeMs: 2000, center: { x: 900, y: 250 }, scale: 2 }),
];

function outputAt(point: Vec, ms: number): Vec {
  return cssToOutput(point, sampleCamera(pushIn, ms), frameRect, viewport);
}

describe("sampleCamera's transition", () => {
  it("zooms at an even perceived rate: the eased progress is spent in log scale", () => {
    // Half way through the window in time, the spring has made `springEase
    // (0.5)` of the move. A zoom whose every step magnifies by the same ratio
    // is then at 2^p; blending scale linearly would put it at 1 + p.
    const p = springEase(0.5, A);
    // Premise: the two readings differ by far more than the tolerance, so
    // the assertion below can tell them apart.
    expect(1 + p - 2 ** p).toBeGreaterThan(0.02);
    expect(sampleCamera(pushIn, 2000 - T / 2).scale).toBeCloseTo(2 ** p, 6);
  });

  it("moves every point of the page on a straight line, as one zoom about one point", () => {
    // A point well off the line from the start centre to the end centre:
    // on that line a blend of centre and scale moves straight whatever
    // the interpolation, so it would prove nothing.
    const q = { x: 300, y: 650 };
    const start = outputAt(q, 2000 - T);
    const end = outputAt(q, 2000);
    const chord = { x: end.x - start.x, y: end.y - start.y };
    const chordLength = Math.hypot(chord.x, chord.y);
    // ...and it really does travel, so a deviation of a pixel is a fraction
    // of a real move rather than of nothing.
    expect(chordLength).toBeGreaterThan(300);
    let worst = 0;
    for (let ms = 2000 - T; ms <= 2000; ms += 10) {
      const p = outputAt(q, ms);
      const off =
        Math.abs(chord.x * (p.y - start.y) - chord.y * (p.x - start.x)) /
        chordLength;
      worst = Math.max(worst, off);
    }
    // Blending centre and scale separately bows this point ~5px off its
    // chord; a single zoom about a fixed point does not bow at all.
    expect(worst).toBeLessThan(0.5);
  });

  it("still pans at a constant scale exactly as the curve says", () => {
    const pan = [
      cameraKey({ outputTimeMs: 0, center: { x: 400, y: 300 }, scale: 2 }),
      cameraKey({
        outputTimeMs: 1000,
        center: { x: 800, y: 500 },
        scale: 2,
        transitionMs: 1000,
      }),
    ];
    const p = springEase(0.5, A);
    const mid = sampleCamera(pan, 500);
    expect(mid.scale).toBe(2);
    expect(mid.center.x).toBeCloseTo(400 + 400 * p, 6);
    expect(mid.center.y).toBeCloseTo(300 + 200 * p, 6);
  });

  it("arrives exactly on each key, at rest", () => {
    const at = sampleCamera(pushIn, 2000);
    expect(at.scale).toBe(2);
    expect(at.center).toEqual({ x: 900, y: 250 });
    const before = sampleCamera(pushIn, 2000 - T);
    expect(before.scale).toBe(1);
    expect(before.center).toEqual({ x: 640, y: 400 });
    // At rest at both ends: a millisecond in, the scale has barely moved.
    expect(sampleCamera(pushIn, 2000 - T + 1).scale - 1).toBeLessThan(1e-4);
    expect(2 - sampleCamera(pushIn, 1999).scale).toBeLessThan(1e-4);
  });

  it("reads the length and the stiffness from the key it arrives at", () => {
    const short = [
      pushIn[0] as CameraKey,
      cameraKey({
        ...(pushIn[1] as CameraKey),
        transitionMs: 400,
        stiffness: 8,
      }),
    ];
    // Still at the start 401ms out: a constant window would have moved.
    expect(sampleCamera(short, 2000 - 401).scale).toBe(1);
    expect(sampleCamera(short, 2000 - 200).scale).toBeCloseTo(
      2 ** springEase(0.5, 8),
      9,
    );
  });
});

/**
 * Settled before the click (the author's ruling 3, polish-parity plan): a key
 * marks an ARRIVAL, the push-in arrives `leadInMs` before the click, and a
 * longer transition starts earlier rather than landing through the action.
 * Driven through `solveCamera`, so the keys are the ones a render draws.
 */
describe("a solved zoom, sampled", () => {
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
  const CLICK_MS = 4000;
  const target = { x: 900, y: 250 };
  const solve = (smoothness = MOTION_DEFAULTS.smoothness) =>
    solveCamera(
      [
        {
          id: "z",
          kind: "zoom",
          anchorId: null,
          point: target,
          actionId: "act-1",
          offsetMs: CAMERA_DEFAULTS.leadInMs,
          scale: 2,
          end: null,
        },
      ],
      () => null,
      timeline,
      new Map([["act-1", CLICK_MS]]),
      viewport,
      null,
      { ...MOTION_DEFAULTS, smoothness },
    ).keys;

  const keys = solve();
  const arrival = keys.find((k) => k.scale === 2) as CameraKey;
  const pullOut = keys.find(
    (k) => k.scale === 1 && k.outputTimeMs > arrival.outputTimeMs,
  ) as CameraKey;
  const { zoomInMs, zoomOutMs } = CAMERA_DEFAULTS;
  const distance = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

  it("has the fixture it claims: one push-in arriving before the click, then one pull-out", () => {
    expect(keys).toHaveLength(3);
    expect(arrival.outputTimeMs).toBe(CLICK_MS + CAMERA_DEFAULTS.leadInMs);
    expect(arrival.outputTimeMs).toBeLessThan(CLICK_MS);
    // The push-in's whole window fits after the opening key, so nothing
    // truncates it and the lengths below are the real ones.
    expect(arrival.outputTimeMs - zoomInMs).toBeGreaterThan(0);
    expect(pullOut.outputTimeMs - zoomOutMs).toBeGreaterThan(
      arrival.outputTimeMs,
    );
    // The two lengths differ, so a test that confuses them goes red.
    expect(zoomInMs).not.toBe(zoomOutMs);
  });

  it("stamps the push-in with zoomInMs and the return with zoomOutMs", () => {
    expect(arrival).toMatchObject({
      transitionMs: zoomInMs,
      stiffness: CAMERA_DEFAULTS.stiffness,
    });
    expect(pullOut).toMatchObject({
      transitionMs: zoomOutMs,
      stiffness: CAMERA_DEFAULTS.stiffness,
    });
    // ...and from the document's smoothness, not the defaults.
    const languid = motionTimings(1);
    const slow = solve(1);
    expect(slow.find((k) => k.scale === 2)).toMatchObject({
      transitionMs: languid.zoomInMs,
      stiffness: languid.stiffness,
    });
    expect(slow[slow.length - 1]).toMatchObject({
      transitionMs: languid.zoomOutMs,
    });
  });

  it("is settled a millisecond before its key, and has barely left the last one a push-in's length before it", () => {
    const T = arrival.outputTimeMs;
    const nearly = sampleCamera(keys, T - 1);
    expect(Math.abs(nearly.scale / arrival.scale - 1)).toBeLessThan(0.005);
    expect(distance(nearly.center, arrival.center)).toBeLessThan(0.5);

    const opening = keys[0] as CameraKey;
    const leaving = sampleCamera(keys, T - zoomInMs + 1);
    expect(Math.abs(leaving.scale / opening.scale - 1)).toBeLessThan(0.005);
    expect(distance(leaving.center, opening.center)).toBeLessThan(0.5);

    // ...and it is genuinely moving in between — the spring's early peak,
    // most of the way there half way through (minimum jerk would be at 0.5).
    const mid = sampleCamera(keys, T - zoomInMs / 2);
    expect(Math.log2(mid.scale)).toBeGreaterThan(0.8);
    expect(Math.log2(mid.scale)).toBeLessThan(0.99);

    // By the click itself it is exactly on the key.
    expect(sampleCamera(keys, CLICK_MS)).toEqual({
      center: arrival.center,
      scale: arrival.scale,
    });
  });

  /** Every instant in [from, to) where the camera's scale differs from the
   *  instant before it, as [first moving ms, first ms back at rest]. */
  function measuredMove(fromMs: number, toMs: number): [number, number] {
    let start = Number.NaN;
    let end = Number.NaN;
    let previous = sampleCamera(keys, fromMs).scale;
    for (let t = fromMs + 1; t <= toMs; t++) {
      const scale = sampleCamera(keys, t).scale;
      if (scale !== previous) {
        if (Number.isNaN(start)) start = t - 1;
        end = t;
      }
      previous = scale;
    }
    return [start, end];
  }

  it("takes zoomInMs to push in and zoomOutMs to pull out", () => {
    const [inStart, inEnd] = measuredMove(0, arrival.outputTimeMs + 10);
    expect(inEnd).toBe(arrival.outputTimeMs);
    expect(inEnd - inStart).toBe(zoomInMs);

    const [outStart, outEnd] = measuredMove(
      arrival.outputTimeMs + 10,
      pullOut.outputTimeMs + 10,
    );
    expect(outEnd).toBe(pullOut.outputTimeMs);
    expect(outEnd - outStart).toBe(zoomOutMs);
  });
});
