import { type CursorGap, type CursorSample, overlapsGap } from "../bundle.js";
import { CURSOR_REST_MS } from "./smooth.js";

/**
 * How long the drawn cursor takes to gather itself.
 *
 * PROVISIONAL, chosen by eye like `CURSOR_SMOOTHING_MS` and owing the same
 * measurement against real takes.
 *
 * The trade it sets is not subtle, so it is worth stating in numbers. A
 * critically damped follower trailing a target that moves at a steady `V`
 * settles at a constant lag of `2 * V * tau`. At 55ms that is 44px behind a
 * leisurely 400px/s traverse and 110px behind a brisk 1000px/s one. That lag
 * IS the effect — it is what makes a cursor look weighted rather than
 * glued to the mouse — but it is also why `anchorMs` below is not optional:
 * a click drawn 110px short of the button it hit is not a stylistic choice.
 *
 * Raise it for more float, lower it for more fidelity.
 */
export const CURSOR_SPRING_TAU_MS = 55;

/**
 * How far ahead of itself the target is read.
 *
 * A critically damped follower tracking a target that moves at a steady `V`
 * settles at a constant lag of `2 * V * tau` — 110px behind an ordinary
 * 1000px/s reach at the time constant above, which is a tenth of the frame.
 * That is not the effect; that is the cursor being somewhere the pointer
 * provably was not, and it would show as the page reacting to a click before
 * the arrow got there.
 *
 * Because that lag is exactly `2 * tau` of TIME, reading the target two time
 * constants ahead cancels it: the follower's steady state becomes
 * `target(t + 2*tau) - 2*V*tau`, which is `target(t)`. What survives is the
 * part worth having — the soft acceleration out of a stop and the soft
 * settle into one, over a fixed span of time rather than a fixed fraction of
 * the gesture. What it costs is a little anticipation: the drawn cursor
 * begins to move before the hand did, by about this much. The Gaussian
 * upstream already does that (a symmetric kernel rounds a corner rather than
 * lagging it) and it reads as smooth rather than as prescience.
 *
 * Exported because the anticipation has to be protected from the retimer as
 * well as produced: a travel hint that starts at the gesture's first recorded
 * sample leaves this much of the drawn movement in the dead air before it,
 * where an authored gap compresses it. See `resolvePlan`'s hints, which
 * widen by exactly this at the head and by `springSettleMs` at the tail.
 */
export function springLeadMs(tauMs: number): number {
  return 2 * tauMs;
}

/**
 * How long the follower needs to be visually on top of a target that has
 * stopped.
 *
 * Six time constants, not the three a plain exponential would want. A
 * critically damped response decays as `(A + B*t) * e^(-t/tau)`, and the
 * linear term is not a rounding detail when the follower arrives at speed:
 * coming off an 800px traverse the error at the moment the target stops is
 * 88px WITH 0.8px/ms of closing speed, which leaves 11px still on the table
 * at 3 tau. Measured, not estimated — an earlier version of this returned
 * `3 * tauMs` and its own test caught it at exactly that 11px.
 *
 * This doubles as the anchor shoulder below, for the same reason: a
 * correction should be spread over the time the spring itself would have
 * taken, or it reads as a movement of its own.
 */
export function springSettleMs(tauMs: number): number {
  return 6 * tauMs;
}

/** Position at `ms`, linear between samples — the same reading `sampleCursor`
 *  does, kept local so this module has no dependency on the resolver. */
function positionAt(
  samples: CursorSample[],
  ms: number,
): { x: number; y: number } {
  const first = samples[0] as CursorSample;
  if (ms <= first.sourceTimeMs) return { x: first.x, y: first.y };
  for (let i = 1; i < samples.length; i++) {
    const to = samples[i] as CursorSample;
    if (to.sourceTimeMs < ms) continue;
    const from = samples[i - 1] as CursorSample;
    const span = to.sourceTimeMs - from.sourceTimeMs;
    const u = span === 0 ? 0 : (ms - from.sourceTimeMs) / span;
    return { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u };
  }
  const last = samples[samples.length - 1] as CursorSample;
  return { x: last.x, y: last.y };
}

