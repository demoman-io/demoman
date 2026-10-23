import { clamp } from "../geometry.js";
import type { ResolvedPlan } from "../plan/resolve.js";
import { sampleCursor } from "../plan/resolve.js";
import { toSourceMs } from "../plan/timeline.js";
import type { RenderPlan } from "../plan/types.js";
import { PRESS_DURATION_MS } from "./draw-cursor.js";

/**
 * The pointer's lean and its press, each a pure function of output time.
 *
 * Both used to be — or could easily have become — little springs stepped
 * once per frame. They are not, for the reason every other value in
 * `renderFrame` is not: the editor scrubs to an arbitrary frame and the
 * export walks them in order, and the two must paint the same picture. A
 * stepped spring remembers the frames before it, so a scrubbed frame would
 * show whatever the scrub happened to pass through. Everything here is read
 * off the recorded path and the click list at the instant asked for.
 */

/**
 * How deep the press goes at `clickBounce: 1`, as a fraction of the arrow's
 * size. The depth every take drew before the bounce existed (it was
 * `PRESS_SHRINK` then), so the default re-renders an old take with the same
 * squeeze and only adds the spring on release.
 */
export const PRESS_DEPTH = 0.14;

/** The release's decay time constant: how fast the spring dies. */
const RELEASE_DECAY_MS = 80;

/**
 * The release's oscillation period. Against an 80ms decay this rises back
 * through 1 at 80ms, peaks about 2% over at 160ms (bounce 1), and is under
 * a tenth of a percent by the end of the window — a single visible
 * overshoot, which is what reads as "springy" rather than "wobbly".
 */
const RELEASE_PERIOD_MS = 320;

/**
 * After this long the release is reported as exactly 1. The spring's
 * residue there is `A·e^(−450/80)` ≈ 0.04% at bounce 2 — a hundredth of a
 * pixel on a 40px arrow — so the cut is invisible, and it is what lets the
 * pointer be exactly unscaled (and its pixels exactly unchanged) for most
 * of a take.
 */
export const RELEASE_MS = 450;

