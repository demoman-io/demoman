import {
  CAMERA_DEFAULTS,
  type FrameBundle,
  type ResolvedPlan,
  sampleCursor,
  toSourceMs,
} from "@demoman/compositor";
import { MIN_ZOOM_GAP_MS } from "@demoman/run-core";
import type { SceneMarker, SourcePoint } from "@demoman/scene-schema";
import type { EditCommand, ZoomTarget } from "./commands";
import { type LaneModel, type MaskSeg, markerAt, type ZoomSeg } from "./lanes";
import { defaultMaskRect } from "./masks";
import { resolvePieceEdge } from "./pieces";
import type { TimelineView } from "./timeline";

/** Pauses are authored to a tenth of a second. Finer is a false claim about
 *  what an author meant by a drag. */
export const PACE_SNAP_MS = 100;

/** The magnetic band around a tick, in screen pixels. The view converts it
 *  to ms at the current zoom and hands it in as `snapMs`. */
export const SNAP_PX = 8;

/** Shortest distance a trimmed head may sit from the tail, and vice versa. */
export const TRIM_MIN_MS = 200;

/** How long a freshly added mask spans when no tick sits close enough to
 *  its own end. */
export const MASK_DEFAULT_MS = 2000;

/** The Zoom lane's ghost is this long, and a click centres a span this long
 *  under the pointer. Defined beside the spacing rule in `core/zoom-defaults`,
 *  which the zooms generated at save share. */
export { MIN_ZOOM_GAP_MS, ZOOM_DEFAULT_MS } from "@demoman/run-core";

/** Shortest span a zoom or a mask may be dragged to. */
export const MIN_SEGMENT_MS = 100;

/* `MIN_ZOOM_GAP_MS` — the least time between two zooms' starts — is
 * re-exported above from `core/zoom-defaults`. Every collision check and its
 * refusal message read that one value, so a bound reported to the author is
 * exactly the bound enforced, and the bound a saved take was laid out to. */

export type Gesture =
  | { kind: "trim"; edge: "head" | "tail"; toMs: number; snapMs: number }
  | { kind: "addZoom"; atMs: number; snapMs: number }
  | { kind: "moveZoom"; id: string; deltaMs: number; snapMs: number }
  | {
      kind: "zoomEdge";
      id: string;
      edge: "start" | "end";
      toMs: number;
      snapMs: number;
    }
  | { kind: "addMask"; atMs: number; snapMs: number }
  | { kind: "moveMask"; id: string; deltaMs: number; snapMs: number }
  | {
      kind: "maskEdge";
      id: string;
      edge: "start" | "end";
      toMs: number;
      snapMs: number;
    }
  /** A piece's edge, dragged by `deltaMs` (spec 2026-10-22 split-tool). */
  | {
      kind: "pieceEdge";
      start: SourcePoint | null;
      side: "start" | "end";
      deltaMs: number;
    };

/**
 * What a gesture needs beyond the model and the view: the render a click's
 * cursor aim is read against, and the viewport a new mask is centred in.
 * `resolved`/`bundle` are null before anything has rendered — addZoom and
 * addMask both fall back rather than failing outright when so.
 */
export interface GestureContext {
  resolved: ResolvedPlan | null;
  bundle: FrameBundle | null;
  viewport: { width: number; height: number };
}

/**
 * A gesture that cannot be applied, and why.
 *
 * The reason is mandatory and is shown to the author. A drag that quietly
 * snapped back would be indistinguishable from a drag the editor never
 * received — the defect class CLAUDE.md opens with.
 */
export interface Refusal {
  kind: "refusal";
  reason: string;
}

/**
 * `null` is the one legitimate third outcome and it is NOT a swallowed
 * failure: it means the drag ended where it began, so there is nothing to do
 * and nothing went wrong. The author already sees the result — the clip is
 * where they left it. A refusal line there would nag about a cancelled
 * gesture.
 */
export type GestureResult = EditCommand | Refusal | null;

/** Narrows any `kind`-tagged outcome — a `GestureResult`, a `ZoomPlacement`,
 *  a mask span — to its refusal. */
export const isRefusal = (result: { kind: string } | null): result is Refusal =>
  result !== null && result.kind === "refusal";

const refuse = (reason: string): Refusal => ({ kind: "refusal", reason });