/**
 * `positionAt`, with the scan kept where the last one finished.
 *
 * The spring reads its target at a non-decreasing sequence of instants — the
 * recorded ones and a grid inside the holes, both ascending, each offset by
 * the same lead — so the pair of samples bracketing one instant is never
 * earlier than the pair bracketing the instant before it. Rescanning the
 * whole array from index 1 each time therefore did the same work over and
 * over, and made this stage quadratic in the take's length: measured at
 * 6.4ms / 25.5ms / 172ms for 30s / 60s / 180s of continuous 120Hz motion,
 * paid on every edit, because the editor resolves the plan on each one.
 * `smooth.ts`'s sliding window records the same class being removed from the
 * smoothing kernel for the same reason.
 *
 * The answer is identical to `positionAt`'s rather than merely close: the
 * same two samples, read the same way, with the search for them bounded
 * instead of the arithmetic changed. `cursor-spring.test.ts` keeps a
 * from-scratch spring built on `positionAt`'s unbounded scan as its oracle,
 * and counts the reads rather than timing them.
 */
function readerFor(
  samples: CursorSample[],
): (ms: number) => { x: number; y: number } {
  let i = 1;
  return (ms) => {
    const first = samples[0] as CursorSample;
    if (ms <= first.sourceTimeMs) return { x: first.x, y: first.y };
    while (
      i < samples.length &&
      (samples[i] as CursorSample).sourceTimeMs < ms
    ) {
      i++;
    }
    const to = samples[i];
    if (!to) {
      const last = samples[samples.length - 1] as CursorSample;
      return { x: last.x, y: last.y };
    }
    const from = samples[i - 1] as CursorSample;
    const span = to.sourceTimeMs - from.sourceTimeMs;
    const u = span === 0 ? 0 : (ms - from.sourceTimeMs) / span;
    return { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u };
  };
}

/**
 * Draw a cursor that chases the recorded one instead of being it.
 *
 * Everything upstream of this makes the *target* honest: the tremor is
 * filtered out, pauses render as pauses, and the traverse between them ramps
 * up, cruises and settles along the route the hand really took. This is the
 * last stage, a mass on a spring, which cannot start instantly and cannot
 * stop instantly: it rounds the corners the route turns and the seams the
 * retimer leaves at a marker.
 *
 * Critically damped, so it closes on the target and never rings past it: an
 * overshoot would be motion the hand did not make, and on a cursor it reads
 * as a bug rather than as bounce. The step is the analytic solution rather
 * than an Euler integration, so it is exact for a target held constant over
 * the step and unconditionally stable at any sample spacing — which matters
 * because a take's samples are not evenly spaced.
 *
 * **Why this is not what a zero-phase filter does, and why both exist.**
 * `smoothCursor` is symmetric in time: it removes tremor without lag,
 * because a filter that lagged would move the drawn cursor away from where
 * the pointer provably was. This deliberately lags. The two are not
 * alternatives — the filter decides *where the route is*, and this decides
 * *how a body with weight travels along it*. Filtering harder never produces
 * this; measured across sigma 30/60/90 the residual barely moved, because
 * what was missing was never noise.
 *
 * **Anchors keep the lag honest.** At each instant in `anchorMs` — the
 * take's markers, so every click and hover — the drawn cursor is corrected
 * back onto the target, over a raised-cosine shoulder rather than by a jump,
 * so the correction has no corner in it. The shoulder is clamped to half the
 * distance to the neighbouring anchor, so two close markers cannot fight
 * over the same samples and each is exact at its own instant.
 */
/**
 * How finely the settle is written down.
 *
 * The spring needs somewhere to put its own curve. A rest records no samples
 * — that is what makes it a rest — so between the last sample of a gesture
 * and the next one there may be two seconds of nothing, and every consumer
 * downstream reads this array by interpolating STRAIGHT LINES between its
 * entries. Emitting only the endpoints would therefore render a 330ms
 * exponential settle as a two-second linear creep across the whole pause:
 * the exact defect `holdThroughRests` exists to fix, reintroduced one stage
 * later by the thing meant to make the stop look good. Measured on
 * `cursor-rests.test.ts`'s own fixture before this existed — the drawn
 * cursor sat 7.9px from the target a full second into a pause it should have
 * settled into in a third of one.
 *
 * So a long step is walked at this interval for as long as the settle lasts,
 * and jumps to the far end after that, where the spring has converged and
 * extra samples would say nothing. 8ms is 120Hz, comfortably finer than the
 * 60fps the deliverable is composed at.
 */
const SPRING_GRID_MS = 8;

