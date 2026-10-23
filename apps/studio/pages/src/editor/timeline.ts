import {
  CAMERA_DEFAULTS,
  type FrameBundle,
  gapPacedLive,
  isRealTime,
  type ResolvedPlan,
  toOutputMs,
} from "@demoman/compositor";
// One labeller for the whole app. The orchestrator now names the step a
// replay stopped on, and it must use the same words for a target that the
// timeline already shows the author.
import { anchorLabel } from "@demoman/replay-engine";
import {
  type SceneAction,
  type SceneDocument,
  type StrategyName,
  stepsInsideRemoved,
} from "@demoman/scene-schema";

export { anchorLabel } from "@demoman/replay-engine";

/**
 * Whether a beat's position was measured or guessed.
 *
 * `estimated` is a partial replay's honest answer: the run never reached this
 * beat, so no marker exists and the position falls back to the capture
 * timestamp. Drawing it identically to a measured one is the defect this
 * field exists to prevent — a timeline that looks equally confident about
 * both is exactly the "fallback that fires whether or not anything is wrong"
 * shape in CLAUDE.md.
 */
export type Timing = "rendered" | "estimated";

export interface BeatView {
  actionId: string;
  index: number;
  verb: SceneAction["kind"];
  anchorId: string | null;
  label: string;
  /** Present for a `type` action; null when redacted or another verb. */
  text: string | null;
  redacted: boolean;
  /** A `type` into a contenteditable host rather than a field. With
   *  `redacted`, it says the text went unknown mid-field, not that a
   *  credential was withheld. */
  host: boolean;
  /** The strategy that resolved this beat's anchor, for the health chip. */
  strategy: StrategyName | null;
  /** Where the beat sits on the rendered timeline. Null with no bundle. */
  outputMs: number | null;
  /**
   * The zoom the author put on this beat, if any. Carries the event's own id
   * and its lead-in, because the camera lane draws a clip that starts at
   * `outputMs + offsetMs` — `plan/camera.ts` adds the offset in OUTPUT ms —
   * and the author drags that edge to change it.
   */
  camera: { id: string; scale: number; offsetMs: number } | null;
  /**
   * Whether this beat can carry a zoom at all — a zoom needs an anchor to
   * aim at, and a navigation `waitFor` names no element. The lane shows the
   * reason rather than quietly dropping the control.
   */
  canZoom: boolean;
  /**
   * The pace the author authored for the stretch between this beat and the
   * next one, if any. Null means "use what was recorded" — NOT "no pause",
   * which is what a gap of zero says. See `Gap` in the scene schema.
   *
   * A gap has no `offsetMs`: it is the whole interval between two steps, not
   * a freeze at some instant inside one. That is why this is not the `hold`
   * field it replaced.
   */
  gap: { durationMs: number } | null;
  /**
   * Whether an authored gap on this beat would actually change the video.
   *
   * False on the take's LAST beat — `planScene` pairs each action with the
   * next one, so it emits no pace for a terminal action — and false when the
   * stretch to the next beat carries no dead air at all, because a capture
   * bundle applies an authored gap to the idle portion of a stretch and
   * there is none to apply it to. Spec §1: "a pair of steps with no idle
   * between them has no gap to author, and the editor offers no handle there
   * rather than offering one that silently does nothing."
   *
   * True before a bundle exists. Nothing has been rendered yet, so the idle
   * split is not knowable; the honest answer is to offer the control rather
   * than to withhold it on a guess.
   */
  canPace: boolean;
  /**
   * How long the RENDER actually pauses between this beat and the next one,
   * in output ms — read off `resolved.timeline`, never from the authored
   * number.
   *
   * The two differ, and until 2026-09-08 the editor drew the authored number
   * regardless. On a rebuild the reconstruction is a floor and never a
   * ceiling (`paceInstants`: `max(0, idleTarget − replayIdle)`), so an
   * authored gap the rebuild already met adds nothing at all — and the
   * timeline shaded a band sized to the authored number anyway while the
   * inspector said that pause was playing.
   *
   * The TOTAL the render pauses for, on both modes: a rebuild's own elapsed
   * dead air counts here alongside the freeze reconstructed on top of it,
   * because both play. What the author's own number contributed is
   * `renderedPaceFreezeMs`, and the two were one field until 2026-09-08 —
   * which under-drew every rebuilt band by whatever the automation had left.
   *
   * `0` is a statement: the render was read and it plays no pause here.
   * `null` is the absence of one — there is no render yet, or it carries no
   * marker for one of the two steps, which is the same condition
   * `Timeline.unplacedPaces` counts and `timing: "estimated"` draws. Callers
   * must not collapse them: zero withholds the band, null falls back to the
   * author's own number and draws it provisionally, as it did before any
   * render existed.
   *
   * Zero on the take's last beat with or without a render: `planScene` pairs
   * each action with the next and emits no pace for a terminal one, which
   * needs no bundle to know.
   */
  renderedPauseMs: number | null;
  /**
   * How much of `renderedPauseMs` the AUTHORED gap put there, on a rebuild:
   * the `"pace"` freeze `paceInstants` reconstructed for the stretch after
   * this beat.
   *
   * `0` is the floored case and the reason this field exists — the rebuild's
   * own dead air already covered the gap, so the number the author typed
   * adds nothing to this video. The inspector says exactly that
   * (`data-gap-floored`), and it read `renderedPauseMs === 0` for it until
   * that field started reporting the total. A pause the video contains is
   * not evidence the author's number produced it.
   *
   * `null` on a CAPTURE bundle is not "unknown": nothing is reconstructed
   * there at all (`paceInstants` is gated to `"replay"`; `idleOutputFor`
   * retimes the idle in place instead), so the quantity does not exist and a
   * zero would read as one that came out empty. Also null with no render and
   * on the take's last beat, which has no stretch after it.
   */
  renderedPaceFreezeMs: number | null;
  /**
   * The freeze the render plays immediately BEFORE this beat's own content,
   * in output ms. Zero in Recording mode and with no render.
   *
   * Rebuild mode reconstructs a pause as a `"pace"` segment sitting AT the
   * next step's marker, so `toOutputMs(marker)` — which is what `outputMs`
   * above holds — lands on the instant the freeze BEGINS, not the instant
   * this step's own content does. The lane adds this to reach the latter, so
   * a clip covers its own trailing pause instead of ending just before it
   * and leaving the freeze to be drawn over the following step.
   *
   * Every `"pace"` segment at the marker, not only the ones an author set:
   * in Rebuild most of the video's length is reconstructed recorded pacing,
   * and a clip boundary that ignored it would be wrong for every beat.
   *
   * `outputMs` itself is deliberately NOT shifted. `plan/camera.ts:142`
   * places a zoom key at `toOutputMs(marker) + offsetMs`, so the camera lane
   * has to be drawn from the unshifted number or the editor would show a
   * lead-in the render does not use.
   */
  renderedFreezeBeforeMs: number;
  /**
   * A hold from before gaps existed that the schema migration deliberately
   * left alone — a pause after the take's final step, or one at a non-zero
   * offset inside a clip. Neither has a gap equivalent, and both still play:
   * `planScene` maps `edits.holds` to `plan.holds` and `buildTimeline` emits
   * a `"hold"` segment for each.
   *
   * Carried so the editor can SAY so. There is no command that authors or
   * removes one any more, and a pause in the video that the editor draws
   * nothing for and names nowhere is the picture and the editor disagreeing
   * with nothing said.
   */
  legacyHold: { offsetMs: number; durationMs: number } | null;
  /** The step is inside a removed piece (`stepsInsideRemoved`): its frames
   *  are not in the video. */
  cut: boolean;
  /** The trailing beat: deleting it is a trim, which is safe on both tiers. */
  isLast: boolean;
  /** Where this beat's position came from. See `Timing`. */
  timing: Timing;
  /** The take's own timestamp for this action, in source ms. The only axis
   *  available before a bundle exists. */
  captureMs: number;
}

