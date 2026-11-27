import type { SourcePoint } from "@demoman/scene-schema";
import {
  type CursorSample,
  type Degradation,
  type FrameBundle,
  gapPacedLive,
  isHeld,
  isRealTime,
} from "../bundle.js";
import { clamp } from "../geometry.js";
import { CURSOR_SPRING_TAU_MS, springSettleMs } from "./cursor-spring.js";
import { inScreenSpace } from "./screen-space.js";
import type { AuthoredPace, RecordedPace, RenderPlan } from "./types.js";

export interface TimeSpan {
  startMs: number;
  endMs: number;
}

export interface TimelineSegment {
  outStartMs: number;
  outEndMs: number;
  srcStartMs: number;
  srcEndMs: number;
  /**
   * `hold` is an authored pause: output time advances while source time
   * stands still, so `srcStartMs === srcEndMs`. It is the one dilation in a
   * module otherwise dedicated to compression, and the reason the backbone
   * property is stated as monotone *non-decreasing* rather than increasing.
   *
   * `pace` is a RECORDED pause reconstructed at render time, as against
   * `hold`, which the author authored. Structurally identical — output time
   * advances while source time stands still — and kept distinct so the editor
   * can tell the author which durations are theirs.
   *
   * A recorded pace is only ever emitted for a sampled replay bundle. A
   * capture bundle already contains the pause as real elapsed source time;
   * emitting one there would play it twice. The other `pace` is a planned
   * beat's stretch that held no idle frame to stretch (`plannedIdleOf`): a
   * freeze of its planned length at the stretch's end, on a real-time
   * bundle.
   */
  kind: "motion" | "idle" | "hold" | "pace";
}

/**
 * One stretch of source time the author removed from the video, resolved
 * against the bundle being rendered. Overlapping and adjacent pieces are one
 * stretch here, carrying every piece's id.
 *
 * `srcStartMs` is the last instant still IN the video — the seam itself —
 * and the removal is everything after it up to and including `srcEndMs`.
 * Half-open at the start for that reason: things standing exactly on the
 * seam still play.
 */
export interface ResolvedCut {
  ids: string[];
  srcStartMs: number;
  srcEndMs: number;
  /** The stretch reached the end of the take: there is nothing after it to
   *  join it to. */
  trailing: boolean;
}

/**
 * A removed piece that removed no frames, and why.
 *
 * Never a silent skip. "Your cut worked" and "your cut did nothing" look
 * identical on a timeline unless one of them says so, and the caller is the
 * only party that can say it — the editor turns each of these into a lane
 * notice.
 */
export interface UnplacedCut {
  ids: string[];
  /** An author-facing sentence. */
  reason: string;
}

export interface Timeline {
  segments: TimelineSegment[];
  outputDurationMs: number;
  sourceDurationMs: number;
  /** Stretches removed from the output axis, in source time. */
  cuts: ResolvedCut[];
  /** Cuts that removed nothing, each with its reason. */
  unplacedCuts: UnplacedCut[];
  /**
   * Stretches removed because the run was interrupted, not edited: each
   * recovered `occlusionPause` a real-time replay recorded (spec 2026-10-03
   * §6), trimmed against `cuts`. Separate from `cuts`, which are the
   * author's and which the editor tests seams on and names.
   */
  interruptions: TimeSpan[];
  /**
   * Paces the bundle carries no marker for. A rebuild that stopped early is
   * the common cause and not the only one — an action added to the scene
   * after the rebuild ran has no marker in it either — so this counts the
   * condition and leaves the cause to whoever can see the rest of the
   * session. Never silently zero: the caller surfaces it, because a video
   * shorter than the take with no explanation is the defect this feature
   * exists to remove.
   *
   * On a real-time bundle it counts the planned beats (and the planned tail)
   * that could not be placed: a marker missing, or the step's marker without
   * the `approachSourceTimeMs` that splits rest from arrive. That pair plays
   * as recorded, never silently shorter or longer than the plan.
   */
  unplacedPaces: number;
  /**
   * The step each unplaced PLANNED beat sits before, in plan order (`null`
   * for the planned tail, which sits before no step). Its length is the
   * planned part of `unplacedPaces`; absent on a timeline built by hand.
   */
  unplacedBeatSteps?: (string | null)[];
  /**
   * The output-time stretches of IDLE a beat plan placed: the idle segments
   * and freezes of each placed beat's rest, after-scroll and arrive, the
   * opening's and the tail's, touching ones joined. Motion between two steps
   * is never inside one, and a beat counted unplaced contributes none. Present
   * only on a planned take that placed any; the film check reads it.
   */
  placedIdle?: TimeSpan[];
  /**
   * Recorded paces whose interval runs backwards, i.e. the action log is not
   * in time order. Counted over the plan's own paces and therefore
   * independent of `bundle.source`: an out-of-order log is a fact about the
   * take, true whichever frames are being rendered, even though it is a
   * rebuild that shows it as a longer video.
   *
   * Reported for the reason `plan.ts` no longer floors it: a backwards pair
   * contributes nothing where it sits AND leaves its dead air to be claimed
   * by the pair after it, so the video comes out longer with every pause
   * apparently intact. Nothing about the result looks wrong enough to ask
   * about, which is what makes the silence expensive.
   */
  nonMonotonicPaces: number;
}

function merge(spans: TimeSpan[]): TimeSpan[] {
  const sorted = [...spans]
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const out: TimeSpan[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    // Adjacent counts as overlapping: a hairline idle sliver between two
    // motion spans is not dead air, it is sampling noise.
    if (last && span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      out.push({ startMs: span.startMs, endMs: span.endMs });
    }
  }
  return out;
}

/**
 * A degradation that means "the page WAS moving here and the harvest could
 * not keep it" — as opposed to one about the run's conduct, like an
 * occlusion pause or a page that never settled.
 *
 * They differ in cause and agree in consequence, and the consequence is what
 * every reader of this needs: a stretch with no span over it that was
 * nonetheless not idle. Leaving one out lets the retimer read it as idle and
 * compress the take's pacing away at exactly the moments — a scroll, a page
 * load — the author was watching something happen.
 */
export function isUnkeptMotion(d: Degradation): boolean {
  return (
    d.kind === "keyframeOnly" ||
    d.kind === "surfaceMismatch" ||
    d.kind === "encodeRefused" ||
    d.kind === "motionReclaimed"
  );
}

/**
 * Where the source timeline was moving. Three sources of truth, cheapest
 * first: a harvested motion span; a keyframeOnly degradation, which is SP5
 * reporting motion it could not keep; and caller-supplied hints from
 * keyframe diffing, which the render layer computes because it needs pixels.
 */
export function motionSpansOf(
  bundle: FrameBundle,
  hints: TimeSpan[] = [],
): TimeSpan[] {
  return merge([
    ...bundle.motionSpans.map((s) => ({ startMs: s.startMs, endMs: s.endMs })),
    ...bundle.degradations
      .filter(isUnkeptMotion)
      .map((d) => ({ startMs: d.startMs, endMs: d.endMs })),
    ...hints,
  ]);
}

/**
 * Removed pieces to source ranges, against the bundle actually being
 * rendered: each point is its step's marker plus its offset, clamped to the
 * frames.
 *
 * Every refusal here is an `UnplacedCut` with a sentence, never a silent
 * skip and never a fallback to the take's own end. The fallback is the
 * dangerous one: a piece whose closing step has no marker, resolved to the
 * end of the take, deletes every frame after it and reports a clean render
 * — a failure path whose output is indistinguishable from a success, and a
 * long one.
 *
 * Overlapping and adjacent pieces merge into one stretch. Kept apart, the
 * frame on their shared edge would be both the seam that plays and the end
 * of a stretch that does not.
 */