const smoothstep = (u: number): number => {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * The pointer's size multiplier at `outputTimeMs`: 1 is its own size.
 *
 * Over the `PRESS_DURATION_MS` before a click it eases down to `1 − A`
 * (smoothstep, so it leaves 1 with no kink), with `A = PRESS_DEPTH ·
 * bounce`. From the click it springs back as `1 − A·e^(−t/80)·cos(2πt/320)`
 * — equal to `1 − A` at t = 0, so the two halves meet without a step —
 * overshooting past 1 once before it settles. `bounce` 0 is no press at
 * all, not a press of zero depth that still costs anything to draw.
 *
 * Measured on the OUTPUT axis, like the pulse: see `PRESS_DURATION_MS` and
 * the note above the pulse loop in `renderFrame`.
 *
 * Two clicks close together (a double-click is 100–200ms apart) are the one
 * place "the nearest click" is not enough: the second press would start
 * from 1 while the first one's release is still part-way through its
 * spring, and the pointer would jump by up to a fifth of the depth in one
 * frame. So the press eases from wherever the previous release had got to
 * when the press began, and it never begins before the previous click — a
 * press window that would reach back past it starts at it instead, still
 * arriving at `1 − A` on the click. With one click in range this is exactly
 * the press described above.
 */
export function cursorPressScale(
  outputTimeMs: number,
  clickOutputMs: readonly number[],
  bounce: number,
  // A drag's held button: pressed throughout, and the release springs from
  // its end rather than from its press.
  holds: readonly { startMs: number; endMs: number }[] = [],
): number {
  const depth = PRESS_DEPTH * clamp(bounce, 0, 2);
  if (depth <= 0) return 1;
  if (holds.some((h) => outputTimeMs >= h.startMs && outputTimeMs < h.endMs)) {
    return 1 - depth;
  }

  // The click at or before now, and the first one after it. Scanned, not
  // binary-searched: `clickOutputMs` is short and nothing promises it sorted.
  // A hold's end is where its release begins, so it counts as one.
  let previous = Number.NEGATIVE_INFINITY;
  let next = Number.POSITIVE_INFINITY;
  for (const click of [...clickOutputMs, ...holds.map((h) => h.endMs)]) {
    if (click <= outputTimeMs) previous = Math.max(previous, click);
    else next = Math.min(next, click);
  }

  const release = (at: number): number => {
    const since = at - previous;
    if (!(since >= 0 && since <= RELEASE_MS)) return 1;
    return (
      1 -
      depth *
        Math.exp(-since / RELEASE_DECAY_MS) *
        Math.cos((2 * Math.PI * since) / RELEASE_PERIOD_MS)
    );
  };

  if (next !== Number.POSITIVE_INFINITY) {
    const pressStart = Math.max(next - PRESS_DURATION_MS, previous);
    if (outputTimeMs >= pressStart) {
      const from = release(pressStart);
      const u = (outputTimeMs - pressStart) / (next - pressStart);
      return from + (1 - depth - from) * smoothstep(u);
    }
  }
  return release(outputTimeMs);
}

/** The lean at full tilt and full speed: 15°. */
export const TILT_MAX_RAD = (15 * Math.PI) / 180;

/** The velocity window: the pointer's travel over this long before τ. */
const TILT_VELOCITY_MS = 16;

/**
 * The speed that earns the full lean, in viewport widths per second.
 * Viewport-relative so that one gesture leans the same at 720p and at 4K,
 * and on a 1280px page and a 1920px one: a pixel rate would hand the lean
 * to the output size.
 */
const TILT_FULL_SPEED_WIDTHS_PER_S = 1.1;

/** How much vertical motion counts toward the lean, against horizontal. */
const TILT_VERTICAL_WEIGHT = 0.65;

/** The smoothing kernel: this many instants, this far apart... */
const TILT_TAPS = 8;
const TILT_TAP_MS = 20;
/** ...weighted `e^(−k·TAP/TAU)`, the newest heaviest. */
const TILT_TAU_MS = 60;

/**
 * How far back the lean reads: the oldest tap plus its velocity window. A
 * pointer that has been still for this long leans exactly 0 — a frozen
 * stretch of a take paints the same pointer on every frame once it is this
 * far in, and not before.
 */
export const TILT_SETTLE_MS = TILT_VELOCITY_MS + (TILT_TAPS - 1) * TILT_TAP_MS;

/**
 * The unsmoothed lean at one instant, in radians: positive is clockwise on
 * the canvas, which is the way an arrow hanging off its tip swings when it
 * is dragged to the right.
 *
 * Velocity is the pointer's travel over the 16ms before `outputTimeMs`,
 * both ends mapped through the timeline the way `cursorTrailPoints` maps
 * its stamps — so it is the speed the VIEWER sees, and a retimed stretch
 * leans as fast as it plays.
 *
 * `bias = (vx + 0.65·vy) / |v|` is clamped to ±1. Unclamped it reaches
 * √(1 + 0.65²) ≈ 1.19 on a diagonal, which would let a down-and-right
 * stroke lean past the 15° the slider's top end promises.
 *
 * Zero, not "unknown", where there is no history to measure: an instant
 * whose window reaches back before output 0 or before the pointer's first
 * sample. The pointer has no recorded motion there, and treating it as
 * still is what lets the lean ramp in from 0 when the take's time crosses
 * that sample instead of starting mid-swing.
 */
export function cursorTiltRawRad(
  resolved: Pick<ResolvedPlan, "cursor" | "timeline"> & {
    plan: Pick<RenderPlan, "viewport">;
  },
  outputTimeMs: number,
  tilt: number,
): number {
  const amount = clamp(tilt, 0, 1);
  const first = resolved.cursor[0];
  const fromMs = outputTimeMs - TILT_VELOCITY_MS;
  if (amount <= 0 || !first || fromMs < 0) return 0;
  const fromSourceMs = toSourceMs(resolved.timeline, fromMs);
  if (fromSourceMs < first.sourceTimeMs) return 0;
  const from = sampleCursor(resolved.cursor, fromSourceMs);
  const to = sampleCursor(
    resolved.cursor,
    toSourceMs(resolved.timeline, outputTimeMs),
  );
  // Type narrowing, not a failure path: `first` above is the only thing
  // that makes either null, and it is already in hand.
  if (!from || !to) return 0;
  const vx = ((to.x - from.x) * 1000) / TILT_VELOCITY_MS;
  const vy = ((to.y - from.y) * 1000) / TILT_VELOCITY_MS;
  const speed = Math.hypot(vx, vy);
  // Below a thousandth of a CSS pixel per second the direction is noise;
  // the angle it would give is already zero to many places, since `speed`
  // multiplies it.
  if (speed < 1e-3) return 0;
  const bias = clamp((vx + TILT_VERTICAL_WEIGHT * vy) / speed, -1, 1);
  const width = resolved.plan.viewport.width;
  const fullSpeed = TILT_FULL_SPEED_WIDTHS_PER_S * (width > 0 ? width : 1);
  return bias * Math.min(1, speed / fullSpeed) * TILT_MAX_RAD * amount;
}

/**
 * The lean `renderFrame` draws: `cursorTiltRawRad` averaged over the eight
 * instants 0, 20, … 140ms before `outputTimeMs`, weighted `e^(−k/3)` and
 * normalised. A causal exponential kernel rather than a spring: it is a
 * function of the recorded path alone, so a scrubbed frame and an exported
 * one lean the same way (see the note atop this file). The kernel is what
 * keeps a pointer that stops dead from snapping upright in one frame — the
 * raw lean falls to 0 over the 16ms after a stop, and this spreads that
 * over the 140ms the kernel spans.
 */
export function cursorTiltRad(
  resolved: Pick<ResolvedPlan, "cursor" | "timeline"> & {
    plan: Pick<RenderPlan, "viewport">;
  },
  outputTimeMs: number,
  tilt: number,
): number {
  if (!(tilt > 0)) return 0;
  let sum = 0;
  let weights = 0;
  for (let k = 0; k < TILT_TAPS; k++) {
    const weight = Math.exp((-k * TILT_TAP_MS) / TILT_TAU_MS);
    sum +=
      weight * cursorTiltRawRad(resolved, outputTimeMs - k * TILT_TAP_MS, tilt);
    weights += weight;
  }
  return sum / weights;
}
