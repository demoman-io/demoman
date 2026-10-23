import { describe, expect, it } from "vitest";
import type { Vec } from "../../src/geometry";
import {
  type CameraKey,
  frameCamera,
  sampleCamera,
} from "../../src/plan/camera";
import {
  CAMERA_BLUR_MAX_SMEAR,
  CAMERA_BLUR_MIN_TRAVEL_PX,
  CAMERA_BLUR_PASS_SPACING_PX,
  CAMERA_EXPOSURE_MS,
  type CameraBlurPass,
  cameraBlurTransforms,
} from "../../src/render/camera-blur";
import { cssToOutput } from "../../src/render/compose";
import { contentScale } from "../../src/render/presentation";
import { cameraKey } from "../fixtures/camera-key";

const VIEWPORT = { width: 1280, height: 800 };
const CANVAS = { width: 1920, height: 1080 };
/** The viewport's own aspect, so `contentScale` is 1.25 on both axes. */
const FRAME = { x: 160, y: 40, width: 1600, height: 1000 };
const BASE = contentScale(FRAME, VIEWPORT);

const cameraAt = (keys: CameraKey[], t: number) =>
  frameCamera(sampleCamera(keys, t), BASE, FRAME, VIEWPORT, CANVAS);

/** The single pass for one earlier instant: a one-instant window. */
const cameraBlurPassFor = (
  keys: CameraKey[],
  t: number,
  at: number,
): Pick<CameraBlurPass, "scale" | "x" | "y"> => {
  const now = cameraAt(keys, t);
  const then = cameraAt(keys, at);
  const r = then.scale / now.scale;
  const F = { x: FRAME.x + FRAME.width / 2, y: FRAME.y + FRAME.height / 2 };
  return {
    scale: r,
    x: (1 - r) * F.x + then.scale * (now.focus.x - then.focus.x),
    y: (1 - r) * F.y + then.scale * (now.focus.y - then.focus.y),
  };
};

const passesAt = (keys: CameraKey[], t: number, blur: number) =>
  cameraBlurTransforms({
    camera: { cameraKeys: keys, cameraFollow: [] },
    outputTimeMs: t,
    blur,
    current: cameraAt(keys, t),
    base: BASE,
    frameRect: FRAME,
    viewport: VIEWPORT,
    canvas: CANVAS,
  });

const apply = (pass: CameraBlurPass, q: Vec): Vec => ({
  x: pass.scale * q.x + pass.x,
  y: pass.scale * q.y + pass.y,
});

const IDENTITY = { scale: 1, x: 0, y: 0 };
/** How far apart two passes put the canvas corner that differs most. */
const apart = (
  a: Pick<CameraBlurPass, "scale" | "x" | "y">,
  b: Pick<CameraBlurPass, "scale" | "x" | "y">,
): number =>
  Math.max(
    ...[
      { x: 0, y: 0 },
      { x: CANVAS.width, y: 0 },
      { x: 0, y: CANVAS.height },
      { x: CANVAS.width, y: CANVAS.height },
    ].map((c) => {
      const p = apply({ ...a, outputTimeMs: 0 }, c);
      const q = apply({ ...b, outputTimeMs: 0 }, c);
      return Math.hypot(p.x - q.x, p.y - q.y);
    }),
  );
const MAX_SMEAR_PX =
  CAMERA_BLUR_MAX_SMEAR * Math.hypot(CANVAS.width, CANVAS.height);

/** The widest gap between neighbouring passes, the sharp frame first. */
const widestGap = (passes: CameraBlurPass[]): number => {
  let widest = 0;
  let prior: Pick<CameraBlurPass, "scale" | "x" | "y"> = IDENTITY;
  for (const pass of passes) {
    widest = Math.max(widest, apart(pass, prior));
    prior = pass;
  }
  return widest;
};

/** A push-in from full frame to 2x on (400, 300), arriving at 1000ms. */
const pushIn: CameraKey[] = [
  cameraKey({
    outputTimeMs: 0,
    center: { x: 640, y: 400 },
    scale: 1,
    transitionMs: 0,
  }),
  cameraKey({
    outputTimeMs: 1000,
    center: { x: 400, y: 300 },
    scale: 2,
    transitionMs: 600,
  }),
];

/** A pan at a held 2x, from x 400 to x 800, arriving at 1000ms. */
const pan: CameraKey[] = [
  cameraKey({
    outputTimeMs: 0,
    center: { x: 400, y: 400 },
    scale: 2,
    transitionMs: 0,
  }),
  cameraKey({
    outputTimeMs: 1000,
    center: { x: 800, y: 400 },
    scale: 2,
    transitionMs: 600,
  }),
];

