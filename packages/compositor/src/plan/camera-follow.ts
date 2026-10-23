import { lerpVec, type Vec } from "../geometry.js";
import { type CameraKey, sampleCamera } from "./camera.js";

/**
 * The follow spring's step, in output ms. The step is exact for a target
 * held over it (see `solveFollow`), so this only decides how finely the
 * pointer is read: 8ms is four reads a frame at 30fps, and a ten-minute zoom
 * is 75,000 of them.
 */
export const FOLLOW_STEP_MS = 8;

/**
 * One zoomed stretch's spring (spec 2026-10-22, "the camera trails the
 * pointer"): from a push-in's landing to the pull-out's arrival.
 */
export interface FollowStretch {
  /** The push-in's landing: the spring starts there at rest on its aim. */
  startMs: number;
  /** Where the pull-out sets off, the window `sampleCamera` uses: from
   *  here the drawn centre blends from the spring back onto the keys. */
  pullOutDepartMs: number;
  /** The pull-out's arrival, or the video's end when nothing pulls out. */
  endMs: number;
  /** The spring's centre at `startMs + i × FOLLOW_STEP_MS`, through `endMs`. */
  centers: Vec[];
}

/** What every reader draws the camera from. `ResolvedPlan` is one. */
export interface CameraTrack {
  cameraKeys: CameraKey[];
  cameraFollow: FollowStretch[];
}

/** Where the move that arrives at `keys[i]` sets off (`sampleCamera`'s window). */
function departs(keys: CameraKey[], i: number): number {
  const key = keys[i] as CameraKey;
  const before = keys[i - 1];
  if (!before) return key.outputTimeMs;
  return (
    key.outputTimeMs -
    Math.min(key.transitionMs, key.outputTimeMs - before.outputTimeMs)
  );
}

/**
 * While the camera is zoomed, its centre is a critically damped spring
 * chasing the pointer as drawn, so a run of clicks reads as one journey
 * that slows onto each button rather than a park at every key (the author's
 * choices of 2026-10-22: it trails the hand, and follows every movement).
 * The keys keep the scale, the push-in and the pull-out.
 *
 * Planned once, into a table, never as per-frame state: the author's ruling
 * 4 (2026-10-09) is that the camera is a pure function of output time, so
 * the preview, the export, the film check and the mask overlay read the
 * same camera and a scrubbed frame equals the exported one.
 *
 * - A stretch starts at a push-in's landing (a key above scale 1 after one
 *   at or below it) at rest on that key's centre, so the push-in, its
 *   landing and the first click's framing are exactly the keys'. It runs
 *   through every following key above 1 up to the pull-out.
 * - The target is the pointer, unclamped: `frameCamera` clamps at render as
 *   it always has. It is the aim in force instead (the latest key whose
 *   move has set off) when `cursorAt` is null (follow off, or no pointer
 *   is drawn), when it answers null, and while a drag's button is held:
 *   the drag's zoom is fitted to both its ends, and trailing the hand from
 *   the press would cut off the far one.
 * - Each step is the exact solution for a target held over the step, so
 *   it neither drifts nor depends on the step's size.
 */
