import { type CursorGap, type CursorSample, overlapsGap } from "../bundle.js";

/**
 * The width of the smoothing kernel, as its standard deviation.
 *
 * PROVISIONAL, and in the same way the 40ms box window it replaced was
 * provisional: it has not been measured against a real captured take. It is
 * an author's judgement, chosen by eye, and it still owes the measurement
 * `SPAN_MIN_FRAMES` (`packages/replay-engine/src/constants.ts`) is the house
 * standard for — a population of real recorded takes, a residual-amplitude
 * figure and a max-displacement-in-pixels figure at each of several
 * candidate widths, a stated gap between "clearly tremor" and "clearly
 * motion", and the smallest width whose residual falls in the flat part of
 * that curve. None of that exists yet. Do it before trusting this number
 * for anything but the bounds proven in `cursor-smoothing.test.ts`.
 *
 * What IS derived rather than tasted is the kernel's *shape*, and the two
 * bounds the tests hold it to. A Gaussian's frequency response is
 * `exp(-(2*pi*f*sigma)^2 / 2)` with no sidelobes, so at 30ms it passes
 * deliberate movement (under ~2Hz) essentially untouched and leaves 7.8% of
 * a 12Hz hand tremor — the band physiological tremor actually occupies.
 * Measured on the tremor fixture: 0.078px of a 1px tremor survives, against
 * 0.590px under the 40ms box this replaced, which is a visible shimmer at
 * 12Hz. That 7.5x is the whole reason for the change of kernel.
 *
 * Raising it smooths more and cuts corners harder — displacement at a
 * direction change grows roughly with speed times sigma. Lower it if the
 * cursor reads as floaty, raise it if a shaky hand still reads as shaky;
 * `cursor-smoothing.test.ts` holds both ends of that trade.
 */
export const CURSOR_SMOOTHING_MS = 30;

/** Where the kernel is truncated. Beyond 3 sigma a Gaussian carries 0.3% of
 *  its weight, which is below the sub-pixel scale anything here is drawn at. */
const KERNEL_REACH_SIGMAS = 3;

/**
 * Below this, a hole between two samples is undersampling; above it, the
 * pointer was not moving.
 *
 * Derived rather than tasted, unlike `CURSOR_SMOOTHING_MS`. While the
 * pointer is moving, `pointermove` coalesces to at least one event per frame
 * and the sensor drains a batch per `requestAnimationFrame`, preserving the
 * sub-frame positions `getCoalescedEvents` returns — so consecutive samples
 * during real travel are about one frame apart, 16.7ms at 60Hz. Three frames
 * of silence is not a fast pointer, it is a still one. A hand moving so
 * slowly that consecutive positions round to the same CSS pixel is deduped
 * by `createPointerSampler` and lands here too, which is correct: sub-pixel
 * travel is not drawable anyway.
 *
 * Two things read it, for one reason. `holdThroughRests` (`plan/resolve.ts`)
 * makes the pause render as a pause; `smoothCursor` treats it as a boundary
 * its kernel may not reach across. Both follow from the same fact — the
 * pointer stopped — so they must agree on when that happened, which is why
 * this is one constant and not two.
 */
export const CURSOR_REST_MS = 50;

/**
 * The samples `sampleCursor` would read at each of `times`.
 *
 * One index per side: the last sample at or before the instant and the first
 * at or after it. Those two, and only those two, decide the interpolated
 * position there — so those two are what has to survive smoothing untouched
 * for the drawn position at that instant to be the recorded one. An instant
 * outside the samples' range brackets to whichever single endpoint exists,
 * which is already pinned; that costs nothing and needs no special case.
 *
 * Linear scan per instant rather than a binary search: `times` is one entry
 * per action, which is tens at most, against samples numbering thousands —
 * and this runs once per resolve, not per frame.
 */
function bracketIndices(
  samples: CursorSample[],
  times: readonly number[],
): Set<number> {
  const out = new Set<number>();
  for (const t of times) {
    let before: number | null = null;
    let after: number | null = null;
    for (let i = 0; i < samples.length; i++) {
      const at = samples[i]?.sourceTimeMs;
      if (at === undefined) continue;
      if (at <= t) before = i;
      if (at >= t) {
        after = i;
        break;
      }
    }
    if (before !== null) out.add(before);
    if (after !== null) out.add(after);
  }
  return out;
}

