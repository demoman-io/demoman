import {
  type FrameBundle,
  motionTimings,
  type Rect,
  type ResolvedPlan,
  type TimeSpan,
  toOutputMs,
} from "@demoman/compositor";
import { zoomDefaultMs, zoomSkippedNote } from "@demoman/run-core";
import {
  MOTION_DEFAULTS,
  type SceneDocument,
  type SceneMarker,
  type SourcePoint,
} from "@demoman/scene-schema";
import { isAuthoredScene, rerunAdvice } from "../shell/runs-link";
import type { ZoomTarget } from "./commands";
import type { HoverReport } from "./hover-report";
import { type Join, type Piece, piecesOf } from "./pieces";
import type { BeatView, TimelineView, Timing } from "./timeline";

export type { ZoomTarget } from "./commands";

/**
 * How much room the last step gets on a capture-derived axis.
 *
 * A take with no bundle has no duration: the last action's timestamp is the
 * last thing known about it. The final clip still needs somewhere to live, so
 * it gets a second. This is a placeholder and is allowed to be one *because*
 * the whole axis is already labelled `captured` and drawn provisionally — the
 * author is never shown this number as if it were measured.
 */
export const CAPTURED_TAIL_MS = 1000;

/**
 * What a reclaimed-motion span is called on the timeline.
 *
 * `src/adapters/frame-store.ts` writes this same sentence into new rows. It
 * is duplicated there rather than imported, because a storage adapter
 * importing an editor module would pull `@demoman/compositor`'s runtime into
 * the worker's dependency graph for one string; the two are pinned together
 * by `editor-lanes.test.ts` instead.
 */
export const MOTION_RECLAIMED_LABEL =
  "Motion reclaimed to free space. Re-shoot it in Runs to restore.";

/**
 * The reclaimed-motion sentence for a reader's take. The stored note is
 * written at reclaim time, when the reader's take is not known, so an
 * authored take (whose Runs route is its script, not a re-shoot) gets its
 * wording here, at read time.
 */
function motionReclaimedLabel(
  authored: boolean,
  rerunLine: string | null,
): string {
  return `Motion reclaimed to free space. ${rerunAdvice(authored, rerunLine, "to restore")}`;
}

/**
 * The wordings `frame-store.ts` wrote before the current one, still on disk
 * in every take reclaimed while each was current.
 *
 * Retiring "Replay" from author-facing copy did not come with a migration,
 * so a legacy row is relabelled at the point it is read. **Only these exact
 * strings**, which is the part that matters: substituting on `kind` alone
 * discarded whatever the row actually said, and `note` is typed as free
 * text. A producer that one day names *which* spans went would have had its
 * sentence silently replaced by this generic one, with nothing anywhere
 * reporting the substitution.
 */
const LEGACY_MOTION_RECLAIMED_NOTES: ReadonlySet<string> = new Set([
  "Motion reclaimed to free space. Replay to restore.",
  // Written from 2026-09-08 until 2026-09-28, when the rebuild left the
  // editor (plan 2 of the agent door, Task 7) and the way to restore became
  // a re-shoot in Runs. Relabelled the same way, and for the same reason.
  "Motion reclaimed to free space. Rebuild to restore.",
]);

/**
 * A degradation's clip label: the author's sentence for a reclaimed span,
 * and `kind: note` for every compositor-internal reason.
 */
function labelOf(
  kind: string,
  note: string,
  authored: boolean,
  rerunLine: string | null,
): string {
  if (kind !== "motionReclaimed") return `${kind}: ${note}`;
  return LEGACY_MOTION_RECLAIMED_NOTES.has(note) ||
    note === MOTION_RECLAIMED_LABEL
    ? motionReclaimedLabel(authored, rerunLine)
    : note;
}

export interface Tick {
  actionId: string;
  atMs: number;
  verb: string;
  label: string;
  timing: Timing;
  /**
   * A hover the develop-time pixel check says changed nothing on screen.
   * Per-clip rather than per-take because the verdict is sometimes wrong and
   * the author has to be able to disagree with it one hover at a time.
   */
  flag: "unchangedHover" | null;
  canZoom: boolean;
  /** The step is inside a removed piece: its frames are not in the video.
   *  Drawn hollow, and fanned out within its run — see `cutIndexAt`. */
  cut: boolean;
}