export interface TimelineView {
  beats: BeatView[];
  outputDurationMs: number | null;
  hasBundle: boolean;
}

/**
 * The two tracks, as data.
 *
 * Both tracks are indexed by action: the timeline snaps to markers by
 * design (v8 §6), so a beat is the unit and there is no pixel-time ruler
 * for anything to float on. The scrubber's own positions come from
 * `outputMs`, which already carries retiming and holds.
 */
export function buildTimelineView(args: {
  scene: SceneDocument;
  resolved: ResolvedPlan | null;
  bundle?: FrameBundle | null;
}): TimelineView {
  const { scene, resolved, bundle = null } = args;
  const anchors = new Map(scene.anchors.map((a) => [a.id, a]));
  // cameraIntents when the plan has been resolved; the document's own events
  // otherwise. Without the fallback an authored zoom disappears from the lane
  // until the next regeneration, which reads as the edit not having landed.
  const cameraByAction = new Map(
    resolved
      ? resolved.plan.cameraIntents.map((intent) => [
          intent.actionId,
          {
            id: intent.id,
            scale: intent.scale,
            offsetMs: intent.offsetMs,
          },
        ])
      : scene.camera.map((event) => [
          event.marker.actionId,
          {
            id: event.id,
            scale: event.scale ?? CAMERA_DEFAULTS.defaultZoomScale,
            offsetMs: event.marker.offsetMs,
          },
        ]),
  );
  // Keyed by the action the gap comes AFTER, which is the action whose beat
  // shows it. Sourced from `edits.gaps` and not from `edits.holds`: the
  // schema migration folds every offset-0 hold into a gap on read, so the
  // hold array no longer carries the pauses this control authors.
  //
  // `?? []` here and on `holds` below for the reason `migrateHoldsToGaps`
  // and `commands.ts` both write it: the frame store casts raw IndexedDB
  // rows, so Zod's `.default([])` never runs on a document written before
  // either field existed. Every path into this function today goes through
  // `scene-store.ts`'s `migrateToCurrent`, so it is not reachable — but a
  // row `prune` survives would throw a TypeError out of `buildTimelineView`
  // and take the editor's whole render with it.
  const gapAfterAction = new Map(
    (scene.edits.gaps ?? []).map((g) => [g.afterActionId, g]),
  );
  // Every hold still in the document is one the migration refused to convert
  // — see `migrateHoldsToGaps`. They are read-only here; the editor has no
  // command for them any more.
  const holdByAction = new Map(
    (scene.edits.holds ?? []).map((h) => [h.marker.actionId, h]),
  );
  // The resolved plan's when there are frames: a removed piece that removed
  // none of them takes no step out of the video (review 2026-10-22).
  const removedSteps = resolved
    ? new Set(resolved.plan.removedSteps ?? [])
    : stepsInsideRemoved(scene);
  // Replay's own marker times where it reached the action; the capture
  // timestamp for a beat a partial run never got to, so a trailing beat
  // still draws somewhere sensible instead of collapsing onto zero.
  const markerSourceMs = new Map(
    (bundle?.markers ?? []).map((m) => [m.actionId, m.sourceTimeMs] as const),
  );

  /**
   * Whether the stretch from `action` to the one after it carries dead air.
   *
   * Asked the same way `authoredPaceCovering` (compositor plan/timeline.ts)
   * asks it — is there an idle segment inside the two markers' bracket —
   * because that function is what decides whether an authored gap does
   * anything, and two different answers to one question would offer a
   * control whose effect the editor mis-predicts.
   *
   * Only real-time bundles (a recording, or a continuous rebuild) are gated.
   * A SAMPLED rebuild reconstructs
   * `max(0, targetMs − replayElapsed)` as its own `"pace"` segment
   * (`paceInstants`) with no reference to idle at all, so idle is not what
   * decides there — and replay's idle is synthetic re-render time rather than
   * the author's, so gating on it would withhold a control that works.
   *
   * Not the same as "an authored gap always does something on a rebuild". The
   * reconstruction is a floor, never a ceiling: compression through motion is
   * forbidden (v8 §4), so a target SHORTER than the replay's own elapsed adds
   * nothing and nothing here says so. That is Task 4's contract, and a
   * different question from the one this predicate asks — this one is about
   * whether the stretch can be paced at all.
   */
  const paceableAfter = (action: SceneAction, next: SceneAction): boolean => {
    if (resolved === null || bundle === null) return true;
    // Gated where source time is real: a recording, or a real-time rebuild
    // (spec 2026-10-03 §1). A sampled rebuild reconstructs its pace without
    // reference to idle, so idle is not what decides there.
    if (!isRealTime(bundle)) return true;
    // A pause the rebuild waited out live is in source time, honoured
    // whatever moved inside it (review of 2026-10-03): withholding its
    // control would hide a pause that is playing.
    if (gapPacedLive(bundle, action.id)) return true;
    const after = markerSourceMs.get(action.id);
    const before = markerSourceMs.get(next.id);
    // A partial run reached neither: nothing is known, so nothing is
    // withheld. The beat is already drawn as `estimated` for the same
    // reason.
    if (after === undefined || before === undefined) return true;
    return resolved.timeline.segments.some(
      (segment) =>
        segment.kind === "idle" &&
        segment.srcEndMs > segment.srcStartMs &&
        after <= segment.srcStartMs &&
        segment.srcEndMs <= before,
    );
  };

  /**
   * The `"pace"` freezes the render plays at one source instant, summed.
   *
   * Epsilon-matched on `srcStartMs` the way `buildTimeline`'s own
   * `emitPacesAt` matches: a pace resolves to a marker's source time, and
   * whether that value arrived through the segment splitter or straight off
   * a pre-existing cut is not something either side should depend on.
   *
   * `"pace"` only, never `"hold"`. A legacy terminal hold also freezes at a
   * marker, and `clipDimensions` already derives that clip's geometry from
   * its own end — counting it here too would move the clip twice.
   */
  const PACE_EPSILON_MS = 1e-6;
  const freezeAt = (sourceTimeMs: number): number => {
    if (resolved === null) return 0;
    let ms = 0;
    for (const segment of resolved.timeline.segments) {
      if (segment.kind !== "pace") continue;
      if (Math.abs(segment.srcStartMs - sourceTimeMs) > PACE_EPSILON_MS)
        continue;
      ms += segment.outEndMs - segment.outStartMs;
    }
    return ms;
  };

  /**
   * What the render actually plays for the stretch between two steps. See
   * `BeatView.renderedPauseMs` for why this is read from the timeline rather
   * than taken from the authored number.
   *
   * BOTH halves, on both modes, and until 2026-09-08 this returned two
   * different quantities under one name. A rebuild plays its own elapsed
   * dead air AND the freeze `paceInstants` reconstructs on top of it
   * (`max(0, idleTarget − replayIdle)`), so returning the freeze alone
   * under-reported every rebuilt pause by whatever the automation itself had
   * left: a 1200ms gap over a rebuild that left 400ms of its own answered
   * 800 while the video paused for 1200 — and the same take's band was
   * 1200 wide in Recording mode, which is exactly the "toggle changes
   * provenance and nothing else" promise broken in the editor.
   *
   * One expression covers both because the two modes are gated apart in the
   * compositor: `paceInstants` is `bundle.source === "replay"` only, so
   * `freezeAt` is zero on a capture bundle and this reduces to the idle sum
   * there; `idleOutputFor` is `"capture"` only, so a rebuild's idle segments
   * pass through at their recorded output and the freeze is what the author's
   * number added. Neither mode double-counts, which is Ruling P1.
   *
   * What the AUTHORED number contributed is a different question, and the
   * one `renderedPaceFreezeMs` answers.
   */
  const renderedPauseOf = (
    action: SceneAction,
    next: SceneAction | undefined,
  ): number | null => {
    if (next === undefined) return 0;
    if (resolved === null || bundle === null) return null;
    const after = markerSourceMs.get(action.id);
    const before = markerSourceMs.get(next.id);
    if (after === undefined || before === undefined) return null;
    let ms = freezeAt(before);
    for (const segment of resolved.timeline.segments) {
      if (segment.kind !== "idle") continue;
      if (after <= segment.srcStartMs && segment.srcEndMs <= before) {
        ms += segment.outEndMs - segment.outStartMs;
      }
    }
    return ms;
  };

  /**
   * The freeze `paceInstants` reconstructed for the stretch after a beat, on
   * a rebuild — `max(0, idleTargetMs − replayIdle)`, which is the whole of
   * what an authored gap adds there.
   *
   * `null` on a capture bundle, deliberately, and it is NOT "unknown": a
   * capture bundle reconstructs nothing at all (`paceInstants` is gated to
   * `"replay"`), so there is no such quantity to report and zero would read
   * as one that came out empty. Also null with no render and with either
   * marker missing, which is the same condition `renderedPauseMs` returns
   * null for.
   *
   * The one consumer is the inspector's `data-gap-floored` line, and this
   * field exists because `renderedPauseMs` stopped being able to answer it:
   * a floored gap on a rebuild now reports the dead air the automation left,
   * which is a real pause in the video and a true thing to draw a band for.
   * "The video pauses here" and "the number you typed is what put it there"
   * are two questions, and one field cannot hold both.
   */
  const paceFreezeOf = (
    action: SceneAction,
    next: SceneAction | undefined,
  ): number | null => {
    if (next === undefined) return null;
    if (resolved === null || bundle === null) return null;
    if (isRealTime(bundle)) return null;
    const before = markerSourceMs.get(next.id);
    if (markerSourceMs.get(action.id) === undefined || before === undefined) {
      return null;
    }
    return freezeAt(before);
  };

  const lastIndex = scene.actions.length - 1;
  const beats: BeatView[] = scene.actions.map((action, index) => {
    const anchor = action.anchorId ? anchors.get(action.anchorId) : undefined;
    const intent = cameraByAction.get(action.id);
    const gap = gapAfterAction.get(action.id);
    const hold = holdByAction.get(action.id);
    const next = scene.actions[index + 1];
    const markerMs = markerSourceMs.get(action.id);
    return {
      actionId: action.id,
      index,
      verb: action.kind,
      anchorId: action.anchorId,
      label: anchorLabel(anchor),
      text: action.kind === "type" ? action.text : null,
      redacted: action.kind === "type" ? action.redacted : false,
      host: action.kind === "type" && action.host === true,
      strategy: anchor?.resolution.strategy ?? null,
      outputMs: resolved
        ? toOutputMs(resolved.timeline, markerMs ?? action.timestamp)
        : null,
      timing: markerMs === undefined ? "estimated" : "rendered",
      captureMs: action.timestamp,
      camera: intent ?? null,
      canZoom: action.anchorId !== null,
      gap: gap ? { durationMs: gap.durationMs } : null,
      canPace: next !== undefined && paceableAfter(action, next),
      renderedPauseMs: renderedPauseOf(action, next),
      renderedPaceFreezeMs: paceFreezeOf(action, next),
      // Zero once the marker reaches `sourceDurationMs`: `toOutputMs`
      // short-circuits there straight to `outputDurationMs`, which is the
      // instant AFTER the freeze rather than before it, so `outputMs`
      // already covers it and adding it again would push the previous clip
      // past the end of the axis. The same short-circuit is why a terminal
      // legacy hold's clip is derived from its end in `clipDimensions`.
      renderedFreezeBeforeMs:
        bundle !== null &&
        !isRealTime(bundle) &&
        markerMs !== undefined &&
        resolved !== null &&
        markerMs < resolved.timeline.sourceDurationMs
          ? freezeAt(markerMs)
          : 0,
      legacyHold: hold
        ? { offsetMs: hold.marker.offsetMs, durationMs: hold.durationMs }
        : null,
      cut: removedSteps.has(action.id),
      isLast: index === lastIndex,
    };
  });

  return {
    beats,
    outputDurationMs: resolved?.timeline.outputDurationMs ?? null,
    hasBundle: resolved !== null,
  };
}