function cutRanges(
  plan: RenderPlan,
  bundle: FrameBundle,
  sourceDurationMs: number,
): { cuts: ResolvedCut[]; unplacedCuts: UnplacedCut[] } {
  const markerAt = new Map(
    bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]),
  );
  const resolved: ResolvedCut[] = [];
  const unplacedCuts: UnplacedCut[] = [];
  // `?? []` the way `planScene` writes it: `buildTimeline` accepts any
  // `RenderPlan`, including a hand-built one in a test written before this
  // field existed, and a TypeError here would take the whole render down.
  for (const piece of plan.removed ?? []) {
    const ids = [piece.id];
    const sourceOf = (
      point: SourcePoint | null,
      ifNull: number,
    ): number | string => {
      if (point === null) return ifNull;
      const marker = markerAt.get(point.actionId);
      if (marker === undefined) {
        return `these frames carry no marker for "${point.actionId}", so where this piece ${ifNull === 0 ? "starts" : "ends"} is unknown and no frames were removed`;
      }
      return clamp(marker + point.sourceOffsetMs, 0, sourceDurationMs);
    };
    const start = sourceOf(piece.start, 0);
    const end = sourceOf(piece.end, sourceDurationMs);
    if (typeof start === "string" || typeof end === "string") {
      unplacedCuts.push({
        ids,
        reason: typeof start === "string" ? start : (end as string),
      });
      continue;
    }
    if (end <= start) {
      unplacedCuts.push({
        ids,
        reason: `this piece's two ends land at the same instant (${Math.round(start)}ms) or out of order, so it covers no frames`,
      });
      continue;
    }
    resolved.push({
      ids,
      srcStartMs: start,
      srcEndMs: end,
      trailing: end >= sourceDurationMs,
    });
  }

  resolved.sort((a, b) => a.srcStartMs - b.srcStartMs);
  const cuts: ResolvedCut[] = [];
  for (const cut of resolved) {
    const previous = cuts[cuts.length - 1];
    if (previous && cut.srcStartMs <= previous.srcEndMs) {
      previous.ids.push(...cut.ids);
      previous.srcEndMs = Math.max(previous.srcEndMs, cut.srcEndMs);
      previous.trailing ||= cut.trailing;
      continue;
    }
    cuts.push(cut);
  }
  return { cuts, unplacedCuts };
}

/**
 * Whether a source instant falls inside a removed stretch, CLOSED at the
 * end: the closing instant itself (`srcEndMs`) counts as removed.
 *
 * Half-open at the START either way — the stretch's opening instant is the
 * last frame still in the video, the seam itself, so a hold or a pace
 * standing exactly there still plays.
 *
 * This is the form `paceInstants` wants. A pace's instant lands at `to`, the
 * END of the stretch it reconstructs, and `to === srcEndMs` is the pace that
 * would have landed exactly on the frame the cut runs up to — a wait for an
 * action the author cut away, which the cut already removed. Closed, this
 * answers `true` there, and the pace is dropped WITH the stretch rather than
 * reconstructed on its far side.
 *
 * Split from a single `insideCut` on 2026-09-24 (Task 11, ledger minor #1):
 * one predicate answered both this question and `holdInstantsClosed`'s open
 * one below, and closed-at-the-end was the only answer offered. That is
 * right for a pace and wrong for a hold — see that function's docblock —
 * and the fix is two named predicates, not moving the boundary on the one
 * that existed.
 */
export function insideCutClosed(
  cuts: readonly ResolvedCut[],
  sourceMs: number,
): boolean {
  return cuts.some((c) => sourceMs > c.srcStartMs && sourceMs <= c.srcEndMs);
}

/**
 * Whether a source instant falls inside a removed stretch, OPEN at the end:
 * the closing instant itself (`srcEndMs`) does NOT count as removed.
 *
 * This is the form `holdInstants` wants, and the reason is `rawSegmentsOf`'s
 * own segmentation: `srcEndMs` is a cut boundary in its `cutSet`, and the raw
 * segment that starts exactly there is emitted and kept — it is the first
 * frame that plays again after the seam, not one the removed stretch still
 * owns. A legacy `edits.holds` entry whose resolved instant lands exactly on
 * a cut's closing marker sits on that surviving frame, and its pause plays.
 * Answered with the closed form above, it read as still inside the cut and
 * was dropped though the frame it names is on screen and the panel says so.
 *
 * Narrow to vanishing in practice — no command creates a legacy hold any
 * more (`migrateHoldsToGaps` retired them) and the position has to be exact
 * — which is why it stood deferred through plan 2's final review rather than
 * being fixed there. See `timeline-cuts-edits.test.ts`'s boundary case.
 */
export function insideCutOpen(
  cuts: readonly ResolvedCut[],
  sourceMs: number,
): boolean {
  return cuts.some((c) => sourceMs > c.srcStartMs && sourceMs < c.srcEndMs);
}

/**
 * Tolerance for matching a hold's resolved source instant against a segment
 * boundary. Everything that produces these numbers (marker lookup, integer
 * offsetMs, the proportional split below) is exact in practice, but the
 * comparisons that depend on it should not be coupled to that by accident.
 */
const HOLD_EPSILON_MS = 1e-6;

interface HoldInstant {
  sourceTimeMs: number;
  durationMs: number;
}

/**
 * Authored holds, resolved from marker-relative to source-absolute.
 *
 * A hold whose action the bundle has no marker for is dropped. That is a
 * partial replay stopping mid-flow, and the alternative — inventing a source
 * time — is precisely the absolute-timestamp anchoring v8 §6 exists to
 * forbid.
 *
 * `durationMs` is clamped to zero-or-more: `buildTimeline` takes any
 * `RenderPlan`, including a hand-built one in a test, and a negative
 * duration would walk the output cursor backwards, breaking monotonicity of
 * both `toSourceMs` and `toOutputMs`.
 */
/** Where a hold stands in source time: its marker plus its offset, inside
 *  the source. One rule for the hold and for what is drawn on it
 *  (`resolvePlan`'s dialog cards), so a marker past the source's end still
 *  finds its hold. */
export const holdSourceMs = (
  markerMs: number,
  offsetMs: number,
  sourceDurationMs: number,
): number => clamp(markerMs + offsetMs, 0, sourceDurationMs);

