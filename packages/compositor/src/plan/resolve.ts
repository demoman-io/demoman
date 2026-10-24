import type {
  SceneCursor,
  SceneDocument,
  SceneMotion,
} from "@demoman/scene-schema";
import { CURSOR_DEFAULTS, MOTION_DEFAULTS } from "@demoman/scene-schema";
import type { CursorGap, CursorSample, FrameBundle } from "../bundle.js";
import { easings } from "../easing.js";
import { lerpVec, type Rect, type Vec } from "../geometry.js";
import {
  type CameraKey,
  type CameraSegment,
  motionTimings,
  sampleCamera,
  solveCamera,
} from "./camera.js";
import { type FollowStretch, solveFollow } from "./camera-follow.js";
import { sampleSegment } from "./cursor.js";
import {
  CURSOR_SPRING_TAU_MS,
  followWithSpring,
  springLeadMs,
  springSettleMs,
} from "./cursor-spring.js";
import { retimeAlongRoute } from "./cursor-timing.js";
import { leaveThroughEdges } from "./off-page.js";
import { planScene } from "./plan.js";
import {
  type ClampedRange,
  type OutputRange,
  resolveMaskRange,
  resolveRange,
} from "./ranges.js";
import { inScreenSpace, segmentsInScreenSpace } from "./screen-space.js";
import { CURSOR_REST_MS, CURSOR_SMOOTHING_MS, smoothCursor } from "./smooth.js";
import {
  buildTimeline,
  type Timeline,
  type TimeSpan,
  toOutputMs,
  toSourceMs,
} from "./timeline.js";
import type { RenderPlan } from "./types.js";

export interface ResolvedCosmetic {
  id: string;
  kind: "mask";
  rect: Rect;
  range: OutputRange | null;
  /**
   * Sides of `range` whose step the bundle carries no marker for. That side
   * fell back to the take's own end, so the mask covers MORE than it was
   * authored to — the caller says so, exactly as it does for the trim's
   * `trimUnplaced` and a zoom segment's `endUnplaced`. Empty for a mask
   * with no range: a whole-take mask has no side that could go missing.
   */
  unplaced: ("start" | "end")[];
}

export interface ResolvedPlan {
  plan: RenderPlan;
  timeline: Timeline;
  /** `solveCamera`'s keys: the scale, the push-ins and the pull-outs. */
  cameraKeys: CameraKey[];
  /**
   * While zoomed, the spring the camera's centre trails the pointer by
   * (`solveFollow`, spec 2026-10-22). Read the camera through `sampleTrack`,
   * never `sampleCamera(cameraKeys, …)` alone, or it draws the keys' parked
   * centres instead of the camera the video shows.
   */
  cameraFollow: FollowStretch[];
  cameraSegments: CameraSegment[];
  /** Source-time cursor samples: replay's own, or synthesized for frozen frames. */
  cursor: CursorSample[];
  /**
   * *Output* times at which a click lands, for the pulse and the press.
   *
   * Output, not source, and the unit is the whole point. `PULSE_DURATION_MS`
   * and `PRESS_DURATION_MS` are viewer-time constants — 400ms and 110ms of
   * screen time — so windowing them against a source clock plays them at the
   * retimer's rate for whatever span they land in. A click that lands in a
   * compressed idle span is the normal case, not an edge one: the pointer
   * dwells on the target, so it emits no cursor-motion span to protect it,
   * and the last click of a demo is always followed by dead air. Measured on
   * the real timeline, a 400ms pulse in a 6x-compressed idle span rendered as
   * four frames — 67ms of screen time, a flicker.
   */
  clickOutputMs: number[];
  /** Each drag's held button, in output time (as `clickOutputMs`): the
   *  cursor is drawn pressed from `startMs` to `endMs`. */
  holdOutputMs: { startMs: number; endMs: number }[];
  /**
   * Whether the take was filmed as a touch device (spec 2026-10-10 §5): it
   * is drawn as taps, not as a pointer — no arrow, no trail, no glide.
   */
  touch: boolean;
  /**
   * Each tap of a touch take: its output time (as `clickOutputMs`) and where
   * the finger was, in source CSS px. Empty for a desktop take. A click with
   * no pointer position at all — a take with no samples, where the arrow is
   * not drawn either — has no tap.
   */
  taps: { outputMs: number; at: Vec }[];
  /**
   * How the pointer is drawn: the scene's own block, or the defaults when
   * the caller passed no scene. No per-field fallback beyond that — the
   * document schema refuses an unknown style at the boundary, so a
   * `?? "light"` here would be a fallback that fires whether or not
   * anything is wrong.
   */
  cursorLook: SceneCursor;
  /**
   * How the camera moves: the scene's own `motion` block, or
   * `MOTION_DEFAULTS` when it has none or the caller passed no scene. The
   * camera keys above were already solved with it; carried for the passes
   * that run after `solveCamera` — the follow spring and the camera blur — so
   * they read the same settings rather than looking the block up again.
   */
  motion: SceneMotion;
  /** Output-axis stretches where the pointer is still. See `cursorRestSpans`. */
  cursorRestOutputMs: TimeSpan[];
  cosmetics: ResolvedCosmetic[];
  /** The trim, on the untrimmed output axis. The whole output when none. */
  range: OutputRange;
  /** Trim sides whose step the bundle has no marker for; that side is uncut. */
  trimUnplaced: ("head" | "tail")[];
  /** Every range the render cut to nothing. Tasks 4 and 5 append to this. */
  clampedRanges: ClampedRange[];
  /**
   * Every zoom a `cover` target lowered, keyed by step for a consumer
   * that names the zoom by its click rather than by its camera id — the
   * CLI's export answer (run-core's `zoomWarnings`). A narrowed zoom is
   * also a `zoomFit` note in `clampedRanges`; a zoom the vertical cap alone
   * lowered is here only, so the editor lists no notice for it. Empty
   * under `contain`.
   */
  loweredZooms: LoweredZoom[];
}

