import {
  dragPoints,
  MOTION_DEFAULTS,
  type SceneDocument,
  type SceneMotion,
} from "@demoman/scene-schema";
import { springEase } from "../easing.js";
import {
  clamp,
  lerp,
  lerpVec,
  type Rect,
  rectCenter,
  type Vec,
} from "../geometry.js";
import { markerOutputMs } from "./ranges.js";
import { type Timeline, toOutputMs } from "./timeline.js";
import type { AttachedEdit, CameraIntent } from "./types.js";

/** What one `smoothness` buys. See `motionTimings`. */
export interface MotionTimings {
  /** `springEase`'s `a`. */
  stiffness: number;
  zoomInMs: number;
  zoomOutMs: number;
  /** The follow spring's rate, per second: how tightly the camera trails
   *  the pointer while zoomed (`solveFollow`, spec 2026-10-22). */
  followRatePerS: number;
}

/**
 * Every camera duration, and the spring's stiffness, from the document's one
 * `motion.smoothness` (polish-parity plan §1). 0 is brisk, 1 is languid; the
 * default 0.5 gives stiffness 6.75, a 1300ms push-in, a 925ms pull-out and a
 * follow spring at 10/s, which trails the pointer by roughly 0.2s.
 *
 * The push-in is the longest move on purpose: it is the one the viewer is
 * asked to read, and it lands before the click (`leadInMs`), so a longer one
 * starts earlier rather than landing through the action. The pull-out is
 * shorter because nothing is being introduced by it. `stiffness` falls as
 * smoothness rises — a softer spring with a longer tail.
 *
 * Throws on a smoothness outside [0, 1] rather than clamping it: the schema
 * refuses one at the door, so one here is a caller that skipped the door,
 * and a clamp would answer it as if nothing were wrong.
 */
export function motionTimings(smoothness: number): MotionTimings {
  if (!(Number.isFinite(smoothness) && smoothness >= 0 && smoothness <= 1)) {
    throw new RangeError(
      `motion smoothness must be within 0..1, got ${smoothness}`,
    );
  }
  return {
    stiffness: lerp(8, 5.5, smoothness),
    zoomInMs: lerp(1000, 1600, smoothness),
    zoomOutMs: lerp(700, 1150, smoothness),
    followRatePerS: lerp(13, 7, smoothness),
  };
}

const DEFAULT_TIMINGS = motionTimings(MOTION_DEFAULTS.smoothness);

export const CAMERA_DEFAULTS = {
  /**
   * The level a newly added zoom starts at, for an editor to write into the
   * document. Nothing in the plan reads it: a zoom exists only if the scene
   * carries an event for it, and that event carries its own scale.
   */
  defaultZoomScale: 1.8,
  /**
   * Ceiling on camera scale in a `cover` (vertical) cut — a cap, not a floor.
   *
   * This was `verticalZoomScale: 2.4`, a *floor*, and it was compensating for
   * a crop that never happened: under the old letterbox a 9:16 cut drew the
   * capture at the same size as the landscape one, so it needed extra
   * magnification to be legible on a phone. `cover` makes the crop real and
   * the fit now supplies ~2.29x of that magnification by itself, so a floor
   * on top of it double-counts — 2.4 x 2.29 is a ~180 CSS px window, roughly
   * one button and nothing else.
   *
   * The cap replaces it because the compounding does not stop at the floor:
   * a default 1.8x zoom over a real crop is a 241 CSS px window
   * with the panel the click opened reduced to a featureless dark slab. Under
   * `cover` the tight axis shows *exactly* the full viewport at scale 1, so
   * every percent of camera scale cuts that axis by a percent — the vertical
   * camera can trim, but it cannot crop. 1.15 is what that trim is worth:
   * measured on the harvested fixture it keeps the click beat's payoff
   * readable (377 x 696 CSS px) where 1.25 loses the panel title and 1.4
   * loses the panel entirely, while still reading as a push-in rather than a
   * locked-off frame.
   */
  verticalMaxScale: 1.15,
  /**
   * CSS px of page kept round a zoomed target on every side, so its edges
   * and the cursor on it are not flush with the frame. The extension's
   * generated zooms fit against the capture viewport with it
   * (`zoomsForClicks`); a `cover` render fits against its own crop with it
   * (`solveCamera`'s `fitWindow`).
   */
  fitMarginPx: 24,
  /** Enter before the marker so the beat has landed by the time the action fires. */
  leadInMs: -350,
  /**
   * The settle after an act: how long the result of a step is shown before
   * the camera may set off toward a later zoom (spec 2026-10-19, "unhurried
   * beats"). Not `neutral.minPlateauMs`, which also sets pull-outs, the hold
   * before a push-in and the auto-zoom gap, and which old takes render by.
   */
  actSettleMs: 400,
  /**
   * The push-in and the pull-out at the DEFAULT smoothness — what the
   * extension sizes a fresh zoom's length by (`zoom-defaults.ts`) and the
   * editor draws an unauthored end with. A render reads the document's own
   * smoothness through `motionTimings`, so these are the timings of a take
   * that never touched the slider, not of every take.
   *
   * One `transitionMs: 500` served both directions until the spring curve
   * (2026-10-09): every reader of it now names the direction it means.
   */
  zoomInMs: DEFAULT_TIMINGS.zoomInMs,
  zoomOutMs: DEFAULT_TIMINGS.zoomOutMs,
  stiffness: DEFAULT_TIMINGS.stiffness,
  maxScale: 2.5,
  /**
   * Return-to-neutral. See `insertNeutralKeys` for how these were chosen.
   */
  neutral: {
    /** Shortest plateau — at the zoom, and at 1.0 — that reads as a hold. */
    minPlateauMs: 250,
    /**
     * How long the camera stays in after arriving, before it starts pulling
     * out. Arrival is `leadInMs` before the marker, so this has to cover the
     * approach *and* what the action did — a pull-out that begins at the
     * marker shows the reach and hides the result.
     *
     * Measured on the harvested fixture, rendered with the checkout zoom as
     * the take's last one so the full hold applies rather than being clipped
     * by the next beat: at 1200 the pull-out starts 850ms after the click,
     * and the frame at that moment still has the invoice panel the click
     * opened fully readable. The camera then reached full frame with about a
     * second of the take left — measured under the 500ms pull-out of the
     * time. The pull-out is `zoomOutMs` now (925ms at the default
     * smoothness) and still STARTS 850ms after the click, because the return
     * key is placed `zoomOutMs` past the hold; it lands ~0.4s later.
     */
    zoomHoldMs: 1200,
  },
} as const;