/**
 * The index ranges the kernel is allowed to average within.
 *
 * A run is a stretch of continuous travel: consecutive samples no further
 * apart than `CURSOR_REST_MS`. A longer hole is a pause (see that
 * constant), and the two sides of a pause are two separate gestures —
 * averaging across one blends the end of a reach with the start of whatever
 * the hand did next, which is not smoothing but invention.
 *
 * A recorded gap breaks a run as well, and it is not the same condition. A
 * pause is a hole long enough to mean the hand stopped; a gap is a stretch
 * where the position was not observed AT ALL, and it can be far shorter than
 * a pause — `pointerleave` opens one and the next `pointermove` closes it.
 * Measured on a 30ms gap with the pointer returning 1000px away, the kernel
 * averaged straight across the teleport and drew the first position after it
 * 151px from where the pointer was seen. The time boundary cannot catch
 * that, because by time alone those two samples are one frame apart.
 *
 * Returns, for each index, the first and last index of its own run.
 */
function runBounds(
  samples: CursorSample[],
  boundaryMs: number,
  gaps: readonly CursorGap[],
): { start: number[]; end: number[] } {
  const start = new Array<number>(samples.length).fill(0);
  const end = new Array<number>(samples.length).fill(samples.length - 1);
  let runStart = 0;
  for (let i = 1; i <= samples.length; i++) {
    const previous = samples[i - 1];
    const current = samples[i];
    const broken =
      current === undefined ||
      previous === undefined ||
      current.sourceTimeMs - previous.sourceTimeMs > boundaryMs ||
      overlapsGap(gaps, previous.sourceTimeMs, current.sourceTimeMs);
    if (!broken) continue;
    for (let j = runStart; j < i; j++) {
      start[j] = runStart;
      end[j] = i - 1;
    }
    runStart = i;
  }
  return { start, end };
}

