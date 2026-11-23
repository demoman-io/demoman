import { lerpVec, type Rect, type Vec } from "../geometry.js";
import { type CameraKey, frameCamera, sampleCamera } from "./camera.js";
import { CURSOR_MOTION_EPSILON_PX } from "./timeline.js";

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
 * - The target is the pointer, moved by `legal` to where the window can
 *   stand at the zoom of that instant: a spring chasing a point out of reach
 *   (a toolbar at the page's edge) was stopped dead against the edge by the
 *   render clamp, at full speed, and let go at full speed (DEM-211). Aimed
 *   in reach, it eases into the edge. It is the aim in force instead (the
 *   latest key whose move has set off) when `cursorAt` is null (follow off, or no pointer
 *   is drawn), when it answers null, and while a drag's button is held:
 *   the drag's zoom is fitted to both its ends, and trailing the hand from
 *   the press would cut off the far one. It is the aim before the press too,
 *   once it is in force, since the hand is going to a grab already in frame.
 *   It stays the aim after the release until the hand moves again, since a
 *   hand at rest on the drop is in frame.
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
  /** Where the camera can stand at a scale (`frameTrack`'s canvas clamp).
   *  The default aims as planned, for readers with no canvas. */
  legal?: (center: Vec, scale: number) => Vec;
}): FollowStretch[] {
  const { keys, cursorAt, holds, outputDurationMs } = args;
  const legal = args.legal ?? ((center: Vec) => center);
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
    // A hand resting where a drag let go is still in the drag's fitted
    // frame: the aim holds until it moves on, or the camera lurches to the
    // drop as the button lifts (the Sublime board, 2026-11-08). It is the
    // keys' aim in force, so a step that does not move the pointer (a key
    // press after a drag) is still framed when its key sets off.
    // Leaving the rest, the aim is a lead that moves with the hand and closes
    // on it by no more than the hand's own step: it may wait, never move
    // against the hand. Aimed at the hand at once, the camera went down to
    // the drop as the hand went up from it (DEM-211, Excalidraw). While the
    // hand is still, the lead closes on it at the follow's own rate, unless
    // that would go against where the hand moves next: a pause on the way
    // is waited out, not lurched toward (review of PR #86).
    let holding = false;
    let rest: Vec | null = null;
    let lead: { at: Vec; hand: Vec; next?: Vec | null } | null = null;
    /** The hand's next move from `from`, still at `t`, in this stretch. */
    const nextMove = (t: number, from: Vec): Vec | null => {
      for (let s = t + FOLLOW_STEP_MS; s < endMs; s += FOLLOW_STEP_MS) {
        const h = cursorAt?.(s) ?? null;
        if (h === null) return null;
        const d = { x: h.x - from.x, y: h.y - from.y };
        if (Math.hypot(d.x, d.y) >= CURSOR_MOTION_EPSILON_PX) return d;
      }
      return null;
    };
    // The aim the next press will hold is already in force when no key sets
    // off between now and that press. Its frame was fitted to the drag's
    // ends, the grab among them, so the hand on its way there is not chased:
    // chasing it to the card swung the camera there and back at the press,
    // a bounce before the drag began (DEM-254, the Sublime board).
    // A pan to that aim that sets off mid-stretch is eased from where the
    // camera stood when it set off, at the keys' own pace, and the press
    // keeps the same target until the pan lands. Three cheaper aims each
    // failed (review of fix/drag-camera, 2026-11-23): the keys' eased camera
    // stepped back to the previous key's centre when the hand was already on
    // its way to the grab, a reversal of its own; the key's end, handed to
    // the spring at once, outran the keys' pan by half again on the Sublime
    // takes; and either one switched to the end at a press that came mid-pan.
    // With no pointer to trail, the follow chased the keys' aims already, and
    // still does.
    let easing: { from: Vec; key: number } | null = null;
    const pressTarget = (t: number, camera: Vec): Vec => {
      const aim = aimAt(t);
      if (cursorAt === null || aimed < 0) return aim;
      if (easing?.key !== aimed) easing = { from: camera, key: aimed };
      const prev = aimed === 0 ? landing.center : departures[aimed - 1]?.center;
      if (prev === undefined) return aim;
      const span = { x: aim.x - prev.x, y: aim.y - prev.y };
      const length2 = span.x * span.x + span.y * span.y;
      if (length2 < 1) return aim;
      // How far the keys' own pan has come, from 0 at its set-off to 1 at
      // its landing.
      const keysAt = sampleCamera(keys, t).center;
      const done = Math.min(
        1,
        Math.max(
          0,
          ((keysAt.x - prev.x) * span.x + (keysAt.y - prev.y) * span.y) /
            length2,
        ),
      );
      return lerpVec(easing.from, aim, done);
    };
    const pressAimInForce = (t: number): boolean => {
      let press = Number.POSITIVE_INFINITY;
      for (const h of holds) {
        if (h.startMs > t && h.startMs < press) press = h.startMs;
      }
      return (
        press < endMs && !departures.some((d) => d.at > t && d.at <= press)
      );
    };
    const targetAt = (t: number, dt: number, camera: Vec): Vec => {
      if (held(t)) {
        holding = true;
        lead = null;
        // A press that comes mid-pan keeps the pan's eased target.
        return easing === null ? aimAt(t) : pressTarget(t, camera);
      }
      if (pressAimInForce(t)) {
        lead = null;
        return pressTarget(t, camera);
      }
      easing = null;
      const hand = cursorAt?.(t) ?? null;
      if (holding) {
        holding = false;
        rest = hand;
      }
      if (
        hand !== null &&
        rest !== null &&
        Math.hypot(hand.x - rest.x, hand.y - rest.y) < CURSOR_MOTION_EPSILON_PX
      ) {
        return aimAt(t);
      }
      if (rest !== null && hand !== null) lead = { at: aimAt(t), hand: rest };
      rest = null;
      if (hand === null) {
        lead = null;
        return aimAt(t);
      }
      if (lead === null) return hand;
      const step = { x: hand.x - lead.hand.x, y: hand.y - lead.hand.y };
      const moved = Math.hypot(step.x, step.y);
      const carried = { x: lead.at.x + step.x, y: lead.at.y + step.y };
      const gap = { x: hand.x - carried.x, y: hand.y - carried.y };
      const left = Math.hypot(gap.x, gap.y);
      if (moved === 0) {
        if (lead.next === undefined) lead.next = nextMove(t, hand);
        const next = lead.next;
        if (next !== null && gap.x * next.x + gap.y * next.y < 0) {
          lead = { ...lead, hand };
          return lead.at;
        }
      }
      const reach = moved > 0 ? moved : left * (1 - Math.exp(-omega * dt));
      if (left <= reach) {
        lead = null;
        return hand;
      }
      const k = reach / left;
      lead = {
        at: { x: carried.x + gap.x * k, y: carried.y + gap.y * k },
        hand,
      };
      return lead.at;
    };

    let x = landing.center;
    let v = { x: 0, y: 0 };
    const centers: Vec[] = [x];
    for (let t = landing.outputTimeMs; t < endMs; t += FOLLOW_STEP_MS) {
      const dt = Math.min(FOLLOW_STEP_MS, endMs - t);
      const target = legal(targetAt(t, dt, x), sampleCamera(keys, t).scale);
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
 * from the spring back onto the keys by the pull-out's own pivot weight, so
 * it leaves the spring without a jump and lands on the keys at full frame.
 *
 * `legal` moves a centre to where the camera can stand at a scale
 * (`frameTrack` passes the canvas clamp). It is applied to the keys and the
 * spring BEFORE they are blended, never after: `zoomBetween` moves every
 * edge of the window on a straight line between its ends, so two ends that
 * fit the canvas give a move that fits it throughout. Clamped after, per
 * axis, a pull-out from a button near an edge grew about the button until
 * one side met the canvas edge, slid along it, and turned when the other
 * side met its own — the "bump" (2026-10-29). The default leaves centres
 * as planned, for readers that ask how the plan moves, not how it is drawn.
 */
export function sampleTrack(
  track: CameraTrack,
  outputTimeMs: number,
  legal: (center: Vec, scale: number) => Vec = (center) => center,
): { center: Vec; scale: number } {
  const keys = track.cameraKeys.map((key) => ({
    ...key,
    center: legal(key.center, key.scale),
  }));
  const base = sampleCamera(keys, outputTimeMs);
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
    return { center: legal(spring, base.scale), scale: base.scale };
  }
  const from = sampleCamera(keys, stretch.pullOutDepartMs).scale;
  if (from <= 1) return base;
  // The spring held legal at the departure's scale and the pull-out's
  // landing are the move's two ends; weighted as `zoomBetween` weights a
  // centre, the window between them fits wherever both ends do.
  const landing = sampleCamera(keys, stretch.endMs).center;
  const w = (1 / from - 1 / base.scale) / (1 / from - 1);
  return {
    center: lerpVec(legal(spring, from), landing, w),
    scale: base.scale,
  };
}

/**
 * The camera a frame is drawn with: `sampleTrack` with every centre held
 * inside the canvas at its own scale, then `frameCamera`. Every reader that
 * draws or overlays the picture goes through this one, so they all draw
 * the same camera.
 */
/** Where the camera can stand at a scale: the canvas clamp every reader
 *  draws with. The follow is solved with this same clamp so it aims in
 *  reach (DEM-211): one definition, or the aim and the drawing drift apart. */
export function legalFor(
  base: number,
  frameRect: Rect,
  viewport: { width: number; height: number },
  canvas: { width: number; height: number },
): (center: Vec, scale: number) => Vec {
  return (center, scale) =>
    frameCamera({ center, scale }, base, frameRect, viewport, canvas).center;
}

export function frameTrack(
  track: CameraTrack,
  outputTimeMs: number,
  /** Output pixels per CSS pixel at camera scale 1 — `contentScale(...)`. */
  base: number,
  frameRect: Rect,
  viewport: { width: number; height: number },
  canvas: { width: number; height: number },
): ReturnType<typeof frameCamera> {
  return frameCamera(
    sampleTrack(
      track,
      outputTimeMs,
      legalFor(base, frameRect, viewport, canvas),
    ),
    base,
    frameRect,
    viewport,
    canvas,
  );
}