/** One zoom a `cover` target lowered. See `ResolvedPlan.loweredZooms`. */
export interface LoweredZoom {
  /** The camera event's id. */
  id: string;
  /** The step the zoom is on. */
  actionId: string;
  /** The author's scale. */
  asked: number;
  /** The scale the camera holds: 1 when it only pans to the target. */
  got: number;
  /** `cap`: the vertical cap alone lowered it. `fit`: the crop fit
   *  narrowed it, after the cap when the cap applied too. */
  by: "cap" | "fit";
}

/**
 * Cursor position at a source time. Linear between samples — the curve is
 * already in them. Out-of-range times CLAMP onto the end samples; null means
 * only that there are no samples at all, never that the time was refused.
 *
 * Binary search, not a walk from index 0. `compose.ts` samples once for the
 * pointer and once per motion-blur ghost, and `motionBlur: 1` — the product
 * default, and what the v4→v5 migration backfills onto every existing
 * document — asks for ten ghosts. A linear scan therefore crossed the take's
 * whole sample list eleven times per composed frame, on every render and
 * every preview scrub, where before the cursor panel it crossed it once.
 */
export function sampleCursor(
  samples: CursorSample[],
  sourceMs: number,
): Vec | null {
  const first = samples[0];
  if (!first) return null;
  if (sourceMs <= first.sourceTimeMs) return { x: first.x, y: first.y };
  const last = samples[samples.length - 1];
  if (!last) return null;
  if (sourceMs >= last.sourceTimeMs) return { x: last.x, y: last.y };

  // Those two clamps establish the invariant this narrows under:
  // `samples[lo] < sourceMs <= samples[hi]`, so the pair it settles on is
  // the same one the old scan stopped at — the first sample at or after
  // `sourceMs`, and its predecessor.
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const at = samples[mid];
    if (!at) break;
    if (at.sourceTimeMs < sourceMs) lo = mid;
    else hi = mid;
  }
  const from = samples[lo];
  const to = samples[hi];
  if (!from || !to) return { x: last.x, y: last.y };
  const span = to.sourceTimeMs - from.sourceTimeMs;
  const t = span === 0 ? 0 : (sourceMs - from.sourceTimeMs) / span;
  return lerpVec({ x: from.x, y: from.y }, { x: to.x, y: to.y }, t);
}

/** How long `holdAcrossGaps`' step out of a hold takes. See its docblock. */
const GAP_STEP_MS = 0.01;

/**
 * Make a gap render as a hold rather than as a journey.
 *
 * `sampleCursor` interpolates linearly between adjacent samples, so a hole
 * between two real positions is drawn as a straight line the pointer never
 * travelled — a failure path (position unknown) rendered exactly like a
 * success (position observed). Two synthetic samples at the pre-gap position
 * make that same interpolation flat instead, which needs no change to the
 * interpolator and no new state for its callers.
 *
 * The hold ends a hundredth of a millisecond before the gap does, so the
 * real sample that closed the gap is still the next point. The cursor
 * therefore sits still and then jumps, which is what happened: the pointer
 * left, and came back somewhere else.
 *
 * A hundredth, not the whole millisecond this was until 2026-10-06. The
 * step between the hold and the next sample is interpolated like any other,
 * so it is a straight line drawn over that window — a path the pointer
 * never travelled — and a frame landing inside it draws the cursor partway
 * along it. At 1ms that was one frame in seventeen at 60fps; at 0.01ms it
 * is one in well over a thousand. It mattered once `leaveThroughEdges`
 * started ending runs off the page on two different sides: the line between
 * them cuts through the page's corner.
 *
 * **The hole is emptied first, and that is not a detail.** Two samples make
 * the interpolation flat only if nothing else is left between them, and by
 * the time this runs on a capture take there is: `followWithSpring` writes
 * its own grid into exactly the long holes a gap makes, so appending and
 * sorting left the spring's curve sitting inside the stretch and the hold
 * either side of it. Measured through the whole pipeline on a two-second
 * gap, the drawn cursor sat still until 112ms before the gap closed, then
 * travelled 600px across a stretch where the position is by definition
 * unknown, and then snapped back to where it started inside the final
 * millisecond. Nothing here is a recorded observation being dropped — no
 * observation exists inside a gap, which is what makes it one — it is the
 * fabrications of earlier stages being cleared out of a hole they had no
 * business filling.
 */
export function holdAcrossGaps(
  samples: CursorSample[],
  gaps: CursorGap[],
): CursorSample[] {
  if (gaps.length === 0) return samples;

  const first = samples[0];
  // A gap before the first sample has no known position to hold.
  const usable = gaps.filter(
    (gap) => first !== undefined && gap.startMs >= first.sourceTimeMs,
  );
  // The pre-gap position is where the observed trajectory already was the
  // instant the gap opened — `sampleCursor` against the untouched samples,
  // not the raw coordinates of whichever sample happens to precede it. A
  // gap can open mid-flight, between two real samples; holding at the
  // earlier sample's own coordinates would snap the cursor backward onto a
  // position it had already left. Read before anything is removed, for the
  // same reason.
  const holds = usable.flatMap((gap) => {
    const before = sampleCursor(samples, gap.startMs);
    return before === null ? [] : [{ gap, before }];
  });

  const held = samples.filter(
    (sample) =>
      !usable.some(
        (gap) =>
          sample.sourceTimeMs > gap.startMs && sample.sourceTimeMs < gap.endMs,
      ),
  );
  for (const { gap, before } of holds) {
    held.push({ sourceTimeMs: gap.startMs, x: before.x, y: before.y });
    held.push({
      sourceTimeMs: Math.max(gap.startMs, gap.endMs - GAP_STEP_MS),
      x: before.x,
      y: before.y,
    });
  }
  return held.sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
}

