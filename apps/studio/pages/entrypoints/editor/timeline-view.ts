import type { SourcePoint } from "@demoman/scene-schema";
import { el } from "../../src/editor/dom";
import type { Gesture } from "../../src/editor/gestures";
import {
  isRefusal,
  MASK_DEFAULT_MS,
  maskSpanAt,
  placeZoom,
  SNAP_PX,
} from "../../src/editor/gestures";
import type { HoverReport } from "../../src/editor/hover-report";
import {
  drawnEndMs,
  estimatedDepartMs,
  type LaneModel,
  type MaskSeg,
  type Tick,
  type ZoomSeg,
} from "../../src/editor/lanes";
// The controller ruling on this task's brief: `Selection` lives in
// `src/editor/selection.ts`, not here, so a later `src/` module (the
// inspector, Task 11) can import it without reaching into `entrypoints/`.
// Re-exported so every existing import of `Selection` from this file keeps
// working.
import { type Join, type Piece, samePoint } from "../../src/editor/pieces";
import { formatClock } from "../../src/editor/preview";
import type { Selection } from "../../src/editor/selection";
import { ZOOM_STEP } from "../../src/editor/shortcuts";
import {
  fitAll,
  MIN_SPAN_MS,
  pan,
  spanToZoom,
  toFraction,
  type Viewport,
  zoomAt,
  zoomTo,
  zoomToSpan,
} from "../../src/editor/viewport";
import { setCodeText } from "../../src/shell/code-spans";
import { type GlyphName, icon } from "../../src/shell/icons";
import { runsRouteClause } from "../../src/shell/runs-link";
import { withoutTip, withTip } from "../../src/shell/tooltip";

export type { Selection } from "../../src/editor/selection";

/**
 * The narrowest a clip may be drawn. Below this it cannot be clicked, let
 * alone dragged, and a timeline whose short beats are unreachable is a list
 * with extra steps.
 *
 * A widened clip is marked `data-to-scale="false"`. Widening without saying
 * so would make the lane lie about duration at exactly the zoom levels where
 * an author is least able to check.
 */
export const MIN_CLIP_FRACTION = 0.006;

export interface TimelineState {
  viewport: Viewport;
  selection: Selection;
  positionMs: number;
  /** The last refused gesture, or null. Persists until the next successful
   *  command — a toast the author was not watching is unrecoverable. */
  refusal: string | null;
  /** The take-wide hover check's verdict. Null is "nothing to say" — no
   *  check has run, or it flagged nothing. The SENTENCE about it is the
   *  status row's since 2026-09-22 (`renderTakeNotes`); this is still here
   *  because `buildLaneModel` reads it to flag the individual beats it is
   *  about, which is what draws a dot dashed. */
  hoverReport?: HoverReport | null;
  /**
   * Whether a drag is magnetic to the nearest beat. On by default: this
   * timeline snaps to markers by design, and a beat is the unit.
   *
   * Off is how an author reaches an instant no step sits on — the band is
   * `SNAP_PX` of the current window, which on a 60s take is ~600ms wide, so
   * with it on there are spans that simply cannot be dragged to. Toggled by
   * the Snap button in the bar and by S.
   */
  snapping: boolean;
  /** The removed piece whose card is open, or null. Owned by `main.ts`, the
   *  way `selection` is, so a redraw cannot close it. */
  openJoin?: string | null;
}

export interface TimelineHandlers {
  onSelect(selection: Selection): void;
  onSeek(outputMs: number): void;
  /**
   * A scrub gesture has begun, before the seek it begins with.
   *
   * `main.ts` pauses playback here. Ordered before the first `onSeek` on
   * purpose: a pause that arrived afterwards would let one tick of the
   * transport overwrite the instant the author just asked for, and the
   * playhead would drift out from under the pointer holding it.
   */
  onSeekStart(): void;
  onGesture(gesture: Gesture): void;
  onViewport(viewport: Viewport): void;
  /** The Snap button. `main.ts` owns the flag, the way it owns `viewport`. */
  onSnapping(snapping: boolean): void;
  /** The Split button: split the clip at the playhead (⌘B). */
  onSplit(): void;
  /** A join's card: bring that removed piece back. */
  onRestorePiece(removedId: string): void;
  /** A join's dot: open its card, or close it (null). */
  onOpenJoin(removedId: string | null): void;
}

/** Fixed precision, so a jsdom assertion has something stable to match and a
 *  browser does not re-layout on sub-pixel churn. */
const pct = (fraction: number): string => `${(fraction * 100).toFixed(4)}%`;

/** Where something with a span lands in the window, as fractions of a track. */
interface Box {
  left: number;
  width: number;
  /** False when the box was widened past its own span to stay reachable. */
  toScale: boolean;
}

/**
 * A span's box in the current window, or null when the window never reaches
 * it.
 *
 * Three jobs the plain fraction did not do:
 *
 *  - A span outside the window is not drawn at all. Left in, its `left` runs
 *    to thousands of percent at a zoomed-in viewport, and an absolutely
 *    positioned child that far out is still scrollable overflow: `#timeline`
 *    grew a horizontal scrollbar proportional to the zoom level.
 *  - A span that straddles an edge is cut to the window rather than drawn
 *    past it.
 *  - A span with no width of its own is pulled back inside the right edge.
 *    The take's LAST beat has none: its marker is the take's own source
 *    duration, so `toOutputMs` short-circuits to the end of the output and
 *    the clip's start and end are one instant. Drawn at `left: 100%` it was a
 *    sliver PAST its track, taking its pause band and its insert caret with
 *    it — the final step of every take, unreachable. `toScale` is how it says
 *    the width it was given is not the width it has.
 */
function boxOf(
  viewport: Viewport,
  startMs: number,
  endMs: number,
  // Zero for the cursor trace, which nothing clicks: widening it would
  // overstate how far the pointer moved, and there is no gesture on it that
  // a sliver would put out of reach.
  minWidth = MIN_CLIP_FRACTION,
): Box | null {
  if (endMs < viewport.startMs || startMs > viewport.endMs) return null;
  const from = Math.max(0, toFraction(viewport, startMs));
  const to = Math.min(1, toFraction(viewport, endMs));
  const width = Math.max(minWidth, to - from);
  return {
    left: Math.min(from, 1 - width),
    width,
    toScale: to - from >= minWidth,
  };
}

/**
 * Where the playhead goes in the current window, as a fraction of the axis.
 *
 * Clamped, not culled: the playhead is where the take currently IS, and a
 * transport that simply lost it while the author was zoomed in would look
 * exactly like a stopped player. Exported because `renderTransportRow` moves
 * the playhead in place sixty times a second rather than redrawing the
 * timeline, and two answers to "where is the playhead" is one too many.
 */
export const playheadFraction = (
  viewport: Viewport,
  positionMs: number,
): number => Math.min(1, Math.max(0, toFraction(viewport, positionMs)));

/**
 * The tick spacings the ruler is allowed to use, shortest first.
 *
 * Round numbers, so the labels read like a video's clock rather than like a
 * sample index — but not floored at a second: `MIN_SPAN_MS` is 250, so an
 * author can zoom to a window that straddles no whole second at all, and a
 * one-second floor left the ruler there with no ticks on it whatsoever.
 */
const TICK_STEPS_MS = [
  100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000,
];

/** `formatClock` to the second, plus a tenth once the ticks are closer
 *  together than one — at a 250ms window every tick reads "0:00" without it. */
const tickLabel = (ms: number, stepMs: number): string =>
  stepMs >= 1000
    ? formatClock(ms)
    : `${formatClock(ms)}.${Math.floor((ms % 1000) / 100)}`;