function holdInstants(
  plan: RenderPlan,
  bundle: FrameBundle,
  sourceDurationMs: number,
  cuts: ResolvedCut[],
): HoldInstant[] {
  const markerAt = new Map(
    bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]),
  );
  // Dialog holds first: the sort below is stable, so at an instant shared
  // with an authored hold the dialog's is the first hold segment there,
  // which is where `resolvePlan` looks for its card.
  const dialogHolds = (plan.dialogs ?? []).map((d) => ({
    actionId: d.actionId,
    offsetMs: 0,
    durationMs: d.durationMs,
  }));
  return [...dialogHolds, ...plan.holds]
    .flatMap((hold) => {
      const marker = markerAt.get(hold.actionId);
      if (marker === undefined) return [];
      const sourceTimeMs = holdSourceMs(
        marker,
        hold.offsetMs,
        sourceDurationMs,
      );
      // A pause inside a stretch the author cut is gone with the stretch
      // (spec §1, "Gaps, holds and paces inside a removed range are dropped
      // with it"). Stated as a RULE rather than left to the segmentation:
      // the segment that would have carried this instant is never emitted,
      // so the pause already vanished by accident — and an accident is not
      // something the boundary case below can be written against. A hold
      // standing EXACTLY on the OPENING seam survives for that reason.
      //
      // The OPEN form, not the closed one `paceInstants` wants: a hold that
      // resolves exactly onto the cut's CLOSING marker sits on the frame
      // `rawSegmentsOf` resumes the take on, which plays — see
      // `insideCutOpen`'s own docblock for why the two callers disagree.
      if (insideCutOpen(cuts, sourceTimeMs)) return [];
      return [
        {
          sourceTimeMs,
          durationMs: Math.max(0, hold.durationMs),
        },
      ];
    })
    .sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
}

interface PaceInstant {
  sourceTimeMs: number;
  durationMs: number;
}

/**
 * How much of `[fromMs, toMs)` the merged motion set covers.
 *
 * `motion` must be the SAME merged set `rawSegmentsOf` classified idle vs
 * motion with (bundle spans + degradations + caller hints — see
 * `motionSpansOf`), never a fresh `motionSpansOf(bundle)` recomputed with no
 * hints. `resolvePlan` always calls `buildTimeline` with
 * `cursorMotionSpans(cursor)` folded into its hints (resolve.ts), so on a
 * real bundle the cursor moving toward the next target during a stretch
 * narrows the idle inside it — recomputing without that hint overcounts idle
 * and under-realizes every authored gap. Found 2026-09-08 in review.
 */
function motionMsBetween(
  motion: TimeSpan[],
  fromMs: number,
  toMs: number,
): number {
  let motionMs = 0;
  for (const span of motion) {
    const start = Math.max(span.startMs, fromMs);
    const end = Math.min(span.endMs, toMs);
    if (end > start) motionMs += end - start;
  }
  return motionMs;
}

/**
 * The one place the authored and recorded paces become one number: the IDLE
 * duration this pair should end up with, on the bundle being rendered.
 *
 * An authored gap already IS an idle figure — that is what the author set,
 * and it is bundle-independent by design, which is precisely what makes the
 * render-mode toggle change provenance and nothing else.
 *
 * A recorded pace is not. `planScene` has only `action.timestamp` and cannot
 * tell a dropdown opening apart from the author sitting still, so it carries
 * the whole interval and the motion comes off here, against whichever
 * bundle is being rendered. On a capture bundle that subtraction returns the
 * idle the bundle already holds, which is why `authoredRegions` can
 * skip recorded paces outright rather than re-deriving a no-op. On a replay
 * bundle it cancels with `replayIdle` in `paceInstants`, leaving
 * `max(0, recordedSpanMs − (to − from))` — the whole-span arithmetic rebuild
 * mode has always used for recorded pacing, and correctly: reproducing the
 * take's own length is exactly what a recorded pace asks for.
 */
function idleTargetMsFor(
  pace: AuthoredPace | RecordedPace,
  motionMs: number,
): number {
  return pace.origin === "authored"
    ? pace.idleTargetMs
    : Math.max(0, pace.recordedSpanMs - motionMs);
}

/**
 * Reconstructed pacing, for a rebuild only. Gated to `bundle.source ===
 * "replay"` (Ruling P1, 2026-09-08): a capture bundle's source time already
 * IS real time and its pause is already realized as elapsed idle
 * (`idleOutputFor`, gated the other way, to `"capture"`); computing one here
 * too would apply the same pause twice.
 *
 * `shortfall = max(0, idleTarget − replayIdle)`. Replay ran the take back at
 * whatever speed the automation could manage, never at the author's own
 * pace, so `replayIdle` (the dead air between the two markers) is rarely
 * what the author actually left. Never negative: compression here would be a
 * speed-up through in-app motion, which the standing rule (v8 §4) forbids —
 * compression is a cut on dead air, never a speed-up through motion. If
 * replay ran slower than the author, nothing is inserted and nothing is
 * trimmed either.
 *
 * Both sides of that subtraction are IDLE, and both had to move to make them
 * so. It read `max(0, targetMs − (to − from))` — the whole marker span —
 * until 2026-09-08, which is the mirror image of what `idleOutputFor`
 * apportions on a capture bundle, and the two modes therefore rendered
 * different lengths for every authored gap: recording played
 * `motion + gap`, rebuild played `max(gap, span)`, a difference of exactly
 * the motion duration. Spec §1's whole reason for one gap concept rather
 * than two is that "the toggle changes provenance and nothing else"; a
 * shortfall measured against a span that includes motion is that promise
 * broken. `pace/idle` in, `pace/idle` out.
 *
 * The instant lands at `to`, the END of the stretch: whatever the page did
 * in response to `afterActionId` has already played through at rate 1.0
 * before the freeze begins, so the freeze lands on the settled frame rather
 * than holding the pre-response frame across the very motion the take was
 * recording.
 *
 * A pace whose action pair the bundle has no marker for is counted in
 * `unplacedPaces` rather than dropped the way `holdInstants` drops a
 * markerless hold. A hold is authored and rare; an unplaced pace here would
 * silently shorten the render wherever a marker is missing, with no signal
 * the caller could tell apart from a take that was simply short — the exact
 * defect this feature exists to remove. Replay stopping early is the usual
 * way a marker goes missing, but not the only one, so nothing here claims a
 * cause. See `Timeline.unplacedPaces`.
 */
function paceInstants(
  plan: RenderPlan,
  bundle: FrameBundle,
  motion: TimeSpan[],
  cuts: ResolvedCut[],
): { instants: PaceInstant[]; unplacedPaces: number } {
  // Only a SAMPLED replay reconstructs pacing. A capture already holds it as
  // elapsed source time, and so does a real-time replay (the engine waited
  // it out live, spec 2026-10-03 §5); a freeze there would play it twice.
  if (plan.paces === null || isRealTime(bundle)) {
    return { instants: [], unplacedPaces: 0 };
  }
  const markerAt = new Map(
    bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]),
  );
  const instants: PaceInstant[] = [];
  let unplacedPaces = 0;
  for (const pace of plan.paces) {
    // A beat plan is a real-time rule (`plannedIdleOf`): on a sampled replay
    // the pair renders as recorded, and is not a pace this one failed to
    // place.
    if (pace.origin === "planned") continue;
    const from = markerAt.get(pace.afterActionId);
    const to = markerAt.get(pace.beforeActionId);
    if (from === undefined || to === undefined) {
      unplacedPaces++;
      continue;
    }
    // Dropped with the stretch, and NOT counted unplaced. `unplacedPaces`
    // means "the frames carry no marker for this pair" — a fault the editor
    // draws as a `pacingUnplaced` degradation on the lane. A pause the
    // author themselves cut away is neither a fault nor a surprise, and
    // folding the two together would hang a warning on every cut.
    //
    // The CLOSED form, not the open one `holdInstants` wants: `to` is the
    // pace's own instant, and `to === srcEndMs` is a wait for the action the
    // cut runs up to — already removed with the stretch, not something to
    // reconstruct on its far side. See `insideCutClosed`'s own docblock.
    if (insideCutClosed(cuts, to)) continue;
    const motionMs = motionMsBetween(motion, from, to);
    const idleMs = Math.max(0, to - from - motionMs);
    const shortfall = Math.max(0, idleTargetMsFor(pace, motionMs) - idleMs);
    if (shortfall > 0) {
      instants.push({ sourceTimeMs: to, durationMs: shortfall });
    }
  }
  return {
    instants: instants.sort((a, b) => a.sourceTimeMs - b.sourceTimeMs),
    unplacedPaces,
  };
}