/**
 * Make a pause render as a pause.
 *
 * A resting hand records nothing at all — Chrome fires no `pointermove`
 * while the mouse is untouched — so a pause arrives as a hole between two
 * real samples, and `sampleCursor` interpolates straight across it. Measured
 * on a two-second pause, the drawn cursor glided the whole way to the next
 * target while the hand sat still: it was never at rest anywhere in a take.
 * The retimer inherited the same lie, because `cursorMotionSpans` saw one
 * pair of distant samples and reported two seconds of a static page as
 * cursor travel, which it then passed at rate 1.0 instead of compressing.
 *
 * This is `holdAcrossGaps`' defect in a second place, and deliberately not
 * `holdAcrossGaps` itself: a `CursorGap` is a stretch where the position was
 * *unknown*, and its docblock says so. Here the position is known and
 * unchanged, and the difference is not cosmetic — it decides where in the
 * pipeline the hold belongs. A rest's inserted sample is a true observation
 * (the pointer really was there for that whole stretch), so the smoothing
 * filter is welcome to average across it; a gap's is a fabrication standing
 * in for a hole, so the filter must never see it. See `resolvePlan`.
 *
 * One sample per pause, not two: the pause's start is already a real sample.
 * The hold ends one millisecond before the next one, so that sample is still
 * the next point and the pointer moves off the rest rather than being
 * teleported off it. Where the next sample is far away — the pointer left
 * the window without firing `pointerout`, say — holding and then jumping is
 * the honest rendering of "it was here, and then it was there", which is the
 * same argument `holdAcrossGaps` makes.
 *
 * **The hold ends when the observing does.** A pause can end with the
 * pointer leaving rather than moving — it sits still for a while and then
 * goes — and then the tail of the hole is a `CursorGap`, where this
 * function's claim about its inserted sample (the pointer really was there,
 * for that whole stretch) is exactly what is not known. So the hold stops at
 * the gap's start, and the hole from there on belongs to `holdAcrossGaps`,
 * which fills it later, where nothing will read it as a route. A gap that
 * opens at the pausing sample itself leaves nothing to hold at all.
 *
 * Both halves of that matter, in opposite directions. Running the hold on
 * into the gap joined the two sides of one into a single stretch of
 * observation: `retimeAlongRoute` then measured arc length along the
 * teleport across it and spread that distance over the gesture that
 * followed, drawing the hand's first position after a two-second gap,
 * (900,700), at (110,108). Dropping the hold entirely is the mirror fault —
 * the stillness before the pointer left is real, and without it the position
 * `holdAcrossGaps` reads at the gap's start is a straight-line interpolation
 * across the pause, 100px along a journey that had not begun.
 */
export function holdThroughRests(
  samples: CursorSample[],
  minQuietMs: number,
  gaps: readonly CursorGap[] = [],
): CursorSample[] {
  if (minQuietMs <= 0) return samples;

  const held: CursorSample[] = [];
  for (const [i, sample] of samples.entries()) {
    held.push(sample);
    const next = samples[i + 1];
    if (!next) continue;
    if (next.sourceTimeMs - sample.sourceTimeMs <= minQuietMs) continue;
    const until = Math.min(
      next.sourceTimeMs - 1,
      ...gaps
        .filter(
          (gap) =>
            gap.startMs >= sample.sourceTimeMs &&
            gap.startMs < next.sourceTimeMs,
        )
        .map((gap) => gap.startMs),
    );
    if (until <= sample.sourceTimeMs) continue;
    held.push({ sourceTimeMs: until, x: sample.x, y: sample.y });
  }
  return held;
}

const SYNTHETIC_SAMPLE_HZ = 120;

/**
 * v9's second cursor rule, for any scene whose frames came from capture
 * rather than replay: nothing dispatched a cursor, so no samples came back
 * and the compositor walks its own segments instead, arriving at each
 * marker. Most often that is a mutating scene the author's setting refuses
 * to replay — but "mutating" is not itself the condition, and whether such a
 * scene replays is decided in `packages/replay-engine/src/policy.ts`
 * alone. On a hover-sensitive scene the easing is deliberately gentler, so
 * the drawn cursor never visibly disagrees with captured hover pixels.
 */
function synthesizeCursor(
  plan: RenderPlan,
  markerSourceMs: Map<string, number>,
): CursorSample[] {
  const samples: CursorSample[] = [];
  const easing = plan.hoverSensitive
    ? easings.easeInOutSine
    : easings.minimumJerk;

  for (const segment of plan.cursorSegments) {
    const arriveMs = markerSourceMs.get(segment.toActionId);
    if (arriveMs === undefined) continue;
    // A segment wants to depart `dwell + duration` before its marker — at
    // the defaults, 540ms or more. Two markers closer together than that
    // would have segment k+1 departing BEFORE segment k arrives, and after
    // the sort segment k's trailing hold sample lands in the middle of k+1's
    // travel: `sampleCursor` interpolates towards it and the pointer visibly
    // snaps back to the anchor it already left. The previous marker is the
    // earliest honest departure, so clamp to it.
    const departAfterMs =
      (segment.fromActionId === null
        ? 0
        : markerSourceMs.get(segment.fromActionId)) ?? 0;
    const startMs = Math.max(
      0,
      departAfterMs,
      arriveMs - segment.dwellMs - segment.durationMs,
    );
    // And the travel has to fit in the room that leaves, or the tail of the
    // path would overrun the marker it is aiming at and re-create the same
    // out-of-order sample from the other side.
    const travelMs = Math.max(
      0,
      Math.min(segment.durationMs, arriveMs - startMs),
    );
    const steps = Math.max(
      2,
      Math.round((travelMs / 1000) * SYNTHETIC_SAMPLE_HZ),
    );
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const point = sampleSegment(segment, easing(t));
      samples.push({
        sourceTimeMs: startMs + travelMs * t,
        x: point.x,
        y: point.y,
      });
    }
    // Hold on the anchor through the dwell, so hover UI has time to appear.
    samples.push({ sourceTimeMs: arriveMs, x: segment.to.x, y: segment.to.y });
  }

  return samples.sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
}

