import { describe, expect, it } from "vitest";
import type { Vec } from "../../src/geometry";
import { type CameraKey, frameCamera } from "../../src/plan/camera";
import {
  type CameraTrack,
  frameTrack,
  sampleTrack,
  solveFollow,
} from "../../src/plan/camera-follow";
import {
  contentScale,
  derivePresentation,
} from "../../src/render/presentation";
import {
  LANDSCAPE_1080P,
  type RenderTarget,
  VERTICAL_1080,
} from "../../src/render/target";
import { cameraKey } from "../fixtures/camera-key";
import { readonlyScene } from "../fixtures/scene";

// 2026-10-29: a pull-out from a button near the canvas edge "bumped". The
// keys are blended unclamped and `frameCamera` clamped the result per axis,
// so the window grew about the button, met one edge and slid along it, then
// turned when it met the other. `frameTrack` holds each key inside the canvas
// before the blend, so the move is one straight zoom.

const viewport = { width: 1280, height: 800 };
/** A button low on the left: out of the canvas's reach across at 2x and in
 *  reach down (asserted below), so the old composition clamped x the whole
 *  move and y only from partway through — the turn. Clamped on both axes
 *  throughout, the old path is straight, and this fixture tests nothing. */
const NEAR_EDGE: Vec = { x: 60, y: 560 };
const PUSH_IN = { departMs: 700, arriveMs: 2000 };
const PULL_OUT = { departMs: 4075, arriveMs: 5000 };

/** A push-in to the button and the pull-out `insertNeutralKeys` plans for a
 *  last zoom: back to 1x at the zoom's own centre (`pullOut(atMs, seed.center)`). */
const keys: CameraKey[] = [
  cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1 }),
  cameraKey({ outputTimeMs: PUSH_IN.arriveMs, center: NEAR_EDGE, scale: 2 }),
  cameraKey({
    outputTimeMs: PULL_OUT.arriveMs,
    center: NEAR_EDGE,
    scale: 1,
    transitionMs: PULL_OUT.arriveMs - PULL_OUT.departMs,
  }),
];
const still: CameraTrack = { cameraKeys: keys, cameraFollow: [] };

/** A pan between two zoomed beats: from the page's middle, in reach, to the
 *  button. The old path ran straight at the button until x met the edge,
 *  then went on down alone. */
const PAN = { departMs: 2500, arriveMs: 3500 };
const panning: CameraTrack = {
  cameraKeys: [
    cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1 }),
    cameraKey({ outputTimeMs: 1500, center: { x: 640, y: 400 }, scale: 2 }),
    cameraKey({
      outputTimeMs: PAN.arriveMs,
      center: NEAR_EDGE,
      scale: 2,
      transitionMs: PAN.arriveMs - PAN.departMs,
    }),
  ],
  cameraFollow: [],
};

function stage(target: RenderTarget) {
  const { frameRect } = derivePresentation(
    readonlyScene().branding,
    target,
    viewport,
  );
  const base = contentScale(frameRect, viewport);
  const frame = (sampled: { center: Vec; scale: number }) =>
    frameCamera(sampled, base, frameRect, viewport, target);
  const legal = (center: Vec, scale: number) => frame({ center, scale }).center;
  return {
    frame,
    legal,
    /** What renders drew before the fix: blended, then clamped. */
    naive: (track: CameraTrack, at: number) => frame(sampleTrack(track, at)),
    drawn: (track: CameraTrack, at: number) =>
      frameTrack(track, at, base, frameRect, viewport, target),
    /** How far the render-time clamp moved the blended centre. */
    clampMoved: (track: CameraTrack, at: number) => {
      const sampled = sampleTrack(track, at, legal);
      const framed = frame(sampled).center;
      return Math.hypot(
        framed.x - sampled.center.x,
        framed.y - sampled.center.y,
      );
    },
  };
}

/** The 60fps instants of a move, ends excluded. */
function instants(move: { departMs: number; arriveMs: number }): number[] {
  const out: number[] = [];
  for (let t = move.departMs + 1000 / 60; t < move.arriveMs; t += 1000 / 60) {
    out.push(t);
  }
  return out;
}

/** The widest swing, in radians, of the focus's frame-to-frame direction
 *  over a move. 0 is a straight line. */
function turn(focusAt: (at: number) => Vec, times: number[]): number {
  const angles: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const a = focusAt(times[i - 1] as number);
    const b = focusAt(times[i] as number);
    if (Math.hypot(b.x - a.x, b.y - a.y) > 0.05) {
      angles.push(Math.atan2(b.y - a.y, b.x - a.x));
    }
  }
  expect(angles.length, "the move moves").toBeGreaterThan(times.length / 2);
  return Math.max(...angles) - Math.min(...angles);
}