interface RawSegment {
  srcStartMs: number;
  srcEndMs: number;
  kind: "motion" | "idle";
  outDurationMs: number;
}

/**
 * The pre-hold segmentation: cut only at markers, motion-span boundaries and
 * paced regions' edges. Motion always passes through at rate 1.0
 * (`outDurationMs === srcDuration`) — that never changes here, on either
 * bundle mode. Idle passes through unchanged too, UNLESS an authored gap or a
 * planned beat covers it on a real-time bundle; see `idleOutputFor`. Either
 * way a cut here no longer risks re-timing dead air twice the way the
 * deleted min/max clamp did.
 *
 * Holds must never contribute a cut here regardless: a cut here splits
 * whatever span contains it into two proportionally-apportioned halves (see
 * `splitAtHold`), and that split belongs to the hold, not to this pass.
 */
function rawSegmentsOf(
  bundle: FrameBundle,
  motion: TimeSpan[],
  sourceDurationMs: number,
  cuts: ResolvedCut[],
  regions: readonly IdleRegion[],
): RawSegment[] {
  // `cutSet` is a set of CUT POINTS on the source axis — boundaries where
  // the segmentation splits. `cuts` is the author's removed stretches. Two
  // meanings for one word in one function is the seam `PlannedPace`'s
  // docblock is about, so this one was renamed when the second arrived.
  const cutSet = new Set<number>([0, sourceDurationMs]);
  for (const marker of bundle.markers) cutSet.add(marker.sourceTimeMs);
  for (const span of motion) {
    cutSet.add(span.startMs);
    cutSet.add(span.endMs);
  }
  // Every removed stretch's edges, so no raw segment straddles one.
  for (const cut of cuts) {
    cutSet.add(cut.srcStartMs);
    cutSet.add(cut.srcEndMs);
  }
  // Every paced region's edges, so no idle segment straddles two targets. A
  // planned beat's rest and arrive meet at the approach, which is no marker;
  // every other edge is already here.
  for (const region of regions) {
    cutSet.add(region.srcStartMs);
    cutSet.add(region.srcEndMs);
  }
  const ordered = [...cutSet]
    .filter((t) => t >= 0 && t <= sourceDurationMs)
    .sort((a, b) => a - b);

  const isMotion = (start: number, end: number): boolean =>
    motion.some((s) => s.startMs <= start && s.endMs >= end && end > start);

  const raw: RawSegment[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const srcStartMs = ordered[i - 1];
    const srcEndMs = ordered[i];
    if (srcStartMs === undefined || srcEndMs === undefined) continue;
    const srcDuration = srcEndMs - srcStartMs;
    if (srcDuration <= 0) continue;

    // A segment wholly inside a removed stretch is not emitted at all. It
    // cannot be PARTLY inside: every cut edge is in `cutSet` above, so the
    // segmentation already split there. Tested at the midpoint for exactly
    // that reason — an edge is shared with the segment on the other side of
    // it, and either predicate's half-open start would answer for the wrong
    // one there. The CLOSED/OPEN split below only matters exactly ON a
    // boundary, which a midpoint of a positive-length segment never is —
    // either form agrees here, and `insideCutClosed` is used for no reason
    // beyond it being the pre-split name.
    if (insideCutClosed(cuts, (srcStartMs + srcEndMs) / 2)) continue;

    const kind = isMotion(srcStartMs, srcEndMs) ? "motion" : "idle";
    const outDurationMs =
      kind === "motion"
        ? srcDuration
        : idleOutputFor(regions, srcStartMs, srcEndMs, srcDuration);

    raw.push({ srcStartMs, srcEndMs, kind, outDurationMs });
  }
  return raw;
}

/**
 * A stretch of source time whose idle plays for `targetMs` in all: an
 * authored gap's pair, or one of a planned beat's rest, arrive or tail.
 * `idleMs` is the idle in it that plays (`idleMsIn`), the denominator
 * `idleOutputFor` shares `targetMs` against.
 */
interface IdleRegion {
  srcStartMs: number;
  srcEndMs: number;
  targetMs: number;
  idleMs: number;
}

/**
 * The authored paces, as the stretches their idle is set on.
 *
 * Gated to capture bundles (Ruling P1, 2026-09-08): a capture bundle's
 * source time IS real time, so an authored gap can set the segment's OUTPUT
 * duration directly here. A replay bundle's source time is synthetic
 * re-render time instead — Task 4 covers rebuild mode there with a dedicated
 * `"pace"` segment carrying `max(0, targetMs − replayElapsed)`. Applying an
 * authored gap here too, on a replay bundle, would double-count it: once by
 * scaling idle to `targetMs`, once again as that shortfall segment.
 *
 * `origin === "recorded"` paces are never matched: on a capture bundle the
 * recorded target already IS what the bundle holds (the source time itself),
 * so re-applying it would double it the same way.
 */
function authoredRegions(
  plan: RenderPlan,
  bundle: FrameBundle,
  idleIn: (fromMs: number, toMs: number) => number,
): IdleRegion[] {
  if (!isRealTime(bundle)) return [];
  const markerAt = new Map(
    bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]),
  );
  return (plan.paces ?? []).flatMap((pace) => {
    if (pace.origin !== "authored") return [];
    // Already in source time: the engine waited this exact gap out live.
    if (gapPacedLive(bundle, pace.afterActionId, pace.idleTargetMs)) {
      return [];
    }
    const after = markerAt.get(pace.afterActionId);
    const before = markerAt.get(pace.beforeActionId);
    if (after === undefined || before === undefined) return [];
    return [
      {
        srcStartMs: after,
        srcEndMs: before,
        targetMs: pace.idleTargetMs,
        idleMs: idleIn(after, before),
      },
    ];
  });
}

/**
 * The beat plan, as the stretches its idle is set on (spec 2026-11-13,
 * Part 3). Real-time bundles only: a sampled replay renders a planned pair as
 * recorded (`paceInstants` skips it), and a scripted take, the only kind
 * that writes a plan, is never sampled.
 *
 * Each beat is two stretches, split where the cursor set off for its step
 * (`approachSourceTimeMs`): from the step before's act end (its marker when it
 * has none, source 0 for the opening) to there plays `restMs`, from there to
 * the step `arriveMs`, counted from where the cursor's travel began: idle
 * between the approach and that is the machine's latency, and plays for 0. A
 * step whose approach scrolled (`scrollEndSourceTimeMs` with the beat's
 * `afterScrollMs`) has a third: the rest ends where the scroll did, and from
 * there to the approach plays `afterScrollMs`, the camera's room after the page
 * moved. The idle after the plan's last act plays `tailMs`. Idle inside a
 * step's own act (from its marker to its act end) plays for 0: an act's length
 * is the machine's (measured 94 against 416 ms for one click, fast against
 * slowed, on 2026-11-13), so playing its idle would put the machine back into
 * the video. Motion plays at rate 1.0 as everywhere, so a pair lasts its
 * planned idle and its motion.
 *
 * A stretch with no idle that plays (all motion, or all removed) has nothing
 * to stretch, so it becomes a freeze of its planned length at its end — at
 * the approach, the cursor sets off when the rest is over; at the step, the
 * step acts when the arrive is over (`toOutputMs` answers a pace's last
 * instant). Inside an author's cut it is dropped with the cut, as
 * `paceInstants` drops a pace.
 *
 * Inside an interruption a freeze has no frame to stand on: the instant is
 * removed, and nothing after the interruption is in this stretch (the
 * stretch ends inside it). It moves back to where the interruption began,
 * the stretch's last frame that plays, which `buildTimeline` emits the way
 * it does a cut's seam. When the interruption began at or before the
 * stretch's start, the stretch has no frame that plays, and the beat is
 * counted.
 *
 * A beat that cannot be placed — a marker missing, the step's marker without
 * an approach, an approach outside its pair, a scroll's end without its
 * `afterScrollMs` (or the reverse), or a freeze with no frame — is
 * counted, never guessed: the pair then plays as recorded, and
 * `unplacedPaces` says so.
 */