/** Below this, sample-to-sample movement is jitter or a hold, not travel. */
const CURSOR_MOTION_EPSILON_PX = 0.5;

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
 * How long the pointer must be still, ON SCREEN, before it starts to fade.
 *
 * Output time, not source time, and that is the whole of the correctness
 * here. A dwell is by definition idle and the retimer compresses idle hard,
 * so a 1200ms pause inside a 6x span is 200ms of screen time. Measured on
 * the source axis this threshold would be met on nearly every dwell in
 * every take, and a cursor that vanishes and returns inside 200ms reads as
 * a dropped frame rather than as a deliberate fade.
 */
export const CURSOR_IDLE_HIDE_MS = 1000;

/** How long the fade itself takes, each way. Viewer time, as above. */
export const CURSOR_IDLE_FADE_MS = 250;

/**
 * How long the drawn cursor takes to cross a cut, in OUTPUT milliseconds.
 *
 * 250 to start, tuned by eye on a real take (spec §1). Output time, like
 * `CURSOR_IDLE_HIDE_MS` and for the same reason: the viewer's clock is the
 * one the glide has to look right on, and the stretch after a seam can be
 * retimed.
 */
export const CUT_BRIDGE_MS = 250;

/**
 * Make a cut render as a move rather than as a teleport.
 *
 * The drawn cursor follows recorded samples, so across a cut the pointer
 * would be in one place on one frame and hundreds of pixels away on the
 * next — measured at 514px on the procedural fixture. It glides from its
 * last kept position to its next recorded one over `bridgeMs` of output
 * time, OVERLAPPING the frames after the seam. There is no frozen hold on
 * either side: a cut exists to remove time, and putting some back at the
 * join is the one thing it must not do.
 *
 * Runs AFTER `buildTimeline` — unlike `holdAcrossGaps` and
 * `holdThroughRests`, which run before it — because how much source time
 * `bridgeMs` of output buys is a question only the timeline can answer, and
 * the cut ranges only exist once the markers have been resolved against the
 * bundle.
 *
 * **The pre-cut position is read before anything is removed**, the same
 * discipline `holdAcrossGaps` states: it is where the observed trajectory
 * already was when the cut opened, not the raw coordinates of whichever
 * sample happens to precede it.
 *
 * Linear in SOURCE time between the two inserted points, which is linear in
 * output time wherever the bridged stretch plays at rate 1.0 — motion always
 * does, and 250ms of idle is not a stretch an authored gap meaningfully
 * warps. Kept simple deliberately: a sampled curve here would have to be
 * re-derived every time the retimer changed.
 */
export function bridgeCutSeams(
  samples: CursorSample[],
  timeline: Timeline,
  bridgeMs: number,
): CursorSample[] {
  if (timeline.cuts.length === 0 || samples.length === 0) return samples;

  interface Bridge {
    fromMs: number;
    toMs: number;
    from: Vec;
    to: Vec;
  }
  const bridges: Bridge[] = [];
  for (const cut of timeline.cuts) {
    // A trailing cut has no frames after it, so nothing to glide to; a
    // leading one has none before it the viewer saw, so nothing to glide
    // from — a glide there would be motion added to the picture.
    if (cut.trailing || cut.srcStartMs <= 0) continue;
    const from = sampleCursor(samples, cut.srcStartMs);
    // No recorded sample at or before the seam to glide FROM. Silent on
    // purpose (ledger minor #5, comment-only): no bridge for this cut means
    // the PRE-CUT behaviour stands — the drawn cursor teleports across this
    // seam exactly as it did before this function existed. That is a real
    // gap in coverage, not a corrupted render, so it is not surfaced as one.
    if (from === null) continue;
    const seamOutMs = toOutputMs(timeline, cut.srcStartMs);
    const endSrcMs = toSourceMs(timeline, seamOutMs + bridgeMs);
    // A bridge that would run into the NEXT cut is cut short at that cut's
    // start, so two close cuts never produce crossing glides.
    const nextCutStartMs = timeline.cuts
      .filter((c) => c.srcStartMs > cut.srcEndMs)
      .reduce(
        (min, c) => Math.min(min, c.srcStartMs),
        Number.POSITIVE_INFINITY,
      );
    const toMs = Math.min(endSrcMs, nextCutStartMs);
    // The window collapsed to nothing (or the next cut sits at or before
    // this one's own close). Same answer as `from === null` above: no
    // bridge here means the pre-cut behaviour, a teleport at this seam, and
    // that is correct rather than a failure to report.
    if (toMs <= cut.srcEndMs) continue;
    const to = sampleCursor(samples, toMs);
    // No recorded sample to glide TO. Same reasoning again — the pre-cut
    // behaviour (a teleport) is what plays, and nothing here is wrong for
    // this cut alone having nothing to bridge with.
    if (to === null) continue;
    bridges.push({ fromMs: cut.srcEndMs, toMs, from, to });
  }
  if (bridges.length === 0) return samples;

  // Empty the window first, exactly as `holdAcrossGaps` does and for the
  // same reason: two samples make the interpolation a straight glide only
  // if nothing else is left between them.
  //
  // INCLUSIVE at the start, where `holdAcrossGaps` is exclusive, and the
  // difference is the whole bridge. `fromMs` is the cut's closing instant —
  // the first frame after the seam — and the recorded sample sitting there
  // is precisely the teleport destination this exists to remove. Left in,
  // it survives beside the inserted one at the same instant and the sort
  // picks between them arbitrarily: measured, the drawn step stayed at
  // 514px, exactly as if there were no bridge at all.
  const kept = samples.filter(
    (sample) =>
      !bridges.some(
        (b) => sample.sourceTimeMs >= b.fromMs && sample.sourceTimeMs < b.toMs,
      ),
  );
  for (const bridge of bridges) {
    kept.push({
      sourceTimeMs: bridge.fromMs,
      x: bridge.from.x,
      y: bridge.from.y,
    });
    kept.push({ sourceTimeMs: bridge.toMs, x: bridge.to.x, y: bridge.to.y });
  }
  return kept.sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
}