function rulerNode(model: LaneModel, state: TimelineState): HTMLElement {
  const ruler = el("div", "ruler");
  ruler.setAttribute("data-ruler", "");
  ruler.setAttribute("data-source", model.timeSource);
  const span = state.viewport.endMs - state.viewport.startMs;
  // Roughly a tick every tenth of the window, snapped up to a round number.
  const target = span / 10;
  const stepMs =
    TICK_STEPS_MS.find((step) => step >= target) ??
    Math.ceil(target / 60_000) * 60_000;
  for (
    let ms = Math.ceil(state.viewport.startMs / stepMs) * stepMs;
    ms <= state.viewport.endMs;
    ms += stepMs
  ) {
    const fraction = toFraction(state.viewport, ms);
    const tick = el("span", "tick", tickLabel(ms, stepMs));
    tick.style.left = pct(fraction);
    tick.dataset.fraction = String(fraction);
    ruler.append(tick);
  }
  rulerLabels?.observe(ruler);
  return ruler;
}

/**
 * Keeps every ruler label inside the ruler and clear of its neighbour.
 *
 * A label starts at its tick and runs right, so one near the end ran past
 * the ruler and was clipped. Turning the last 5% of ticks inward by
 * FRACTION was the first fix, and it was wrong both ways: a tick lands
 * exactly on the end whenever the window is a whole number of steps, and
 * on a narrow ruler the inward label then overlapped the one before it
 * (5000ms at the 952px floor: 78px between ticks, two 43px labels); on a
 * wide one a label at 0.96 that fitted was turned anyway. So it is decided
 * in pixels: a label turns inward only when it would run past the end, and
 * a label that would then overlap the one before it is not painted.
 *
 * Widths are read before anything is written, so a ruler costs one layout.
 * A ruler with no width (not laid out yet, or jsdom) is left alone.
 */
function placeRulerLabels(ruler: HTMLElement): void {
  const width = ruler.clientWidth;
  if (width === 0) return;
  const labels = [...ruler.querySelectorAll<HTMLElement>(".tick")].map(
    (tick) => ({ tick, w: tick.offsetWidth }),
  );
  let previousRight = Number.NEGATIVE_INFINITY;
  for (const { tick, w } of labels) {
    const at = Number(tick.dataset.fraction) * width;
    const inward = at + w > width;
    const start = inward ? at - w : at;
    const crowded = start < previousRight;
    tick.toggleAttribute("data-crowded", crowded);
    if (inward) tick.setAttribute("data-edge", "end");
    else tick.removeAttribute("data-edge");
    if (!crowded) previousRight = start + w;
  }
}

/**
 * One observer for every ruler, because a ruler's width changes without a
 * render — the panel opening or closing, the window resizing. Its first
 * callback comes after the new ruler's first layout and before its first
 * paint, so a label is never painted unplaced. A replaced ruler reports
 * once more as it leaves the document, and that is when it is dropped.
 * Absent where there is no `ResizeObserver` (jsdom), where nothing is laid
 * out to place.
 */
const rulerLabels =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        for (const entry of entries) {
          const ruler = entry.target as HTMLElement;
          if (ruler.isConnected) placeRulerLabels(ruler);
          else rulerLabels?.unobserve(ruler);
        }
      });

/**
 * A `.lane` row: a label cell and a second cell for whatever is drawn on the
 * axis.
 *
 * The ruler goes in one of these rather than straight into `.timeline` so
 * that the grid — and not a second copy of the label column's width — is what
 * gives it the clips' own origin and scale. Positioned against the whole box
 * it had neither: at a 1000px pane time 0 put it 84px left of the first clip,
 * and because the scales differed too (1000px against 916px) the error grew
 * across the axis, so a click on the ruler under a clip seeked somewhere else
 * entirely.
 */
function laneRow(label: HTMLElement, cell: HTMLElement): HTMLElement {
  const row = el("div", "lane");
  row.append(label, cell);
  return row;
}

/**
 * A track's header: the lane's glyph in its hue on a grey disc, then its
 * name, both centred on the track.
 *
 * Until 2026-09-22 it was 10px uppercase text right-aligned in an empty
 * column beside a coloured dot, and it read as a caption floating next to
 * the track rather than the head of its row. The glyph took the dot's job
 * — the hue is on the icon's stroke now — so the header carries one mark,
 * not two.
 *
 * The glyph sits in its own positioned box so a flag (see
 * `hoverCheckFlag`) can be pinned to the disc's corner without moving it.
 */
function laneHead(
  name: string,
  glyph: GlyphName,
  action?: HTMLElement,
): HTMLElement {
  const head = el("div", "lane-label lane-head");
  const title = el("span", "lane-title");
  const disc = el("span", "lane-glyph");
  disc.append(icon(glyph));
  title.append(disc, el("span", "lane-name", name));
  if (action) title.append(action);
  head.append(title);
  return head;
}

/**
 * What the Clip lane says about the hover pass, or null when the pass ran
 * and covered every hover — the one case with nothing to report.
 *
 * The design's failure table: "the Cursor lane is marked unchecked, never
 * clean". `renderTakeNotes` says it in a sentence in the status row, which
 * stays the place it is read; this is the mark on the lane that sends the
 * eye there, and without it `LaneModel.hoverCheck` is a field no view reads.
 *
 * An amber dot on the Clip glyph's disc since 2026-09-22, carrying this
 * sentence as its tooltip and accessible name. It was a second line of text
 * under "Clip" before that, which lifted the Clip header's glyph and name
 * 7px off its track's centre while Zoom and Mask sat centred, so the one
 * lane read as a different kind of lane.
 */
function hoverCheckFlag(check: LaneModel["hoverCheck"]): HTMLElement | null {
  let said: string;
  if (check.failed)
    said = "The hover check could not run, so nothing here has been checked.";
  else if (check.unchecked > 0)
    said = `${check.unchecked} ${
      check.unchecked === 1 ? "hover" : "hovers"
    } could not be checked.`;
  else return null;
  const flag = el("span", "lane-flag");
  flag.setAttribute("role", "img");
  flag.setAttribute("aria-label", said);
  flag.title = said;
  flag.setAttribute("data-hover-check", check.failed ? "failed" : "unchecked");
  return flag;
}

/** Below this a "drag" is a click that wobbled. */
const DRAG_THRESHOLD_PX = 3;

/**
 * Press-and-drag seeking, for the ruler and for the playhead's own handle.
 *
 * Both surfaces scrub the same way and must agree to the millisecond, so
 * there is one implementation and each caller passes the box it measures
 * against. Those boxes — the ruler row and the axis — are pinned to a single
 * origin and scale by `editor-timeline-geometry.test.ts`, which is what stops
 * a drag from landing on a different instant than the one drawn.
 *
 * Listens on `window`, for `armDrag`'s reason: a pointer that slides off a
 * 16px ruler mid-scrub must keep scrubbing, and an element-bound listener is
 * how a gesture silently stops halfway.
 */