function plannedIdleOf(
  plan: RenderPlan,
  bundle: FrameBundle,
  idleIn: (fromMs: number, toMs: number) => number,
  cuts: readonly ResolvedCut[],
  interruptions: readonly TimeSpan[],
  sourceDurationMs: number,
): {
  regions: IdleRegion[];
  freezes: PaceInstant[];
  unplacedPaces: number;
  unplacedBeatSteps: (string | null)[];
} {
  const regions: IdleRegion[] = [];
  const freezes: PaceInstant[] = [];
  const unplacedBeatSteps: (string | null)[] = [];
  if (!isRealTime(bundle)) {
    return { regions, freezes, unplacedPaces: 0, unplacedBeatSteps };
  }
  const markerOf = new Map(bundle.markers.map((m) => [m.actionId, m]));
  /** The cursor's travel, as the render reads it (screen px). */
  const travel = cursorMotionSpans(
    inScreenSpace(bundle, undefined).bundle.cursorSamples,
  );
  /** Where the cursor set off inside [fromMs, toMs]: the first travel that
   *  starts there. Null with none, or with travel already under way at
   *  `fromMs` (the set-off is not this stretch's). */
  const setOffIn = (fromMs: number, toMs: number): number | null => {
    const first = travel.find((t) => t.endMs > fromMs && t.startMs < toMs);
    return first === undefined || first.startMs < fromMs ? null : first.startMs;
  };
  const removedAt = (t: number): boolean =>
    insideCutClosed(cuts, t) ||
    interruptions.some((s) => s.startMs <= t && t < s.endMs);
  /** False when the stretch's planned idle has nowhere to play. */
  const share = (
    srcStartMs: number,
    srcEndMs: number,
    targetMs: number,
  ): boolean => {
    const idleMs = idleIn(srcStartMs, srcEndMs);
    if (idleMs > 0) {
      regions.push({ srcStartMs, srcEndMs, targetMs, idleMs });
      return true;
    }
    if (targetMs <= 0 || insideCutClosed(cuts, srcEndMs)) return true;
    const gone = interruptions.find(
      (s) => s.startMs <= srcEndMs && srcEndMs < s.endMs,
    );
    const at = gone ? gone.startMs : srcEndMs;
    // No frame: the interruption opens at or before the stretch, or where an
    // author's cut closes (its seam frame is removed too).
    if (gone && (at <= srcStartMs || insideCutClosed(cuts, at))) return false;
    freezes.push({ sourceTimeMs: at, durationMs: targetMs });
    return true;
  };
  /**
   * Where a stretch after `prev` starts: its act end, so the act's own idle
   * takes no share of the rest meant to follow it, and plays for 0 itself
   * (its region's target). An act end before the marker (the schema refuses
   * one) or past `endMs` is treated as absent: the stretch then starts at
   * the marker, as before act ends were read here.
   *
   * shortcut: typing's lead-in (`TYPE_LEAD_MS` of idle before the first
   * key) is in its act and is dropped with it, and the designed clock does
   * not count it either (run-core's `actMs`); if it is missed, the walk can
   * plan it into that step's `arriveMs`.
   */
  const afterAct = (
    prev: { sourceTimeMs: number; actEndSourceTimeMs?: number },
    endMs: number,
  ): number => {
    const end = prev.actEndSourceTimeMs;
    if (end === undefined || end < prev.sourceTimeMs || end > endMs) {
      return prev.sourceTimeMs;
    }
    // A target of 0 never freezes, so this cannot fail.
    share(prev.sourceTimeMs, end, 0);
    return end;
  };
  for (const pace of plan.paces ?? []) {
    if (pace.origin !== "planned") continue;
    const prev =
      pace.afterActionId === null
        ? { sourceTimeMs: 0 }
        : markerOf.get(pace.afterActionId);
    const step = markerOf.get(pace.beforeActionId);
    const approach = step?.approachSourceTimeMs;
    const scrollEnd = step?.scrollEndSourceTimeMs;
    if (
      prev === undefined ||
      step === undefined ||
      approach === undefined ||
      approach < prev.sourceTimeMs ||
      approach > step.sourceTimeMs ||
      // The scroll's stretch needs both halves: where the scroll ended and
      // what to play after it. One without the other is not guessed at.
      (scrollEnd === undefined) !== (pace.afterScrollMs === undefined) ||
      (scrollEnd !== undefined &&
        (scrollEnd < prev.sourceTimeMs || scrollEnd > approach))
    ) {
      unplacedBeatSteps.push(pace.beforeActionId);
      continue;
    }
    // The rest runs to the scroll's end when the step scrolled: the camera
    // needs its room after the scroll, which `afterScrollMs` carries.
    const restEnd = scrollEnd ?? approach;
    const rest = share(afterAct(prev, restEnd), restEnd, pace.restMs);
    const scroll =
      scrollEnd === undefined || pace.afterScrollMs === undefined
        ? true
        : share(scrollEnd, approach, pace.afterScrollMs);
    // The arrive counts from where the cursor set off: idle before that is
    // the machine's latency in starting the journey, which the plan does
    // not have, and plays for 0 (186 ms of it took 186 of a
    // planned 300 on CI's macOS). With no travel there, travel already
    // under way at the approach, or a set-off inside a removed stretch, or
    // an arrive that cannot be placed from it, it counts from the approach
    // as before.
    const setOff = setOffIn(approach, step.sourceTimeMs);
    const from =
      setOff !== null && setOff > approach && !removedAt(setOff)
        ? setOff
        : approach;
    let arrive = share(from, step.sourceTimeMs, pace.arriveMs);
    if (from > approach) {
      if (arrive) share(approach, from, 0);
      else arrive = share(approach, step.sourceTimeMs, pace.arriveMs);
    }
    if (!rest || !scroll || !arrive)
      unplacedBeatSteps.push(pace.beforeActionId);
  }
  if (plan.tailMs != null) {
    // The plan's last step is the last pair's second one: a plan writes a
    // beat for every step, the opening included.
    const lastStep = plan.paces?.at(-1)?.beforeActionId;
    const last = lastStep === undefined ? undefined : markerOf.get(lastStep);
    if (
      last === undefined ||
      !share(afterAct(last, sourceDurationMs), sourceDurationMs, plan.tailMs)
    ) {
      unplacedBeatSteps.push(null);
    }
  }
  return {
    regions,
    freezes,
    unplacedPaces: unplacedBeatSteps.length,
    unplacedBeatSteps,
  };
}