/**
 * Stretches where the pointer is still, on the OUTPUT axis, long enough to
 * be worth fading out.
 *
 * A click inside a rest splits it: the press and the pulse are the cursor
 * doing something, so they re-arm the timer rather than firing on a pointer
 * that has faded out from under them.
 *
 * No samples yields no spans, which reads as "never idle" and leaves the
 * cursor visible. That is the safe direction: a take whose samples did not
 * arrive has a larger fault, already reported by the bundle banner, and
 * hiding the pointer on top of it would add a symptom with no second cause.
 */
export function cursorRestSpans(
  samples: CursorSample[],
  timeline: Timeline,
  clickOutputMs: number[],
): TimeSpan[] {
  const still: TimeSpan[] = [];
  let restStartMs: number | null = null;
  for (let i = 1; i < samples.length; i++) {
    const from = samples[i - 1];
    const to = samples[i];
    if (!from || !to) continue;
    const moved =
      Math.hypot(to.x - from.x, to.y - from.y) >= CURSOR_MOTION_EPSILON_PX;
    if (!moved) {
      restStartMs ??= from.sourceTimeMs;
      continue;
    }
    if (restStartMs !== null) {
      still.push({ startMs: restStartMs, endMs: from.sourceTimeMs });
      restStartMs = null;
    }
  }
  const last = samples[samples.length - 1];
  if (restStartMs !== null && last) {
    still.push({ startMs: restStartMs, endMs: last.sourceTimeMs });
  }

  const clicks = [...clickOutputMs].sort((a, b) => a - b);
  const spans: TimeSpan[] = [];
  for (const span of still) {
    const startMs = toOutputMs(timeline, span.startMs);
    const endMs = toOutputMs(timeline, span.endMs);
    // The threshold is judged against the WHOLE rest, before any click cuts
    // it — a click splits an already-qualifying rest into two pieces that
    // both stay, rather than resetting the clock on two fresh, shorter
    // ones. A 1200ms dwell split by a click at its 600ms mark reads as one
    // interrupted fade, not two 600ms non-fades: the pointer was still
    // idle-long before the click landed, and the click does not erase that.
    if (endMs - startMs < CURSOR_IDLE_HIDE_MS) continue;
    let cutFrom = startMs;
    for (const click of clicks) {
      if (click <= cutFrom || click >= endMs) continue;
      spans.push({ startMs: cutFrom, endMs: click });
      cutFrom = click;
    }
    spans.push({ startMs: cutFrom, endMs });
  }
  return spans;
}

/** The opacity a fade-out has reached `elapsedMs` into a rest. */
function fadeOutAlpha(elapsedMs: number): number {
  const past = elapsedMs - CURSOR_IDLE_HIDE_MS;
  if (past <= 0) return 1;
  return Math.max(0, 1 - past / CURSOR_IDLE_FADE_MS);
}

/**
 * The cursor's opacity at an output instant: 1 everywhere except inside a
 * rest that has run past `CURSOR_IDLE_HIDE_MS`, and across the fade back in
 * from the rest's end.
 *
 * The fade-in is measured from the span's END rather than from the next
 * sample, because the span ends exactly where movement resumed.
 */
export function cursorIdleAlpha(
  rests: TimeSpan[],
  outputTimeMs: number,
): number {
  for (const rest of rests) {
    if (outputTimeMs >= rest.startMs && outputTimeMs < rest.endMs) {
      return fadeOutAlpha(outputTimeMs - rest.startMs);
    }
    const since = outputTimeMs - rest.endMs;
    if (since >= 0 && since < CURSOR_IDLE_FADE_MS) {
      // Resume from the opacity the fade-out actually reached, NOT from 0.
      // A rest only a little past the threshold is still mid-ramp when it
      // ends, and starting the fade-in at 0 drops the pointer to invisible
      // on the very frame it starts moving again — measured at 0.204 -> 0
      // on a 1200ms rest, which is the artifact this feature exists to
      // remove rather than introduce. A rest short enough to never have
      // faded reaches 1 here too, via `fadeOutAlpha`, so no separate guard
      // for that case is needed.
      const reached = fadeOutAlpha(rest.endMs - rest.startMs);
      return reached + (1 - reached) * (since / CURSOR_IDLE_FADE_MS);
    }
  }
  return 1;
}

/** A scale for a note: two places, trailing zeros dropped. */
function scaleText(scale: number): string {
  return String(Number(scale.toFixed(2)));
}