export function solveFollow(args: {
  keys: CameraKey[];
  cursorAt: ((outputTimeMs: number) => Vec | null) | null;
  holds: readonly { startMs: number; endMs: number }[];
  outputDurationMs: number;
  /** `MotionTimings.followRatePerS`. */
  rate: number;
}): FollowStretch[] {
  const { keys, cursorAt, holds, outputDurationMs } = args;
  const omega = args.rate / 1000;
  const held = (t: number) => holds.some((h) => h.startMs <= t && t < h.endMs);
  const stretches: FollowStretch[] = [];

  for (let i = 1; i < keys.length; i++) {
    const landing = keys[i] as CameraKey;
    if (landing.scale <= 1 || (keys[i - 1] as CameraKey).scale > 1) continue;
    let last = i;
    while ((keys[last + 1]?.scale ?? 0) > 1) last++;
    const out = last + 1 < keys.length ? last + 1 : null;
    const endMs =
      out === null ? outputDurationMs : (keys[out] as CameraKey).outputTimeMs;
    const pullOutDepartMs =
      out === null ? outputDurationMs : departs(keys, out);

    // The aim in force: the latest key whose move has set off. Departures
    // are in time order and `t` only rises, so one cursor walks them.
    const departures = keys
      .slice(i + 1, last + 1)
      .map((key, k) => ({ at: departs(keys, i + 1 + k), center: key.center }));
    let aimed = -1;
    const aimAt = (t: number): Vec => {
      while (
        aimed + 1 < departures.length &&
        (departures[aimed + 1]?.at ?? Number.POSITIVE_INFINITY) <= t
      ) {
        aimed++;
      }
      return departures[aimed]?.center ?? landing.center;
    };
    const targetAt = (t: number): Vec =>
      (cursorAt !== null && !held(t) ? cursorAt(t) : null) ?? aimAt(t);

    let x = landing.center;
    let v = { x: 0, y: 0 };
    const centers: Vec[] = [x];
    for (let t = landing.outputTimeMs; t < endMs; t += FOLLOW_STEP_MS) {
      const target = targetAt(t);
      const dt = Math.min(FOLLOW_STEP_MS, endMs - t);
      const e = Math.exp(-omega * dt);
      const step = (y: number, vel: number) => {
        const k = vel + omega * y;
        return { y: (y + k * dt) * e, v: (vel - omega * k * dt) * e };
      };
      const sx = step(x.x - target.x, v.x);
      const sy = step(x.y - target.y, v.y);
      x = { x: target.x + sx.y, y: target.y + sy.y };
      v = { x: sx.v, y: sy.v };
      centers.push(x);
    }
    stretches.push({
      startMs: landing.outputTimeMs,
      pullOutDepartMs,
      endMs,
      centers,
    });
    i = last;
  }
  return stretches;
}

/**
 * The camera at an output instant: the keys' scale, and while zoomed the
 * spring's centre (`solveFollow`). Through the pull-out the centre blends
 * from the spring back onto the keys by how far the scale has come down, so
 * it leaves the spring without a jump and lands on the keys at full frame.
 */
export function sampleTrack(
  track: CameraTrack,
  outputTimeMs: number,
): { center: Vec; scale: number } {
  const base = sampleCamera(track.cameraKeys, outputTimeMs);
  if (base.scale <= 1) return base;
  // `endMs` included: a take that ends zoomed has no pull-out, and its last
  // instant is the spring's, not the keys' parked aim (a pull-out's own
  // end is at scale 1 and was answered above).
  const stretch = track.cameraFollow.find(
    (s) => s.startMs <= outputTimeMs && outputTimeMs <= s.endMs,
  );
  if (!stretch) return base;
  // Sample i is at `startMs + i × FOLLOW_STEP_MS`, the last at `endMs`, so
  // the last step may be short.
  const last = stretch.centers.length - 1;
  const i = Math.min(
    Math.floor((outputTimeMs - stretch.startMs) / FOLLOW_STEP_MS),
    last,
  );
  const timeOf = (k: number) =>
    Math.min(stretch.startMs + k * FOLLOW_STEP_MS, stretch.endMs);
  const here = stretch.centers[i] as Vec;
  const next = stretch.centers[i + 1];
  const spring =
    next === undefined
      ? here
      : lerpVec(
          here,
          next,
          (outputTimeMs - timeOf(i)) / (timeOf(i + 1) - timeOf(i)),
        );
  if (outputTimeMs < stretch.pullOutDepartMs) {
    return { center: spring, scale: base.scale };
  }
  const from = sampleCamera(track.cameraKeys, stretch.pullOutDepartMs).scale;
  if (from <= 1) return base;
  const w = (base.scale - 1) / (from - 1);
  return { center: lerpVec(base.center, spring, w), scale: base.scale };
}