export function followWithSpring(
  samples: CursorSample[],
  tauMs: number,
  anchorMs: readonly number[],
  gaps: readonly CursorGap[] = [],
): CursorSample[] {
  if (tauMs <= 0 || samples.length < 2) return samples;
  if (gaps.length === 0) return followOneStretch(samples, tauMs, anchorMs);

  // A gap is a discontinuity, not a movement, so the follower restarts on
  // the far side of one rather than gliding across it. Carrying position and
  // velocity through means answering a jump the hand never made with a
  // journey: measured on a two-second gap with the pointer returning 1000px
  // away, the spring was still crossing the screen when the gap closed and
  // drew the first observed position after it — (900,700) — at (602,463),
  // a point on a straight line between two places the pointer was seen and
  // nowhere it was ever seen itself. Started afresh, the segment after a gap
  // begins exactly where the pointer was next observed, at rest, which is
  // what "it was here, and then it was there" looks like on a body with
  // weight. Each stretch also keeps only the anchors that fall inside it:
  // a marker on the far side of a gap has no observed position on this side
  // to correct onto.
  const out: CursorSample[] = [];
  let start = 0;
  for (let i = 1; i <= samples.length; i++) {
    const current = samples[i];
    const previous = samples[i - 1] as CursorSample;
    const broken =
      current === undefined ||
      overlapsGap(gaps, previous.sourceTimeMs, current.sourceTimeMs);
    if (!broken) continue;
    const stretch = samples.slice(start, i);
    const from = stretch[0] as CursorSample;
    const to = stretch[stretch.length - 1] as CursorSample;
    out.push(
      ...(stretch.length < 2
        ? stretch
        : followOneStretch(
            stretch,
            tauMs,
            anchorMs.filter(
              (ms) => ms >= from.sourceTimeMs && ms <= to.sourceTimeMs,
            ),
          )),
    );
    start = i;
  }
  return out;
}