/**
 * The camera's centre while zoomed (spec 2026-10-22), from the keys a target
 * draws: `resolvePlan`'s own, and again `composeForTarget`'s once the detail
 * clamp has cut them, so a trail is never planned from scales the target
 * does not draw. It needs the pointer as DRAWN — `bridged`, the samples
 * `renderFrame` reads, cut bridges and all. A take that draws no pointer (a
 * touch take's taps, or a cursor the author hid) has nothing to trail: it
 * chases the zooms' aims, as with follow off. Only a drag with a zoom of its
 * own holds the camera on that aim; one without is pressed inside another
 * zoom, and the camera follows the hand.
 */
export function resolveCameraFollow(args: {
  keys: CameraKey[];
  plan: RenderPlan;
  bundle: FrameBundle;
  timeline: Timeline;
  cursor: CursorSample[];
  motion: SceneMotion;
  drawsPointer: boolean;
}): FollowStretch[] {
  const { keys, plan, bundle, timeline, cursor, motion } = args;
  const zoomedActions = new Set(plan.cameraIntents.map((i) => i.actionId));
  return solveFollow({
    keys,
    cursorAt:
      motion.follow && args.drawsPointer
        ? (outputMs) => sampleCursor(cursor, toSourceMs(timeline, outputMs))
        : null,
    holds: (bundle.heldPresses ?? [])
      .filter((h) => zoomedActions.has(h.actionId))
      .map((h) => ({
        startMs: toOutputMs(timeline, h.pressMs),
        endMs: toOutputMs(timeline, h.releaseMs),
      })),
    outputDurationMs: timeline.outputDurationMs,
    rate: motionTimings(motion.smoothness).followRatePerS,
  });
}

/**
 * The bundle-dependent stage: still pure, still canvas-free, but it knows
 * where things actually were on screen and where the frames were dense.
 *
 * `cameraFitWindow` is the CSS window a `cover` target shows at scale 1;
 * `composeForTarget` passes it and every zoom is fitted to it. See
 * `solveCamera`.
 */