export interface ClipLane {
  /** The untrimmed output length: the axis every marker is drawn on. */
  durationMs: number;
  trim: {
    headMs: number;
    headTiming: Timing;
    tailMs: number;
    tailTiming: Timing;
    /** The document's own markers, for the same reason `ZoomSeg` carries
     *  its pair: a gesture that moves ONE side has to compare against the
     *  step the author left the other side on, not against a millisecond
     *  re-derived from the nearest tick. `null` is an uncut side. */
    headMarker: SceneMarker | null;
    tailMarker: SceneMarker | null;
  };
  ticks: Tick[];
  /** Stretches the harvest could not keep, on the output axis. Hatched on
   *  the bar AND named in `notices`: hatching alone is missable.
   *
   * The pointer-velocity strip that used to sit beside this field is gone
   * (2026-09-21, with the flat dock): it was 240 buckets of cursor speed
   * drawn as a histogram inside the Clip track, and the Clip lane is a
   * labelled block now with no bed to draw it on. It was removed rather
   * than left uncomputed — a `velocity` no view read would have been work
   * done on every model build for a picture nothing paints. */
  degraded: TimeSpan[];
  /** The clip as pieces between splits and joins (`pieces.ts`). Empty
   *  before anything has rendered: a split needs the frames' markers. */
  pieces: Piece[];
  /** Where each removed piece was; a click restores it. */
  joins: Join[];
}

export interface ZoomSeg {
  id: string;
  actionId: string;
  /** When the push-in sets off, which is where the lane draws the block
   *  from and where its start cap sits. `startMs` is where it lands. */
  departMs: number;
  startMs: number;
  endMs: number;
  /** Where the block stops: `endMs`, or where the next zoom sets off when
   *  the camera pans straight on to it (`drawnEndMs`). */
  drawnEndMs: number;
  endAuthored: boolean;
  scale: number;
  target: ZoomTarget;
  /** Why the aim is not what the click asked for, from the event's note. */
  aimFallback: string | null;
  timing: Timing;
  /** A clamped range names this zoom. */
  clamped: boolean;
  /** The document's own markers, so a gesture that moves ONE end can keep
   *  the other end on the step the author left it on rather than
   *  re-deriving it from the nearest tick. */
  marker: SceneMarker;
  endMarker: SceneMarker | null;
}

export interface MaskSeg {
  id: string;
  startMs: number;
  endMs: number;
  rect: Rect;
  wholeTake: boolean;
  timing: Timing;
  /** Null on a whole-take mask. In the frames' own time (schema v13). */
  startMarker: SourcePoint | null;
  endMarker: SourcePoint | null;
}

export interface LaneModel {
  clip: ClipLane;
  zooms: ZoomSeg[];
  masks: MaskSeg[];
  durationMs: number;
  timeSource: "rendered" | "captured";
  /** Whether a script made this take, so the timeline's own advice ("re-shoot
   *  it in Runs" / "run its script again in Runs") reads the same fact the
   *  notices here were worded from. */
  authored: boolean;
  /** The platform's re-film line, said whole in place of that advice where
   *  there is no Runs page (the studio); null where there is one. */
  rerunLine: string | null;
  hoverCheck: { failed: boolean; unchecked: number };
  /** Every sentence the view must show persistently. Never rendered as a
   *  toast; never folded into a texture alone. */
  notices: string[];
  /** How long a zoom with no end of its own runs at this document's
   *  smoothness (`zoomDefaultMs`): the lane's estimate, the hover ghost and
   *  the zoom a click adds all read this one number. */
  zoomDefaultMs: number;
  /** The push-in's length at this document's smoothness: how far before
   *  its landing a new or unrendered zoom is drawn from, and how far after
   *  a dropped start cap it lands. */
  zoomInMs: number;
}

export interface LaneModelArgs {
  scene: SceneDocument;
  view: TimelineView;
  bundle: FrameBundle | null;
  resolved: ResolvedPlan | null;
  hoverReport: HoverReport | null;
  /**
   * The platform's re-film line where it names no Runs page (the studio's
   * `nav.rerun` answers `kind: "line"`): every "Re-shoot it in Runs …"
   * notice below says it whole instead (`rerunAdvice`). Absent where the
   * platform answers with a link, as the extension does; `main.ts`, the one
   * production caller, always passes `platform.nav.rerun`'s answer.
   */
  rerunLine?: string | null;
}