/** The recorded pointer at an output instant, or the reason there is none. */
function cursorAt(
  ctx: GestureContext,
  atMs: number,
): { point: { x: number; y: number } } | { reason: string } {
  if (ctx.resolved === null || ctx.bundle === null) {
    return { reason: "nothing has rendered yet" };
  }
  if (ctx.bundle.cursorSamples.length === 0) {
    return { reason: "this take has no recorded pointer" };
  }
  const sourceMs = toSourceMs(ctx.resolved.timeline, atMs);
  if (
    ctx.bundle.cursorGaps.some(
      (g) => sourceMs >= g.startMs && sourceMs < g.endMs,
    )
  ) {
    return { reason: "the pointer was off the page here" };
  }
  const point = sampleCursor(ctx.resolved.cursor, sourceMs);
  return point ? { point } : { reason: "the pointer was not observed here" };
}

const zoomOf = (model: LaneModel, id: string): ZoomSeg | undefined =>
  model.zooms.find((z) => z.id === id);
const maskOf = (model: LaneModel, id: string): MaskSeg | undefined =>
  model.masks.find((m) => m.id === id);

/** Why a candidate placement crowds another zoom (`collides`). */
interface Collision {
  zoom: ZoomSeg;
  /** `start`: the two would start under `MIN_ZOOM_GAP_MS` apart.
   *  `endsAfter`: the candidate's authored end would run past `zoom`'s start.
   *  `startsInside`: the candidate would start before `zoom`'s authored end. */
  why: "start" | "endsAfter" | "startsInside";
}

/**
 * The other zoom, if any, that the candidate placement of zoom `self` would
 * crowd. `self` is `""` for a zoom that does not exist yet (`placeZoom`).
 *
 * Neither rule is a return to full frame. Since 2026-10-09 two zooms closer
 * than a full return are a legitimate layout — the camera glides from one
 * to the next, settled on both clicks (`insertNeutralKeys`) — and auto-zoom
 * writes them on every close pair of clicks, so the lane may not refuse
 * them. What it refuses:
 *
 * - two STARTS under `MIN_ZOOM_GAP_MS` apart, where the glide would be a
 *   whip — the rule `zoomsForClicks` skips a click by;
 * - an AUTHORED end past the start of a zoom after it, from either side: the
 *   candidate's own end (`endMs`, non-null only when the gesture authors or
 *   carries one) or an earlier zoom's end the candidate would start inside.
 *   The camera leaves a zoom to arrive at the next, so an end there names
 *   an instant it cannot honour. An automatic end is the compositor's and
 *   moves with its neighbours, so it never blocks anything.
 *
 * Each only when the gesture makes things worse than they already are: a
 * layout already tighter (a double click on one element zoomed by hand, a
 * document from before the rule) stays movable AWAY from its neighbour. That
 * clause is what kept the old room rule from freezing such zooms, and it
 * stays for the same reason.
 *
 * Until 2026-10-09 this was the gap between the two SPANS, which had to be
 * `ZOOM_ROOM_MS` (1550ms) — room for the camera to return between them.
 * Every pair auto-zoom now writes on close clicks sits at a gap of zero by
 * that measure (the first one's drawn end IS the next one's start), so
 * every drag of one toward its neighbour was refused.
 */
function collides(
  model: LaneModel,
  self: string,
  startMs: number,
  endMs: number | null,
): Collision | undefined {
  const current = model.zooms.find((z) => z.id === self);
  for (const z of model.zooms) {
    if (z.id === self) continue;
    const why = collisionWith(z, current, startMs, endMs);
    if (why) return { zoom: z, why };
  }
  return undefined;
}

/**
 * `collides`' rules against one other zoom `z`, for a candidate starting at
 * `startMs` that is the zoom `current` moved (undefined for a zoom not yet
 * on the lane). The one copy of the spacing rule: drags ask it through
 * `collides`, and `placeZoom` asks it at each start a new zoom can take, so
 * the editor never places a zoom that a drag would then refuse.
 *
 * "No worse than before" for the start gap means a wider distance on the
 * SAME side of `z`. Dragged across it to land inside the gap on the far
 * side, the two swap order closer than a glide, however much wider that
 * distance is than the one it left.
 */