export function resolvePlan(
  givenPlan: RenderPlan,
  given: FrameBundle,
  givenScene?: SceneDocument,
  hints: TimeSpan[] = [],
  cameraFitWindow: { width: number; height: number } | null = null,
): ResolvedPlan {
  // The page's layout px onto the screen the frames show (`screen-space.ts`).
  // Here and not in `planScene`: the plan's cursor segments are also
  // replay's input, which speaks layout px.
  // Reassigned once below, when a removed piece removed no frames.
  let plan = givenPlan;
  const { bundle, scene } = inScreenSpace(given, givenScene);
  // Two maps, not one. `anchorRects` entries are per-ACTION — replay
  // re-measures the element at every action, and capture now records the rect
  // each sighting saw — while the fingerprint rect is the element's first
  // sighting and is the fallback for an action with no entry of its own.
  //
  // These were one map keyed by anchorId until 2026-09-04, which collapsed
  // every action on an anchor onto whichever rect was written last. That was
  // invisible while `fingerprintKey` included `boundingRect`, because a moved
  // element forked into its own anchor and no anchor ever held two positions.
  const anchorRects = new Map<string, Rect>();
  for (const anchor of scene?.anchors ?? []) {
    if (anchor.fingerprint.boundingRect) {
      anchorRects.set(anchor.id, anchor.fingerprint.boundingRect);
    }
  }
  const actionRects = new Map<string, Rect>();
  for (const entry of bundle.anchorRects) {
    actionRects.set(entry.actionId, entry.rect);
  }
  const rectOf = (anchorId: string, actionId: string): Rect | null =>
    actionRects.get(actionId) ?? anchorRects.get(anchorId) ?? null;

  const markerSourceMs = new Map(
    bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]),
  );
  // Cursor first, timeline second: the timeline needs to know where the
  // pointer was moving before it can decide what counts as dead air.
  //
  // Replay samples are drawn as recorded: they ARE the input that drove the
  // app, and `plan/types.ts` makes that identity the point. Capture samples
  // are a real hand, and a real hand jitters. Smoothing runs before
  // `holdAcrossGaps` so the synthetic hold samples it inserts are never
  // averaged together with real ones across a hole.
  //
  // The markers' source times are handed in as pin points. A marker is the
  // instant an action fired, which is the instant `render.ts` reads the
  // cursor at for the click pulse — an averaged sample there draws the click
  // beside the button it hit, because a real arrival decelerates and a
  // centred average of a decelerating approach lags behind it. See
  // `smoothCursor`'s `pinnedMs`.
  // A capture take's trips off the page are written into its samples
  // before anything else reads them — see `plan/off-page.ts` for why first.
  // Every stage below sees the run out to the edge as part of the gesture,
  // and the gaps cut down to the wait off the page. Replay has no gaps, and
  // its first sample is the first position the walk drove, not an arrival.
  const pointer =
    bundle.source === "capture"
      ? leaveThroughEdges(
          bundle.cursorSamples,
          bundle.cursorGaps,
          plan.viewport,
        )
      : { samples: bundle.cursorSamples, gaps: bundle.cursorGaps };
  const recorded =
    bundle.source === "capture"
      ? smoothCursor(
          holdThroughRests(pointer.samples, CURSOR_REST_MS, pointer.gaps),
          CURSOR_SMOOTHING_MS,
          bundle.markers.map((m) => m.sourceTimeMs),
          pointer.gaps,
        )
      : pointer.samples;
  // Re-timing goes after the filter and before the gap holds, for the two
  // reasons those neighbours were placed where they are: the filter should
  // clean the route before anything walks along it, and a gap's hold is a
  // fabrication standing in for an unknown position, which nothing should
  // slide a cursor across. Capture only — a replay bundle's samples are the
  // coordinates that drove the app, and re-timing them would draw a cursor
  // somewhere the click did not happen.
  const travelled =
    pointer.samples.length > 0
      ? holdAcrossGaps(recorded, pointer.gaps)
      : synthesizeCursor(
          {
            ...plan,
            cursorSegments: segmentsInScreenSpace(
              plan.cursorSegments,
              given.viewportTransforms ?? [],
              markerSourceMs,
            ),
          },
          markerSourceMs,
        );
  const markerTimes = bundle.markers.map((m) => m.sourceTimeMs);
  const cursor =
    bundle.source === "capture" && pointer.samples.length > 0
      ? // The gaps are handed to all three stages, and none of them is
        // spared by the others. The re-timer must not measure arc length
        // along a teleport; the spring must not glide across one, and must
        // not read its target through the hole either, which it would do
        // `springLeadMs` before the gap opened; and the hold at the end
        // still has to clear out the settle the spring writes past the last
        // sample of the stretch before it.
        holdAcrossGaps(
          followWithSpring(
            retimeAlongRoute(
              recorded,
              markerTimes,
              CURSOR_REST_MS,
              pointer.gaps,
              plan.viewport,
            ),
            CURSOR_SPRING_TAU_MS,
            markerTimes,
            pointer.gaps,
          ),
          pointer.gaps,
        )
      : travelled;

  // Hints from the path as recorded, NOT as re-timed, and the difference is
  // load-bearing. A hint says "the pointer was travelling here, so do not
  // compress it", and re-timing cannot change which stretches those are — it
  // moves the cursor along the same route between the same two instants. But
  // it does make the drawn steps at each end of a gesture very small, and
  // `cursorMotionSpans` drops a pair under half a pixel: measured on a
  // one-second reach, 32ms of the gesture lost its protection and the
  // retimer would have compressed exactly the ease this adds, putting a rate
  // change at the gesture's own boundary.
  // ...and each travel hint runs on past the end of the gesture, because the
  // drawn cursor does. `followWithSpring` is still closing on the target for
  // `springSettleMs` after the hand has stopped, and that glide is the half
  // of the effect a viewer notices most. Left unextended it lands in the
  // dead air after the gesture and an authored gap compresses it, which
  // turns the settle into a snap.
  // ...and each travel hint starts before the gesture, for the mirror-image
  // reason. The spring reads its target `springLeadMs` ahead, so the drawn
  // cursor is already gathering itself that long before the hand's first
  // recorded sample — measured, movement began 112ms before a gesture whose
  // first sample was at 3000ms. That anticipation lands in the dead air the
  // gesture is approached through, which is exactly the stretch an authored
  // gap compresses hardest. Covering one end and not the other protected the
  // settle and left the departure to be snapped through.
  const settleMs =
    bundle.source === "capture" ? springSettleMs(CURSOR_SPRING_TAU_MS) : 0;
  const leadMs =
    bundle.source === "capture" ? springLeadMs(CURSOR_SPRING_TAU_MS) : 0;
  const motionHints = [
    ...hints,
    ...cursorMotionSpans(travelled).map((span) => ({
      startMs: Math.max(0, span.startMs - leadMs),
      endMs: span.endMs + settleMs,
    })),
  ];
  let timeline = buildTimeline(plan, bundle, motionHints);
  // A removed piece that removed no frames (its ends are nowhere in these
  // frames) takes no steps out of the video either: the frameless plan
  // dropped their zooms, masks and holds on the document's word, and those
  // frames still play. Planned again without it, and the timeline rebuilt
  // on that plan — `removed` itself kept whole, so the piece is still
  // reported as having removed nothing (review 2026-10-22).
  const unplacedIds = new Set(timeline.unplacedCuts.flatMap((u) => u.ids));
  if (unplacedIds.size > 0 && givenScene !== undefined) {
    const kept = planScene(
      {
        ...givenScene,
        edits: {
          ...givenScene.edits,
          removed: (givenScene.edits.removed ?? []).filter(
            (r) => !unplacedIds.has(r.id),
          ),
        },
      },
      { retiming: plan.retiming },
    );
    plan = {
      ...plan,
      cameraIntents: kept.cameraIntents,
      cosmetics: kept.cosmetics,
      holds: kept.holds,
      removedSteps: kept.removedSteps,
      attachedToCuts: kept.attachedToCuts,
    };
    timeline = buildTimeline(plan, bundle, motionHints);
  }

  // After the timeline, not before it: the bridge needs the cut ranges, and
  // needs the timeline to say how much source time 250ms of output buys.
  // Everything below reads `bridged` rather than `cursor` —
  // `cursorRestOutputMs` above all, which would otherwise call the glide a
  // rest and fade the pointer out across it.
  const bridged = bridgeCutSeams(cursor, timeline, CUT_BRIDGE_MS);

  const trim = resolveRange({
    id: "trim",
    kind: "trim",
    start: plan.trim.head,
    end: plan.trim.tail,
    timeline,
    markerSourceMs,
  });
  const clampedRanges: ClampedRange[] = trim.clamped ? [trim.clamped] : [];

  // Absent is the documented default (`MotionSchema`), not a fault: every
  // document written before the block existed has none.
  const motion = scene?.motion ?? MOTION_DEFAULTS;
  // A removed step's act is not in the film, so it holds no later zoom back.
  // `?? []`: a hand-built plan from before the field existed has none.
  const cutIds = new Set(plan.removedSteps ?? []);
  const actEnds = new Map(
    bundle.markers.flatMap((m) =>
      m.actEndSourceTimeMs === undefined || cutIds.has(m.actionId)
        ? []
        : [[m.actionId, m.actEndSourceTimeMs] as const],
    ),
  );
  // Each drag's held button, in output time: the cursor is drawn pressed
  // through it, and a zoom does not go back out before it ends.
  const holdOutputMs = (bundle.heldPresses ?? []).map((h) => ({
    startMs: toOutputMs(timeline, h.pressMs),
    endMs: toOutputMs(timeline, h.releaseMs),
  }));
  const camera = solveCamera(
    plan.cameraIntents,
    rectOf,
    timeline,
    markerSourceMs,
    plan.viewport,
    cameraFitWindow,
    motion,
    actEnds,
    holdOutputMs,
  );
  const intentAction = new Map(
    plan.cameraIntents.map((intent) => [intent.id, intent.actionId] as const),
  );
  const loweredZooms: LoweredZoom[] = [];
  for (const segment of camera.segments) {
    if (segment.fitted !== null) {
      const { from, to, cap } = segment.fitted;
      // The cap alone: the fit left the capped scale whole. Data only, no
      // note: the cap applies to every zoom in a 9:16 frame, so a note per
      // zoom would be a notice per click under the editor's timeline
      // (author, 2026-10-14). The CLI's export says it once.
      const capOnly = cap !== null && to >= cap;
      if (!capOnly) {
        clampedRanges.push({
          id: segment.id,
          kind: "zoomFit",
          note:
            to <= 1
              ? `zoom "${segment.id}" asked for ${scaleText(from)}x, but its target is too wide to zoom on in this frame's crop, so the camera pans to it at 1x instead`
              : `zoom "${segment.id}" asked for ${scaleText(from)}x, and was narrowed to ${scaleText(to)}x so its target fits this frame's crop`,
        });
      }
      const actionId = intentAction.get(segment.id);
      // A segment is only ever made from an intent (`solveCamera`'s seeds),
      // so this always finds one; the guard is for the type.
      if (actionId !== undefined) {
        loweredZooms.push({
          id: segment.id,
          actionId,
          asked: Number(from.toFixed(2)),
          got: Number(to.toFixed(2)),
          by: capOnly ? "cap" : "fit",
        });
      }
    }
    if (!segment.endClamped) continue;
    clampedRanges.push({
      id: segment.id,
      kind: "zoom",
      note: `zoom "${segment.id}" was asked to end at an instant the camera cannot reach — too close to its own push-in or to the next zoom — so it returns at ${Math.round(segment.endMs)}ms instead`,
    });
  }

  // A replayed type clicks its field to focus it, at its marker as a click
  // does (`performVerb`), so it gets the same press and pulse. Not on a
  // capture: the author may have tabbed in, and a click they made is a step
  // of its own.
  // A drag presses at its marker too; its release is in `heldPresses`.
  const clickKinds = new Set(
    bundle.source === "replay" ? ["click", "type", "drag"] : ["click"],
  );
  const clickActionIds = new Set(
    (scene?.actions ?? [])
      .filter((a) => clickKinds.has(a.kind))
      .map((a) => a.id),
  );
  const clickOutputMs = bundle.markers
    .filter((m) => clickActionIds.has(m.actionId))
    .map((m) => toOutputMs(timeline, m.sourceTimeMs))
    .sort((a, b) => a - b);
  const touch = scene?.meta.capture.device?.touch === true;
  const taps = touch
    ? bundle.markers
        .filter((m) => clickActionIds.has(m.actionId))
        .flatMap((m) => {
          const at = sampleCursor(bridged, m.sourceTimeMs);
          return at === null
            ? []
            : [{ outputMs: toOutputMs(timeline, m.sourceTimeMs), at }];
        })
        .sort((a, b) => a.outputMs - b.outputMs)
    : [];

  const cameraFollow = resolveCameraFollow({
    keys: camera.keys,
    plan,
    bundle,
    timeline,
    cursor: bridged,
    motion,
    drawsPointer: !touch && !(scene?.cursor ?? CURSOR_DEFAULTS).hidden,
  });

  const cosmetics: ResolvedCosmetic[] = plan.cosmetics.map((binding) => {
    let range: OutputRange | null = null;
    let unplaced: ("start" | "end")[] = [];
    if (binding.range) {
      const resolved = resolveMaskRange({
        id: binding.id,
        start: binding.range.start,
        end: binding.range.end,
        timeline,
        markerSourceMs,
      });
      if (resolved.clamped) clampedRanges.push(resolved.clamped);
      // An unplaced side fell back to the take's own end, so the mask paints
      // over more than it was authored to. That is carried out to the caller
      // rather than dropped here: `timing: estimated` hatches the end as
      // unmeasured, which is a different sentence from "this mask is now
      // covering a stretch you did not ask to redact".
      unplaced = resolved.unplaced;
      range = resolved.range;
    }
    return {
      id: binding.id,
      kind: "mask",
      rect: binding.rect,
      range,
      unplaced,
    };
  });

  return {
    plan,
    timeline,
    cameraKeys: camera.keys,
    cameraFollow,
    cameraSegments: camera.segments,
    cursor: bridged,
    clickOutputMs,
    holdOutputMs,
    touch,
    taps,
    cursorLook: scene?.cursor ?? CURSOR_DEFAULTS,
    motion,
    cursorRestOutputMs: cursorRestSpans(bridged, timeline, clickOutputMs),
    cosmetics,
    range: trim.range,
    trimUnplaced: trim.unplaced.map((side) =>
      side === "start" ? "head" : "tail",
    ),
    clampedRanges,
    loweredZooms,
  };
}

export { sampleCamera };
