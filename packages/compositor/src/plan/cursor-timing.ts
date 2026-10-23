import { type CursorGap, type CursorSample, overlapsGap } from "../bundle.js";

/**
 * Redraw each gesture at an eased, even speed along the route the hand
 * actually took.
 *
 * The smoothing kernel fixes *where* the cursor is; this fixes *when*. A real
 * hand does not cross the screen at a steady rate — it sets off fast, stalls
 * partway while its owner thinks or corrects their aim, overshoots, comes
 * back. Filtering the positions leaves all of that intact, because it is not
 * noise: it is a faithful record of an uneven hand, and a viewer reads it as
 * the recording stuttering rather than as a person thinking.
 *
 * **Nothing spatial is invented.** Every drawn position lies on the recorded
 * polyline — the route, its corners and its overshoots are exactly what was
 * captured. What changes is how far along that route the cursor has got at
 * each instant. That is the whole difference between this and
 * `synthesizeCursor`, which draws a curve of its own between targets and is
 * reserved for scenes that recorded no pointer at all.
 *
 * **A gesture is re-timed, never a take.** Runs are split on the same
 * `CURSOR_REST_MS` boundary the rest of this pipeline uses, so the pause
 * between two reaches is untouched and no route is ever joined across one.
 * A recorded gap splits a run too, and on its own terms rather than on that
 * boundary's: a gap is a stretch where the position was *unknown*, so the
 * straight line across it is not a route the hand took and its length is not
 * distance the hand covered. Feeding one to the arc-length profile spreads
 * the teleport evenly over the gesture on the far side — measured on a
 * two-second gap, 800px of invented travel along a line the pointer never
 * crossed. The time boundary alone would not catch it: a gap opens on
 * `pointerleave` and closes on the next `pointermove`, so it can be far
 * shorter than a rest and still hold a jump across the whole screen.
 *
 * **Anchors are honoured exactly.** Each run's own ends, and every marker
 * inside it, keep their recorded position at their recorded instant: the
 * profile is a monotone cubic through those knots rather than a single ease
 * across the whole run. Without that, a click taken mid-reach would be drawn
 * wherever the eased profile had got to — measured on this file's own
 * fixture, more than 10px from the button it hit, because the hand was
 * mid-stall and the profile was not. Slopes at a run's two ends are its own
 * end secants, so the knots alone would traverse a gesture with no interior
 * marker at an exactly even pace; slopes at interior anchors come from the
 * neighbouring secants, so a marker the hand clicked through does not become
 * a stop.
 *
 * **Every gesture ramps up out of rest and settles into it** (2026-10-09):
 * the clock the knots are read on is warped at the run's two ends — see
 * `rampWarp` and `GESTURE_RAMP_MAX_MS` — so the cursor gathers itself for a
 * capped time, cruises, and settles, arriving when the hand did. (This said
 * "zero" slopes until 2026-09-12, then left the whole ease to
 * `followWithSpring`; its 55ms only softened the corners of a
 * constant-speed slide.)
 */

