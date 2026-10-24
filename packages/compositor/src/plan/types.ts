import type { SourcePoint } from "@demoman/scene-schema";
import type { EasingName } from "../easing.js";
import type { Rect, Vec } from "../geometry.js";

/**
 * One cursor transition, expressed as geometry rather than timings.
 *
 * This is the half of the plan SP5 consumes: it dispatches
 * Input.dispatchMouseEvent along `via` with `easing` over `durationMs`, then
 * records what it actually sent into bundle.cursorSamples. The compositor
 * draws from those recorded samples, so the drawn cursor is literally the
 * input that drove the app — identical by construction, and robust to a
 * replay stall, which moves pixels and cursor together.
 */
export interface CursorSegment {
  fromActionId: string | null;
  toActionId: string;
  from: Vec;
  to: Vec;
  /** Spline control points, `from` first and `to` last. */
  via: Vec[];
  durationMs: number;
  easing: EasingName;
  /** Settle time at arrival before the action fires. */
  dwellMs: number;
}

/** The document's marker, flattened the way `PlannedHold` is. Output ms
 *  relative to the step's instant on the untrimmed output axis. */
export interface PlannedMarker {
  actionId: string;
  offsetMs: number;
}

/** A cut on the output axis. `null` on a side means "no cut there". */
export interface PlannedTrim {
  head: PlannedMarker | null;
  tail: PlannedMarker | null;
}

/**
 * A piece the author removed (`edits.removed`), on the frameless stage.
 *
 * Its points are step-relative in SOURCE time, so resolving them needs
 * `bundle.markers` — which is why that happens in `buildTimeline` and not
 * here, the same split `PlannedHold` states. A null side is that end of the
 * take.
 */
export interface PlannedRemoval {
  id: string;
  start: SourcePoint | null;
  end: SourcePoint | null;
}

/**
 * An edit whose marker is a cut step.
 *
 * Kept in the document and not drawn (spec §1, "Edits attached to a cut
 * step"): undoing the cut restores it. Carried out of the plan rather than
 * dropped in silence, because a zoom that stops happening with nothing said
 * is the silent `prune` the 2026-09-13 pixel-first spec called out.
 *
 * A mask is never here: it covers whatever of its frames survive a cut.
 */
export interface AttachedEdit {
  id: string;
  kind: "zoom" | "hold";
  actionId: string;
}

/**
 * No `origin`: every intent comes from an authored camera event now, and a
 * field with one possible value is a distinction the editor would keep
 * drawing for the reader long after it stopped meaning anything.
 */
export interface CameraIntent {
  id: string;
  kind: "zoom" | "pan";
  /** The element to frame, or null for a point target. Exactly one of these two is non-null. */
  anchorId: string | null;
  /** Capture-space CSS px — the recorded cursor position where the author clicked the Zoom lane. */
  point: Vec | null;
  actionId: string;
  offsetMs: number;
  scale: number;
  /**
   * The scale the author asked for, when a target's cap lowered `scale`
   * below it (`verticalCameraIntents`). Absent: `scale` is the author's own.
   * Carried so `solveCamera` can report the zoom against what was asked
   * rather than against the cap — a 1.8x zoom narrowed to 1.05x read "asked
   * for 1.15x" until 2026-10-14, and the cap from 1.8 to 1.15 by itself was
   * never said at all.
   */
  requestedScale?: number;
  /** What a narrower crop's fit must keep whole, when that is more than the
   *  point aimed at: a drag's two ends round its `point`. */
  fit?: Rect;
  /** Where the camera is back at full frame. Null: the compositor's own return timing. */
  end: PlannedMarker | null;
}

/** A mask: an opaque fill over `rect`, the one cosmetic the editor keeps. */
export interface CosmeticBinding {
  id: string;
  kind: "mask";
  rect: Rect;
  /** The frames it covers, in source time: null is every frame. */
  range: { start: SourcePoint; end: SourcePoint } | null;
}

/**
 * `minIdleMs` (120) and `maxIdleMs` (400) were removed on 2026-09-08.
 * They clamped every idle span, so a six-second pause rendered as 0.4s and a
 * 50ms one was stretched to 120ms — both inventing a duration the take did
 * not have. Pacing is now the author's, verbatim, through `RenderPlan.paces`.
 * See spec §1.
 */
export interface RetimingPolicy {
  /** Mean absolute difference (0..1) on a 64x64 grey downsample. */
  motionDiffThreshold: number;
}

/**
 * An authored pause, flattened from the document's `marker` shape.
 *
 * v8 §6's load-bearing constraint in the plan: the pause is attached to an
 * action and an offset, never to an absolute time, so it survives re-capture
 * and regeneration. Resolving `actionId` to a source instant needs
 * `bundle.markers`, which is why that happens in `buildTimeline` and not here
 * — the plan is the frameless stage.
 */
export interface PlannedHold {
  id: string;
  actionId: string;
  offsetMs: number;
  durationMs: number;
}

/** The two steps a pace sits between, in take order. */
interface PaceAnchors {
  afterActionId: string;
  beforeActionId: string;
}