function collisionWith(
  z: ZoomSeg,
  current: ZoomSeg | undefined,
  startMs: number,
  endMs: number | null,
): Collision["why"] | undefined {
  const gap = Math.abs(startMs - z.startMs);
  if (
    gap < MIN_ZOOM_GAP_MS &&
    (current === undefined ||
      gap < Math.abs(current.startMs - z.startMs) ||
      startMs < z.startMs !== current.startMs < z.startMs)
  )
    return "start";
  if (
    endMs !== null &&
    z.startMs > startMs &&
    endMs > z.startMs &&
    (current === undefined || !current.endAuthored || endMs > current.endMs)
  )
    return "endsAfter";
  if (
    z.endAuthored &&
    z.startMs < startMs &&
    z.endMs > startMs &&
    (current === undefined || startMs < current.startMs)
  )
    return "startsInside";
  return undefined;
}

/** The refusal for a `collides` answer, in the author's words. */
function crowded({ zoom, why }: Collision): Refusal {
  switch (why) {
    case "start":
      return refuse(
        `That would start it within ${MIN_ZOOM_GAP_MS}ms of the zoom "${zoom.id}" at ${clock(zoom.startMs)}; the camera needs ${MIN_ZOOM_GAP_MS}ms between two zooms to glide from one to the other.`,
      );
    case "endsAfter":
      return refuse(
        `That would end it after the zoom "${zoom.id}" starts at ${clock(zoom.startMs)}; a zoom can stay in until the next one, not past it.`,
      );
    case "startsInside":
      return refuse(
        `That would start it before the zoom "${zoom.id}" ends at ${clock(zoom.endMs)}; drag that zoom's end earlier first.`,
      );
  }
}

/** `m:ss.t` for a placement note. Tenths, because two zooms a second apart
 *  are the case the note exists to explain and whole seconds cannot tell
 *  them apart. */