/**
 * Idle source-ms in `[fromMs, toMs]` that plays: the span minus whatever
 * motion falls inside it. This is the denominator `idleOutputFor` apportions
 * a region's `targetMs` against when several idle segments (with motion
 * between them) fall inside it — the same reasoning as `splitAtHold`'s
 * apportion-rather-than-re-derive: independent per-segment targets would not
 * sum back to what the author (or the plan) asked for.
 *
 * `motion` carries the same constraint `motionMsBetween` states: it must be
 * the merged set `rawSegmentsOf` classified this segment with, hints
 * included.
 *
 * `removed` is every stretch segmentation drops — the author's cuts and a
 * real-time replay's interruptions. None of it plays, so none of it is idle
 * that can take a share of the target: a 4 s occlusion pause inside a pair
 * with 0.5 s of real idle gave that 0.5 s a ninth of the author's gap
 * (review of 2026-10-03). Merged with motion first, so a stretch that is
 * both is subtracted once.
 */
function idleMsIn(
  motion: TimeSpan[],
  removed: readonly ResolvedCut[],
  fromMs: number,
  toMs: number,
): number {
  const notIdle = merge([
    ...motion,
    ...removed.map((cut) => ({ startMs: cut.srcStartMs, endMs: cut.srcEndMs })),
  ]);
  return Math.max(0, toMs - fromMs - motionMsBetween(notIdle, fromMs, toMs));
}

/**
 * How long an idle stretch plays for.
 *
 * Recorded pacing needs no work here: a capture bundle's source time IS real
 * time, so passing the span through at rate 1.0 already reproduces what the
 * author left. Only an authored gap or a planned beat changes anything, and
 * it changes the idle portion alone — the motion segments on either side
 * keep rate 1.0, which is why this is asked per-segment rather than
 * per-action-pair.
 *
 * A region with several idle segments in it (motion in the middle) shares
 * its target proportionally, for the same reason `splitAtHold` apportions
 * rather than re-derives: two independently-set halves would not sum to the
 * duration asked for.
 */
function idleOutputFor(
  regions: readonly IdleRegion[],
  srcStartMs: number,
  srcEndMs: number,
  srcDuration: number,
): number {
  const region = regions.find(
    (r) => r.srcStartMs <= srcStartMs && srcEndMs <= r.srcEndMs,
  );
  // `idleMs` is not 0 for any region holding an idle segment: that segment
  // is idle by the same `motion` and `removed`, and inside the region. The
  // guard is the "answer with what we have, not a division by (near) zero"
  // choice `holdInstants` makes for a hold with no marker.
  if (!region || region.idleMs <= 0) return srcDuration;
  return region.targetMs * (srcDuration / region.idleMs);
}

/**
 * Split the raw segment straddling `sourceTimeMs`, apportioning its
 * *output* duration by source fraction rather than re-deriving it.
 *
 * Both kinds are rate-1.0 by construction now (`outDurationMs === srcSpan`),
 * so a fraction-proportional split keeps both halves at rate-1.0 too —
 * trivially so, since splitting an already-exact total by source fraction
 * just hands each half its own exact source span back. (Before 2026-09-08 an
 * idle span's `outDurationMs` was clamped once over the whole span in
 * `rawSegmentsOf`, and this proportional split was what kept that clamp
 * answering to the span the author actually authored the hold on, instead of
 * two shorter halves each independently re-clamped. The clamp is gone; the
 * split stays, because a hold still needs to land mid-span correctly.)
 *
 * A hold that lands on an existing boundary (within `HOLD_EPSILON_MS`)
 * finds no straddling segment and passes through unchanged — it is handled
 * by the cut-boundary insertion in `buildTimeline` instead.
 */
function splitAtHold(raw: RawSegment[], sourceTimeMs: number): RawSegment[] {
  const idx = raw.findIndex(
    (s) =>
      s.srcStartMs + HOLD_EPSILON_MS < sourceTimeMs &&
      sourceTimeMs < s.srcEndMs - HOLD_EPSILON_MS,
  );
  if (idx === -1) return raw;
  const seg = raw[idx];
  if (!seg) return raw;

  const srcSpan = seg.srcEndMs - seg.srcStartMs;
  const t = (sourceTimeMs - seg.srcStartMs) / srcSpan;
  const leftOutDurationMs = seg.outDurationMs * t;
  const left: RawSegment = {
    srcStartMs: seg.srcStartMs,
    srcEndMs: sourceTimeMs,
    kind: seg.kind,
    outDurationMs: leftOutDurationMs,
  };
  const right: RawSegment = {
    srcStartMs: sourceTimeMs,
    srcEndMs: seg.srcEndMs,
    kind: seg.kind,
    outDurationMs: seg.outDurationMs - leftOutDurationMs,
  };
  return [...raw.slice(0, idx), left, right, ...raw.slice(idx + 1)];
}

/** The recovered occlusion pauses of a real-time replay, minus whatever an
 *  authored cut already removes, merged. Empty for every other bundle: a
 *  sampled replay's frames held still across the pause, and capture has no
 *  occlusion guard. */
function interruptionsOf(
  bundle: FrameBundle,
  cuts: readonly ResolvedCut[],
): TimeSpan[] {
  if (bundle.timing !== "real") return [];
  const out: TimeSpan[] = [];
  for (const d of bundle.degradations) {
    if (d.kind !== "occlusionPause" || d.endMs <= d.startMs) continue;
    let pieces: TimeSpan[] = [{ startMs: d.startMs, endMs: d.endMs }];
    for (const cut of cuts) {
      pieces = pieces.flatMap((p) => {
        if (p.endMs <= cut.srcStartMs || p.startMs >= cut.srcEndMs) return [p];
        return [
          ...(p.startMs < cut.srcStartMs
            ? [{ startMs: p.startMs, endMs: cut.srcStartMs }]
            : []),
          ...(p.endMs > cut.srcEndMs
            ? [{ startMs: cut.srcEndMs, endMs: p.endMs }]
            : []),
        ];
      });
    }
    out.push(...pieces);
  }
  return merge(out);
}

/** Below this, sample-to-sample movement is jitter or a hold, not travel. */
export const CURSOR_MOTION_EPSILON_PX = 0.5;

/**
 * Spans in which the cursor is actually travelling.
 *
 * The design doc claimed dead air contains no cursor motion "by
 * construction". It plainly does: the pointer crosses the screen between one
 * action and the next while the page underneath it sits perfectly still, so
 * the retimer saw a static page, called it dead air and compressed it. On the
 * harvested fixture two ~1270ms travels were squeezed into 400ms each and the
 * pointer whipped across at 3.2x. A polished recording never speeds up a
 * cursor move, and the reason it looks wrong is that a sped-up pointer is the one
 * thing in the frame a viewer knows the real speed of.
 *
 * These come back as `buildTimeline` hints, so they merge with the harvested
 * motion spans and get the same treatment: passed through at rate 1.0. Holds
 * and dwells produce no span, so genuine dead air still compresses.
 */
export function cursorMotionSpans(samples: CursorSample[]): TimeSpan[] {
  const spans: TimeSpan[] = [];
  for (let i = 1; i < samples.length; i++) {
    const from = samples[i - 1];
    const to = samples[i];
    if (!from || !to) continue;
    if (to.sourceTimeMs <= from.sourceTimeMs) continue;
    if (Math.hypot(to.x - from.x, to.y - from.y) < CURSOR_MOTION_EPSILON_PX) {
      continue;
    }
    spans.push({ startMs: from.sourceTimeMs, endMs: to.sourceTimeMs });
  }
  return spans;
}