/**
 * Camera *intent* — which anchor, what scale, at which marker. Deliberately
 * not a solved curve: the curve needs on-screen rects, which only the frame
 * bundle carries. Transition lengths come from the document's one
 * `motion.smoothness` (`motionTimings`) while positions are authored per
 * zoom, which is why an authored zoom needs no duration field of its own.
 *
 * A zoom is authored or it does not exist. Auto-zoom-on-click used to fill
 * every click the author had not touched, and because it refilled anything
 * deleted, the editor could not offer a delete at all — "Hold at 1:1" wrote
 * `scale: 1` to shout the auto zoom down. That made the camera track a thing
 * you argued with rather than a thing you built: zooms you never asked for on
 * beats you never touched, and no way to see which were yours.
 */
/**
 * `cutSteps` are the steps the author cut. A zoom whose marker is one of
 * them is kept in the document and not drawn, and pushed onto `attached` so
 * the caller can say so (spec §1, "Edits attached to a cut step"). Dropped
 * BEFORE the `scale > 1` filter, so a zoom on a cut step is named once and
 * not twice — and matched on its own marker rather than on its `end`, which
 * the solver clamps on its own terms.
 */
export function planCameraIntents(
  scene: SceneDocument,
  cutSteps: ReadonlySet<string>,
  attached: AttachedEdit[],
): CameraIntent[] {
  const order = new Map(scene.actions.map((a, i) => [a.id, i]));
  const actionOf = new Map(scene.actions.map((a) => [a.id, a]));
  // A drag's zoom aims at the middle of its two ends (`zoomsForClicks`); a
  // narrower crop has to keep both of them, not just that middle.
  const fitOf = (event: SceneDocument["camera"][number]) => {
    const action = actionOf.get(event.marker.actionId);
    if (event.point === undefined || action?.kind !== "drag") return {};
    const ends = dragPoints(action, action.rect, action.toRect);
    if (ends === null) return {};
    const x = Math.min(ends.start.x, ends.end.x);
    const y = Math.min(ends.start.y, ends.end.y);
    return {
      fit: {
        x,
        y,
        width: Math.max(ends.start.x, ends.end.x) - x,
        height: Math.max(ends.start.y, ends.end.y) - y,
      },
    };
  };
  return (
    scene.camera
      .flatMap((event) => {
        if (cutSteps.has(event.marker.actionId)) {
          attached.push({
            id: event.id,
            kind: "zoom",
            actionId: event.marker.actionId,
          });
          return [];
        }
        return [event];
      })
      .map((event) => ({
        id: event.id,
        kind: event.kind,
        anchorId: event.anchorId ?? null,
        point: event.point ?? null,
        actionId: event.marker.actionId,
        offsetMs: event.marker.offsetMs,
        scale: clamp(event.scale ?? 1, 1, CAMERA_DEFAULTS.maxScale),
        end: event.end ?? null,
        ...fitOf(event),
      }))
      // Every scene edited before auto-zoom was removed carries `scale: 1`
      // events from that "Hold at 1:1" button, and the schema's `scale` is
      // optional besides. Both say "no zoom here". Honouring one literally
      // would spend two transitions arriving at 1.0 and leaving it again — a
      // camera move with nothing to show.
      .filter((intent) => intent.scale > 1)
      .sort((a, b) => {
        const byAction =
          (order.get(a.actionId) ?? 0) - (order.get(b.actionId) ?? 0);
        return byAction !== 0 ? byAction : a.offsetMs - b.offsetMs;
      })
  );
}

export interface CameraKey {
  /** When the camera ARRIVES here — the move ends at this instant. */
  outputTimeMs: number;
  center: Vec;
  scale: number;
  /**
   * Length of the move that arrives at this key: it departs the previous
   * key `transitionMs` before `outputTimeMs` (or at the previous key, if
   * that is nearer). On the key rather than a constant because the two
   * directions differ — a push-in carries `zoomInMs`, the return to full
   * frame `zoomOutMs` — and a pan inside a run is shortened for the act
   * before it. The centre while zoomed is not the keys' at all: it trails
   * the pointer (`ResolvedPlan.cameraFollow`, read through `sampleTrack`).
   * The opening key at 0 carries 0: nothing arrives at it.
   */
  transitionMs: number;
  /** `springEase`'s `a` for that arriving move. */
  stiffness: number;
}