/**
 * A Gaussian-weighted, symmetric, zero-phase average over a time window.
 *
 * **Why a Gaussian and not the box average this replaced.** A box leaves
 * sidelobes: its response is a sinc, so it attenuates some frequencies far
 * less than its width suggests and leaves a residue that is *jerky* rather
 * than merely present. At the 40ms box that shipped until 2026-09-11, a 1px
 * 12Hz tremor — the band a real hand actually shakes in — came through at
 * 0.590px, i.e. barely filtered at all, as a shimmer. The same fixture under
 * this kernel leaves 0.078px. A Gaussian's response has no sidelobes, so
 * what it removes it removes smoothly, and the drawn path's *velocity* is
 * smooth as well as its position — which is what reads as smooth motion.
 *
 * **The centre sample is included, and that is a change.** The box version
 * deliberately excluded it: for equal weights, a window that includes the
 * centre cannot fully cancel a signal that flips sign every sample, because
 * the centre contributes one point of a phase no neighbour shares. Unequal
 * weights remove that argument — the alternating sum of a Gaussian's own
 * weights is already ~0.15% of their total — so the exclusion buys nothing
 * here and cost something real: it rounded every interior corner harder
 * than the kernel itself does, which the old docblock recorded as "a real
 * softening of every click this function smooths, not just of noise". That
 * cost is gone with it.
 *
 * **Reach is clamped symmetrically.** An asymmetric window biases the
 * estimate toward the side with more points, and that is not a rare edge:
 * the last samples before a pause have no real neighbours on the far side at
 * all, so the box version — which clamped to the whole take's endpoints
 * rather than to the run — pulled an arrival backward along its own approach
 * by 2.5px, and the first sample after a pause 12px backward onto the
 * gesture before it. Both measured; both are assertions in
 * `cursor-smoothing.test.ts` now.
 *
 * **A run is padded with the stillness observed either side of it.** Clamping
 * the reach to the run's own ends kept the window symmetric but shrank it to
 * nothing at every gesture boundary, and a short reach is nearly all
 * boundary — so the tremor that survived was concentrated exactly there, and
 * no sigma could remove it. Measured on a 250ms gesture at sigma 30/60/90:
 * 0.274 / 0.270 / 0.273 px RMS, flat, because the binding constraint was the
 * boundary and not the kernel.
 *
 * The pointer's position either side of a run is not unknown. It sat still
 * there, for the whole pause — that is what made the pause a pause (see
 * `CURSOR_REST_MS`), and `holdThroughRests` has already written it down. So
 * the window is filled outward from each end of the run with that resting
 * position, at the run's own mean sample cadence so the padding carries the
 * same weight per unit time the real samples do, for as long as the pause
 * actually lasted and no longer. The reach is then the smaller of 3 sigma
 * and how far each side can be filled, which is symmetric again.
 *
 * The gain is measured: on a 250ms gesture the wiggle left in the drawn
 * path falls from 0.0795 to 0.0227 (RMS second difference), a further 3.5x
 * on exactly the short reaches that still read as jerky.
 *
 * It is NOT an ease-in, and an earlier draft of this comment claimed it was.
 * A symmetric zero-phase kernel does not lag a corner, it rounds it — so at
 * a rest boundary the drawn cursor leaves slightly EARLY rather than
 * accelerating away late. Measured on that fixture, the first step out of a
 * rest was 8.1px drawn against 4.0px recorded: the opposite of easing. The
 * anticipation is bounded by roughly sigma and reads as smooth rather than
 * as prescience, but it is worth knowing it is there — a lagging follower,
 * which is what would actually ease, is a different filter and would fight
 * the marker pinning below.
 *
 * What the rounding costs is distance from the recorded path: 5.4px at the
 * worst point of that fixture against 1.3px with the reach clamped. The
 * bound that matters is that the drawn cursor stays on the control the hand
 * was on, and `cursor-smoothing.test.ts` holds it to 16px.
 *
 * Padding never exceeds the observed pause, so a 60ms pause contributes 60ms
 * of stillness and not 90. At the take's very first and last run there is no
 * pause to stand on and nothing is padded: before the first sample the
 * pointer's position is genuinely unknown, and inventing stillness there
 * would be the fabrication this whole file is careful not to commit.
 *
 * The first and last sample of every run passes through **exactly**, by rule
 * rather than by the reach going to zero. The take's own endpoints are a
 * special case, so the cursor still arrives where the action fired; and so
 * does every arrival that ends in a pause, which is what an arrival at a
 * click is. Timestamps pass through one for one, so every downstream
 * consumer (`cursorMotionSpans`, the timeline's dead-air detection) sees the
 * same sample count at the same instants.
 *
 * `pinnedMs` covers the arrivals that are NOT run ends — a click the hand
 * clicked through without stopping, a marker mid-gesture. The caller supplies
 * `bundle.markers`' source times: a marker is where an action fires, so it is
 * where `sampleCursor` is read for the click pulse and where the drawn cursor
 * has to be the recorded one.
 *
 * What gets pinned is the two samples *bracketing* each instant — the last
 * at or before it and the first at or after — and NOT only a sample whose
 * time equals it. That distinction is the whole fix, not a detail of it.
 * `sampleCursor` is a linear interpolation between the two adjacent samples
 * around the instant asked for, so those two are what decide where the
 * click is drawn; and nothing in this pipeline ever produces a sample whose
 * time equals a marker's. A marker's `sourceTimeMs` is an integer
 * `Date.now()` rebased on the sessionStart record (`core/reduce.ts`'s
 * `rebase`), while a cursor sample's is `performance.timeOrigin +
 * event.timeStamp` rebased on `Date.parse(meta.createdAt)`
 * (`adapters/capture-frames.ts`) — a different clock, a sub-millisecond
 * value, and a different base. Pinning on equality would have matched
 * nothing outside a fixture built to make it match: a fix that passes its
 * own test and does nothing in production.
 *
 * Pinning is one-way: a pinned sample's own raw value still feeds its
 * neighbours' averages, because it is a true observation and the
 * neighbours want the trend it belongs to.
 */