/** One stretch of continuous observation. See `followWithSpring`. */
function followOneStretch(
  samples: CursorSample[],
  tauMs: number,
  anchorMs: readonly number[],
): CursorSample[] {
  const omega = 1 / tauMs;
  const settleMs = springSettleMs(tauMs);

  const first = samples[0] as CursorSample;
  const out: CursorSample[] = [{ ...first }];
  let x = first.x;
  let y = first.y;
  // Velocity of the *error*, which is what the damped system carries.
  let vx = 0;
  let vy = 0;

  /** One analytic step of the critically damped system toward `target`. */
  const advance = (
    dt: number,
    targetX: number,
    targetY: number,
    atMs: number,
  ): void => {
    if (dt <= 0) {
      out.push({ sourceTimeMs: atMs, x, y });
      return;
    }
    const decay = Math.exp(-omega * dt);
    // e = drawn - target, evolving as (e0 + (v + omega*e0) t) e^{-omega t}.
    const ex = x - targetX;
    const ey = y - targetY;
    const bx = vx + omega * ex;
    const by = vy + omega * ey;
    const nx = (ex + bx * dt) * decay;
    const ny = (ey + by * dt) * decay;
    vx = (bx - omega * (ex + bx * dt)) * decay;
    vy = (by - omega * (ey + by * dt)) * decay;
    x = targetX + nx;
    y = targetY + ny;
    out.push({ sourceTimeMs: atMs, x, y });
  };

  // Every instant the result will carry: the recorded ones, plus a fine
  // grid inside any hole long enough to hide a settle. See SPRING_GRID_MS.
  const lead = springLeadMs(tauMs);
  const times: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const from = samples[i - 1] as CursorSample;
    const to = samples[i] as CursorSample;
    // A HOLE, on the boundary that decides what a hole is everywhere else in
    // this pipeline (`CURSOR_REST_MS`, which `smoothCursor` and
    // `holdThroughRests` also split on). An ordinary interval is a frame
    // apart and has a recorded sample at each end: there is no curve between
    // them left to write down, and the spring's step is exact over an
    // interval of any length, so subdividing one records nothing.
    //
    // It was subdivided anyway until 2026-09-12, because the tail window
    // below spans the whole of any interval shorter than `lead + settleMs`
    // and so matched every one of them. Measured: 8640 recorded samples came
    // back as 24095, and the added points sat a fraction of a millisecond
    // before a real sample, carrying no information into the array every
    // consumer downstream then interpolates.
    if (to.sourceTimeMs - from.sourceTimeMs > CURSOR_REST_MS) {
      // Both ends of a hole need writing down, and for different reasons. The
      // head is where the settle happens. The tail is where the LEAD bites:
      // the target is read `lead` ahead, so the drawn cursor starts moving
      // toward whatever follows the hole before the hole is over, and with no
      // samples in that stretch the move is read as a straight line across
      // the entire pause. Measured before this covered the tail — a
      // two-second pause put the drawn cursor 285px from a target it should
      // have been sitting on.
      const headUntil = Math.min(to.sourceTimeMs, from.sourceTimeMs + settleMs);
      const tailFrom = Math.max(
        from.sourceTimeMs,
        to.sourceTimeMs - lead - settleMs,
      );
      for (
        let ms = from.sourceTimeMs + SPRING_GRID_MS;
        ms < to.sourceTimeMs;
        ms += SPRING_GRID_MS
      ) {
        if (ms < headUntil || ms >= tailFrom) times.push(ms);
      }
    }
    times.push(to.sourceTimeMs);
  }

  const read = readerFor(samples);
  let previous = first.sourceTimeMs;
  for (const ms of times) {
    // The target is read at the MIDDLE of the step, not at its end. A step
    // holds the target still for its whole duration (that is what makes the
    // solution analytic), so where in the step it is read from decides how
    // far the answer is biased: reading at the end leads a moving target by
    // half a step, which is a bias of `dt/2 * V` that no amount of lead
    // cancels because it is a property of the discretization rather than of
    // the spring. Measured on a 1000px/s traverse sampled a frame apart, the
    // drawn cursor cruised 8.3px ahead of the hand read at the end of the
    // step and 0.001px behind it read from the middle of it. It also makes the
    // result independent of the step size, which the grid above now varies.
    const target = read((previous + ms) / 2 + lead);
    advance(ms - previous, target.x, target.y, ms);
    previous = ms;
  }

  // The samples run out before the spring does. Stepping only to the last
  // recorded instant leaves whatever error the follower was still carrying
  // frozen into the final drawn position, and `sampleCursor` clamps to it
  // for the rest of the video: measured on a plain 500ms reach with no
  // markers, the take ended at (696,398) and the drawn cursor stopped
  // 31.6px short of it and stayed there. The hand has stopped, so the target
  // for this stretch is the last thing it was observed to be — the same
  // reading `positionAt` gives beyond the end of the array — and the spring
  // is walked on until it has arrived.
  const last = samples[samples.length - 1] as CursorSample;
  for (
    let ms = previous + SPRING_GRID_MS;
    ms <= last.sourceTimeMs + settleMs;
    ms += SPRING_GRID_MS
  ) {
    advance(ms - previous, last.x, last.y, ms);
    previous = ms;
  }

  return anchor(out, samples, anchorMs, settleMs);
}

/**
 * Pull the drawn cursor back onto the target at each anchor, over a shoulder
 * wide enough that the correction is invisible as a movement of its own.
 */
function anchor(
  drawn: CursorSample[],
  target: CursorSample[],
  anchorMs: readonly number[],
  shoulderMs: number,
): CursorSample[] {
  const anchors = [...new Set(anchorMs)].sort((a, b) => a - b);
  if (anchors.length === 0 || shoulderMs <= 0) return drawn;

  const out = drawn.map((s) => ({ ...s }));
  for (const [index, ms] of anchors.entries()) {
    const previous = anchors[index - 1];
    const next = anchors[index + 1];
    const room = Math.min(
      previous === undefined ? Number.POSITIVE_INFINITY : (ms - previous) / 2,
      next === undefined ? Number.POSITIVE_INFINITY : (next - ms) / 2,
    );
    const shoulder = Math.min(shoulderMs, room);
    if (!Number.isFinite(shoulder) || shoulder <= 0) continue;

    const truth = positionAt(target, ms);
    const here = positionAt(out, ms);
    const dx = truth.x - here.x;
    const dy = truth.y - here.y;
    if (dx === 0 && dy === 0) continue;

    for (const sample of out) {
      const away = Math.abs(sample.sourceTimeMs - ms);
      if (away > shoulder) continue;
      const weight = 0.5 * (1 + Math.cos((Math.PI * away) / shoulder));
      sample.x += dx * weight;
      sample.y += dy * weight;
    }
  }
  return out;
}