/** One zoom's span on the output axis, for the editor's Zoom lane. */
export interface CameraSegment {
  id: string;
  /** When the move that arrives at `startMs` sets off — the first instant
   *  the preview moves for this zoom. The Zoom lane draws from here: drawn
   *  from the arrival, a block began where the zoom had already landed. */
  departMs: number;
  /** The push-in's arrival: marker + offset, floored at 0 like the key. */
  startMs: number;
  /** The pull-out's arrival — where the video is back at full frame. */
  endMs: number;
  endAuthored: boolean;
  /** An authored end the plateau rules could not honour. Reported upstream
   *  as a `ClampedRange` of kind `zoom`. */
  endClamped: boolean;
  /** The author named an end whose step the bundle carries no marker for.
   *  The segment falls back to the compositor's own return timing, and
   *  `endAuthored` stays true so the editor reports the end as
   *  authored-but-estimated rather than as automatic — the segment carries
   *  the estimated hatching, and the inspector withholds "end automatic".
   *  (It stopped being a cap shape when the caps were squared.) */
  endUnplaced: boolean;
  /** The scale the zoom asked for and the one it got, when a `cover`
   *  target lowered it — the vertical cap (`verticalCameraIntents`), the
   *  crop fit (`fitScaleFor`), or both; null when it kept its own. `from`
   *  is the author's scale (`CameraIntent.requestedScale` when the cap
   *  lowered it), and `cap` the cap's ceiling when the cap is what lowered
   *  it, else null. Reported upstream as a `ClampedRange` of kind
   *  `zoomFit` when the fit narrowed it (a zoom the fit took all the way to
   *  1 is a pan, while the lane still reads its own scale, 2026-10-09
   *  review); when the cap alone did, only in `ResolvedPlan.loweredZooms`. */
  fitted: ZoomLowered | null;
}

/** See `CameraSegment.fitted`. */
export interface ZoomLowered {
  from: number;
  to: number;
  cap: number | null;
}

interface Seed extends CameraKey {
  id: string;
  /** A zoom's push-in, as opposed to the opening full-frame key. A zoom a
   *  `cover` fit narrowed all the way to 1 is still a zoom: it pans the crop
   *  to its target and returns, so it keeps its pull-out and its segment. */
  zoom: boolean;
  authoredEndMs: number | null;
  /** `intent.end` was set but `markerOutputMs` could not place it. Distinct
   *  from `authoredEndMs === null` meaning "no end was authored at all" —
   *  see `CameraSegment.endUnplaced`. */
  endUnplaced: boolean;
  /** See `CameraSegment.fitted`. */
  fitted: ZoomLowered | null;
  /**
   * The output instant the zoom's action fires: its marker, BEFORE the
   * intent's `offsetMs` moved the arrival off it and before the arrival was
   * floored at 0. Read by `insertNeutralKeys` when it pans straight to the
   * next zoom, so the pan leaves only after this beat's action has landed.
   * Carried rather than recomputed as `outputTimeMs - offsetMs`: the floor
   * at 0 breaks that subtraction, and nothing promises the offset is
   * `leadInMs`. 0 on the opening key, which is not a zoom and is never read.
   */
  actionMs: number;
  /**
   * The move's length before any earlier act shortened it (`actEnds` in
   * `solveCamera`). Where the previous zoom must be back at full frame is
   * measured from this, so holding a push-in back for an act never moves
   * the pull-out before it (code review 2026-10-20, R2).
   */
  plannedTransitionMs: number;
}

/**
 * Turns camera intent into a curve over *output* time, plus one
 * `CameraSegment` per zoom for the editor's Zoom lane.
 *
 * Transitions come from `motion` (the document's block, or
 * `MOTION_DEFAULTS`), positions are authored — which is why an authored zoom
 * needs no duration field, and why "return to 1:1" is simply another intent
 * with scale 1. Every key is stamped with the length and stiffness of the
 * move that arrives at it: `zoomInMs` for a push-in, `zoomOutMs` for the
 * return, and for the straight pan to the next zoom when there is no room to
 * return between them, `zoomInMs` shortened so it leaves after the departing
 * beat's action (`insertNeutralKeys`).
 */