describe("frameTrack near the canvas edge", () => {
  const { frame, legal, naive, drawn, clampMoved } = stage(LANDSCAPE_1080P);

  it("has the fixture it claims: out of reach across at 2x, in reach down, out of reach on both at 1x", () => {
    const zoomed = legal(NEAR_EDGE, 2);
    expect(zoomed.x).toBeGreaterThan(NEAR_EDGE.x + 1);
    expect(zoomed.y).toBe(NEAR_EDGE.y);
    const full = legal(NEAR_EDGE, 1);
    expect(full.x).toBeGreaterThan(NEAR_EDGE.x + 1);
    expect(full.y).toBeLessThan(NEAR_EDGE.y - 1);
    // ...and the old composition turned mid-move: the bug. (A push-in from
    // full frame did not: its start is in reach, and its far end is out of
    // reach across from the first frame on, so only one axis ever clamps.)
    expect(
      turn((at) => naive(still, at).focus, instants(PULL_OUT)),
    ).toBeGreaterThan(0.3);
    expect(
      turn((at) => naive(panning, at).focus, instants(PAN)),
    ).toBeGreaterThan(0.3);
  });

  it("pulls out on one straight line", () => {
    expect(
      turn((at) => drawn(still, at).focus, instants(PULL_OUT)),
    ).toBeLessThan(1e-6);
  });

  it("pans between zoomed beats on one straight line", () => {
    expect(turn((at) => drawn(panning, at).focus, instants(PAN))).toBeLessThan(
      1e-6,
    );
  });

  it("starts and ends where the old composition did", () => {
    for (const at of [0, PUSH_IN.arriveMs, 3000, PULL_OUT.arriveMs]) {
      expect(drawn(still, at)).toEqual(naive(still, at));
    }
  });

  it("never needs the render-time clamp mid-move, pointer-follow included", () => {
    // The pointer drifts off the page's bottom-left while zoomed, so the
    // spring the pull-out leaves from is out of reach too (asserted).
    const pointer = (at: number): Vec => ({
      x: NEAR_EDGE.x - (at - 2000) / 50,
      y: NEAR_EDGE.y + (at - 2000) / 15,
    });
    const follow: CameraTrack = {
      cameraKeys: keys,
      cameraFollow: solveFollow({
        keys,
        cursorAt: pointer,
        holds: [],
        outputDurationMs: 6000,
        rate: 10,
      }),
    };
    expect(follow.cameraFollow).toHaveLength(1);
    const spring = sampleTrack(follow, PULL_OUT.departMs).center;
    expect(frame({ center: spring, scale: 2 }).center.y).toBeLessThan(
      spring.y - 20,
    );
    expect(
      Math.max(
        ...instants(PULL_OUT).map((at) => {
          const s = sampleTrack(follow, at);
          const f = frame(s).center;
          return Math.hypot(f.x - s.center.x, f.y - s.center.y);
        }),
      ),
      "the old blend is clamped mid pull-out",
    ).toBeGreaterThan(10);

    for (const track of [still, panning, follow]) {
      for (const at of [
        ...instants(PUSH_IN),
        ...instants(PAN),
        ...instants(PULL_OUT),
      ]) {
        expect(clampMoved(track, at), `${at}ms`).toBeLessThan(1e-6);
      }
    }
    // And it leaves the spring without a jump: no step across the
    // departure is longer than the steps either side of it.
    const step = (at: number) => {
      const a = drawn(follow, at - 1).center;
      const b = drawn(follow, at).center;
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    expect(step(PULL_OUT.departMs + 1)).toBeLessThan(
      2 * Math.max(step(PULL_OUT.departMs - 5), step(PULL_OUT.departMs + 5)) +
        0.01,
    );
  });

  it("never needs the render-time clamp under a cover crop", () => {
    const cover = stage(VERTICAL_1080);
    expect(
      Math.max(
        ...instants(PULL_OUT).map((at) => {
          const s = sampleTrack(still, at);
          const f = cover.frame(s).center;
          return Math.hypot(f.x - s.center.x, f.y - s.center.y);
        }),
      ),
      "the old composition is clamped mid-move here too",
    ).toBeGreaterThan(10);
    for (const at of [...instants(PUSH_IN), ...instants(PULL_OUT)]) {
      expect(cover.clampMoved(still, at), `${at}ms`).toBeLessThan(1e-6);
    }
  });
});