/**
 * A pace whose duration the AUTHOR set, with `setGap`.
 *
 * `idleTargetMs` is the IDLE duration asked for — dead air only. Motion
 * between the two markers is NOT part of it: motion always plays at rate 1.0
 * and is added to this (the plan's Global Constraint, "a gap names the idle
 * stretch between two steps, never the whole stretch"). So `setGap(…, 0)`
 * removes the dead air and leaves a dropdown animation intact, and a pair
 * with 1200ms of motion and a 500ms gap plays for 1700ms on a capture
 * bundle, where `idleOutputFor` sets the idle output to the target outright.
 *
 * A rebuild is a FLOOR and not a ceiling, and this docstring claimed "1700ms
 * in BOTH modes" until 2026-09-08. `paceInstants` inserts
 * `max(0, idleTargetMs − replayIdle)`, so a rebuild whose automation left
 * 900ms of its own dead air between the two markers plays 1200 + 900 =
 * 2100ms, not 1700 — nothing is trimmed, because compression through in-app
 * motion is forbidden (v8 §4) and there is no way to shorten replay's own
 * idle without risking it. The floor is stated on `paceInstants` and named
 * to the author by the inspector's `data-gap-floored` line; two comments in
 * one feature asserting opposite invariants is how the next reader picks the
 * wrong one.
 *
 * It replaces the recorded pacing rather than stacking on it, and it is
 * bundle-independent by construction — which is what makes the render-mode
 * toggle change provenance and (to the floor above) nothing else.
 */
export interface AuthoredPace extends PaceAnchors {
  origin: "authored";
  idleTargetMs: number;
}

/**
 * A pace nobody edited: the pair plays for as long as the take recorded.
 *
 * `recordedSpanMs` is the WHOLE interval between the two actions, motion
 * included — not an idle figure, and it cannot be one here. `planScene` is
 * the frameless stage and has only `action.timestamp`, which cannot tell the
 * dropdown opening apart from the author sitting still. The idle share is
 * whatever is left once the bundle being rendered accounts for its own
 * motion, so that subtraction belongs to a reader holding a bundle — see
 * `idleTargetMsFor` in `plan/timeline.ts`.
 *
 * NEGATIVE when the action log does not ascend, and deliberately not floored
 * here: a floored 0 reads exactly like two simultaneous actions, and the
 * difference matters because the pair after a backwards one double-counts
 * dead air. `idleTargetMsFor` floors it for arithmetic; `buildTimeline`
 * counts it into `Timeline.nonMonotonicPaces` for the author.
 */
export interface RecordedPace extends PaceAnchors {
  origin: "recorded";
  recordedSpanMs: number;
}

/**
 * One adjacent action pair's pacing, resolved from timestamps and gaps.
 *
 * A UNION, and deliberately not one `targetMs` with an `origin` beside it.
 * That shape shipped on 2026-09-08 with a docstring saying "the idle
 * duration this pair should end up with" while `planScene` filled it with
 * the whole inter-action interval for `origin: "recorded"` — and the two
 * readers in `plan/timeline.ts` then disagreed about which of those it was.
 * The cost was the property this whole feature exists to buy: recording mode
 * apportioned the number across the idle alone and rebuild mode floored it
 * against the whole marker span, so flipping the render-mode toggle changed
 * the video's length by exactly the motion duration, per authored gap. One
 * field with two meanings is a seam, and this is what a reader falling
 * through it costs. Distinct names make picking the wrong one a type error.
 *
 * Both variants are turned into ONE number — the idle duration the pair
 * should end up with, against a particular bundle — by `idleTargetMsFor` in
 * `plan/timeline.ts`, which is the only place the conversion happens.
 */
export type PlannedPace = AuthoredPace | RecordedPace;

export interface RenderPlan {
  planVersion: 1;
  compositorVersion: string;
  sceneId: string;
  viewport: { width: number; height: number };
  cursorSegments: CursorSegment[];
  cameraIntents: CameraIntent[];
  cosmetics: CosmeticBinding[];
  holds: PlannedHold[];
  /**
   * Pacing between adjacent steps, or `null` when it was never computed.
   *
   * The distinction is load-bearing and must not collapse to "empty array":
   * `[]` means "computed, and this take has no gaps"; `null` means "this plan
   * was built without a scene, so pacing is unknown". `buildTimeline` accepts
   * hand-built plans, and a null there must not render at replay speed as
   * though that were the recorded pace.
   */
  paces: PlannedPace[] | null;
  /**
   * Pieces the author removed. Resolved to SOURCE ranges by `buildTimeline`
   * (it needs `bundle.markers`) and dropped from the output axis there.
   *
   * Unlike `trim`, which is a range ON the output axis that leaves the axis
   * itself untouched, a removal SHORTENS the axis: the frames it covers are
   * not in the video at all, so every marker after it moves.
   */
  removed: PlannedRemoval[];
  /** The steps inside a removed piece (`stepsInsideRemoved`): their frames
   *  are not in the video, so nothing is drawn on them. */
  removedSteps: string[];
  /** Edits whose marker is a step inside a removed piece: kept, not drawn,
   *  and named. */
  attachedToCuts: AttachedEdit[];
  /**
   * The trim, as markers. Resolved to an `OutputRange` by `resolvePlan`
   * (it needs `bundle.markers`, which the frameless stage does not have),
   * and walked by `renderScene`. The timeline itself is NOT shortened: the
   * output axis stays untrimmed so that every other marker's offset keeps
   * meaning what it meant, and the cut is a range on that axis.
   */
  trim: PlannedTrim;
  retiming: RetimingPolicy;
  hoverSensitive: boolean;
  /** Source-time duration implied by the action log, before retiming. */
  durationHintMs: number;
}

export interface PlanOptions {
  retiming?: Partial<RetimingPolicy>;
}