export function solveCamera(
  intents: CameraIntent[],
  rectOf: (anchorId: string, actionId: string) => Rect | null,
  timeline: Timeline,
  markerSourceMs: Map<string, number>,
  viewport: { width: number; height: number },
  /**
   * The CSS window the frame shows at scale 1, when that is narrower than
   * the viewport: a `cover` target's crop (`composeForTarget`). Each zoom is
   * then narrowed until its target and `fitMarginPx` fit that window
   * (`fitScaleFor`), never below 1. Absent, scales are the intents' own.
   */
  fitWindow: { width: number; height: number } | null = null,
  /** The document's motion settings; see `motionTimings`. */
  motion: SceneMotion = MOTION_DEFAULTS,
  /**
   * Each step's act end, in source ms, by actionId (the bundle markers'
   * `actEndSourceTimeMs`). A zoom's move, push-in or pan, sets off no
   * earlier than the latest act end before its own marker plus
   * `actSettleMs`; it keeps its arrival and is shortened, never below
   * `MIN_PAN_MS`. Pull-outs are not touched: full frame keeps every action
   * in view. Empty: today's behaviour.
   */
  actEnds: ReadonlyMap<string, number> = new Map(),
  /**
   * Each drag's held button, in output ms (`ResolvedPlan.holdOutputMs`). A
   * zoom with a drag pressed in it does not go back out until that drag is
   * released: its return counts from the release, as a click's counts from
   * its arrival (Excalidraw, 2026-10-21, where the camera pulled back while
   * a rectangle was still being drawn). Empty: today's behaviour.
   */
  holds: readonly { startMs: number; endMs: number }[] = [],
): { keys: CameraKey[]; segments: CameraSegment[] } {
  const timings = motionTimings(motion.smoothness);
  const neutral: Vec = { x: viewport.width / 2, y: viewport.height / 2 };
  const seeds: Seed[] = [];
  /** Each seed's latest earlier act end, in output ms; settled below. */
  const actEndOf = new Map<Seed, number>();

  for (const intent of intents) {
    // A point is its own zero-size rect: `rectCenter` returns it and
    // `frameCamera` keeps the view inside the canvas, so a point near an
    // edge frames as far toward it as the composition allows.
    const rect = intent.point
      ? { x: intent.point.x, y: intent.point.y, width: 0, height: 0 }
      : intent.anchorId
        ? rectOf(intent.anchorId, intent.actionId)
        : null;
    if (!rect) continue;
    const sourceMs = markerSourceMs.get(intent.actionId);
    if (sourceMs === undefined) continue;

    const actionMs = toOutputMs(timeline, sourceMs);
    const outputMs = Math.max(0, actionMs + intent.offsetMs);
    // Three cases, not two: no end authored at all (null, not unplaced); an
    // end authored and resolved (the instant); an end authored but naming a
    // step the bundle has no marker for (null, AND unplaced — see
    // `CameraSegment.endUnplaced`). Collapsing the last two into one null
    // would drop the author's own end silently instead of reporting it.
    const resolvedEndMs = intent.end
      ? markerOutputMs(intent.end, timeline, markerSourceMs)
      : null;
    const asked = clamp(intent.scale, 1, CAMERA_DEFAULTS.maxScale);
    // What the author asked for, before a target's cap made it `asked`.
    // Never below `asked`: a cap only ever lowers.
    const requested = Math.max(
      asked,
      clamp(intent.requestedScale ?? intent.scale, 1, CAMERA_DEFAULTS.maxScale),
    );
    const scale =
      fitWindow === null
        ? asked
        : clamp(fitScaleFor(intent.fit ?? rect, fitWindow), 1, asked);
    let actEndMs = Number.NEGATIVE_INFINITY;
    for (const [actionId, endMs] of actEnds) {
      const at = markerSourceMs.get(actionId);
      if (at === undefined || at >= sourceMs) continue;
      actEndMs = Math.max(actEndMs, toOutputMs(timeline, endMs));
    }
    const seed: Seed = {
      id: intent.id,
      outputTimeMs: outputMs,
      center: rectCenter(rect),
      scale,
      // Shortened below for an earlier act, once every seed is known.
      transitionMs: timings.zoomInMs,
      stiffness: timings.stiffness,
      zoom: true,
      authoredEndMs: resolvedEndMs,
      endUnplaced: intent.end !== null && resolvedEndMs === null,
      fitted:
        scale < requested
          ? {
              from: requested,
              to: scale,
              cap: asked < requested ? asked : null,
            }
          : null,
      actionMs,
      plannedTransitionMs: timings.zoomInMs,
    };
    seeds.push(seed);
    actEndOf.set(seed, actEndMs);
  }

  // The move sets off once every earlier act has ended and settled. A pan
  // inside a run (the zoom before it holds until the camera pans straight
  // on) waits for the act alone: the author traded the settle for flow there
  // (spec 2026-10-22, pacing "C"), and the walk adds no room to pay for it.
  // Pan or return is `insertNeutralKeys`' own decision, holds included, so
  // it is asked here of the same seeds with the same `heldUntilOf`.
  seeds.sort((a, b) => a.outputTimeMs - b.outputTimeMs);
  for (const [i, seed] of seeds.entries()) {
    const before = seeds[i - 1];
    const pans =
      before !== undefined &&
      !returnsBetween(
        heldUntilOf(before, seed.actionMs, holds),
        seed.outputTimeMs,
        timings,
      );
    const notBeforeMs =
      (actEndOf.get(seed) ?? Number.NEGATIVE_INFINITY) +
      (pans ? 0 : CAMERA_DEFAULTS.actSettleMs);
    if (seed.outputTimeMs - timings.zoomInMs < notBeforeMs) {
      seed.transitionMs = Math.max(
        MIN_PAN_MS,
        Math.min(timings.zoomInMs, seed.outputTimeMs - notBeforeMs),
      );
    }
  }

  return insertNeutralKeys(
    [
      {
        id: "",
        outputTimeMs: 0,
        center: neutral,
        scale: 1,
        // Always `keys[0]`, so never a move's destination: the sort is
        // stable and it goes in first. 0 says nothing arrives at it.
        transitionMs: 0,
        stiffness: timings.stiffness,
        zoom: false,
        authoredEndMs: null,
        endUnplaced: false,
        fitted: null,
        actionMs: 0,
        plannedTransitionMs: 0,
      },
      ...seeds,
    ].sort((a, b) => a.outputTimeMs - b.outputTimeMs),
    timeline.outputDurationMs,
    timings,
    holds,
  );
}

/**
 * The largest scale at which `rect` and `fitMarginPx` round it fit inside a
 * frame that shows `window` CSS px at scale 1, rounded down to the hundredth
 * so the fit is never lost to the rounding. A point (a zero-size rect) fits
 * at any scale a margin allows.
 *
 * Why a `cover` render asks this of its own crop (2026-10-09): the zooms an
 * agent's take carries were fitted against the capture viewport when the
 * take was made, and a 9:16 export shows far less than that. A 1280x800
 * capture shows 450 CSS px across at 1x in 9:16, and 391 at the 1.15x cap,
 * so a 440 px row the landscape fit kept whole was cut at both ends.
 */