const clock = (ms: number): string => {
  // Floored, like the transport's `formatClock`: rounding up would name an
  // instant the zoom has not reached.
  const tenths = Math.max(0, Math.floor(ms / 100));
  const seconds = Math.floor(tenths / 10);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${tenths % 10}`;
};

/**
 * The earliest and latest instant a zoom added at `atMs` can start.
 *
 * `applyCommand` gives an element zoom on a tick the default lead-in, so it
 * starts `leadInMs` before the click; the default point zoom takes none and
 * starts at it. Placing against both means anything the gesture authors,
 * every drag gesture can then move — at the cost of moving a point zoom
 * `-leadInMs` further from its neighbour than strictly necessary.
 */
function startsOf(atMs: number): { earliestMs: number; latestMs: number } {
  const { leadInMs } = CAMERA_DEFAULTS;
  return { earliestMs: atMs + leadInMs, latestMs: atMs };
}

/** Where a zoom asked for at one instant will actually go. */
export type ZoomPlacement =
  | {
      kind: "placed";
      /** The instant the zoom is added at — the click, unless it moved. */
      atMs: number;
      /** The segment the click adds by default — a point zoom, which takes
       *  no lead-in — for a view drawing the outcome before the click. The
       *  element fallback on a tick starts `leadInMs` earlier than this. */
      startMs: number;
      endMs: number;
      /** The zoom it was moved past, and which side of it, or null when the
       *  click's own instant had room. */
      movedPast: { zoom: ZoomSeg; side: "after" | "before" } | null;
    }
  | Refusal;

/**
 * The instant a new zoom lands when asked for at `atMs`: the click itself
 * when every start it can take passes `collides` — `MIN_ZOOM_GAP_MS` from
 * every other zoom's start, and outside every authored span — else the
 * first slot that does, walking forward past each zoom in the way and
 * falling back to the slot before the first collision when nothing fits
 * before the take ends. Refuses, saying so, only when neither side has a
 * slot. A zoom closer than a full return to its neighbour is placed: the
 * camera glides between the two (`collides`), and the span it draws stops
 * at the next zoom's start, where the render will end it.
 *
 * Until 2026-09-14 a collision was a refusal telling the author to "add
 * this one further away" — arithmetic the resolver had already done. The
 * view's hover ghost draws this same placement, so a moved zoom is visible
 * before the click, not only in the note after it.
 *
 * Pure and cheap: it runs on every pointermove over the Zoom lane.
 */
export function placeZoom(model: LaneModel, atMs: number): ZoomPlacement {
  const { leadInMs } = CAMERA_DEFAULTS;
  const lengthMs = model.zoomDefaultMs - leadInMs;
  const placed = (
    at: number,
    movedPast: { zoom: ZoomSeg; side: "after" | "before" } | null,
  ): ZoomPlacement => {
    // Its automatic end, unless a zoom after it starts first: the camera
    // glides on to that one instead of returning, and the render ends this
    // zoom's segment there.
    const nextStartMs = Math.min(
      ...model.zooms.map((z) => z.startMs).filter((ms) => ms > at),
    );
    return {
      kind: "placed",
      atMs: at,
      startMs: at,
      endMs: Math.min(at + model.zoomDefaultMs, nextStartMs),
      movedPast,
    };
  };
  // `collides`' rules for a zoom with no end of its own yet, at either
  // start it can take (`collisionWith`, the one copy of them).
  const blockerOf = (at: number): ZoomSeg | undefined => {
    const { earliestMs, latestMs } = startsOf(at);
    return model.zooms.find(
      (z) =>
        collisionWith(z, undefined, earliestMs, null) !== undefined ||
        collisionWith(z, undefined, latestMs, null) !== undefined,
    );
  };
  const first = blockerOf(atMs);
  if (!first) return placed(atMs, null);

  // Forward: the slot right after each zoom in the way, in turn.
  let blocker: ZoomSeg | undefined = first;
  for (let i = 0; i <= model.zooms.length && blocker; i++) {
    const at =
      Math.max(
        blocker.startMs + MIN_ZOOM_GAP_MS,
        blocker.endAuthored ? blocker.endMs : Number.NEGATIVE_INFINITY,
      ) - leadInMs;
    if (at + lengthMs + leadInMs > model.durationMs) break;
    const next = blockerOf(at);
    if (!next) return placed(at, { zoom: blocker, side: "after" });
    blocker = next;
  }
  // Backward: the slot right before each zoom in the way, in turn.
  blocker = first;
  for (let i = 0; i <= model.zooms.length && blocker; i++) {
    const at = blocker.startMs - MIN_ZOOM_GAP_MS;
    if (startsOf(at).earliestMs < 0) break;
    const prev = blockerOf(at);
    if (!prev) return placed(at, { zoom: blocker, side: "before" });
    blocker = prev;
  }
  return refuse(
    `There is no room for a zoom here: it would run into the zoom "${first.id}" at ${clock(first.startMs)}, and there is no slot either side of it. Drag that zoom to make space, or remove one.`,
  );
}

/** The span a mask added at `atMs` gets: to the next tick, or
 *  `MASK_DEFAULT_MS`, or the end of the take, whichever comes first. Refuses
 *  when the trim leaves nothing after `atMs` to cover. Shared by `addMask`
 *  and the Mask lane's hover ghost, so the ghost draws what the click adds. */
export function maskSpanAt(
  model: LaneModel,
  atMs: number,
): { kind: "span"; startMs: number; endMs: number } | Refusal {
  const { trim } = model.clip;
  if (atMs > trim.tailMs - TRIM_MIN_MS) {
    return refuse(
      "Move the playhead earlier: a mask needs some of the video after it to cover.",
    );
  }
  const nextTick =
    model.clip.ticks.find((t) => t.atMs > atMs + 1)?.atMs ??
    Number.POSITIVE_INFINITY;
  return {
    kind: "span",
    startMs: atMs,
    endMs: Math.min(nextTick, atMs + MASK_DEFAULT_MS, model.durationMs),
  };
}

/**
 * Whether two markers, computed independently by two `markerAt` calls at the
 * same `snapMs`, resolve to the same instant or to `end` before `start`.
 *
 * `markerAt` snaps anything within `snapMs` of a tick to offset 0, so a drag
 * that lands inside one tick's band no longer disagrees with the millisecond
 * arithmetic that guards each gesture above it (`MIN_SEGMENT_MS`, "cannot
 * cross") — those compare raw ms, and a snap can erase the gap between two
 * values they judged fine. Left uncaught, the zero-or-negative-length range
 * reaches `SceneDocumentSchema.parse` as a raw ZodError instead of a
 * refusal in the author's words — the exact defect class CLAUDE.md opens
 * with. `end === null` (an unauthored zoom end) never collapses: there is
 * no second marker to compare.
 */
/**
 * A mask edge at output instant `ms`, in the frames' own time (schema v13):
 * snapped as any edit is (`markerAt`), then read back through the editor's
 * current timeline (`refreshDerived` re-resolves it from the live document
 * on every edit, cuts included), so the edge stays on the frame it was
 * dropped on through every later cut. Snapped onto a step, it is that
 * step's frame. With no frames loaded there is no timeline, and the offset
 * is taken as source time — the lane says `estimated` until they load.
 */
function maskPointAt(
  model: LaneModel,
  ctx: GestureContext,
  ms: number,
  snapMs: number,
): SourcePoint {
  const marker = markerAt(model, ms, snapMs);
  const frame = ctx.bundle?.markers.find((m) => m.actionId === marker.actionId);
  if (marker.offsetMs === 0 || ctx.resolved === null || frame === undefined) {
    return { actionId: marker.actionId, sourceOffsetMs: marker.offsetMs };
  }
  return {
    actionId: marker.actionId,
    sourceOffsetMs: Math.round(
      toSourceMs(ctx.resolved.timeline, ms) - frame.sourceTimeMs,
    ),
  };
}

/** `collapsed` for a mask's two source points. */
const maskCollapsed = (start: SourcePoint, end: SourcePoint): boolean =>
  start.actionId === end.actionId && end.sourceOffsetMs <= start.sourceOffsetMs;

function collapsed(start: SceneMarker, end: SceneMarker | null): boolean {
  return (
    end !== null &&
    start.actionId === end.actionId &&
    end.offsetMs <= start.offsetMs
  );
}

const refuseNoLength = (segment: "mask" | "zoom"): Refusal =>
  refuse(`That would leave the ${segment} no length; drag its end further.`);

/** The trim's version of `refuseNoLength`. Named after the cause the author
 *  can act on — the two cuts landed on one step — rather than after the
 *  millisecond bound, which this drag did satisfy. */
const refuseSameStep = (edge: "head" | "tail"): Refusal =>
  refuse(
    `The cut would leave nothing: that puts the ${edge} on the same step as the ${edge === "head" ? "tail" : "head"}. Drag it further away, or move the other end first.`,
  );

/** The tick immediately after the one named `actionId`, in track order —
 *  not the nearest tick to some ms value. `addMask`'s collapse fallback
 *  pushes the end onto THIS step, so an author dragging near the very last
 *  step (which has none) is refused instead of silently landing nowhere. */
function tickAfter(
  model: LaneModel,
  actionId: string,
): { actionId: string } | undefined {
  const ticks = model.clip.ticks;
  const index = ticks.findIndex((t) => t.actionId === actionId);
  return index === -1 ? undefined : ticks[index + 1];
}

export function resolveGesture(
  model: LaneModel,
  view: TimelineView,
  gesture: Gesture,
  ctx: GestureContext,
): GestureResult {
  const { durationMs } = model;
  // F6: `markerAt` throws on a take with zero ticks — correctly, since a
  // take always has steps in the app's own flow — but every branch below
  // calls it (directly or through a stored marker's neighbourhood), so an
  // uncaught throw would reach the author as a stack trace instead of a
  // refusal. One guard here instead of one in each branch.
  if (model.clip.ticks.length === 0) {
    return refuse("This take has no steps to attach an edit to.");
  }
  switch (gesture.kind) {
    case "pieceEdge":
      return resolvePieceEdge(
        ctx.bundle,
        ctx.resolved?.timeline ?? null,
        model.clip.pieces,
        gesture.start,
        gesture.side,
        gesture.deltaMs,
      );
    case "trim": {
      const { trim } = model.clip;
      if (gesture.edge === "head") {
        if (gesture.toMs <= 0) return { kind: "setTrim", head: null };
        if (gesture.toMs > trim.tailMs - TRIM_MIN_MS) {
          return refuse(
            `The cut would leave nothing: the head has to stay at least ${TRIM_MIN_MS}ms before the tail.`,
          );
        }
        const head = markerAt(model, gesture.toMs, gesture.snapMs);
        // F1: the ms guard above compares raw milliseconds, and `markerAt`'s
        // snap band is wider than `TRIM_MIN_MS` at any realistic zoom — on a
        // 60s take across an ~800px track it is ~600ms against 200. So a
        // drag it just approved can still land the head on the very step the
        // tail sits on. Nothing downstream would catch it: `setTrim`
        // validates only that the action exists, `SceneDocumentSchema` has
        // an ordering refinement for masks and none for `edits.trim`, and
        // `resolveRange` only gets to report the collapse after the author
        // has already been handed a zero-length deliverable.
        if (collapsed(head, trim.tailMarker)) return refuseSameStep("head");
        return { kind: "setTrim", head };
      }
      if (gesture.toMs >= durationMs) return { kind: "setTrim", tail: null };
      if (gesture.toMs < trim.headMs + TRIM_MIN_MS) {
        return refuse(
          `The cut would leave nothing: the tail has to stay at least ${TRIM_MIN_MS}ms after the head.`,
        );
      }
      const tail = markerAt(model, gesture.toMs, gesture.snapMs);
      // Symmetric with the head above. `collapsed` takes (start, end), so
      // the stored head is the start here and the dragged tail the end; a
      // null head is the take's own start and can never collapse.
      if (trim.headMarker && collapsed(trim.headMarker, tail)) {
        return refuseSameStep("tail");
      }
      return { kind: "setTrim", tail };
    }

    case "addZoom": {
      // F5: this gated on CONTAINMENT — `atMs` inside an existing zoom —
      // while `moveZoom` and both `zoomEdge` branches gated on the room
      // between two zooms. A click one millisecond past another zoom's end
      // therefore succeeded and produced a segment every subsequent drag of
      // EITHER zoom refused, leaving the author something they can only
      // delete. `placeZoom` checks every start the zoom can take against
      // the same `MIN_ZOOM_GAP_MS` the drags answer to (`collides`), and
      // moves it rather than refusing.
      const placement = placeZoom(model, gesture.atMs);
      if (isRefusal(placement)) return placement;
      const { atMs, movedPast } = placement;
      // The snap is for the author's click. A placement that moved is not
      // the click any more, and snapping it onto a tick could pull the zoom
      // back into the clearance it was just moved out of.
      const marker = markerAt(model, atMs, movedPast ? 0 : gesture.snapMs);
      const placementNote = movedPast
        ? `Placed ${movedPast.side} the zoom at ${clock(movedPast.zoom.startMs)}: there was no room at ${clock(gesture.atMs)}.`
        : null;
      const scale = CAMERA_DEFAULTS.defaultZoomScale;
      // The cursor, by default, and at the instant the zoom actually lands.
      // Until 2026-09-14 a click within the snap band of a tick that could
      // zoom aimed at that step's element instead; the inspector's "Zoom on
      // this step" is the element route now.
      const cursor = cursorAt(ctx, atMs);
      if ("point" in cursor) {
        return {
          kind: "addZoom",
          marker,
          target: { kind: "point", x: cursor.point.x, y: cursor.point.y },
          scale,
          ...(placementNote === null ? {} : { note: placementNote }),
        };
      }
      // Nearest step with something on screen, by distance on the axis.
      const fallback = [...model.clip.ticks]
        .filter((t) => t.canZoom)
        .sort((a, b) => Math.abs(a.atMs - atMs) - Math.abs(b.atMs - atMs))[0];
      const anchorId = fallback
        ? view.beats.find((b) => b.actionId === fallback.actionId)?.anchorId
        : null;
      if (!fallback || !anchorId) {
        return refuse(
          `There is nothing to aim at here: ${cursor.reason}, and no step on this take has an element on screen.`,
        );
      }
      const target: ZoomTarget = { kind: "element", anchorId };
      // Both reasons ride on the event as its `note`; the lane model reads
      // it back as `aimFallback` and the inspector shows it.
      const aimNote = `Aimed at "${fallback.label}" instead of the cursor: ${cursor.reason}.`;
      return {
        kind: "addZoom",
        marker,
        target,
        scale,
        note: placementNote ? `${placementNote} ${aimNote}` : aimNote,
      };
    }

    case "moveZoom": {
      const z = zoomOf(model, gesture.id);
      if (!z) return refuse(`There is no zoom "${gesture.id}" to move.`);
      if (gesture.deltaMs === 0) return null;
      const startMs = z.startMs + gesture.deltaMs;
      const endMs = z.endMs + gesture.deltaMs;
      if (startMs < 0)
        return refuse("A zoom cannot start before the take does.");
      if (endMs > durationMs)
        return refuse("A zoom cannot end after the take does.");
      // An automatic end moves with the compositor, so only an authored one
      // is checked against the zooms after it.
      const crowding = collides(
        model,
        z.id,
        startMs,
        z.endAuthored ? endMs : null,
      );
      if (crowding) return crowded(crowding);
      const start = markerAt(model, startMs, gesture.snapMs);
      const end = z.endAuthored ? markerAt(model, endMs, gesture.snapMs) : null;
      // F1: only reachable with an authored end — an automatic one is
      // `null` and never collides with `start`.
      if (collapsed(start, end)) return refuseNoLength("zoom");
      return { kind: "setZoomRange", id: z.id, start, end };
    }

    case "zoomEdge": {
      const z = zoomOf(model, gesture.id);
      if (!z) return refuse(`There is no zoom "${gesture.id}" to resize.`);
      if (gesture.edge === "start") {
        // The start cap sits where the push-in sets off (`ZoomSeg.departMs`),
        // so `toMs` is a departure and the zoom lands `zoomInMs` after it.
        // Dragged off the take's start it sets off at the start, as early
        // as a push-in can.
        const departMs = Math.max(0, gesture.toMs);
        if (departMs > z.drawnEndMs - MIN_SEGMENT_MS) {
          return refuse(
            "A zoom's start cannot cross its end; it would start after the zoom already ends. Drag the end later first.",
          );
        }
        const landsMs = departMs + model.zoomInMs;
        if (z.endAuthored && landsMs > z.endMs - MIN_SEGMENT_MS) {
          return refuse(
            `Zooming in from there, it would land at ${clock(landsMs)}, after its end at ${clock(z.endMs)}. Drag the end later first.`,
          );
        }
        // The end stays where it is, so only the start is judged.
        const crowding = collides(model, z.id, landsMs, null);
        if (crowding) return crowded(crowding);
        // Snapped where the cap was dropped, then moved on to the landing.
        const departure = markerAt(model, departMs, gesture.snapMs);
        const start = {
          ...departure,
          offsetMs: departure.offsetMs + model.zoomInMs,
        };
        const end = z.endMarker;
        // F1: only reachable when the end is authored — `end === null`
        // never collapses (see `collapsed`).
        if (collapsed(start, end)) return refuseNoLength("zoom");
        return { kind: "setZoomRange", id: z.id, start, end };
      }
      if (gesture.toMs > durationMs)
        return refuse("A zoom cannot end after the take does.");
      if (gesture.toMs < z.startMs + MIN_SEGMENT_MS) {
        return refuse(
          "A zoom's end cannot cross its start; it would end before it starts. Drag the start earlier first.",
        );
      }
      // Authoring an end: it may run up to the next zoom's start.
      const crowding = collides(model, z.id, z.startMs, gesture.toMs);
      if (crowding) return crowded(crowding);
      const start = z.marker;
      const end = markerAt(model, gesture.toMs, gesture.snapMs);
      // F1: the ms-diff guard above (`MIN_SEGMENT_MS`) does not see a snap
      // that lands `end` back on `start`'s own tick at the same offset.
      if (collapsed(start, end)) return refuseNoLength("zoom");
      return { kind: "setZoomRange", id: z.id, start, end };
    }

    case "addMask": {
      const span = maskSpanAt(model, gesture.atMs);
      if (isRefusal(span)) return span;
      const { endMs } = span;
      const cursor = cursorAt(ctx, gesture.atMs);
      const centre =
        "point" in cursor
          ? cursor.point
          : { x: ctx.viewport.width / 2, y: ctx.viewport.height / 2 };
      const rect = defaultMaskRect(ctx.viewport, centre);
      const start = maskPointAt(model, ctx, gesture.atMs, gesture.snapMs);
      let end = maskPointAt(model, ctx, endMs, gesture.snapMs);
      // F1: the band that snaps `start` onto a tick can snap `end` onto the
      // very same tick — `nextTick` above is nearest-by-ms, not
      // nearest-by-track-order, so a playhead just inside a tick's band
      // makes both ends of a fresh mask land on it. Push the end to the
      // NEXT step in track order instead of authoring a zero-length mask;
      // with nothing after `start`, there is nowhere to push it to.
      if (maskCollapsed(start, end)) {
        const after = tickAfter(model, start.actionId);
        if (!after) {
          return refuse(
            "That would leave the mask no length; move the playhead earlier.",
          );
        }
        end = { actionId: after.actionId, sourceOffsetMs: 0 };
      }
      return "point" in cursor
        ? { kind: "addMask", rect, start, end }
        : {
            kind: "addMask",
            rect,
            start,
            end,
            note: `Placed at the centre of the frame: ${cursor.reason}. Drag it into place on the preview.`,
          };
    }

    case "moveMask": {
      const m = maskOf(model, gesture.id);
      if (!m) return refuse(`There is no mask "${gesture.id}" to move.`);
      if (m.wholeTake || m.startMarker === null || m.endMarker === null) {
        return refuse(
          "This mask covers the whole take, so it has no ends to move. Add a new mask to cover a stretch.",
        );
      }
      if (gesture.deltaMs === 0) return null;
      const startMs = m.startMs + gesture.deltaMs;
      const endMs = m.endMs + gesture.deltaMs;
      if (startMs < 0)
        return refuse("A mask cannot start before the take does.");
      if (endMs > durationMs)
        return refuse("A mask cannot end after the take does.");
      const start = maskPointAt(model, ctx, startMs, gesture.snapMs);
      const end = maskPointAt(model, ctx, endMs, gesture.snapMs);
      if (maskCollapsed(start, end)) return refuseNoLength("mask");
      return { kind: "setMaskRange", id: m.id, start, end };
    }

    case "maskEdge": {
      const m = maskOf(model, gesture.id);
      if (!m) return refuse(`There is no mask "${gesture.id}" to resize.`);
      if (m.wholeTake || m.startMarker === null || m.endMarker === null) {
        return refuse(
          "This mask covers the whole take, so it has no ends to move. Add a new mask to cover a stretch.",
        );
      }
      if (gesture.edge === "start") {
        if (gesture.toMs < 0)
          return refuse("A mask cannot start before the take does.");
        if (gesture.toMs > m.endMs - MIN_SEGMENT_MS) {
          return refuse(
            "A mask cannot start after it ends; drag its end later first.",
          );
        }
        const start = maskPointAt(model, ctx, gesture.toMs, gesture.snapMs);
        const end = m.endMarker;
        if (maskCollapsed(start, end)) return refuseNoLength("mask");
        return { kind: "setMaskRange", id: m.id, start, end };
      }
      if (gesture.toMs > durationMs)
        return refuse("A mask cannot end after the take does.");
      if (gesture.toMs < m.startMs + MIN_SEGMENT_MS) {
        return refuse(
          "A mask cannot end before it starts; drag its start earlier first.",
        );
      }
      const start = m.startMarker;
      const end = maskPointAt(model, ctx, gesture.toMs, gesture.snapMs);
      // F1: the ms-diff guard above does not see a snap that lands `end`
      // back on `start`'s own frame at the same offset.
      if (maskCollapsed(start, end)) return refuseNoLength("mask");
      return { kind: "setMaskRange", id: m.id, start, end };
    }
  }
}

/**
 * An authored pause, checked before it becomes a `setGap`.
 *
 * Shared by the timeline's pace drag and the inspector's number field, in
 * the same shape and for the same reason `resolveCameraOffset` used to be
 * shared: a value one of them would refuse is refused in the same words
 * when it arrives through the other. `input[type=number]` with `min="0"`
 * refuses nothing — a typed `-500` reaches `change` as `"-500"` and a typed
 * `abc` as `""`-or-`NaN` — so without this the author's own typo travelled
 * all the way to `SceneDocumentSchema.parse` and came back as a Zod path.
 *
 * `durationMs` of zero is valid and is not a clear: see spec §1.
 */
export function resolveGap(
  view: TimelineView,
  actionId: string,
  durationMs: number,
): GestureResult {
  const beat = view.beats.find((b) => b.actionId === actionId);
  if (beat === undefined) {
    return refuse(`There is no step "${actionId}" to pace.`);
  }
  // A gap is the time BETWEEN two steps, so the last step cannot carry one —
  // `planScene` emits no pace for it and `applyCommand` throws. Refused here
  // with the same fact, rather than sent on to become an error line the
  // gesture did not explain.
  if (beat.isLast) {
    return refuse(
      `"${actionId}" is the last step, and a pause is the time between two steps. Trim or add a step after it instead.`,
    );
  }
  // `Gap.durationMs` is `nonnegative()` and finite, and this is the same
  // rule said in the author's words rather than as a schema path. NaN
  // reaches here from `Number("abc")` on a field the author typed into.
  if (!Number.isFinite(durationMs)) {
    return refuse("A pause has to be a number of milliseconds.");
  }
  if (durationMs < 0) {
    return refuse(
      "A pause cannot be shorter than nothing. Type 0 to cut the dead air here, or use the recorded pause.",
    );
  }
  return { kind: "setGap", afterActionId: actionId, durationMs };
}