/**
 * How long the bundle filmed, in source ms: its last keyframe, marker,
 * motion, or cursor travel (and, on a capture, the drawn cursor's settle
 * after it). The timeline's `sourceDurationMs`, and what an end past it is
 * clamped to. A question of the bundle alone, so a take asks it before it
 * writes a trim (`@demoman/replay-engine`'s `trimFromScript`) and gets the
 * answer the render will: the render's keyframe-diff hints lie between
 * keyframes, and its cursor hints are this travel.
 */
export function sourceDurationOf(bundle: FrameBundle): number {
  const lastKeyframe = bundle.keyframes[bundle.keyframes.length - 1];
  // In screen space, as the render reads it: the travel threshold is px.
  const travel = cursorMotionSpans(
    inScreenSpace(bundle, undefined).bundle.cursorSamples,
  ).at(-1);
  const settleMs =
    bundle.source === "capture" ? springSettleMs(CURSOR_SPRING_TAU_MS) : 0;
  return Math.max(
    lastKeyframe?.sourceTimeMs ?? 0,
    ...bundle.markers.map((m) => m.sourceTimeMs),
    ...motionSpansOf(bundle).map((m) => m.endMs),
    travel === undefined ? 0 : travel.endMs + settleMs,
  );
}

/**
 * Dead air only, never through in-app motion (v8 §4).
 *
 * On a static idle span the frames are identical, so compressing it is a cut
 * rather than a speed-up and nothing judders. That is precisely why this is
 * safe here and forbidden on motion, where a speed-up would play a dropdown
 * transition at the wrong rate.
 */
export function buildTimeline(
  plan: RenderPlan,
  bundle: FrameBundle,
  hints: TimeSpan[] = [],
  /**
   * Keyframe-diff motion (`detectKeyframeMotion`): two stills that differ
   * with no motion recorded between them. Motion like `hints`, except on a
   * planned take (`scene.pacing`, ruling 2026-11-13) or a held one, where it is idle: no
   * frames lie between the two stills, so nothing is lost, and a planned
   * length must not depend on what only a reader with pixels detects.
   */
  keyframeHints: TimeSpan[] = [],
): Timeline {
  const isPlanned =
    plan.tailMs !== null ||
    (plan.paces ?? []).some((pace) => pace.origin === "planned");
  const motion = motionSpansOf(
    bundle,
    isPlanned || isHeld(bundle) ? hints : [...hints, ...keyframeHints],
  );
  const sourceDurationMs = sourceDurationOf(bundle);

  const { cuts, unplacedCuts } = cutRanges(plan, bundle, sourceDurationMs);
  const interruptions = interruptionsOf(bundle, cuts);
  // What segmentation removes: the author's cuts and the interruptions. Only
  // the author's go back out as `cuts`.
  const removed: ResolvedCut[] = [
    ...cuts,
    ...interruptions.map((span) => ({
      ids: [],
      srcStartMs: span.startMs,
      srcEndMs: span.endMs,
      trailing: false,
    })),
  ].sort((a, b) => a.srcStartMs - b.srcStartMs);
  const holds = holdInstants(plan, bundle, sourceDurationMs, cuts);
  const recorded = paceInstants(plan, bundle, motion, cuts);
  const idleIn = (fromMs: number, toMs: number) =>
    idleMsIn(motion, removed, fromMs, toMs);
  const planned = plannedIdleOf(
    plan,
    bundle,
    idleIn,
    cuts,
    interruptions,
    sourceDurationMs,
  );
  const regions = [
    ...authoredRegions(plan, bundle, idleIn),
    ...planned.regions,
  ];
  // A sampled replay places recorded paces and a real-time one planned
  // beats; one of these is always empty.
  const paces = [...recorded.instants, ...planned.freezes].sort(
    (a, b) => a.sourceTimeMs - b.sourceTimeMs,
  );
  const unplacedPaces = recorded.unplacedPaces + planned.unplacedPaces;
  // Counted off the plan rather than inside `paceInstants`, which returns
  // early for a capture bundle: the log's order is a property of the take,
  // not of the frames being rendered, and reporting it only in rebuild mode
  // would hide it exactly where the author cannot yet see its effect.
  const nonMonotonicPaces = (plan.paces ?? []).filter(
    (pace) => pace.origin === "recorded" && pace.recordedSpanMs < 0,
  ).length;

  // Segment the source the way the pre-hold code always did — neither holds
  // nor paces touch the cut set — then, per instant, split whichever raw
  // segment straddles it. See splitAtHold for why that split (not a shared
  // cut) is what keeps both kinds' rate-1.0 pass-through untouched. Paces
  // reuse the same splitter: it is generic over "some source instant",
  // agnostic to what produced it.
  let raw = rawSegmentsOf(bundle, motion, sourceDurationMs, removed, regions);
  for (const hold of holds) raw = splitAtHold(raw, hold.sourceTimeMs);
  for (const pace of paces) raw = splitAtHold(raw, pace.sourceTimeMs);

  const segments: TimelineSegment[] = [];
  let outCursor = 0;

  // A hold sits at a cut, before the span that leaves it. Emitting it here
  // rather than dilating the neighbouring span keeps every other segment's
  // rate exactly what it was — in particular a motion span stays 1.0.
  //
  // The match is epsilon-based rather than exact equality: a hold that
  // landed strictly inside a span reaches this loop as a boundary that
  // `splitAtHold` created from this same `sourceTimeMs` value, but a hold
  // that landed on a pre-existing cut (a marker, a motion-span edge) never
  // passes through the splitter at all, so nothing guarantees bit-identical
  // floats between the two paths.
  const emitHoldsAt = (sourceTimeMs: number): void => {
    for (const hold of holds) {
      if (Math.abs(hold.sourceTimeMs - sourceTimeMs) > HOLD_EPSILON_MS)
        continue;
      segments.push({
        outStartMs: outCursor,
        outEndMs: outCursor + hold.durationMs,
        srcStartMs: sourceTimeMs,
        srcEndMs: sourceTimeMs,
        kind: "hold",
      });
      outCursor += hold.durationMs;
    }
  };

  // Mirrors emitHoldsAt exactly, including the post-loop terminal call below:
  // a pace lands at the END of its stretch (`to`, not `from`), so a pace on
  // the LAST marker resolves to sourceDurationMs — the terminal instant,
  // which (like a hold there) is never any raw segment's srcStartMs.
  const emitPacesAt = (sourceTimeMs: number): void => {
    for (const pace of paces) {
      if (Math.abs(pace.sourceTimeMs - sourceTimeMs) > HOLD_EPSILON_MS)
        continue;
      segments.push({
        outStartMs: outCursor,
        outEndMs: outCursor + pace.durationMs,
        srcStartMs: sourceTimeMs,
        srcEndMs: sourceTimeMs,
        kind: "pace",
      });
      outCursor += pace.durationMs;
    }
  };

  /** Whether this instant is the last kept frame before a removed stretch. */
  const isSeam = (sourceTimeMs: number): boolean =>
    cuts.some(
      (cut) => Math.abs(cut.srcStartMs - sourceTimeMs) <= HOLD_EPSILON_MS,
    );
  const opensInterruption = (sourceTimeMs: number): boolean =>
    interruptions.some(
      (span) => Math.abs(span.startMs - sourceTimeMs) <= HOLD_EPSILON_MS,
    );

  for (const seg of raw) {
    emitHoldsAt(seg.srcStartMs);
    emitPacesAt(seg.srcStartMs);
    segments.push({
      outStartMs: outCursor,
      outEndMs: outCursor + seg.outDurationMs,
      srcStartMs: seg.srcStartMs,
      srcEndMs: seg.srcEndMs,
      kind: seg.kind,
    });
    outCursor += seg.outDurationMs;
    // A hold or pace standing ON a seam, emitted AFTER the segment that
    // ends there. A cut's opening instant is the last frame still in the
    // video, and it is only ever some segment's `srcEndMs` — never any
    // segment's `srcStartMs`, because the segments that would have started
    // there were removed. So the loop head above can never reach it, in
    // exactly the way the terminal call below exists to cover for the
    // take's own end. Without this a pause the author set on the frame
    // their cut opens at simply stopped playing, with nothing said.
    //
    // It cannot double-emit: this fires only on a cut's opening instant,
    // and what follows a cut is removed segments, so the next emitted
    // segment starts at the cut's CLOSING instant, not at this one.
    //
    // An interruption's opening instant is the same kind of seam for a
    // pace: `plannedIdleOf` moves a planned freeze there when its own
    // instant was removed. (Holds keep the cut-only rule; nothing moves one.)
    if (isSeam(seg.srcEndMs)) emitHoldsAt(seg.srcEndMs);
    if (isSeam(seg.srcEndMs) || opensInterruption(seg.srcEndMs)) {
      emitPacesAt(seg.srcEndMs);
    }
  }
  // The terminal instant (sourceDurationMs) is never a raw segment's
  // srcStartMs — it is only ever the last segment's srcEndMs, or the whole
  // timeline when there are no segments at all — so a hold or pace that
  // resolves there needs one more check after the loop.
  emitHoldsAt(sourceDurationMs);
  emitPacesAt(sourceDurationMs);

  // The idle `plannedIdleOf` retimed (an idle segment inside one of its
  // regions) or froze (a pace segment at one of its freezes), in output time.
  const placedIdle: TimeSpan[] = [];
  for (const seg of segments) {
    const isPlaced =
      seg.kind === "idle"
        ? planned.regions.some(
            (r) => seg.srcStartMs >= r.srcStartMs && seg.srcEndMs <= r.srcEndMs,
          )
        : seg.kind === "pace" &&
          planned.freezes.some(
            (f) => Math.abs(f.sourceTimeMs - seg.srcStartMs) <= HOLD_EPSILON_MS,
          );
    if (!isPlaced || seg.outEndMs <= seg.outStartMs) continue;
    const last = placedIdle.at(-1);
    if (last && seg.outStartMs - last.endMs <= HOLD_EPSILON_MS) {
      last.endMs = seg.outEndMs;
    } else {
      placedIdle.push({ startMs: seg.outStartMs, endMs: seg.outEndMs });
    }
  }

  return {
    segments,
    outputDurationMs: outCursor,
    sourceDurationMs,
    cuts,
    unplacedCuts,
    interruptions,
    unplacedPaces,
    // Present only when a beat was unplaced, so a take with no plan builds
    // the timeline it always did.
    ...(planned.unplacedBeatSteps.length > 0
      ? { unplacedBeatSteps: planned.unplacedBeatSteps }
      : {}),
    ...(placedIdle.length > 0 ? { placedIdle } : {}),
    nonMonotonicPaces,
  };
}