export function fitScaleFor(
  rect: { width: number; height: number },
  window: { width: number; height: number },
): number {
  const margin = 2 * CAMERA_DEFAULTS.fitMarginPx;
  const fit = Math.min(
    window.width / (rect.width + margin),
    window.height / (rect.height + margin),
  );
  return Math.floor(fit * 100) / 100;
}

/** The keys alone. Every caller that wants the segments too uses `solveCamera`. */
export function solveCameraKeys(
  intents: CameraIntent[],
  rectOf: (anchorId: string, actionId: string) => Rect | null,
  timeline: Timeline,
  markerSourceMs: Map<string, number>,
  viewport: { width: number; height: number },
): CameraKey[] {
  return solveCamera(intents, rectOf, timeline, markerSourceMs, viewport).keys;
}

/**
 * Every zoom pulls back out. Full frame is the resting state.
 *
 * It was not: `solveCameraKeys` emitted one key per zoom and `sampleCamera`
 * holds the last key forever, so a zoom was a camera *position* the take
 * never left. The return existed but was gated — the next beat had to be
 * 2.6s away or 40% of the viewport diagonal across the page — and the final
 * beat had no next beat at all, so every video ended zoomed on whatever was
 * clicked last and every scroll between two close beats was watched through
 * a 711-CSS-px window.
 *
 * The gates are gone. What is left is the one thing that cannot be waved
 * away, and it is a matter of room rather than taste:
 *
 * - `sampleCamera` anchors every move to its *destination*, so a key at N
 *   means "arrive at N, having started the key's own `transitionMs`
 *   earlier". A pull-out at N therefore holds the zoom until `N - zoomOutMs`
 *   and holds 1.0 from N until `next - next.transitionMs` (the next push-in's
 *   `zoomInMs`).
 * - The two transitions cost `zoomOutMs + zoomInMs` of the gap outright, and
 *   each end needs `minPlateauMs` left over to read as a hold rather than a
 *   wobble. A gap that cannot pay for all four leaves the camera in, and it
 *   pans from one beat to the next — the one case where the video stays
 *   zoomed, and it is physics, not policy. That pan arrives at a zoom, so it
 *   is the next push-in's key, and it moves over `zoomInMs` or less: it
 *   is shortened until it departs `minPlateauMs` after this beat's action,
 *   so the camera is settled on every click it pans between.
 * - Otherwise the pull-out lands `zoomHoldMs + zoomOutMs` after the push-in
 *   arrived — it STARTS `zoomHoldMs` after — or as late as the next beat's
 *   own plateau allows, whichever is sooner.
 *
 * The closing pull-out has no next beat to make room for, so it is bounded by
 * the video instead: it arrives at `zoomHoldMs` past the beat or at the last
 * frame, whichever comes first. A take that ends immediately after its last
 * click gets a pull-out compressed into whatever footage is left rather than
 * no pull-out at all.
 *
 * The neutral key's centre is the midpoint of the two beats it sits between,
 * and the departing beat's own centre when it closes the video. Under
 * `contain` this is inert — `clampCameraCenter` pins a scale-1 window to the
 * viewport centre, because at 1:1 there is nothing off-frame to pan to. Under
 * `cover` it is the difference between one long pan glued to the push-in and
 * two shorter ones with a hold between them.
 *
 * An AUTHORED end (spec 2026-09-13 §2) replaces `idealMs` — the instant the
 * camera is back at 1.0 — and is still bounded by the same room: no earlier
 * than `earliestMs`, no later than the next beat's `latestMs`. When the bound
 * fires on an authored end the segment says `endClamped`, and `resolvePlan`
 * reports it as a `ClampedRange`; the editor hatches that end rather than
 * drawing the end the author asked for and did not get.
 */
/**
 * The shortest straight pan between two zooms that are too close to return
 * between (`insertNeutralKeys`). Under this the move reads as a jump cut
 * rather than a glide; 150ms is about five frames at 30fps.
 */
export const MIN_PAN_MS = 150;

/**
 * Where a zoom is held until: its arrival, or the release of the latest
 * drag pressed while it is in — after its own action, before it would start
 * back out, before the next zoom's action. The return counts from here, not
 * from the arrival. A drag pressed after the zoom would have gone out holds
 * nothing (final review, finding 1: one 20 s later kept the camera in on a
 * button).
 */
function heldUntilOf(
  seed: Seed,
  nextActionMs: number,
  holds: readonly { startMs: number; endMs: number }[],
): number {
  const outBy = Math.min(
    seed.outputTimeMs + CAMERA_DEFAULTS.neutral.zoomHoldMs,
    nextActionMs,
  );
  return Math.max(
    seed.outputTimeMs,
    ...holds
      .filter((h) => h.startMs >= seed.actionMs && h.startMs < outBy)
      .map((h) => h.endMs),
  );
}

/**
 * Whether the camera returns to full frame between a zoom held until
 * `heldUntilMs` and the next arriving at `nextArrivalMs`: the gap has to pay
 * for the pull-out and the push-in outright, and leave `minPlateauMs` at
 * each end (`insertNeutralKeys`). Otherwise it pans straight on. Exported
 * because the replay asks it too (spec 2026-10-22): a click the camera pans
 * to gets no added room, so the walk and the camera must answer alike.
 */