/**
 * Where a beat sits on whichever axis this model is drawn on.
 *
 * `outputMs` is null exactly when `resolved` is null, so the `??` here is
 * unreachable in practice; it is written rather than asserted because a
 * non-null assertion would be a claim about another module's internals.
 *
 * Exported because the inspector's lead-in control has to bound itself by
 * the same number the clip is drawn at — two answers to "where is this beat"
 * would put a control's limit somewhere the author cannot see it.
 */
export const beatPositionMs = (view: TimelineView, beat: BeatView): number =>
  view.hasBundle ? (beat.outputMs ?? beat.captureMs) : beat.captureMs;

function durationOf(view: TimelineView): number {
  if (view.hasBundle && view.outputDurationMs !== null)
    return view.outputDurationMs;
  const last = view.beats[view.beats.length - 1];
  return (last?.captureMs ?? 0) + CAPTURED_TAIL_MS;
}

/**
 * A marker's instant with no render: the step's own timestamp plus the
 * offset. The provisional axis, drawn as `estimated`.
 */
/** A mask edge before any render: its source offset read as output time,
 *  the one guess there is with no timeline (`timing: estimated`). */
const asOutput = (p: SourcePoint): SceneMarker => ({
  actionId: p.actionId,
  offsetMs: p.sourceOffsetMs,
});

function estimateMs(view: TimelineView, marker: SceneMarker): number {
  const beat = view.beats.find((b) => b.actionId === marker.actionId);
  return (beat ? beatPositionMs(view, beat) : 0) + marker.offsetMs;
}