/** Maps output time to source time. Monotone non-decreasing, clamped at both ends. */
export function toSourceMs(timeline: Timeline, outputMs: number): number {
  if (timeline.segments.length === 0) return 0;
  // NOT `0` and NOT `sourceDurationMs`. A LEADING cut means the video's
  // first frame is the cut's end, and a TRAILING cut means its last frame
  // is the cut's start — the take runs on past both, and answering with the
  // take's own ends would show a frame the author removed. Both lines are
  // no-ops on an uncut timeline, where the first segment opens at 0 and the
  // last closes at `sourceDurationMs`, which is why nothing before cuts
  // noticed the difference. Asserted as such in `timeline-cuts.test.ts`'s
  // "leaves a take with no cuts byte-identical".
  const first = timeline.segments[0];
  const last = timeline.segments[timeline.segments.length - 1];
  if (outputMs <= 0) return first?.srcStartMs ?? 0;
  if (outputMs >= timeline.outputDurationMs) {
    return last?.srcEndMs ?? timeline.sourceDurationMs;
  }

  for (const segment of timeline.segments) {
    if (outputMs <= segment.outEndMs) {
      const outSpan = segment.outEndMs - segment.outStartMs;
      const t = outSpan === 0 ? 0 : (outputMs - segment.outStartMs) / outSpan;
      return segment.srcStartMs + (segment.srcEndMs - segment.srcStartMs) * t;
    }
  }
  return timeline.sourceDurationMs;
}

/**
 * Inverse of toSourceMs. Monotone non-decreasing, clamped at both ends.
 *
 * A source instant under a freeze is on screen for the freeze's whole
 * length, so which output instant it answers is a choice. It answers the
 * FIRST — the freeze's start — except under a recorded `pace`, where it
 * answers the LAST. A pace is the wait before the action at its instant
 * (`paceInstants`), so that action happens when the wait ends: its click,
 * the camera aimed at it and any range anchored on it all belong after the
 * freeze. Answered with the start, a click pulsed, the picture held for the
 * whole pace, and the page's response played after it — measured on the
 * runner's fixture as 4.1s between the checkout click and the panel it
 * opened, with the camera already zoomed back out.
 *
 * An authored `hold` keeps the first instant: the marker maps to where the
 * hold begins (`timeline-holds.test.ts`), which the camera solver and the
 * click pulse were built against.
 */
export function toOutputMs(timeline: Timeline, sourceMs: number): number {
  if (timeline.segments.length === 0) return 0;
  if (sourceMs <= 0) return 0;
  if (sourceMs >= timeline.sourceDurationMs) return timeline.outputDurationMs;

  const { segments } = timeline;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as TimelineSegment;
    if (sourceMs <= segment.srcEndMs) {
      // Step over any paces standing at exactly this instant.
      let after = i + 1;
      while (
        segments[after]?.kind === "pace" &&
        segments[after]?.srcStartMs === sourceMs
      ) {
        after++;
      }
      if (after > i + 1) {
        return (segments[after - 1] as TimelineSegment).outEndMs;
      }
      const srcSpan = segment.srcEndMs - segment.srcStartMs;
      // Clamped, for cuts. A source instant inside a removed stretch reaches
      // this line against the segment AFTER the stretch, whose `srcStartMs`
      // is later than it — an unclamped `t` is negative there and walks the
      // answer backwards off that segment's own start, breaking the monotone
      // non-decreasing guarantee this function's name promises. Clamped, it
      // answers the seam, which is where that instant actually plays.
      //
      // A no-op without cuts: the segments are contiguous in source time, so
      // the first one with `srcEndMs >= sourceMs` always contains it.
      const t =
        srcSpan === 0
          ? 0
          : clamp((sourceMs - segment.srcStartMs) / srcSpan, 0, 1);
      return segment.outStartMs + (segment.outEndMs - segment.outStartMs) * t;
    }
  }
  return timeline.outputDurationMs;
}