export function returnsBetween(
  heldUntilMs: number,
  nextArrivalMs: number,
  timings: Pick<MotionTimings, "zoomInMs" | "zoomOutMs">,
): boolean {
  const { minPlateauMs } = CAMERA_DEFAULTS.neutral;
  return (
    nextArrivalMs - timings.zoomInMs - minPlateauMs >=
    heldUntilMs + minPlateauMs + timings.zoomOutMs
  );
}

function insertNeutralKeys(
  seeds: Seed[],
  outputDurationMs: number,
  timings: MotionTimings,
  holds: readonly { startMs: number; endMs: number }[] = [],
): { keys: CameraKey[]; segments: CameraSegment[] } {
  const { neutral } = CAMERA_DEFAULTS;
  const { zoomOutMs } = timings;
  const keys: CameraKey[] = [];
  const segments: CameraSegment[] = [];
  const strip = ({
    outputTimeMs,
    center,
    scale,
    transitionMs,
    stiffness,
  }: Seed): CameraKey => ({
    outputTimeMs,
    center,
    scale,
    transitionMs,
    stiffness,
  });
  /** The return to full frame: a pull-out, over `zoomOutMs`. */
  const pullOut = (outputTimeMs: number, center: Vec): CameraKey => ({
    outputTimeMs,
    center,
    scale: 1,
    transitionMs: zoomOutMs,
    stiffness: timings.stiffness,
  });

  for (const [i, seed] of seeds.entries()) {
    // `sampleCamera`'s departure: `transitionMs` before the arrival, or the
    // previous key if that is nearer. Read before this seed's key goes in.
    const previousMs = keys[keys.length - 1]?.outputTimeMs ?? seed.outputTimeMs;
    const departMs = Math.max(
      previousMs,
      seed.outputTimeMs - seed.transitionMs,
    );
    keys.push(strip(seed));
    if (!seed.zoom) continue;

    const next = seeds[i + 1];
    const heldUntil = heldUntilOf(
      seed,
      next?.actionMs ?? Number.POSITIVE_INFINITY,
      holds,
    );
    const earliestMs = heldUntil + neutral.minPlateauMs + zoomOutMs;
    const idealMs = heldUntil + neutral.zoomHoldMs + zoomOutMs;
    const wantedMs = seed.authoredEndMs ?? idealMs;
    // A resolved authored end can be clamped; an authored-but-unplaced one
    // falls back to `idealMs` and was never clamped — nothing was asked for
    // that the plateau rules had to refuse. `endAuthored` covers both: the
    // author DID author an end either way.
    const resolvedAuthored = seed.authoredEndMs !== null;
    const authored = resolvedAuthored || seed.endUnplaced;
    // Whether the end the segment actually got differs from the one the
    // author asked for. `resolvedAuthored` alone is NOT that question — it
    // says an end was authored and placed, not that the plateau rules had to
    // move it — and two of the four branches below used it directly, so
    // `resolvePlan` emitted "was asked to end at an instant the camera cannot
    // reach … so it returns at Nms instead" for zooms whose end was honoured
    // exactly. One helper so all four branches answer it the same way.
    const movedFromWanted = (endMs: number): boolean =>
      resolvedAuthored && Math.abs(endMs - wantedMs) > 1e-6;

    if (!next) {
      // Already clamped to `outputDurationMs` by the `Math.min` below the
      // `Math.max` — a second `Math.min(atMs, outputDurationMs)` used to
      // shadow this as `atLeast`, and it could never differ from `atMs`.
      const atMs = Math.min(Math.max(wantedMs, earliestMs), outputDurationMs);
      if (atMs <= seed.outputTimeMs) {
        segments.push({
          id: seed.id,
          departMs,
          startMs: seed.outputTimeMs,
          endMs: outputDurationMs,
          endAuthored: authored,
          endClamped: movedFromWanted(outputDurationMs),
          endUnplaced: seed.endUnplaced,
          fitted: seed.fitted,
        });
        continue;
      }
      keys.push(pullOut(atMs, seed.center));
      segments.push({
        id: seed.id,
        departMs,
        startMs: seed.outputTimeMs,
        endMs: atMs,
        endAuthored: authored,
        endClamped: movedFromWanted(atMs),
        endUnplaced: seed.endUnplaced,
        fitted: seed.fitted,
      });
      continue;
    }

    // `next.transitionMs` is the next push-in's own length: every seed after
    // the opening key is a zoom, stamped `zoomInMs` by `solveCamera`.
    const latestMs =
      next.outputTimeMs - next.plannedTransitionMs - neutral.minPlateauMs;
    if (
      !returnsBetween(heldUntil, next.outputTimeMs, {
        zoomInMs: next.plannedTransitionMs,
        zoomOutMs,
      })
    ) {
      // No room to return: the camera pans straight to the next beat. That
      // pan is the next key's move, and it used to keep the push-in's
      // `zoomInMs` — 1300ms at the default smoothness — so on two clicks a
      // second apart (arrivals 1650 and 2650) it departed at 1650, the
      // instant this zoom arrived, and at this beat's own click (2000) the
      // camera was already 69% of the way to the next one, with the clicked
      // point off-screen. Ruling 3 of the polish-parity plan is that the
      // camera is SETTLED before every click, and a pan through the click
      // is the opposite.
      //
      // So the pan is shortened until it departs a plateau after this beat
      // has both arrived and acted: `settledMs` is the later of the two
      // (an offset after the marker puts the arrival last). Never longer
      // than `zoomInMs` — the shortening only ever removes travel time — and
      // never shorter than `MIN_PAN_MS`, below which the move is a cut.
      // When the beats are so close that even `MIN_PAN_MS` departs before
      // `settledMs`, the floor wins: the pan is as late as it can be while
      // still being a move, and it crosses the tail of this beat's plateau.
      // There is no later instant to give it — the next beat's arrival is
      // fixed by its own click.
      const settledMs =
        Math.max(seed.outputTimeMs, seed.actionMs, heldUntil) +
        neutral.minPlateauMs;
      seeds[i + 1] = {
        ...next,
        transitionMs: Math.max(
          MIN_PAN_MS,
          Math.min(next.transitionMs, next.outputTimeMs - settledMs),
        ),
      };
      segments.push({
        id: seed.id,
        departMs,
        startMs: seed.outputTimeMs,
        endMs: next.outputTimeMs,
        endAuthored: authored,
        endClamped: movedFromWanted(next.outputTimeMs),
        endUnplaced: seed.endUnplaced,
        fitted: seed.fitted,
      });
      continue;
    }
    const atMs = Math.min(Math.max(wantedMs, earliestMs), latestMs);
    keys.push(pullOut(atMs, lerpVec(seed.center, next.center, 0.5)));
    segments.push({
      id: seed.id,
      departMs,
      startMs: seed.outputTimeMs,
      endMs: atMs,
      endAuthored: authored,
      endClamped: movedFromWanted(atMs),
      endUnplaced: seed.endUnplaced,
      fitted: seed.fitted,
    });
  }

  return { keys, segments };
}