/** Cumulative distance along the polyline, in the same units as the points. */
function arcLengths(samples: CursorSample[], start: number, end: number) {
  const s = [0];
  for (let i = start + 1; i <= end; i++) {
    const a = samples[i - 1] as CursorSample;
    const b = samples[i] as CursorSample;
    s.push((s[s.length - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return s;
}

/** How far along the route the hand had got at `ms`, by its own timing. */
function arcAtTime(
  samples: CursorSample[],
  start: number,
  end: number,
  s: number[],
  ms: number,
): number {
  for (let i = start + 1; i <= end; i++) {
    const b = samples[i] as CursorSample;
    if (b.sourceTimeMs < ms) continue;
    const a = samples[i - 1] as CursorSample;
    const span = b.sourceTimeMs - a.sourceTimeMs;
    const u = span === 0 ? 0 : (ms - a.sourceTimeMs) / span;
    const from = s[i - 1 - start] as number;
    const to = s[i - start] as number;
    return from + (to - from) * u;
  }
  return s[s.length - 1] as number;
}

/** The point at a given distance along the route. */
function pointAtArc(
  samples: CursorSample[],
  start: number,
  end: number,
  s: number[],
  target: number,
): { x: number; y: number } {
  for (let i = start + 1; i <= end; i++) {
    const to = s[i - start] as number;
    if (to < target) continue;
    const from = s[i - 1 - start] as number;
    const a = samples[i - 1] as CursorSample;
    const b = samples[i] as CursorSample;
    const span = to - from;
    const u = span === 0 ? 0 : (target - from) / span;
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  }
  const last = samples[end] as CursorSample;
  return { x: last.x, y: last.y };
}

/**
 * Fritsch-Carlson slopes: the standard way to interpolate a set of knots
 * with a cubic that cannot overshoot between them. Overshoot here would mean
 * the cursor running past a point on the route and coming back, which is
 * motion the hand did not make — so monotonicity is a correctness property,
 * not a smoothness preference.
 *
 * The two ends take their own secant rather than zero, which makes a run
 * with no interior marker traverse at an exactly even pace. They were zero
 * until the spring landed, to ease out of rest and into it, across the whole
 * gesture: a smoothstep across a two-second reach is slow for hundreds of
 * milliseconds at each end and quick in the middle, which reads as pumping.
 * The ease now comes from `rampWarp`, capped in time, on top of this even
 * pace. Ends at their secant still satisfy the Fritsch-Carlson monotonicity
 * bound (|m| <= 3|d|), so nothing overshoots.
 */
function monotoneSlopes(times: number[], arcs: number[]): number[] {
  const n = times.length;
  const secant: number[] = [];
  for (let i = 1; i < n; i++) {
    const dt = (times[i] as number) - (times[i - 1] as number);
    secant.push(
      dt === 0 ? 0 : ((arcs[i] as number) - (arcs[i - 1] as number)) / dt,
    );
  }
  const m = new Array<number>(n).fill(0);
  m[0] = secant[0] ?? 0;
  m[n - 1] = secant[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const d0 = secant[i - 1] as number;
    const d1 = secant[i] as number;
    if (d0 <= 0 || d1 <= 0) continue;
    const h0 = (times[i] as number) - (times[i - 1] as number);
    const h1 = (times[i + 1] as number) - (times[i] as number);
    m[i] = (3 * (h0 + h1)) / ((2 * h1 + h0) / d0 + (h1 + 2 * h0) / d1);
  }
  return m;
}

/** The cubic Hermite through those knots, evaluated at `ms`. */
function progressAt(
  times: number[],
  arcs: number[],
  slopes: number[],
  ms: number,
): number {
  for (let i = 1; i < times.length; i++) {
    const t1 = times[i] as number;
    if (t1 < ms) continue;
    const t0 = times[i - 1] as number;
    const h = t1 - t0;
    if (h <= 0) return arcs[i] as number;
    const u = (ms - t0) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      (arcs[i - 1] as number) * (2 * u3 - 3 * u2 + 1) +
      (slopes[i - 1] as number) * h * (u3 - 2 * u2 + u) +
      (arcs[i] as number) * (-2 * u3 + 3 * u2) +
      (slopes[i] as number) * h * (u3 - u2)
    );
  }
  return arcs[arcs.length - 1] as number;
}

/**
 * The longest a gesture spends gathering itself out of rest, and settling
 * into it.
 *
 * The author's ask of 2026-10-09: every move ramps up and settles, at the
 * same overall speed. The 55ms spring alone softened only the first and last
 * ~150ms, so the middle of a reach read as a constant-speed slide.
 *
 * A cap in time, not a share of the gesture, for the reason the ease left
 * this stage on 2026-09-12: easing a two-second reach end to end is slow for
 * hundreds of milliseconds at each end and quick in the middle, which reads
 * as pumping. A body with weight gathers itself in about the same time
 * whether it is going far or near. PROVISIONAL, chosen by eye like
 * `CURSOR_SPRING_TAU_MS`.
 */
export const GESTURE_RAMP_MAX_MS = 350;

/** A short gesture ramps for this share of itself at each end, so the two
 *  ramps never meet and its middle still cruises. */
const GESTURE_RAMP_SHARE = 0.4;

/**
 * Where on the knots' own clock the drawn cursor is at `ms`: a warp of the
 * interval `[a, b]` that starts (and/or ends) at rest, ramps over `ramp`
 * with a smoothstep-shaped speed, and cruises in between — fast enough that
 * it still arrives at `b` exactly at `b`.
 *
 * Only a run's outer intervals ramp; the ends of an interval at an interior
 * anchor are the identity, so a marker the hand clicked through is still
 * drawn where the hand was, when it was there. The speed does step there by
 * the one-ramp cruise's ratio — never more than 1.25x — which the spring
 * downstream rounds off.
 */
function rampWarp(
  a: number,
  b: number,
  rampIn: boolean,
  rampOut: boolean,
  ms: number,
): number {
  const length = b - a;
  const ramps = (rampIn ? 1 : 0) + (rampOut ? 1 : 0);
  if (ramps === 0 || length <= 0) return ms;
  const ramp = Math.min(GESTURE_RAMP_SHARE * length, GESTURE_RAMP_MAX_MS);
  // Each ramp covers half the ground the cruise would in the same time.
  const cruise = length / (length - (ramps * ramp) / 2);
  // The distance a smoothstep speed covers by `x` of its ramp: the integral
  // of 3x^2 - 2x^3, which is 1/2 at the ramp's end.
  const covered = (x: number) => x * x * x - (x * x * x * x) / 2;
  const u = ms - a;
  if (rampIn && u < ramp) return a + cruise * ramp * covered(u / ramp);
  if (rampOut && u > length - ramp) {
    return b - cruise * ramp * covered((length - u) / ramp);
  }
  return a + cruise * (u - (rampIn ? ramp / 2 : 0));
}

function retimeRun(
  samples: CursorSample[],
  start: number,
  end: number,
  anchorMs: readonly number[],
  /** Whether each end of the run is a rest, and so ramps. An end at a gap
   *  is where the pointer stopped being observed, not where it stopped. */
  ramps: { in: boolean; out: boolean },
  out: CursorSample[],
): void {
  if (end - start < 2) return;
  const first = samples[start] as CursorSample;
  const last = samples[end] as CursorSample;
  if (last.sourceTimeMs <= first.sourceTimeMs) return;

  const s = arcLengths(samples, start, end);
  const total = s[s.length - 1] as number;
  // A run the pointer did not actually travel has no route to re-time along.
  if (total <= 0) return;

  const interior = [
    ...new Set(
      anchorMs.filter(
        (ms) => ms > first.sourceTimeMs && ms < last.sourceTimeMs,
      ),
    ),
  ].sort((a, b) => a - b);
  const times = [first.sourceTimeMs, ...interior, last.sourceTimeMs];
  const arcs = times.map((ms) => arcAtTime(samples, start, end, s, ms));
  const slopes = monotoneSlopes(times, arcs);

  const runStart = times[0] as number;
  const runEnd = times[times.length - 1] as number;
  const firstKnot = times[1] as number;
  const lastKnot = times[times.length - 2] as number;
  for (let i = start + 1; i < end; i++) {
    const sample = samples[i] as CursorSample;
    const ms = sample.sourceTimeMs;
    const warped =
      ms <= firstKnot
        ? rampWarp(
            runStart,
            firstKnot,
            ramps.in,
            firstKnot === runEnd && ramps.out,
            ms,
          )
        : ms >= lastKnot
          ? rampWarp(lastKnot, runEnd, false, ramps.out, ms)
          : ms;
    const progress = progressAt(times, arcs, slopes, warped);
    const point = pointAtArc(samples, start, end, s, progress);
    out[i] = { sourceTimeMs: sample.sourceTimeMs, x: point.x, y: point.y };
  }
}

export function retimeAlongRoute(
  samples: CursorSample[],
  anchorMs: readonly number[],
  boundaryMs: number,
  gaps: readonly CursorGap[] = [],
  /** The page, for telling a rest from a glide `leaveThroughEdges` drew. */
  viewport?: { width: number; height: number },
): CursorSample[] {
  if (samples.length < 3) return samples;
  // An end off the page is the glide `leaveThroughEdges` drew to or from
  // the edge: a hand still moving, whichever way it went. Its leading gap is
  // dropped once the arrival is drawn, so this is the only sign left of it.
  const onPage = (sample: CursorSample): boolean =>
    viewport === undefined ||
    (sample.x >= 0 &&
      sample.x <= viewport.width &&
      sample.y >= 0 &&
      sample.y <= viewport.height);
  const out = [...samples];
  let start = 0;
  let startsAtGap = false;
  for (let i = 1; i <= samples.length; i++) {
    const current = samples[i];
    const previous = samples[i - 1] as CursorSample;
    // A gap ends a run without the pointer having stopped: it went off the
    // page (where `leaveThroughEdges` has already drawn it on its way), into
    // an iframe, onto a native popup. Ramping into one would ease to rest
    // where the hand never rested — the hitch at the edge `off-page.ts`
    // records, back again. So only a rest, or the take's own ends, ramp.
    const atGap =
      current !== undefined &&
      overlapsGap(gaps, previous.sourceTimeMs, current.sourceTimeMs);
    const broken =
      current === undefined ||
      atGap ||
      current.sourceTimeMs - previous.sourceTimeMs > boundaryMs;
    if (!broken) continue;
    retimeRun(
      samples,
      start,
      i - 1,
      anchorMs,
      {
        in: !startsAtGap && onPage(samples[start] as CursorSample),
        out: !atGap && onPage(previous),
      },
      out,
    );
    start = i;
    startsAtGap = atGap;
  }
  return out;
}