export function buildLaneModel(args: LaneModelArgs): LaneModel {
  const { scene, view, bundle, resolved } = args;
  // Whether Runs re-shoots this take or runs its script again: the one
  // decision every "Re-shoot it in Runs" notice below reads.
  const authored = isAuthoredScene(scene);
  const rerunLine = args.rerunLine ?? null;
  const advise = (tail: string): string =>
    rerunAdvice(authored, rerunLine, tail);
  const durationMs = durationOf(view);
  const notices: string[] = [];
  const removable = new Set(args.hoverReport?.removable ?? []);
  const positionOf = new Map(
    view.beats.map((b) => [b.actionId, beatPositionMs(view, b)] as const),
  );
  const timingOf = new Map(
    view.beats.map((b) => [b.actionId, b.timing] as const),
  );
  const timingAt = (marker: { actionId: string } | undefined): Timing =>
    resolved === null
      ? "estimated"
      : marker
        ? (timingOf.get(marker.actionId) ?? "estimated")
        : "rendered";

  const ticks: Tick[] = view.beats.map((beat) => ({
    actionId: beat.actionId,
    atMs: positionOf.get(beat.actionId) ?? 0,
    verb: beat.verb,
    label: beat.label,
    timing: beat.timing,
    flag: removable.has(beat.actionId) ? "unchangedHover" : null,
    canZoom: beat.canZoom,
    cut: beat.cut,
  }));

  // The trim: the resolved range when there is one, the estimate otherwise.
  const trimEdits = scene.edits.trim;
  const trim = resolved
    ? {
        headMs: resolved.range.startMs,
        headTiming: (resolved.trimUnplaced.includes("head")
          ? "estimated"
          : "rendered") as Timing,
        tailMs: resolved.range.endMs,
        tailTiming: (resolved.trimUnplaced.includes("tail")
          ? "estimated"
          : "rendered") as Timing,
        headMarker: trimEdits?.head ?? null,
        tailMarker: trimEdits?.tail ?? null,
      }
    : {
        headMs: trimEdits?.head
          ? Math.max(0, estimateMs(view, trimEdits.head))
          : 0,
        headTiming: (trimEdits?.head ? "estimated" : "rendered") as Timing,
        tailMs: trimEdits?.tail
          ? Math.min(durationMs, estimateMs(view, trimEdits.tail))
          : durationMs,
        tailTiming: (trimEdits?.tail ? "estimated" : "rendered") as Timing,
        headMarker: trimEdits?.head ?? null,
        tailMarker: trimEdits?.tail ?? null,
      };
  for (const side of resolved?.trimUnplaced ?? []) {
    notices.push(
      `The trim's ${side} is placed from the take's own timestamp: the last render carried no marker for its step. ${advise("to give it measured timing")}`,
    );
  }

  // A removed piece that removed nothing, said where the author reads it:
  // a piece that worked and one that did nothing look identical otherwise.
  for (const unplaced of resolved?.timeline.unplacedCuts ?? []) {
    notices.push(`A removed piece removed no frames: ${unplaced.reason}.`);
  }

  // A zoom's `clamped` is its authored end not reached (the inspector says
  // so); a `zoomFit` narrowed its scale and left its end alone, so only its
  // note is shown.
  const clampedIds = new Set(
    (resolved?.clampedRanges ?? [])
      .filter((c) => c.kind === "zoom")
      .map((c) => c.id),
  );
  for (const clamped of resolved?.clampedRanges ?? [])
    notices.push(clamped.note);

  const segmentOf = new Map(
    (resolved?.cameraSegments ?? []).map((s) => [s.id, s] as const),
  );
  // The document's own pull-out, so an estimated end sits where the render
  // will put it at the author's smoothness, not at the default's.
  const { smoothness } = scene.motion ?? MOTION_DEFAULTS;
  const defaultZoomMs = zoomDefaultMs(smoothness);
  const { zoomInMs } = motionTimings(smoothness);
  const unrendered = new Set<string>();
  const drawn: ZoomSeg[] = scene.camera.flatMap((event) => {
    const scale = event.scale ?? 1;
    if (scale <= 1) return []; // "no zoom here", as planCameraIntents reads it
    const segment = segmentOf.get(event.id);
    if (!segment) unrendered.add(event.id);
    const startMs = segment
      ? segment.startMs
      : Math.max(0, estimateMs(view, event.marker));
    const endMs = segment
      ? segment.endMs
      : Math.min(
          durationMs,
          event.end ? estimateMs(view, event.end) : startMs + defaultZoomMs,
        );
    const target: ZoomTarget = event.point
      ? { kind: "point", x: event.point.x, y: event.point.y }
      : { kind: "element", anchorId: event.anchorId ?? "" };
    // A ruling from Task 4, amending this task's original brief: a
    // segment's `endUnplaced` means the author DID name an end (so
    // `endAuthored` is true), but that end's own step carries no marker in
    // this render, so the instant fell back to the compositor's default
    // return timing rather than a measured one. Drawing that identically to
    // a measured end would be exactly the "fallback that fires whether or
    // not anything is wrong" shape CLAUDE.md calls out — so it is drawn
    // `estimated` and named in `notices`, the same treatment an unplaced
    // trim side gets above.
    if (segment?.endUnplaced) {
      notices.push(
        `The end of zoom "${event.id}" is placed from the take's own timestamp: the last render carried no marker for its step. ${advise("to give it measured timing")}`,
      );
    }
    return [
      {
        id: event.id,
        actionId: event.marker.actionId,
        // An unrendered zoom's is estimated below, among its neighbours.
        departMs: segment?.departMs ?? startMs,
        startMs,
        endMs,
        drawnEndMs: endMs,
        endAuthored: event.end !== undefined,
        scale,
        target,
        aimFallback: event.note ?? null,
        timing: segment
          ? segment.endUnplaced
            ? "estimated"
            : timingAt(event.marker)
          : "estimated",
        clamped: clampedIds.has(event.id),
        marker: event.marker,
        endMarker: event.end ?? null,
      },
    ];
  });

  // An estimated end stops at the next zoom's start. Two zooms closer than a
  // full return are a layout auto-zoom writes on every close pair of clicks
  // (`zoomsForClicks`), and the render glides from one to the next rather
  // than returning — its segment ends where the next one starts
  // (`insertNeutralKeys`). Drawn from `zoomHoldMs + zoomOutMs` alone, the
  // estimate overlapped the next zoom and promised a return that never
  // comes. A rendered segment already ends there.
  const ended = drawn.map((zoom) => {
    if (!unrendered.has(zoom.id)) return zoom;
    const nextStartMs = Math.min(
      ...drawn.map((z) => z.startMs).filter((ms) => ms > zoom.startMs),
    );
    return zoom.endMs > nextStartMs ? { ...zoom, endMs: nextStartMs } : zoom;
  });
  // Each block as the preview shows it: departures first, since a block's
  // drawn end is the next one's departure.
  const departed = ended.map((zoom) =>
    unrendered.has(zoom.id)
      ? {
          ...zoom,
          departMs: estimatedDepartMs(ended, zoom.startMs, zoomInMs),
        }
      : zoom,
  );
  const zooms = departed.map((zoom) => ({
    ...zoom,
    drawnEndMs: drawnEndMs(departed, zoom.startMs, zoom.endMs),
  }));

  // Every click the zooms generated at save left out, one line each, in the
  // take notes (`zoomSkippedNote`). Not once the author has zoomed that step
  // themselves: the note would then describe a zoom the lane shows. And not
  // a too-close one once the zoom it was measured from has left its step:
  // the note would say the click is blocked by a zoom that is not there.
  const zoomedSteps = new Set(scene.camera.map((c) => c.marker.actionId));
  for (const skip of scene.zoomsSkipped ?? []) {
    if (zoomedSteps.has(skip.actionId)) continue;
    if ("afterActionId" in skip && !zoomedSteps.has(skip.afterActionId)) {
      continue;
    }
    notices.push(zoomSkippedNote(skip));
  }

  const cosmeticOf = new Map(
    (resolved?.cosmetics ?? []).map((c) => [c.id, c] as const),
  );
  const masks: MaskSeg[] = scene.edits.masks.map((mask) => {
    const wholeTake = mask.start === undefined || mask.end === undefined;
    const cosmetic = cosmeticOf.get(mask.id);
    const range = cosmetic?.range ?? null;
    // The same treatment an unplaced trim side and an unplaced zoom end get
    // above, and for a reason particular to a mask: the fallback does not
    // just leave the end unmeasured, it runs the redaction to the take's own
    // end. `timing: estimated` alone says "this position is unmeasured",
    // which reads the same on a mask that is still covering what the author
    // drew — so it cannot carry "this is now covering more of your video".
    for (const side of cosmetic?.unplaced ?? []) {
      notices.push(
        `The ${side} of mask "${mask.id}" is placed from the take's own timestamp: the last render carried no marker for its step, so the mask covers more of the video than it was drawn to. ${advise("to give it measured timing")}`,
      );
    }
    const startMs = wholeTake
      ? 0
      : range
        ? range.startMs
        : mask.start
          ? Math.max(0, estimateMs(view, asOutput(mask.start)))
          : 0;
    const endMs = wholeTake
      ? durationMs
      : range
        ? range.endMs
        : mask.end
          ? Math.min(durationMs, estimateMs(view, asOutput(mask.end)))
          : durationMs;
    return {
      id: mask.id,
      startMs,
      endMs,
      rect: mask.rect,
      wholeTake,
      timing: wholeTake
        ? "rendered"
        : resolved && range
          ? timingAt(mask.start) === "rendered" &&
            timingAt(mask.end) === "rendered"
            ? "rendered"
            : "estimated"
          : "estimated",
      startMarker: mask.start ?? null,
      endMarker: mask.end ?? null,
    };
  });

  const map = (ms: number): number =>
    resolved ? toOutputMs(resolved.timeline, ms) : ms;
  const degraded: TimeSpan[] = (bundle?.degradations ?? []).map((d) => ({
    startMs: map(d.startMs),
    endMs: map(d.endMs),
  }));
  for (const d of bundle?.degradations ?? [])
    notices.push(labelOf(d.kind, d.note, authored, rerunLine));

  // The only reader of `Timeline.unplacedPaces`, and the reason the count
  // exists. `paceInstants` cannot place a pace whose two markers the bundle
  // does not carry, and dropping it silently is a video shorter than the
  // take with nothing to tell the author apart from a take that was simply
  // short.
  const unplacedPaces = resolved?.timeline.unplacedPaces ?? 0;
  if (unplacedPaces > 0) {
    const pauses = unplacedPaces === 1 ? "pause" : "pauses";
    notices.push(
      `pacingUnplaced: ${unplacedPaces} recorded ${pauses} could not be placed. The last render carried no marker for the steps they sit between, so this video is shorter than the take by however long those ${pauses} were. ${advise("to restore them")}`,
    );
  }

  // The only reader of `Timeline.nonMonotonicPaces`, and the reason that
  // count exists. A backwards pair is counted twice over — nothing where it
  // sits, and again by the pair after it, which claims the dead air this one
  // should have carried. The take still looks right: every pause is there,
  // the video is just longer than the one that was recorded, which is the
  // kind of wrong nobody thinks to ask about.
  const backwardsPaces = resolved?.timeline.nonMonotonicPaces ?? 0;
  if (backwardsPaces > 0) {
    const pairs = backwardsPaces === 1 ? "pair" : "pairs";
    notices.push(
      `pacingBackwards: ${backwardsPaces} step ${pairs} in this take carry timestamps that run backwards, so the take's order is not its time order. A re-shoot counts the pause across ${backwardsPaces === 1 ? "it" : "them"} twice and comes out longer than the take. Re-record to straighten the order; the frames you already have are unaffected.`,
    );
  }

  const { pieces, joins, unplacedSplits } =
    bundle !== null && resolved !== null
      ? piecesOf(scene, bundle, resolved.timeline)
      : { pieces: [], joins: [], unplacedSplits: [] };
  for (const _ of unplacedSplits) {
    notices.push(
      `A split is not drawn: the last render carried no marker for its step. ${advise("to place it")}`,
    );
  }

  return {
    clip: {
      durationMs,
      trim,
      ticks,
      degraded,
      pieces,
      joins,
    },
    zooms,
    masks,
    durationMs,
    timeSource: view.hasBundle ? "rendered" : "captured",
    authored,
    rerunLine,
    hoverCheck: {
      failed: args.hoverReport?.failed ?? false,
      unchecked: args.hoverReport?.unchecked ?? 0,
    },
    notices,
    zoomDefaultMs: defaultZoomMs,
    zoomInMs,
  };
}