/**
 * Keep the camera's visible window inside the captured viewport.
 *
 * Since 2026-10-05 `renderFrame` calls this only at scale 1, through
 * `frameCamera`, to place the app inside its window (the `cover` follow
 * crop); the zoom itself is clamped against the canvas there. The rule
 * below is unchanged and still holds for any `k` it is given.
 *
 * `renderFrame` draws the source image so that one CSS pixel becomes `k`
 * output pixels, then translates it so `center` lands at the frame's middle.
 * The window the viewer actually sees is therefore `frameRect / k` CSS pixels,
 * and its centre has to stay a half-window from each viewport edge — anything
 * further leaves part of the frame uncovered, and an uncovered frame renders
 * as the black fill `drawFrameChrome` laid down for its shadow passes. A
 * deliverable with a black wedge in it is not a deliverable.
 *
 * Per axis, and from the real `k` rather than from the camera scale alone,
 * because the two fit modes give the axes different amounts of room:
 *
 * - Under `contain` at scale 1 the window is exactly the viewport on both
 *   axes, so both collapse to a single legal point. Correct: at 1:1 there is
 *   nothing off-frame to pan to.
 * - Under `cover` the frame is filled on its tight axis and overflows on the
 *   other, so even at scale 1 the overflowing axis has real room to move.
 *   That room *is* the follow crop — a vertical cut has to be free to slide
 *   its 9:16 window across a 16:10 page — so it must not be clamped away.
 *
 * A window wider than the viewport is capped at the viewport, which pins that
 * axis instead of inverting the bounds. `clamp` is `min(hi, max(lo, v))`, so
 * an inverted range would silently answer `hi` and shove the camera into a
 * corner rather than centring it.
 */
export function clampCameraCenter(
  center: Vec,
  /** Output pixels per CSS pixel, camera scale already folded in. */
  k: number,
  frameRect: { width: number; height: number },
  viewport: { width: number; height: number },
): Vec {
  const scale = k > 0 ? k : 1;
  const halfWidth = Math.min(frameRect.width / scale, viewport.width) / 2;
  const halfHeight = Math.min(frameRect.height / scale, viewport.height) / 2;
  return {
    x: clamp(center.x, halfWidth, viewport.width - halfWidth),
    y: clamp(center.y, halfHeight, viewport.height - halfHeight),
  };
}

/**
 * The camera `renderFrame` draws with: one zoom over the whole composition.
 *
 * The camera used to zoom the app *inside* its window while the window, its
 * shadow and the background stayed put. It now zooms the whole picture —
 * background, rounded window and app as one thing, the window glued to the
 * background — so the cursor, the logo and the margin all ride the zoom with
 * the page.
 *
 * Two moves, kept apart because they are clamped against different things:
 *
 * - `pan` is the app's position inside its window at scale 1 — the CSS point
 *   drawn at the window's centre. Under `contain` it is pinned to the
 *   viewport's middle; under `cover` it is the follow crop, which slides on
 *   the overflowing axis. `clampCameraCenter` rules it, at scale 1, exactly
 *   as before, so the window is never left with page missing from it.
 * - `focus` is the point of the unzoomed composition, in output pixels, that
 *   the zoom puts at the output's centre. It is kept a half-window inside
 *   the CANVAS: near an edge the camera goes as far as the composition
 *   reaches, and the margin between the window and the canvas edge is in
 *   shot. Nothing outside the canvas ever is.
 *
 * `center` is the CSS point that lands at the output's centre once both are
 * applied — the value `cssToOutput` and its inverse read, so every overlay
 * stays on the pixels underneath it without knowing about either move.
 * Off the page it may lie beyond the viewport: a CSS coordinate extends
 * linearly into the margin, which is where the camera is looking.
 */
