import type { Vec } from "../../src/geometry";
import type { CameraKey } from "../../src/plan/camera";
import { cameraKey } from "./camera-key";

// A run of three clicks while zoomed (spec 2026-10-22), shared by the follow
// spring's node test and its pixel test.

/** The three buttons of the run. */
export const A: Vec = { x: 300, y: 230 };
export const B: Vec = { x: 620, y: 270 };
export const C: Vec = { x: 930, y: 420 };
export const CLICKS = [2000, 3200, 4400] as const;
export const LANDING_MS = 1650;
export const PULL_OUT_MS = 6200;

/** Push-in on A, pans to B and C, then the pull-out. */
export function runKeys(cScale = 2): CameraKey[] {
  return [
    cameraKey({
      outputTimeMs: 0,
      center: { x: 640, y: 400 },
      scale: 1,
      transitionMs: 0,
    }),
    cameraKey({ outputTimeMs: LANDING_MS, center: A, scale: 2 }),
    cameraKey({ outputTimeMs: 2850, center: B, scale: 2, transitionMs: 600 }),
    cameraKey({
      outputTimeMs: 4050,
      center: C,
      scale: cScale,
      transitionMs: 600,
    }),
    cameraKey({
      outputTimeMs: PULL_OUT_MS,
      center: C,
      scale: 1,
      transitionMs: 925,
    }),
  ];
}

const minJerk = (u: number) => u * u * u * (10 - 15 * u + 6 * u * u);

/** A pointer through `[ms, point]` waypoints, minimum-jerk between them. */
export function pointerThrough(way: readonly [number, Vec][]) {
  return (t: number): Vec => {
    for (let i = 1; i < way.length; i++) {
      const [t0, p0] = way[i - 1] as [number, Vec];
      const [t1, p1] = way[i] as [number, Vec];
      if (t > t1) continue;
      if (t1 === t0 || t <= t0) return t <= t0 ? p0 : p1;
      const e = minJerk((t - t0) / (t1 - t0));
      return { x: p0.x + (p1.x - p0.x) * e, y: p0.y + (p1.y - p0.y) * e };
    }
    return (way[way.length - 1] as [number, Vec])[1];
  };
}

/**
 * Still on its way to A when the push-in lands at 1650, on A by 1850; rests,
 * travels to B (arriving 2900), rests, travels to C (arriving 4100), rests.
 */
export const RUN_WAY: [number, Vec][] = [
  [0, { x: 640, y: 700 }],
  [900, { x: 640, y: 700 }],
  [1850, A],
  [2150, A],
  [2900, B],
  [3350, B],
  [4100, C],
];
export const pointer = pointerThrough(RUN_WAY);