/**
 * "Nearest step, plus an offset" — the bridge between a free gesture and
 * step-addressed storage (spec, "The constraint, and the bridge across it").
 * Ties go to the preceding tick. Inside `snapMs` of a tick the offset is
 * EXACTLY zero, so the view's 8px band lands on the step and a test can
 * assert the integer. Nearest rather than preceding because a small offset
 * drifts least across a Rebuild.
 */
/**
 * Where the push-in to a zoom landing at `startMs` sets off, placed as
 * `solveCamera` places a rendered one: `zoomInMs` before the landing, never
 * before the camera's previous key — the return of the zoom before, or that
 * zoom's own landing when the camera pans straight on from it. For a zoom
 * the render has not placed: an unrendered one, and the hover ghost's.
 */
export function estimatedDepartMs(
  zooms: readonly ZoomSeg[],
  startMs: number,
  zoomInMs: number,
): number {
  let previousKeyMs = 0;
  for (const z of zooms) {
    if (z.startMs >= startMs) continue;
    previousKeyMs = Math.max(
      previousKeyMs,
      z.endMs < startMs ? z.endMs : z.startMs,
    );
  }
  return Math.max(previousKeyMs, startMs - zoomInMs);
}

/** Where a zoom's block stops: its return, or the next zoom's departure
 *  when the camera pans straight on to that one before returning. */
export function drawnEndMs(
  zooms: readonly ZoomSeg[],
  startMs: number,
  endMs: number,
): number {
  return Math.min(
    endMs,
    ...zooms.filter((z) => z.startMs > startMs).map((z) => z.departMs),
  );
}

export function markerAt(
  model: LaneModel,
  ms: number,
  snapMs: number,
): SceneMarker {
  const ticks = model.clip.ticks;
  const first = ticks[0];
  if (!first)
    throw new Error("a take with no steps has nothing to attach an edit to");
  let best = first;
  for (const tick of ticks) {
    const d = Math.abs(tick.atMs - ms);
    const bestD = Math.abs(best.atMs - ms);
    if (d < bestD || (d === bestD && tick.atMs < best.atMs)) best = tick;
  }
  const offsetMs = Math.round(ms - best.atMs);
  return {
    actionId: best.actionId,
    offsetMs: Math.abs(offsetMs) <= snapMs ? 0 : offsetMs,
  };
}