export function frameCamera(
  sampled: { center: Vec; scale: number },
  /** Output pixels per CSS pixel at camera scale 1 — `contentScale(...)`. */
  base: number,
  frameRect: Rect,
  viewport: { width: number; height: number },
  canvas: { width: number; height: number },
): { center: Vec; scale: number; pan: Vec; focus: Vec } {
  const { scale } = sampled;
  const pan = clampCameraCenter(sampled.center, base, frameRect, viewport);
  const frameCentre = rectCenter(frameRect);
  const wanted = {
    x: frameCentre.x + (sampled.center.x - pan.x) * base,
    y: frameCentre.y + (sampled.center.y - pan.y) * base,
  };
  // Capped at the canvas, as `clampCameraCenter` caps at the viewport, so a
  // window larger than the canvas pins rather than inverting the bounds.
  const zoom = scale > 0 ? scale : 1;
  const halfWidth = Math.min(canvas.width / zoom, canvas.width) / 2;
  const halfHeight = Math.min(canvas.height / zoom, canvas.height) / 2;
  const focus = {
    x: clamp(wanted.x, halfWidth, canvas.width - halfWidth),
    y: clamp(wanted.y, halfHeight, canvas.height - halfHeight),
  };
  return {
    center: {
      x: pan.x + (focus.x - frameCentre.x) / base,
      y: pan.y + (focus.y - frameCentre.y) / base,
    },
    scale,
    pan,
    focus,
  };
}

/**
 * The camera `t` of the way from one key to the next, as one zoom about one
 * fixed point rather than a centre and a scale blended apart.
 *
 * Scale goes in log space: every step magnifies by the same ratio, so the
 * eye reads the easing curve as the speed of the zoom. Blended linearly, a
 * push-in from 1 to 2 magnifies 1.5x in its first half and 1.33x in its
 * second — it rushes away and then drags into the frame it is arriving at,
 * whatever the easing says.
 *
 * The centre follows the scale so that one CSS point stays at one place in
 * the output throughout: the pivot that takes the first frame onto the
 * second. Every other point then moves on a straight line toward or away
 * from it. Blending the centre on its own clock instead swings the page
 * through a curve — measured, 5px off the straight line for a point 300px
 * from the target on an ordinary push-in. At a constant scale there is no
 * pivot and this is the plain pan it was.
 */
function zoomBetween(
  from: CameraKey,
  to: CameraKey,
  t: number,
): { center: Vec; scale: number } {
  const scale = from.scale * (to.scale / from.scale) ** t;
  const span = 1 / from.scale - 1 / to.scale;
  // How far along the centre is: the share of the change in window size
  // already made, which is what holds the pivot still. Near-equal scales
  // have no pivot worth the name (it runs off to infinity), so they pan.
  const w = Math.abs(span) < 1e-9 ? t : (1 / from.scale - 1 / scale) / span;
  return { center: lerpVec(from.center, to.center, w), scale };
}

/**
 * Camera state at an output time. Eased between keys — never a cut.
 *
 * This has no notion of a timeline hold: `outputTimeMs` is the only input,
 * and a hold is just a stretch of output time where `toSourceMs` happens to
 * return a frozen source instant. The camera keeps easing across it exactly
 * as it would across any other output span. Intentional — a hold pauses the
 * picture to let the viewer read it, and freezing the camera too would fight
 * that by locking the frame mid-move instead of letting it settle.
 */
export function sampleCamera(
  keys: CameraKey[],
  outputTimeMs: number,
): { center: Vec; scale: number } {
  const first = keys[0];
  if (!first) return { center: { x: 0, y: 0 }, scale: 1 };
  if (outputTimeMs <= first.outputTimeMs) {
    return { center: first.center, scale: first.scale };
  }
  const last = keys[keys.length - 1];
  if (!last) return { center: { x: 0, y: 0 }, scale: 1 };
  if (outputTimeMs >= last.outputTimeMs) {
    return { center: last.center, scale: last.scale };
  }

  for (let i = 1; i < keys.length; i++) {
    const to = keys[i];
    const from = keys[i - 1];
    if (!to || !from) continue;
    if (outputTimeMs > to.outputTimeMs) continue;
    const span = to.outputTimeMs - from.outputTimeMs;
    // Anchor the transition to its DESTINATION: hold `from` until the
    // arriving key's own `transitionMs` before it, then ease so the move
    // completes exactly AT `to.outputTimeMs`. Anchoring to the departing key instead — which
    // is what this did — meant every move finished transitionMs after the
    // PREVIOUS key regardless of where the destination sat, so a lone
    // auto-zoom fired at the top of the video and then parked. That made
    // CAMERA_DEFAULTS.leadInMs completely inert: the whole point of a
    // lead-in is that the beat has landed by the time the action fires, and
    // it can only mean anything if the key marks an arrival.
    //
    // The length and the curve are the arriving key's (`CameraKey`): a
    // push-in and a pull-out differ, and a pan inside a run may be shorter.
    // (Keys alone: while zoomed the drawn centre trails the pointer instead,
    // `sampleTrack`.) The curve is `springEase` — off the mark at rest, most of the way
    // early, a long soft landing at rest — still applied through
    // `zoomBetween`, so the zoom stays one move about one fixed point.
    const windowMs = Math.min(to.transitionMs, span);
    const raw =
      windowMs <= 0
        ? 1
        : (outputTimeMs - (to.outputTimeMs - windowMs)) / windowMs;
    return zoomBetween(from, to, springEase(clamp(raw, 0, 1), to.stiffness));
  }
  return { center: last.center, scale: last.scale };
}