describe("cameraBlurTransforms", () => {
  it("is read against cameras that really move at the instants sampled", () => {
    // The premise: mid-move, the camera an exposure earlier differs from now.
    const now = cameraAt(pushIn, 700);
    const then = cameraAt(pushIn, 700 - CAMERA_EXPOSURE_MS);
    expect(now.scale - then.scale).toBeGreaterThan(0.01);
    const panNow = cameraAt(pan, 700);
    const panThen = cameraAt(pan, 700 - CAMERA_EXPOSURE_MS);
    expect(panNow.scale).toBe(panThen.scale);
    expect(panNow.focus.x - panThen.focus.x).toBeGreaterThan(5);
  });

  it("takes every pixel to where the same page point was drawn earlier", () => {
    // Checked against `cssToOutput`, which draws the page from the camera's
    // CENTRE — an independent route from the focus-and-scale algebra the
    // passes are built from. Any page point, any pass, both moves.
    for (const [name, keys] of [
      ["push-in", pushIn],
      ["pan", pan],
    ] as const) {
      const t = 700;
      const passes = passesAt(keys, t, 1);
      expect(passes.length, name).toBeGreaterThan(1);
      const now = cameraAt(keys, t);
      passes.forEach((pass, i) => {
        const then = cameraAt(keys, pass.outputTimeMs);
        for (const point of [
          { x: 0, y: 0 },
          { x: 400, y: 300 },
          { x: 1280, y: 800 },
          { x: 913, y: 77 },
        ]) {
          const q = cssToOutput(point, now, FRAME, VIEWPORT);
          const expected = cssToOutput(point, then, FRAME, VIEWPORT);
          const mapped = apply(pass, q);
          expect(mapped.x, `${name} pass ${i} x`).toBeCloseTo(expected.x, 6);
          expect(mapped.y, `${name} pass ${i} y`).toBeCloseTo(expected.y, 6);
        }
      });
    }
  });

  it("spreads its passes no more than 1.5px apart, however far the move", () => {
    // The pass count follows the distance. Five or eight copies whatever
    // the move put them tens of pixels apart on a fast one — separate
    // ghosts instead of a smear.
    for (const [name, keys] of [
      ["push-in", pushIn],
      ["pan", pan],
    ] as const) {
      for (const t of [450, 550, 700, 850, 900]) {
        for (const blur of [0.25, 0.5, 1]) {
          const passes = passesAt(keys, t, blur);
          const label = `${name} at ${t}, blur ${blur}: ${passes.length} passes`;
          // The premise: every one of these instants is mid-move.
          expect(passes.length, label).toBeGreaterThanOrEqual(2);
          expect(passes.length, label).toBeLessThanOrEqual(24);
          if (passes.length < 24) {
            expect(widestGap(passes), label).toBeLessThanOrEqual(
              CAMERA_BLUR_PASS_SPACING_PX + 1e-9,
            );
          }
          // Oldest last, every one inside the frame's own exposure.
          const times = passes.map((p) => p.outputTimeMs);
          expect(times, label).toEqual([...times].sort((a, b) => b - a));
          expect(times.at(-1) as number, label).toBeGreaterThanOrEqual(
            t - CAMERA_EXPOSURE_MS * blur - 1e-9,
          );
        }
      }
    }
    // And a slower stretch of the same move asks for fewer.
    expect(passesAt(pan, 900, 1).length).toBeLessThan(
      passesAt(pan, 700, 1).length,
    );
  });

  it("caps the smear, shortening the exposure of a fast move", () => {
    // At 700ms the pan moves the corners further across a full 32ms window
    // than the cap allows — the premise. The passes stop where the cap
    // does, and earlier than the full window.
    const t = 700;
    const full = apart(
      cameraBlurPassFor(pan, t, t - CAMERA_EXPOSURE_MS),
      IDENTITY,
    );
    expect(full).toBeGreaterThan(MAX_SMEAR_PX * 1.5);
    const passes = passesAt(pan, t, 1);
    const farthest = passes.at(-1) as CameraBlurPass;
    expect(apart(farthest, IDENTITY)).toBeLessThanOrEqual(MAX_SMEAR_PX + 1e-6);
    // Shortened to the cap, not past it: the longest window that fits.
    expect(apart(farthest, IDENTITY)).toBeGreaterThan(MAX_SMEAR_PX - 0.05);
    expect(farthest.outputTimeMs).toBeGreaterThan(t - CAMERA_EXPOSURE_MS);
    // A slow move is not touched: its whole window fits under the cap.
    expect(
      apart(cameraBlurPassFor(pan, 900, 900 - CAMERA_EXPOSURE_MS), IDENTITY),
    ).toBeLessThan(MAX_SMEAR_PX);
    const slowPasses = passesAt(pan, 900, 1);
    expect((slowPasses.at(-1) as CameraBlurPass).outputTimeMs).toBeCloseTo(
      900 - CAMERA_EXPOSURE_MS,
      9,
    );
  });

  it("gives a pure pan no scale and a translation the way the page came from", () => {
    const passes = passesAt(pan, 700, 1);
    expect(passes.length).toBeGreaterThan(0);
    const now = cameraAt(pan, 700);
    passes.forEach((pass, i) => {
      expect(pass.scale).toBe(1);
      // The camera is moving right, so the page slides left under it: an
      // instant earlier, everything sat further RIGHT. The magnitude is the
      // page's own displacement over that interval, in output pixels.
      const then = cameraAt(pan, pass.outputTimeMs);
      expect(pass.x, `pass ${i}`).toBeGreaterThan(0);
      expect(pass.x).toBeCloseTo((now.center.x - then.center.x) * BASE * 2, 6);
      expect(pass.y).toBeCloseTo(0, 9);
    });
    // Oldest last: the farther back, the farther away.
    const xs = passes.map((p) => p.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("shrinks the picture for earlier instants of a push-in", () => {
    const passes = passesAt(pushIn, 700, 1);
    expect(passes.length).toBeGreaterThan(1);
    for (const pass of passes) expect(pass.scale).toBeLessThan(1);
    const scales = passes.map((p) => p.scale);
    expect(scales).toEqual([...scales].sort((a, b) => b - a));
  });

  it("draws no pass for a still camera, or at blur 0", () => {
    // On the plateau after the push-in has landed.
    expect(cameraAt(pushIn, 1500).scale).toBe(2);
    expect(passesAt(pushIn, 1500, 1)).toEqual([]);
    // Before the move has begun (it departs 600ms before 1000).
    expect(passesAt(pushIn, 300, 1)).toEqual([]);
    // Moving, but blur is off.
    expect(passesAt(pushIn, 700, 0)).toEqual([]);
  });

  it("calls a camera still below the travel gate, and moving above it", () => {
    // A pan so slow that no canvas corner travels 0.75px across the whole
    // exposure. Without the gate this returns two passes that would each
    // repaint the frame by a fraction of a pixel — and a still-looking frame
    // would no longer be byte-identical to blur 0.
    const crawl = (dx: number): CameraKey[] => [
      cameraKey({
        outputTimeMs: 0,
        center: { x: 400, y: 400 },
        scale: 2,
        transitionMs: 0,
      }),
      cameraKey({
        outputTimeMs: 10_000,
        center: { x: 400 + dx, y: 400 },
        scale: 2,
        transitionMs: 10_000,
      }),
    ];
    const travel = (keys: CameraKey[]) => {
      const now = cameraAt(keys, 5000);
      const then = cameraAt(keys, 5000 - CAMERA_EXPOSURE_MS);
      return Math.abs(now.focus.x - then.focus.x) * 2;
    };
    // Premise: the slow one does move, under the gate; the faster one is
    // over it.
    const slow = crawl(20);
    const brisk = crawl(200);
    expect(travel(slow)).toBeGreaterThan(0.05);
    expect(travel(slow)).toBeLessThan(CAMERA_BLUR_MIN_TRAVEL_PX);
    expect(travel(brisk)).toBeGreaterThan(CAMERA_BLUR_MIN_TRAVEL_PX);
    expect(passesAt(slow, 5000, 1)).toEqual([]);
    expect(passesAt(brisk, 5000, 1).length).toBeGreaterThanOrEqual(2);
  });

  it("never reaches back before the take's first frame", () => {
    // 20ms in at blur 1: the 32ms window would reach back to −12ms. It ends
    // at 0 instead, with its passes spread across the 20ms there is. A slow
    // pan, so the smear cap does not shorten the window first.
    const early: CameraKey[] = [
      cameraKey({
        outputTimeMs: 0,
        center: { x: 400, y: 400 },
        scale: 2,
        transitionMs: 0,
      }),
      cameraKey({
        outputTimeMs: 2000,
        center: { x: 600, y: 400 },
        scale: 2,
        transitionMs: 2000,
      }),
    ];
    const passes = passesAt(early, 20, 1);
    expect(passes.length).toBeGreaterThanOrEqual(2);
    for (const pass of passes)
      expect(pass.outputTimeMs).toBeGreaterThanOrEqual(0);
    expect((passes.at(-1) as CameraBlurPass).outputTimeMs).toBeCloseTo(0, 9);
    expect(passesAt(early, 0, 1)).toEqual([]);
  });
});