export function smoothCursor(
  samples: CursorSample[],
  sigmaMs: number,
  pinnedMs: readonly number[] = [],
  gaps: readonly CursorGap[] = [],
): CursorSample[] {
  if (sigmaMs <= 0 || samples.length < 3) return samples;
  const pinned = bracketIndices(samples, pinnedMs);
  const runs = runBounds(samples, CURSOR_REST_MS, gaps);
  const maxReach = KERNEL_REACH_SIGMAS * sigmaMs;
  const twoSigmaSquared = 2 * sigmaMs * sigmaMs;

  // A sliding window over the samples, which the bundle schema keeps in
  // ascending time order (ties allowed). Until 2026-09-06 every sample
  // scanned every other sample: ~450M comparisons per resolve on a
  // 3-minute take at 120 Hz, and the editor resolves on every edit.
  //
  // `lo` is the first index not behind the reach, `hi` one past the last
  // index not ahead of it. Both only ever move forward *within a run*,
  // because both edges of the window are non-decreasing in `i`: the reach is
  // the minimum of a constant and the two distances to the run's ends, so
  // `t - reach` is `max(t - maxReach, t_runStart, 2t - t_runEnd)` and
  // `t + reach` is `min(t + maxReach, 2t - t_runStart, t_runEnd)`, each a
  // non-decreasing function of `t`, and `t` is non-decreasing in `i`. At a
  // run boundary both are reset to the new run's start, which is still
  // forward-only overall because runs are contiguous and in order.
  //
  // The window is found with a hair of slack and the samples in it are
  // then tested with the exact predicate an unbounded scan would use, in
  // the same order. That is what makes the answer identical to the last bit
  // rather than merely close: the same neighbours, summed the same way, with
  // the search bounded instead of the sum changed. See
  // `cursor-smoothing-window.test.ts`, which keeps that unbounded scan as
  // its oracle.
  const SLACK_MS = 1e-6;
  let lo = 0;
  let hi = 0;
  let currentRun = -1;
  let cadence = 0;
  let padBefore = 0;
  let padAfter = 0;

  return samples.map((sample, i) => {
    const runStart = runs.start[i] as number;
    const runEnd = runs.end[i] as number;
    const first = samples[runStart] as CursorSample;
    const last = samples[runEnd] as CursorSample;
    if (runStart !== currentRun) {
      currentRun = runStart;
      lo = runStart;
      hi = runStart;
      // The run's own mean interval, so a padded millisecond weighs what a
      // recorded one does. Not the interval at the boundary itself: the
      // sample `holdThroughRests` inserts sits 1ms before the one that ends
      // the pause, and padding at 1ms would bury the gesture under its own
      // resting position.
      const span = last.sourceTimeMs - first.sourceTimeMs;
      cadence = runEnd > runStart ? span / (runEnd - runStart) : 0;
      // How long the pointer was observed to be still on each side. Zero at
      // the take's ends, where there is no pause to stand on.
      // Zero across a gap as well as at the take's ends, and for the same
      // reason: this pads with stillness the pointer was OBSERVED to hold,
      // and inside a gap it was observed to do nothing at all. Padding there
      // would weight the kernel with a position that is a placeholder for an
      // unknown one.
      const previousEnd =
        runStart > 0 ? (samples[runStart - 1] as CursorSample).sourceTimeMs : 0;
      const nextStart =
        runEnd < samples.length - 1
          ? (samples[runEnd + 1] as CursorSample).sourceTimeMs
          : 0;
      const quietBefore =
        runStart > 0 && !overlapsGap(gaps, previousEnd, first.sourceTimeMs)
          ? first.sourceTimeMs - previousEnd
          : 0;
      const quietAfter =
        runEnd < samples.length - 1 &&
        !overlapsGap(gaps, last.sourceTimeMs, nextStart)
          ? nextStart - last.sourceTimeMs
          : 0;
      padBefore = Math.min(maxReach, quietBefore);
      padAfter = Math.min(maxReach, quietAfter);
    }
    if (i === runStart || i === runEnd) return sample;
    if (pinned.has(i)) return sample;

    const at = sample.sourceTimeMs;
    const reach = Math.min(
      maxReach,
      at - first.sourceTimeMs + padBefore,
      last.sourceTimeMs - at + padAfter,
    );
    if (reach <= 0) return sample;

    while (
      lo <= runEnd &&
      at - (samples[lo] as CursorSample).sourceTimeMs > reach + SLACK_MS
    )
      lo++;
    if (hi < lo) hi = lo;
    while (
      hi <= runEnd &&
      (samples[hi] as CursorSample).sourceTimeMs - at <= reach + SLACK_MS
    )
      hi++;

    let sx = 0;
    let sy = 0;
    let weight = 0;
    for (let j = lo; j < hi; j++) {
      const other = samples[j];
      if (!other) continue;
      const dt = other.sourceTimeMs - at;
      if (Math.abs(dt) > reach) continue;
      const w = Math.exp(-(dt * dt) / twoSigmaSquared);
      sx += other.x * w;
      sy += other.y * w;
      weight += w;
    }

    // The stillness either side, sampled at the run's own cadence and
    // carrying the run's own endpoint position.
    if (cadence > 0) {
      for (let step = cadence; step <= padBefore + SLACK_MS; step += cadence) {
        const dt = first.sourceTimeMs - step - at;
        if (-dt > reach + SLACK_MS) break;
        const w = Math.exp(-(dt * dt) / twoSigmaSquared);
        sx += first.x * w;
        sy += first.y * w;
        weight += w;
      }
      for (let step = cadence; step <= padAfter + SLACK_MS; step += cadence) {
        const dt = last.sourceTimeMs + step - at;
        if (dt > reach + SLACK_MS) break;
        const w = Math.exp(-(dt * dt) / twoSigmaSquared);
        sx += last.x * w;
        sy += last.y * w;
        weight += w;
      }
    }

    return weight === 0
      ? sample
      : { sourceTimeMs: at, x: sx / weight, y: sy / weight };
  });
}