function armScrub(
  surface: HTMLElement,
  measure: () => DOMRect,
  state: TimelineState,
  durationMs: number,
  handlers: TimelineHandlers,
): void {
  surface.addEventListener("pointerdown", (down: PointerEvent) => {
    down.preventDefault();
    // Or a press on the handle would reach the lane beneath it and select
    // whatever clip happens to be under the playhead.
    down.stopPropagation();

    const msAt = (clientX: number): number => {
      const rect = measure();
      if (rect.width === 0) return state.viewport.startMs;
      const fraction = (clientX - rect.left) / rect.width;
      const ms =
        state.viewport.startMs +
        fraction * (state.viewport.endMs - state.viewport.startMs);
      // Clamped to the TAKE, not to the window. A viewport zoomed past the
      // end of the output would otherwise let a drag seek into frames that
      // do not exist, and the transport would sit on a blank canvas.
      return Math.min(Math.max(ms, 0), durationMs);
    };

    handlers.onSeekStart();
    handlers.onSeek(msAt(down.clientX));

    const onMove = (move: PointerEvent): void =>
      handlers.onSeek(msAt(move.clientX));
    const onUp = (up: PointerEvent): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      handlers.onSeek(msAt(up.clientX));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

const same = (a: Selection, b: Selection): boolean =>
  a !== null &&
  b !== null &&
  a.kind === b.kind &&
  (a.kind === "tick"
    ? a.actionId === (b as { actionId: string }).actionId
    : a.kind === "piece"
      ? samePoint(a.start, (b as { start: SourcePoint | null }).start)
      : a.id === (b as { id: string }).id);

/**
 * The magnetic band around a beat, in ms at the current window — or zero
 * when the author has turned snapping off.
 *
 * One function rather than the expression inlined at each drag site, so
 * "snapping is off" cannot be true for three of the four gestures. A band of
 * zero is what `resolveGesture`'s `markerAt` already treats as "land where
 * the pointer is", so nothing downstream needed a second way to say it.
 */
const snapBand = (
  state: Pick<TimelineState, "snapping">,
  perPx: number,
): number => (state.snapping ? SNAP_PX * perPx : 0);

/** ms per px at the current window, for `snapMs` and for body deltas. */
function msPerPx(track: HTMLElement, viewport: Viewport): number {
  const width = track.getBoundingClientRect().width;
  return width === 0 ? 0 : (viewport.endMs - viewport.startMs) / width;
}

function msAt(track: HTMLElement, viewport: Viewport, clientX: number): number {
  const rect = track.getBoundingClientRect();
  const fraction = rect.width === 0 ? 0 : (clientX - rect.left) / rect.width;
  return viewport.startMs + fraction * (viewport.endMs - viewport.startMs);
}

/** Where a drag currently is: the instant under the pointer, the delta from
 *  the press, and the snap band, all in ms. */
interface Drop {
  toMs: number;
  deltaMs: number;
  snapMs: number;
}

/**
 * What a drag looks like while it is still held.
 *
 * `move` repaints the dragged thing at the pointer on every pointermove past
 * the click threshold; `end` puts it back where the model has it, and runs
 * before the gesture is dispatched on release. The restore is not optional:
 * a drop the resolver turns into nothing (`null`) never re-renders, and
 * without it the handle would stay where the pointer left it while the trim
 * underneath had not moved — a drag that looked applied and was not.
 *
 * The preview is geometry only. It does not snap, and it does not know the
 * limits `resolveGesture` will apply on release; a handle dragged past the
 * other end previews there and then snaps back with the refusal line saying
 * why. Previewing the resolver's verdict on every pixel would mean running
 * it on every pixel, and the refusal text flickering under a moving hand.
 */
interface DragPreview {
  move(drop: Drop): void;
  end(): void;
}

/**
 * One drag at a time, tracked on `window` rather than on the element (a
 * pointer that leaves it mid-drag must keep dragging). `make` receives the
 * drop instant, the delta from the press, and the snap band in ms.
 *
 * Until 2026-09-14 the pointermove listener only decided whether the press
 * counted as a drag, so nothing on the timeline moved until release, and an
 * author trimming a clip was aiming blind. `preview` is what moves now.
 */
function armDrag(
  target: HTMLElement,
  track: HTMLElement,
  state: TimelineState,
  make: (drop: Drop) => Gesture,
  handlers: TimelineHandlers,
  preview?: DragPreview,
): void {
  target.addEventListener("pointerdown", (down: PointerEvent) => {
    down.preventDefault();
    down.stopPropagation();
    // Marked for the length of the press, so the stylesheet can keep an
    // edge handle showing while it is dragged: handles show on hover, and a
    // pointer that outruns its block mid-drag is no longer hovering it.
    target.setAttribute("data-dragging", "");
    const startX = down.clientX;
    let moved = false;
    const dropAt = (clientX: number): Drop => {
      const perPx = msPerPx(track, state.viewport);
      return {
        toMs: msAt(track, state.viewport, clientX),
        deltaMs: (clientX - startX) * perPx,
        snapMs: snapBand(state, perPx),
      };
    };
    const onMove = (move: PointerEvent): void => {
      if (Math.abs(move.clientX - startX) > DRAG_THRESHOLD_PX) moved = true;
      if (moved) preview?.move(dropAt(move.clientX));
    };
    const onUp = (up: PointerEvent): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      target.removeAttribute("data-dragging");
      if (!moved) return; // a press that never moved is a click
      preview?.end();
      handlers.onGesture(make(dropAt(up.clientX)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

const clamp01 = (fraction: number): number =>
  Math.max(0, Math.min(1, fraction));

/**
 * Paint one trim side at `fraction` of the track: the handle, and the shaded
 * block behind it.
 *
 * The block IS the trim: it spans head to tail, so the cut is whatever bare
 * track is left either side. That replaced a pair of `[data-cut]` overlays
 * shading the cut regions over a full-width bed (2026-09-21, with the flat
 * dock) — with a block there is nothing to shade, and two ways of saying
 * where the trim is could disagree.
 */
function paintTrim(
  track: HTMLElement,
  handle: HTMLElement,
  edge: "head" | "tail",
  fraction: number,
): void {
  const f = clamp01(fraction);
  handle.style.left = pct(f);
  const block = track.querySelector<HTMLElement>("[data-clip-block]");
  // A window zoomed past the trim draws no block at all (`boxOf` returns
  // null), and the handle is still draggable there — so this is a real
  // state, not a missing element.
  if (block === null) return;
  // The side not being dragged stays where the model put it, which is what
  // `data-block-head`/`data-block-tail` are for: a fraction read back off
  // `style.left` would be re-parsing this function's own output, and the
  // two would drift as soon as either end were clamped.
  const other = Number(
    block.dataset[edge === "head" ? "blockTail" : "blockHead"],
  );
  if (!Number.isFinite(other)) return;
  const head = edge === "head" ? f : other;
  const tail = edge === "head" ? other : f;
  // Crossed ends draw as an empty block rather than a negative width. The
  // resolver refuses the crossing on release; until then the picture just
  // shows the take squeezed to nothing, which is what the gesture means.
  const left = Math.min(head, tail);
  block.style.left = pct(left);
  block.style.width = pct(Math.max(head, tail) - left);
}

/**
 * One edge of a piece: inward cuts frames off it, outward brings back frames
 * removed beside it (`resolvePieceEdge` says how far). While dragged it
 * follows the pointer and says by how much.
 */
function pieceEdge(
  piece: Piece,
  side: "start" | "end",
  track: HTMLElement,
  state: TimelineState,
  handlers: TimelineHandlers,
): HTMLElement {
  const handle = el("div", "edge");
  handle.setAttribute("data-edge", side);
  handle.setAttribute(
    "aria-label",
    side === "start" ? "Drag the piece's start" : "Drag the piece's end",
  );
  armDrag(
    handle,
    track,
    state,
    ({ deltaMs }) => ({
      kind: "pieceEdge",
      start: piece.start,
      side,
      deltaMs,
    }),
    handlers,
    {
      move: ({ deltaMs }) => {
        const px = deltaMs / msPerPx(track, state.viewport);
        handle.style.transform = `translateX(${px}px)`;
        const grown = side === "end" ? deltaMs : -deltaMs;
        handle.setAttribute(
          "data-readout",
          `${grown < 0 ? "−" : "+"}${(Math.abs(grown) / 1000).toFixed(1)}s`,
        );
      },
      end: () => {
        handle.style.transform = "";
        handle.removeAttribute("data-readout");
      },
    },
  );
  return handle;
}

/**
 * The card a join's dot opens: how much was removed, from where to where in
 * the recording, and Restore. `showJoinCard` sets it over the dot once it is
 * on the page.
 */
function joinCard(
  join: Join,
  fraction: number,
  seconds: string,
  handlers: TimelineHandlers,
): HTMLElement {
  const card = el("div", "join-card");
  card.setAttribute("data-join-card", join.removedId);
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Removed frames");
  card.setAttribute(
    "data-align",
    fraction > 0.85 ? "end" : fraction < 0.15 ? "start" : "center",
  );
  card.addEventListener("pointerdown", (event) => event.stopPropagation());
  card.addEventListener("click", (event) => event.stopPropagation());
  const what = el("div", "join-card-what");
  const title = el("b");
  const span = el("span");
  if (join.unplaced === undefined) {
    title.textContent = `${seconds} removed`;
    span.textContent = `${clockTenths(join.srcStartMs)} to ${clockTenths(join.srcEndMs)}`;
  } else {
    // A piece that removed no frames: why, and a way to clear it.
    title.textContent = "Removes no frames";
    span.textContent =
      join.unplaced.charAt(0).toUpperCase() + join.unplaced.slice(1);
  }
  what.append(title, span);
  const restore = el("button", "join-card-restore");
  restore.type = "button";
  restore.setAttribute("data-restore", join.removedId);
  restore.textContent = join.unplaced === undefined ? "Restore" : "Discard";
  restore.addEventListener("click", () =>
    handlers.onRestorePiece(join.removedId),
  );
  card.append(what, restore);
  return card;
}

/** m:ss.t — the card names instants a tenth apart. */
function clockTenths(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const seconds = (tenths % 600) / 10;
  return `${Math.floor(tenths / 600)}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function clipTrack(
  model: LaneModel,
  state: TimelineState,
  handlers: TimelineHandlers,
): HTMLElement {
  const track = el("div", "track");
  track.setAttribute("data-track", "clip");
  const { clip } = model;

  for (const span of clip.degraded) {
    const box = boxOf(state.viewport, span.startMs, span.endMs, 0);
    if (box === null) continue;
    const node = el("div", "degraded");
    node.setAttribute("data-degraded", "");
    node.style.left = pct(box.left);
    node.style.width = pct(box.width);
    track.append(node);
  }
  // The take itself: one block spanning the trim. What is cut is the bare
  // track either side of it — there is no second overlay saying the same
  // thing, which is why `paintTrim` resizes this rather than shading
  // around it.
  const head = toFraction(state.viewport, clip.trim.headMs);
  const tail = toFraction(state.viewport, clip.trim.tailMs);
  const blockBox = boxOf(state.viewport, clip.trim.headMs, clip.trim.tailMs);
  if (blockBox !== null) {
    const block = el("div", "seg");
    block.setAttribute("data-clip-block", "");
    block.setAttribute("data-kind", "clip");
    block.setAttribute("data-to-scale", String(blockBox.toScale));
    block.style.left = pct(blockBox.left);
    block.style.width = pct(blockBox.width);
    // Where the model put each end, for `paintTrim` to hold the other side
    // still with. Read off the dataset rather than re-parsed out of the
    // style it is about to overwrite.
    block.dataset.blockHead = String(blockBox.left);
    block.dataset.blockTail = String(blockBox.left + blockBox.width);
    // Unlabelled, deliberately. There is exactly one clip in a take, and
    // its name is already on the header's own name field — repeating it
    // here names nothing the lane did not already say. If several clips
    // ever share this lane they will need labels to tell them apart, and
    // that is when to add one.
    track.append(block);
  }
  // The pieces: the clip between splits and joins, drawn INSIDE the block,
  // so a pointer over one is still over the block (its trim handles) and a
  // click selects the piece (spec 2026-10-22 split-tool). Once the clip is in
  // more than one piece, each piece is its own rounded block and lights on
  // its own; a clip in one piece stays the one block it always was.
  const clipBlock = track.querySelector<HTMLElement>("[data-clip-block]");
  const pieces = clip.pieces;
  if (clipBlock !== null && blockBox !== null && blockBox.width > 0) {
    if (pieces.length > 1) clipBlock.setAttribute("data-pieces", "");
    pieces.forEach((piece, index) => {
      const box = boxOf(state.viewport, piece.startMs, piece.endMs, 0);
      if (box === null) return;
      const from = Math.max(0, (box.left - blockBox.left) / blockBox.width);
      const to = Math.min(
        1,
        (box.left + box.width - blockBox.left) / blockBox.width,
      );
      if (to <= from) return;
      const wrap = el("div", "piece-wrap");
      wrap.style.left = pct(from);
      wrap.style.width = pct(to - from);
      const node = el("button", "piece");
      node.type = "button";
      node.setAttribute("data-piece", String(piece.startMs));
      node.setAttribute("aria-label", "Piece of the clip");
      if (same(state.selection, { kind: "piece", start: piece.start })) {
        wrap.setAttribute("data-selected", "");
        node.setAttribute("data-selected", "");
      }
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        handlers.onSelect({ kind: "piece", start: piece.start });
      });
      wrap.append(node);
      // Each edge drags, except the clip's own first and last edge where
      // nothing was removed: those are the trim, drawn below.
      const first = index === 0;
      const last = index === pieces.length - 1;
      if (!first || piece.before !== null)
        wrap.append(pieceEdge(piece, "start", track, state, handlers));
      if (!last || piece.after !== null)
        wrap.append(pieceEdge(piece, "end", track, state, handlers));
      clipBlock.append(wrap);
    });
  }
  // Where a removed piece was: an orange line in the lane, which is a mark
  // only, and a dot above the lane, which is the one thing to click — so the
  // lane's full height stays the handles'. A click opens a card naming what
  // was removed, with Restore; a press that turns into a drag opens nothing.
  // The dot and its line share one position, so they cannot drift apart:
  // 1px in from either end of the lane, and joins at one instant fan out
  // together, inward, so each dot stays reachable.
  for (const join of clip.joins) {
    const fraction = toFraction(state.viewport, join.atMs);
    if (fraction < 0 || fraction > 1) continue;
    const inward = fraction >= 1 ? -1 : 1;
    const nudge =
      (fraction >= 1 ? -1 : fraction <= 0 ? 1 : 0) + inward * join.index * 14;
    const left = `calc(${pct(fraction)} + ${nudge}px)`;
    const open = state.openJoin === join.removedId;
    const seconds = `${((join.srcEndMs - join.srcStartMs) / 1000).toFixed(1)}s`;
    const dot = el("button", "join");
    dot.type = "button";
    dot.setAttribute("data-join", join.removedId);
    dot.setAttribute(
      "aria-label",
      join.unplaced === undefined ? `Removed, ${seconds}` : "Removed nothing",
    );
    dot.setAttribute("aria-expanded", String(open));
    dot.style.left = left;
    let down: { x: number; y: number } | null = null;
    dot.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      down = { x: event.clientX, y: event.clientY };
    });
    dot.addEventListener("click", (event) => {
      event.stopPropagation();
      // `detail` 0 is a keyboard press, which has no travel to check.
      const moved =
        down !== null &&
        event.detail > 0 &&
        Math.hypot(event.clientX - down.x, event.clientY - down.y) >
          DRAG_THRESHOLD_PX;
      down = null;
      if (!moved) handlers.onOpenJoin(open ? null : join.removedId);
    });
    const seam = el("span", "seam");
    seam.setAttribute("data-seam", join.removedId);
    seam.style.left = left;
    track.append(seam, dot);
    if (open) track.append(joinCard(join, fraction, seconds, handlers));
  }
  // The trim. Where frames were removed at the clip's own start or end and
  // the trim there is untouched, that end is the piece's edge instead (it
  // brings those frames back first), so no trim handle is drawn on it.
  const firstPiece = pieces[0];
  const lastPiece = pieces.at(-1);
  for (const [edge, fraction, timing] of [
    ["head", head, clip.trim.headTiming],
    ["tail", tail, clip.trim.tailTiming],
  ] as const) {
    if (fraction < 0 || fraction > 1) continue;
    if (
      edge === "head"
        ? clip.trim.headMarker === null && (firstPiece?.before ?? null) !== null
        : clip.trim.tailMarker === null && (lastPiece?.after ?? null) !== null
    ) {
      continue;
    }
    const handle = el("div", "handle");
    handle.setAttribute("data-trim", edge);
    handle.setAttribute("data-timing", timing);
    handle.style.left = pct(fraction);
    armDrag(
      handle,
      track,
      state,
      ({ toMs, snapMs }) => ({ kind: "trim", edge, toMs, snapMs }),
      handlers,
      {
        move: ({ toMs }) =>
          paintTrim(track, handle, edge, toFraction(state.viewport, toMs)),
        end: () => paintTrim(track, handle, edge, fraction),
      },
    );
    track.append(handle);
  }
  // The beats, one dot per recorded step, on the block whose length they
  // fall within. They had a strip of their own between 2026-09-21 and
  // 2026-09-22, moved out because a dot on the block covered the block's
  // name — and the block has had no name since that same day (see above),
  // so the strip was a row of the dock paying for a conflict that no
  // longer existed. A beat is stacked above a trim handle, and the handle
  // stays grabbable above and below it (see the stylesheet).
  for (const tick of clip.ticks) {
    const fraction = toFraction(state.viewport, tick.atMs);
    if (fraction < 0 || fraction > 1) continue;
    const node = el("button", "tick");
    node.type = "button";
    node.setAttribute("data-tick", tick.actionId);
    // The verb picks the mark's shape and tone (see the stylesheet).
    node.setAttribute("data-verb", tick.verb);
    // The step's icon: drawn in the studio, hidden on the extension's page.
    const glyph = STEP_GLYPH[tick.verb];
    if (glyph !== undefined) node.append(icon(glyph));
    node.setAttribute("data-timing", tick.timing);
    node.setAttribute("aria-label", `${tick.verb} ${tick.label}`);
    node.title = `${tick.verb} ${tick.label}`;
    // The frames carry no marker for this step: it is in the take but not
    // in the video, and Delete is its only route.
    if (tick.timing === "estimated") {
      node.setAttribute("data-not-in-video", "");
      node.title = node.title
        ? `${node.title} — not in the video`
        : "Not in the video";
    }
    if (tick.flag) node.setAttribute("data-flag", tick.flag);
    if (tick.cut) node.setAttribute("data-cut", "");
    // Fanned out by how many ticks already sit at this instant, so each
    // stays reachable by pointer. Applied to EVERY tick, not only cut ones:
    // the surviving step a run closes on shares the seam with it, and it is
    // the one that would otherwise sit on top. Read once — the attribute is
    // what a test asserts on and the custom property is what the stylesheet
    // offsets by, and they must not be able to disagree.
    const stackIndex = String(stackIndexAt(clip.ticks, tick));
    node.setAttribute("data-stack-index", stackIndex);
    node.style.setProperty("--tick-stack", stackIndex);
    if (same(state.selection, { kind: "tick", actionId: tick.actionId }))
      node.setAttribute("data-selected", "");
    node.style.left = pct(fraction);
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onSelect({ kind: "tick", actionId: tick.actionId });
    });
    track.append(node);
  }
  return track;
}

/**
 * How many ticks already sit at this one's instant.
 *
 * Cuts stack ticks. Every step in a merged run maps to the seam, and so
 * does the SURVIVING step the run closes on — its marker IS the cut's
 * closing instant. Stacked, only the last one drawn is clickable, and since
 * ticks are appended in beat order that last one is the survivor: clicking
 * a cut step selected the step after it, and the cut step's panel — the
 * only surface carrying "Restore step" — became unreachable by pointer.
 *
 * So this counts EVERY earlier tick at the same instant, cut or not. An
 * earlier version counted only consecutive cut ticks, which left the run's
 * first tick at index 0 — exactly under the survivor.
 */
function stackIndexAt(ticks: readonly Tick[], tick: Tick): number {
  const index = ticks.indexOf(tick);
  let n = 0;
  for (let i = 0; i < index; i++) {
    if (ticks[i]?.atMs === tick.atMs) n += 1;
  }
  return n;
}

function segmentNode(
  seg: ZoomSeg | MaskSeg,
  kind: "zoom" | "mask",
  track: HTMLElement,
  model: LaneModel,
  state: TimelineState,
  handlers: TimelineHandlers,
): HTMLElement | null {
  // A zoom is drawn as the preview shows it (`ZoomSeg.departMs`,
  // `drawnEndMs`): from its push-in setting off, not from its landing.
  const zoom = kind === "zoom" ? (seg as ZoomSeg) : null;
  const drawnFromMs = zoom ? zoom.departMs : seg.startMs;
  const drawnToMs = zoom ? zoom.drawnEndMs : seg.endMs;
  const box = boxOf(state.viewport, drawnFromMs, drawnToMs);
  if (box === null) return null;
  const node = el("div", "seg");
  node.setAttribute("data-segment", seg.id);
  node.setAttribute("data-kind", kind);
  node.setAttribute("data-timing", seg.timing);
  node.setAttribute("data-to-scale", String(box.toScale));
  node.style.left = pct(box.left);
  node.style.width = pct(box.width);
  const { trim } = model.clip;
  if (drawnToMs <= trim.headMs || drawnFromMs >= trim.tailMs)
    node.setAttribute("data-outside-trim", "");
  const selection: Selection = { kind, id: seg.id };
  if (same(state.selection, selection)) node.setAttribute("data-selected", "");
  const wholeTake = kind === "mask" && (seg as MaskSeg).wholeTake;
  if (kind === "zoom") {
    const z = seg as ZoomSeg;
    // Set but not styled: the pill-shaped cap that used to mark an
    // automatic end was squared on 2026-09-20. `src/editor/gestures.ts`
    // reads the same fact — `endAuthored` off the lane model — to decide
    // what a drag on that end does, so the attribute stays.
    node.setAttribute("data-authored-end", String(z.endAuthored));
    node.setAttribute("data-clamped", String(z.clamped));
    node.append(el("span", "seg-label", `${z.scale.toFixed(1)}x`));
  } else {
    if (wholeTake) node.setAttribute("data-whole-take", "");
    node.append(
      el("span", "seg-label", wholeTake ? "mask · whole take" : "mask"),
    );
  }
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    handlers.onSelect(selection);
  });
  if (!wholeTake) {
    const paint = (left: number, width: number): void => {
      node.style.left = pct(left);
      node.style.width = pct(width);
    };
    const restore = (): void => paint(box.left, box.width);
    const windowMs = state.viewport.endMs - state.viewport.startMs;
    for (const edge of ["start", "end"] as const) {
      const cap = el("div", "cap");
      cap.setAttribute("data-cap", edge);
      armDrag(
        cap,
        track,
        state,
        ({ toMs, snapMs }) =>
          kind === "zoom"
            ? { kind: "zoomEdge", id: seg.id, edge, toMs, snapMs }
            : { kind: "maskEdge", id: seg.id, edge, toMs, snapMs },
        handlers,
        {
          move: ({ toMs }) => {
            // The other end stays put; this one follows the pointer, never
            // past the other. Crossing is the resolver's refusal on release.
            const f = clamp01(toFraction(state.viewport, toMs));
            const right = box.left + box.width;
            if (edge === "start") {
              const left = Math.min(f, right);
              paint(left, right - left);
            } else {
              paint(box.left, Math.max(f, box.left) - box.left);
            }
          },
          end: restore,
        },
      );
      node.append(cap);
    }
    armDrag(
      node,
      track,
      state,
      ({ deltaMs, snapMs }) =>
        kind === "zoom"
          ? { kind: "moveZoom", id: seg.id, deltaMs, snapMs }
          : { kind: "moveMask", id: seg.id, deltaMs, snapMs },
      handlers,
      {
        move: ({ deltaMs }) => {
          // Length kept, slid within the window.
          const shift = windowMs === 0 ? 0 : deltaMs / windowMs;
          paint(
            Math.max(0, Math.min(1 - box.width, box.left + shift)),
            box.width,
          );
        },
        end: restore,
      },
    );
  }
  return node;
}

function segmentTrack(
  kind: "zoom" | "mask",
  model: LaneModel,
  state: TimelineState,
  handlers: TimelineHandlers,
): HTMLElement {
  const track = el("div", "track");
  track.setAttribute("data-track", kind);
  const segs: (ZoomSeg | MaskSeg)[] =
    kind === "zoom" ? model.zooms : model.masks;
  for (const seg of segs) {
    const node = segmentNode(seg, kind, track, model, state, handlers);
    if (node) track.append(node);
  }
  // Empty space on either lane adds a segment centred under the pointer.
  // Children stop propagation, so a click that reaches here was on the
  // track.
  track.addEventListener("click", (event) => {
    if (event.target !== track) return;
    const perPx = msPerPx(track, state.viewport);
    handlers.onGesture({
      kind: kind === "zoom" ? "addZoom" : "addMask",
      atMs: centredAt(kind, model, msAt(track, state.viewport, event.clientX)),
      snapMs: snapBand(state, perPx),
    });
  });
  armGhost(track, kind, model, state);
  return track;
}

/**
 * The instant a new segment starts when the pointer is at `pointerMs`: half
 * a default length earlier, so the segment sits centred under the pointer
 * rather than hanging off its right — which read as placed at the pointer's
 * end. Clamped to the take, so a pointer near its start adds a segment that
 * begins at the start. One rule for the hover ghost and the click, so the
 * ghost draws what the click adds.
 */
function centredAt(
  kind: "zoom" | "mask",
  model: LaneModel,
  pointerMs: number,
): number {
  // A zoom's block runs from `zoomInMs` before its landing to
  // `zoomDefaultMs` after it, so the landing sits right of the block's centre.
  const half =
    kind === "zoom"
      ? (model.zoomDefaultMs - model.zoomInMs) / 2
      : MASK_DEFAULT_MS / 2;
  return Math.max(0, Math.min(model.durationMs, pointerMs - half));
}

/**
 * The span a click on empty track at `atMs` would add, or null when the
 * resolver would refuse it. The same placement `resolveGesture` uses —
 * `placeZoom` slides a zoom past a collision, `maskSpanAt` stops a mask at
 * the next tick — so the ghost draws the outcome and not the pointer.
 */
function ghostSpanAt(
  kind: "zoom" | "mask",
  model: LaneModel,
  atMs: number,
): { startMs: number; endMs: number } | null {
  const span =
    kind === "zoom" ? placeZoom(model, atMs) : maskSpanAt(model, atMs);
  if (isRefusal(span)) return null;
  if (kind === "mask") return { startMs: span.startMs, endMs: span.endMs };
  // Drawn as `segmentNode` draws a placed zoom, among the ones already there.
  return {
    startMs: estimatedDepartMs(model.zooms, span.startMs, model.zoomInMs),
    endMs: drawnEndMs(model.zooms, span.startMs, span.endMs),
  };
}

/**
 * A translucent segment under the pointer on empty track, where a click
 * would put the new zoom or mask. Gone when the pointer leaves the track,
 * moves onto a segment (which stops the move from reaching the track), or
 * rests where the click would be refused — a ghost there would promise a
 * segment the click cannot deliver.
 *
 * `pointer-events: none` in the stylesheet keeps the ghost itself out of
 * the pointer's way, so the move and the click both still land on the
 * track beneath it.
 */
function armGhost(
  track: HTMLElement,
  kind: "zoom" | "mask",
  model: LaneModel,
  state: TimelineState,
): void {
  let ghost: HTMLElement | null = null;
  const clear = (): void => {
    ghost?.remove();
    ghost = null;
  };
  track.addEventListener("pointermove", (move: PointerEvent) => {
    if (move.target !== track) return clear();
    const span = ghostSpanAt(
      kind,
      model,
      centredAt(kind, model, msAt(track, state.viewport, move.clientX)),
    );
    const box = span && boxOf(state.viewport, span.startMs, span.endMs);
    if (box === null) return clear();
    if (ghost === null) {
      ghost = el("div", "seg");
      ghost.setAttribute("data-ghost", kind);
      ghost.setAttribute("aria-hidden", "true");
      track.append(ghost);
    }
    ghost.style.left = pct(box.left);
    ghost.style.width = pct(box.width);
  });
  track.addEventListener("pointerleave", clear);
}

/** A step's icon on the Clip lane, by its verb: read at a glance, where the
 *  shapes before them had to be clicked to be read (the author,
 *  2026-10-19). A verb not here draws no icon. */
export const STEP_GLYPH: Readonly<Record<string, GlyphName>> = {
  click: "mousePointerClick",
  type: "type",
  moveTo: "mousePointer2",
  scrollTo: "moveVertical",
  waitFor: "hourglass",
  drag: "handGrab",
};

export function renderTimeline(
  root: HTMLElement,
  model: LaneModel,
  state: TimelineState,
  handlers: TimelineHandlers,
): void {
  const box = el("div", "timeline");

  // Clicking past everything drops the selection.
  //
  // Nothing else in any view calls `onSelect(null)` — the three sites in
  // `main.ts` that clear it are deleting the selected thing or following a
  // replacement notice — and the inspector shows the demo panel (export,
  // branding, render mode, the replacements list) only when the selection
  // resolves to nothing. So the first tick click of a session took all of
  // that off screen until the author deleted the very step they had just
  // clicked. Escape in `main.ts` is the same door for the keyboard.
  //
  // Ticks and segments stop their own clicks before this. What is listed is
  // what is NOT background: the ruler, the trim handles and the playhead's
  // grab are drag surfaces — a scrub that cleared the selection would throw
  // the author back to the demo panel every time they moved the playhead —
  // and empty space on the Zoom and Mask lanes already means "add one
  // here", which is an edit rather than a click past everything.
  box.addEventListener("click", (event) => {
    const from = event.target as HTMLElement | null;
    if (
      from?.closest(
        '[data-ruler], [data-trim], [data-playhead], [data-track="zoom"], [data-track="mask"], button',
      )
    )
      return;
    handlers.onSelect(null);
  });

  if (model.timeSource === "captured") {
    // The platform's re-film line, whole, where there is no Runs page
    // to send the author to (ruling R18).
    const timing = el("p", "muted");
    setCodeText(
      timing,
      model.rerunLine === null
        ? `Timing from the take, not from a render — ${runsRouteClause(model.authored)} to see the timing this demo will actually have.`
        : `Timing from the take, not from a render. ${model.rerunLine}`,
    );
    box.append(timing);
  }

  // The hover report used to be drawn here, in a `.bar` above the ruler,
  // and the take's notices in a list below the lanes. Both moved to the
  // status row on 2026-09-22 (`renderTakeNotes`): they are facts about the
  // take, not instruments, and a standing sentence inside the dock reads as
  // chrome that is permanently complaining. `state.hoverReport` stays on
  // this state object because `buildLaneModel` still needs it to flag the
  // individual beats it is about — the dots this file draws dashed.

  const ruler = rulerNode(model, state);
  // A press and drag, not only a click. The click alone was the whole of the
  // editor's seeking: no drag on the ruler, and a playhead under an `.axis`
  // with `pointer-events: none`, so the take could only be moved through by
  // pressing Play and waiting.
  armScrub(
    ruler,
    () => ruler.getBoundingClientRect(),
    state,
    model.durationMs,
    handlers,
  );
  // The ruler and the lanes share one positioned box, and the playhead's
  // overlay lives in it. Positioned against `.timeline` instead, the overlay
  // spanned the Fit button and the refusal line too.
  const lanes = el("div", "lanes");
  lanes.append(laneRow(el("b", "lane-label"), ruler));

  // The playhead's own column: an overlay over the lanes that the stylesheet
  // insets by the same label column, so `left: N%` means the same instant
  // here as it does inside a track. It is also what the wheel measures
  // against — a zoom anchored on a fraction of the WHOLE box would put the
  // instant under the pointer somewhere else once it landed.
  const axis = el("div", "axis");
  axis.setAttribute("data-axis", "");

  box.addEventListener("wheel", (event: WheelEvent) => {
    const rect = axis.getBoundingClientRect();
    if (rect.width === 0) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const fraction = (event.clientX - rect.left) / rect.width;
      handlers.onViewport(
        zoomAt(
          state.viewport,
          model.durationMs,
          event.deltaY < 0 ? 1.2 : 1 / 1.2,
          fraction,
        ),
      );
      return;
    }
    // Horizontal scroll, the design's third viewport gesture. The lanes are
    // laid out in percentages of the pane, so there is nothing for the
    // browser's own scrolling to move — panning the window is the only way a
    // zoomed-in take scrolls at all. Shift+wheel is the same gesture on a
    // mouse that has no horizontal axis.
    const deltaX = event.shiftKey ? event.deltaY : event.deltaX;
    if (deltaX === 0) return;
    event.preventDefault();
    const span = state.viewport.endMs - state.viewport.startMs;
    handlers.onViewport(
      pan(state.viewport, model.durationMs, (deltaX / rect.width) * span),
    );
  });

  const clipHead = laneHead("Clip", "film");
  // On the Clip header since 2026-09-22, with the beats the pass covers
  // (it rode an Actions strip's label while they had one).
  const flag = hoverCheckFlag(model.hoverCheck);
  if (flag !== null) clipHead.querySelector(".lane-glyph")?.append(flag);
  const clipRow = laneRow(clipHead, clipTrack(model, state, handlers));
  clipRow.setAttribute("data-lane", "clip");
  lanes.append(clipRow);

  const zoomRow = laneRow(
    laneHead("Zoom", "zoomIn"),
    segmentTrack("zoom", model, state, handlers),
  );
  zoomRow.setAttribute("data-lane", "zoom");
  lanes.append(zoomRow);

  // Always drawn, since 2026-09-14: empty track on it is where a mask is
  // added by click, and a lane that appears only after the header button
  // has been pressed has no empty track to click on.
  //
  // `+ Mask` lives on the lane it adds to (spec 2026-10-06) — it used to sit
  // alone at the transport row's left as an unlabelled icon. It reads the
  // playhead at the click: `state.positionMs` is a getter in `main.ts`, and
  // this row is redrawn only by a full render, not by a playing clock.
  const addMask = el(
    "button",
    "btn btn-quiet btn-icon lane-add",
  ) as HTMLButtonElement;
  addMask.type = "button";
  addMask.setAttribute("data-add-mask", "");
  addMask.setAttribute("aria-label", "Add a mask at the playhead");
  addMask.title = "Add a mask at the playhead";
  addMask.append(icon("plus"));
  addMask.onclick = () => {
    const track = box.querySelector<HTMLElement>('[data-track="clip"]');
    const perPx = track ? msPerPx(track, state.viewport) : 0;
    handlers.onGesture({
      kind: "addMask",
      atMs: state.positionMs,
      snapMs: snapBand(state, perPx),
    });
  };
  const maskRow = laneRow(
    laneHead("Mask", "eyeOff", addMask),
    segmentTrack("mask", model, state, handlers),
  );
  maskRow.setAttribute("data-lane", "mask");
  lanes.append(maskRow);

  const playhead = el("div", "playhead");
  playhead.setAttribute("data-playhead", "");
  playhead.style.left = pct(playheadFraction(state.viewport, state.positionMs));
  // The grab handle, inside the playhead so that moving the playhead moves
  // it: `renderTransportRow` nudges `playhead.style.left` sixty times a
  // second and a handle positioned separately would need a second copy of
  // `playheadFraction` to keep up with it.
  //
  // A div rather than a button, deliberately: there is nothing to activate
  // here, only something to drag, and the non-pointer route to the playhead
  // is Home/End/Shift+arrow, which needs no focused control. (It used to say
  // a button would swallow the arrows outright; `main.ts`'s keydown guard
  // now stands down only for the two keys a button activates on.)
  const grab = el("div", "grab");
  grab.setAttribute("data-playhead-grab", "");
  grab.setAttribute("aria-hidden", "true");
  // Measured against the axis, which is the column `playheadFraction` places
  // the playhead in. Measuring against the handle's own 15px box would make
  // every drag relative to where the playhead already was.
  armScrub(
    grab,
    () => axis.getBoundingClientRect(),
    state,
    model.durationMs,
    handlers,
  );
  playhead.append(grab);
  axis.append(playhead);
  lanes.append(axis);
  box.append(lanes);

  // Always rendered, empty when there is nothing to say: a refusal that
  // appeared and then vanished on the next redraw would be a toast with
  // extra steps.
  const refusal = el("p", "refusal");
  setCodeText(refusal, state.refusal ?? "");
  refusal.setAttribute("data-refusal", "");
  refusal.hidden = state.refusal === null;
  box.append(refusal);

  // The Mask lane's + keeps the keyboard focus across this rebuild. It is
  // the one control in the lanes an author presses repeatedly from the
  // keyboard, and the render its own press causes lands here: without
  // this, `replaceChildren` detached the focused button and the focus fell
  // to `body`, so a second mask meant tabbing back from the top. Read
  // BEFORE the swap, while the old button is still in `root` and still
  // focused; restored only when it was this lane's + that had it, so a
  // render never takes the focus from anywhere else.
  const active = root.ownerDocument.activeElement;
  const addMaskHadFocus =
    active instanceof HTMLElement &&
    root.contains(active) &&
    active.matches('[data-lane="mask"] [data-add-mask]');
  root.replaceChildren(box);
  if (addMaskHadFocus) addMask.focus();
  const card = box.querySelector<HTMLElement>("[data-join-card]");
  if (card !== null) showJoinCard(card);
}

/**
 * Lift a join's card into the top layer and set it over its dot. `#timeline`
 * scrolls sideways, so it clips anything drawn above the lanes; a popover is
 * drawn over the whole page instead. Placed by measurement, kept 8px inside
 * the window, its arrow under the dot wherever the card had to shift.
 * Manual, not auto: `main.ts` closes it (a press elsewhere, Escape), since
 * a redraw replaces the element and an auto popover's own dismissal would
 * not reach the editor's state.
 */
function showJoinCard(card: HTMLElement): void {
  const id = card.getAttribute("data-join-card");
  const dot = card.parentElement?.querySelector<HTMLElement>(
    `[data-join="${id}"]`,
  );
  // jsdom has no popover API; the card stays in the lane there.
  if (dot == null || typeof card.showPopover !== "function") return;
  card.setAttribute("popover", "manual");
  card.showPopover();
  const at = dot.getBoundingClientRect();
  const size = card.getBoundingClientRect();
  const margin = 8;
  const centre = at.left + at.width / 2;
  const left = Math.max(
    margin,
    Math.min(innerWidth - size.width - margin, centre - size.width / 2),
  );
  card.style.left = `${left}px`;
  card.style.top = `${Math.max(margin, at.top - size.height - 8)}px`;
  card.style.setProperty("--arrow", `${centre - left}px`);
}

/**
 * One of the row's glyph-only controls: the icon, with its name set on each
 * render by `nameTool`.
 */
function toolButton(glyph: GlyphName): HTMLButtonElement {
  const button = el(
    "button",
    "btn btn-quiet btn-icon tool",
  ) as HTMLButtonElement;
  button.type = "button";
  button.append(icon(glyph));
  return button;
}

/**
 * The name as `aria-label` and as the tooltip, with the key that does the
 * same thing as caps (`tooltip.ts`), so a pointer and a screen reader get
 * the same name. Disabled, a native `title` says it, as Play's does.
 */
function nameTool(
  button: HTMLButtonElement,
  name: string,
  keys: readonly string[],
): void {
  button.setAttribute("aria-label", name);
  if (!button.disabled) withTip(button, name, keys);
  else {
    withoutTip(button);
    button.title = name;
  }
}

/** The row's nodes, built once per root — see `renderTimelineTools`. */
interface ToolParts {
  view: HTMLElement;
  split: HTMLButtonElement;
  snap: HTMLButtonElement;
  fit: HTMLButtonElement;
  zoom: HTMLInputElement;
  zoomOut: HTMLButtonElement;
  zoomIn: HTMLButtonElement;
}

const toolParts = new WeakMap<HTMLElement, ToolParts>();

function buildTools(): ToolParts {
  const view = el("div", "bar-controls");
  view.setAttribute("data-timeline-tools", "view");
  const snap = toolButton("magnet");
  snap.classList.add("snap");
  const fit = toolButton("moveHorizontal");
  fit.classList.add("fit");
  fit.setAttribute("data-fit", "");
  const split = toolButton("scissors");
  split.setAttribute("data-split-tool", "");

  // Zoom, as a slider, to the right of Fit: the button is the one position
  // worth a press, and this is every other position. ⇧Z still fits, and
  // dragging the knob to 0 is the same thing the button does.
  //
  // Between a zoom-out and a zoom-in magnifier since 2026-09-22, which say
  // what the slider does without the word "Zoom" beside it and step it the
  // way the − and + keys do. The slider's own name moved to `aria-label`.
  const zoomWrap = el("div", "zoom-control");
  zoomWrap.setAttribute("data-zoom-control", "");
  const zoom = el("input") as HTMLInputElement;
  zoom.setAttribute("aria-label", "Timeline zoom");
  zoom.type = "range";
  zoom.min = "0";
  zoom.max = "1";
  // Fine enough that a drag reads as continuous, coarse enough that the
  // value is a stable string a test can compare.
  zoom.step = "0.001";
  zoom.setAttribute("data-zoom-slider", "");
  const zoomOut = toolButton("zoomOut");
  zoomOut.classList.add("zoom-step");
  zoomOut.setAttribute("data-zoom-step", "out");
  const zoomIn = toolButton("zoomIn");
  zoomIn.classList.add("zoom-step");
  zoomIn.setAttribute("data-zoom-step", "in");
  zoomWrap.append(zoomOut, zoom, zoomIn);
  view.append(split, snap, fit, zoomWrap);
  return { view, split, snap, fit, zoom, zoomOut, zoomIn };
}

/**
 * Snap, Fit and zoom — the timeline's own bar controls, moved onto
 * `#transport` so they sit beside the shuttle cluster instead of on top of
 * the lanes. They cannot simply be parked inside `renderTimeline`'s own
 * root: `renderTimeline` calls `replaceChildren` on `#timeline` on every
 * redraw, which would destroy anything left there between renders, so
 * `#timeline-tools` is a separate root on `#transport` and this is its own
 * renderer.
 *
 * Drawn as one `[data-timeline-tools="view"]` group in the transport's end
 * cluster. `+ Mask` is not here: it lives on the Mask lane's own header
 * (`renderTimeline`), where it names the lane it adds to.
 *
 * **Built once per root, then updated in place.** The zoom slider's own
 * `input` asks for a new viewport, and `main.ts` answers that with a full
 * render that lands back here — so this runs while the slider is being
 * dragged. Until 2026-09-22 it rebuilt the row every time, and a range input
 * taken out of the document mid-drag loses the gesture: a drag moved the
 * knob one notch and stopped. Re-appending a kept slider would not help
 * either — moving a connected node detaches it for that instant — so the
 * nodes stay where they are and only their state changes. Handlers are
 * assigned (`onclick =`), not added, so each render replaces the last
 * render's closure over `state` instead of stacking another beside it.
 * `editor-timeline-zoom-drag.test.ts` drives a real mouse across it.
 */
export function renderTimelineTools(
  root: HTMLElement,
  model: Pick<LaneModel, "durationMs">,
  state: Pick<TimelineState, "snapping" | "viewport" | "positionMs">,
  handlers: Pick<
    TimelineHandlers,
    "onGesture" | "onSnapping" | "onViewport" | "onSplit"
  >,
): void {
  let parts = toolParts.get(root);
  if (parts === undefined || parts.view.parentElement !== root) {
    parts = buildTools();
    toolParts.set(root, parts);
    root.replaceChildren(parts.view);
  }
  const { split, snap, fit, zoom, zoomOut, zoomIn } = parts;

  nameTool(split, "Split at playhead", ["Mod", "B"]);
  split.onclick = () => handlers.onSplit();

  // Snapping is a mode, and a mode with no indicator is a mode the author
  // cannot tell they are in — S changes how every later drag behaves, so
  // there has to be somewhere on screen that says which way it is set.
  //
  // Until 2026-09-22 nothing painted that indicator: `aria-pressed` was set
  // and no rule read it, so Snap on and Snap off looked identical and only
  // the tooltip told them apart. On is the filled disc; off loses its fill
  // and drops to muted ink (see the stylesheet).
  nameTool(
    snap,
    state.snapping
      ? "Snapping on — drags land on the nearest step"
      : "Snapping off — drags land where you drop them",
    ["S"],
  );
  snap.setAttribute("data-snap", state.snapping ? "on" : "off");
  snap.setAttribute("aria-pressed", state.snapping ? "true" : "false");
  snap.onclick = () => handlers.onSnapping(!state.snapping);

  // Fit. The design lists it in scope beside ⌘-scroll, and it sits between
  // Snap and the zoom slider: the slider's leftmost position is the same
  // window, but a slider is a thing to aim and a button is a thing to press,
  // and "show me all of it" is worth one press.
  //
  // There is nothing to go back to when the whole take is already in view,
  // and until 2026-09-20 this looked identical whether pressing it would do
  // something or nothing. Disabled says which — the same thing Snap beside
  // it does with `aria-pressed`.
  //
  // Compared against `fitAll`'s own result, not against `0..durationMs`: a
  // take shorter than `MIN_SPAN_MS` fits to that floor instead of to its own
  // length, and measured against the raw duration it could never read as
  // fitted — the button would stay live forever on exactly the takes where
  // it has least to do.
  const whole = fitAll(model.durationMs);
  const fitted =
    state.viewport.startMs === whole.startMs &&
    state.viewport.endMs === whole.endMs;
  fit.disabled = fitted;
  nameTool(
    fit,
    fitted ? "The whole take is already in view" : "Fit the whole take",
    ["Shift", "Z"],
  );
  fit.onclick = () => handlers.onViewport(whole);

  const span = state.viewport.endMs - state.viewport.startMs;
  const value = spanToZoom(model.durationMs, span);
  zoom.value = String(value);
  // The fill the shell's range rule paints, in the same percentage the knob
  // sits at. `paintSliderFill` does this for the inspector's sliders from
  // the input's own event; this one is also moved by the wheel, so it is set
  // on every render rather than only on input.
  zoom.style.setProperty("--fill", `${(value * 100).toFixed(2)}%`);
  // A take with nowhere to go — shorter than the floor the viewport clamps
  // to — has no travel, and a slider that moves without changing anything is
  // a control that lies. Disabled says so, with the reason on it, the way
  // the rest of this editor refuses.
  const travels = model.durationMs > MIN_SPAN_MS;
  zoom.disabled = !travels;
  zoom.title = travels
    ? "Zoom the timeline (⌘-scroll, ⇧Z to fit)"
    : "This take is too short to zoom into.";
  zoom.oninput = () => {
    const wanted = zoomToSpan(model.durationMs, Number(zoom.value));
    // Anchored on the playhead when it is in the window, on the window's
    // middle when it is not: zooming in on a take you are watching must not
    // push the thing you are watching off the edge, and when the playhead is
    // somewhere else entirely the middle is the only instant the author has
    // told us about.
    const at = toFraction(state.viewport, state.positionMs);
    handlers.onViewport(
      zoomTo(
        state.viewport,
        model.durationMs,
        wanted,
        at >= 0 && at <= 1 ? at : 0.5,
      ),
    );
  };

  // The magnifiers: one ZOOM_STEP per press, anchored on the playhead and
  // clamped into the window — exactly what main.ts does for the − and + keys,
  // so a press and a keystroke always land on the same window. Disabled at
  // their own end of the travel (and both, on a take with none), for the
  // reason Fit is disabled when it has nothing to do. The ends are read
  // within half the slider's own 0.001 step: `spanToZoom` goes through
  // logarithms, and a fully-out take can come back as 1e-16 rather than 0.
  //
  // `state.positionMs` is read at the CLICK, here and in the slider above,
  // never hoisted to render time: this row is redrawn only by a full render,
  // and main.ts hands it a getter over the live playhead for that reason.
  const step = (factor: number) => {
    const at = Math.min(
      1,
      Math.max(0, toFraction(state.viewport, state.positionMs)),
    );
    handlers.onViewport(zoomAt(state.viewport, model.durationMs, factor, at));
  };
  zoomOut.disabled = !travels || value <= 0.0005;
  zoomOut.onclick = () => step(1 / ZOOM_STEP);
  nameTool(zoomOut, "Zoom out", ["\u2212"]);
  zoomIn.disabled = !travels || value >= 0.9995;
  nameTool(zoomIn, "Zoom in", ["+"]);
  zoomIn.onclick = () => step(ZOOM_STEP);
}
