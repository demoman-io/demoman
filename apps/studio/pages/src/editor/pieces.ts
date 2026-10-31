import {
  type FrameBundle,
  type Timeline,
  toOutputMs,
  toSourceMs,
} from "@demoman/compositor";
import type { SceneDocument, SourcePoint } from "@demoman/scene-schema";

type SceneRemoved = NonNullable<SceneDocument["edits"]["removed"]>[number];

import type { GestureResult } from "./gestures";

/**
 * The split tool's model (spec 2026-10-22 split-tool): the clip as pieces
 * between splits and joins, on the output axis the timeline is drawn on.
 *
 * A removed piece is already gone from that axis (the compositor closes it
 * up), so where it was is a JOIN: one instant, with the piece before it
 * ending at the removal's start and the piece after it beginning at its
 * end. Points are stored in source time; positions here are output ms.
 */

/** A stored removed range beside a piece's edge, in source ms: what that
 *  edge can bring back by dragging outward. */
export interface Beside {
  removedId: string;
  srcStartMs: number;
  srcEndMs: number;
}

/** One stretch of the clip between two boundaries. A null side is that end
 *  of the take. `before`/`after` name the range removed right at that edge,
 *  or null where the frames beside it are kept (or the take ends). */
export interface Piece {
  startMs: number;
  endMs: number;
  start: SourcePoint | null;
  end: SourcePoint | null;
  before: Beside | null;
  after: Beside | null;
}

/** Where a stored removed piece was, and which frames it holds. Joins that
 *  share an instant fan out by `index` so each stays reachable. */
export interface Join {
  removedId: string;
  atMs: number;
  index: number;
  srcStartMs: number;
  srcEndMs: number;
  /** Set when the piece removed no frames: the compositor's reason. Its
   *  join sits where the piece would start, so it can still be cleared. */
  unplaced?: string;
}

/** The shortest a piece may be dragged to. */
export const PIECE_MIN_MS = 200;

/** Two boundaries this close are one: a split typed onto a join or onto
 *  another split adds nothing. */
const SAME_MS = 1;

const refuse = (reason: string): GestureResult => ({ kind: "refusal", reason });

/** The item with the least key; undefined for none. */
function minBy<T>(
  items: readonly T[],
  key: (item: T) => number,
): T | undefined {
  let best: T | undefined;
  let bestKey = Infinity;
  for (const item of items) {
    const k = key(item);
    if (best === undefined || k < bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

function markerSourceMs(bundle: FrameBundle): Map<string, number> {
  return new Map(bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]));
}

/**
 * The frames' own address of an output instant: the last step whose frame
 * is at or before it, and how far past it. Before the first step it is the
 * first step and a negative offset. Null for frames with no markers, which
 * have no step to address anything by.
 */
export function sourcePointAt(
  bundle: FrameBundle,
  timeline: Timeline,
  outputMs: number,
): SourcePoint | null {
  return pointAtSource(bundle, toSourceMs(timeline, outputMs));
}

/** The same address for a source instant, which a removed frame has and an
 *  output instant does not. */
function pointAtSource(bundle: FrameBundle, src: number): SourcePoint | null {
  const markers = [...bundle.markers].sort(
    (a, b) => a.sourceTimeMs - b.sourceTimeMs,
  );
  const first = markers[0];
  if (first === undefined) return null;
  let marker = first;
  for (const m of markers) if (m.sourceTimeMs <= src) marker = m;
  return {
    actionId: marker.actionId,
    sourceOffsetMs: Math.round(src - marker.sourceTimeMs),
  };
}

interface Boundary {
  atMs: number;
  /** Where the piece BEFORE this boundary ends. */
  left: SourcePoint | null;
  /** Where the piece AFTER it begins. */
  right: SourcePoint | null;
  /** The range the piece before runs into, and the one the piece after
   *  comes out of: the same range unless several share the join. */
  leftBeside?: Beside;
  rightBeside?: Beside;
  /** Sort order at one instant: the take's start first, its end last. */
  rank: number;
}

export function piecesOf(
  scene: SceneDocument,
  bundle: FrameBundle,
  timeline: Timeline,
): { pieces: Piece[]; joins: Join[]; unplacedSplits: string[] } {
  const markers = markerSourceMs(bundle);
  const stored = new Map((scene.edits.removed ?? []).map((r) => [r.id, r]));
  const boundaries: Boundary[] = [
    { atMs: 0, left: null, right: null, rank: 0 },
    {
      atMs: timeline.outputDurationMs,
      left: null,
      right: null,
      rank: 2,
    },
  ];
  const joins: Join[] = [];
  // A range's own frames, as `cutRanges` resolves them: a null end is the
  // take's, and the result is clamped to the frames there are.
  const besideOf = (range: SceneRemoved): Beside => {
    const at = (point: SourcePoint | null, ifNull: number): number => {
      if (point === null) return ifNull;
      const marker = markers.get(point.actionId);
      if (marker === undefined) return ifNull;
      const ms = marker + point.sourceOffsetMs;
      return Math.max(0, Math.min(timeline.sourceDurationMs, ms));
    };
    return {
      removedId: range.id,
      srcStartMs: at(range.start, 0),
      srcEndMs: at(range.end, timeline.sourceDurationMs),
    };
  };
  /** Splits whose step the frames carry no marker for: not drawn. */
  const unplacedSplits: string[] = [];

  for (const cut of timeline.cuts) {
    const ranges = cut.ids.flatMap((id) => {
      const range = stored.get(id);
      return range === undefined ? [] : [range];
    });
    // The merged stretch's outer ends: the earliest start and the latest
    // end, by where they resolve — not by id order, which says nothing
    // about position once pieces overlap.
    const srcOf = (point: SourcePoint | null, ifNull: number): number => {
      if (point === null) return ifNull;
      return (markers.get(point.actionId) ?? ifNull) + point.sourceOffsetMs;
    };
    const first = minBy(ranges, (r) => srcOf(r.start, -Infinity));
    const last = minBy(ranges, (r) => -srcOf(r.end, Infinity));
    if (first === undefined || last === undefined) continue;
    const atMs = toOutputMs(timeline, cut.srcStartMs);
    boundaries.push({
      atMs,
      left: first.start,
      right: last.end,
      rank: 1,
      leftBeside: besideOf(first),
      rightBeside: besideOf(last),
    });
    cut.ids.forEach((removedId, index) => {
      const range = stored.get(removedId);
      const own = range === undefined ? null : besideOf(range);
      joins.push({
        removedId,
        atMs,
        index,
        srcStartMs: own?.srcStartMs ?? cut.srcStartMs,
        srcEndMs: own?.srcEndMs ?? cut.srcEndMs,
      });
    });
  }

  // A piece that removed no frames still gets a join, or nothing on the
  // timeline could ever take it back out of the document (review
  // 2026-10-22). It sits where the piece starts, else where it ends, else at
  // the take's start: whichever of its ends these frames can place.
  for (const unplaced of timeline.unplacedCuts) {
    for (const removedId of unplaced.ids) {
      const range = stored.get(removedId);
      const placeable = [range?.start, range?.end].find(
        (p): p is SourcePoint =>
          p !== null && p !== undefined && markers.has(p.actionId),
      );
      const atMs =
        placeable === undefined
          ? 0
          : toOutputMs(
              timeline,
              Math.max(
                0,
                Math.min(
                  timeline.sourceDurationMs,
                  (markers.get(placeable.actionId) ?? 0) +
                    placeable.sourceOffsetMs,
                ),
              ),
            );
      joins.push({
        removedId,
        atMs,
        index: joins.filter((j) => Math.abs(j.atMs - atMs) < SAME_MS).length,
        srcStartMs: 0,
        srcEndMs: 0,
        unplaced: unplaced.reason,
      });
    }
  }

  for (const split of scene.edits.splits ?? []) {
    const marker = markers.get(split.at.actionId);
    if (marker === undefined) {
      unplacedSplits.push(split.id);
      continue;
    }
    const src = marker + split.at.sourceOffsetMs;
    // Inside a removed stretch, or on its edge: its frames are not in the
    // video, and the join already marks the instant. Closed, so the splits
    // a piece was cut between never compete with its join for the points
    // the pieces either side carry.
    if (timeline.cuts.some((c) => src >= c.srcStartMs && src <= c.srcEndMs)) {
      continue;
    }
    const atMs = toOutputMs(timeline, src);
    boundaries.push({ atMs, left: split.at, right: split.at, rank: 1 });
  }

  boundaries.sort((a, b) => a.atMs - b.atMs || a.rank - b.rank);
  const pieces: Piece[] = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const from = boundaries[i] as Boundary;
    const to = boundaries[i + 1] as Boundary;
    if (to.atMs - from.atMs < SAME_MS) continue;
    pieces.push({
      startMs: from.atMs,
      endMs: to.atMs,
      start: from.right,
      end: to.left,
      before: from.rightBeside ?? null,
      after: to.leftBeside ?? null,
    });
  }
  return { pieces, joins, unplacedSplits };
}

/** ⌘B: split the clip at the playhead. */
export function resolveSplit(
  scene: SceneDocument,
  bundle: FrameBundle | null,
  timeline: Timeline | null,
  outputMs: number,
): GestureResult {
  if (bundle === null || timeline === null) {
    return refuse(
      "Nothing has rendered yet, so there is no frame to split at.",
    );
  }
  if (outputMs <= 0 || outputMs >= timeline.outputDurationMs) {
    return refuse("A split at the video's start or end splits nothing.");
  }
  const at = sourcePointAt(bundle, timeline, outputMs);
  if (at === null) {
    return refuse(
      "These frames name no step, so there is nothing to split by.",
    );
  }
  // Where the split will be drawn, which is not the playhead inside a pause:
  // every instant of a hold or a reconstructed pause is one frame, drawn at
  // the pause's own edge.
  const marker = markerSourceMs(bundle).get(at.actionId) ?? 0;
  const landsMs = toOutputMs(timeline, marker + at.sourceOffsetMs);
  const { pieces } = piecesOf(scene, bundle, timeline);
  const taken =
    landsMs <= SAME_MS ||
    landsMs >= timeline.outputDurationMs - SAME_MS ||
    pieces.some((p) => Math.abs(p.startMs - landsMs) < SAME_MS);
  if (taken) {
    return refuse(
      Math.abs(landsMs - outputMs) < SAME_MS
        ? "The clip is already split here."
        : "A pause is one frame, so a split anywhere in it lands at its edge — and the clip is already split there.",
    );
  }
  return { kind: "split", at };
}

/** One frame address, or both the take's start. */
export const samePoint = (
  a: SourcePoint | null,
  b: SourcePoint | null,
): boolean =>
  a === null || b === null
    ? a === b
    : a.actionId === b.actionId && a.sourceOffsetMs === b.sourceOffsetMs;

/** Delete on a selected piece: remove its frames, unless it is all that is
 *  left — of the whole clip, or of what the trim exports. */
export function resolvePieceRemoval(
  pieces: readonly Piece[],
  start: SourcePoint | null,
  trim?: { headMs: number; tailMs: number },
): GestureResult {
  const piece = pieces.find((p) => samePoint(p.start, start));
  if (piece === undefined) {
    return refuse("That piece is no longer on the timeline.");
  }
  if (pieces.length === 1) {
    return refuse(
      "This is the only piece left, so removing it would leave nothing to export.",
    );
  }
  if (trim !== undefined) {
    const exported = (p: Piece) =>
      p.endMs > trim.headMs + SAME_MS && p.startMs < trim.tailMs - SAME_MS;
    if (exported(piece) && pieces.filter(exported).length === 1) {
      return refuse(
        "This is the only piece inside the trim, so removing it would leave nothing to export.",
      );
    }
  }
  return { kind: "removePiece", start: piece.start, end: piece.end };
}

/**
 * A piece's edge dragged by `deltaMs`. Inward cuts frames off the piece:
 * the range already removed beside that edge grows, or a new one starts.
 * Outward brings back frames from the range removed beside it, and pulling
 * past that range's far end restores it whole — there is nothing further to
 * bring back, and the edge never stretches past what was filmed.
 *
 * shortcut: outward assumes removed frames play at one output ms per source
 * ms (they have no output time to measure); a hold or a stretched pause
 * inside a removed range makes the drag bring back a little more or less
 * than the pointer moved.
 */
export function resolvePieceEdge(
  bundle: FrameBundle | null,
  timeline: Timeline | null,
  pieces: readonly Piece[],
  start: SourcePoint | null,
  side: "start" | "end",
  deltaMs: number,
): GestureResult {
  const piece = pieces.find((p) => samePoint(p.start, start));
  if (piece === undefined) {
    return refuse("That piece is no longer on the timeline.");
  }
  if (bundle === null || timeline === null) {
    return refuse(
      "Nothing has rendered yet, so there is no frame to move the edge to.",
    );
  }
  const delta = Math.round(deltaMs);
  if (delta === 0) return null;
  const inward = side === "end" ? delta < 0 : delta > 0;
  const beside = side === "end" ? piece.after : piece.before;

  if (inward) {
    const outMs =
      side === "end"
        ? Math.max(piece.startMs + PIECE_MIN_MS, piece.endMs + delta)
        : Math.min(piece.endMs - PIECE_MIN_MS, piece.startMs + delta);
    if (side === "end" ? outMs >= piece.endMs : outMs <= piece.startMs) {
      return refuse("This piece is as short as a piece can be.");
    }
    const point = sourcePointAt(bundle, timeline, outMs);
    if (point === null) {
      return refuse(
        "These frames name no step, so there is nothing to move the edge by.",
      );
    }
    if (beside !== null) {
      return side === "end"
        ? { kind: "setRemovedEdge", id: beside.removedId, start: point }
        : { kind: "setRemovedEdge", id: beside.removedId, end: point };
    }
    return side === "end"
      ? { kind: "removePiece", start: point, end: piece.end }
      : { kind: "removePiece", start: piece.start, end: point };
  }

  if (beside === null) {
    return refuse(
      side === "end"
        ? "Nothing was removed after this piece, so its end can only move in."
        : "Nothing was removed before this piece, so its start can only move in.",
    );
  }
  const target =
    side === "end" ? beside.srcStartMs + delta : beside.srcEndMs + delta;
  const reachesFar =
    side === "end"
      ? target >= beside.srcEndMs - SAME_MS
      : target <= beside.srcStartMs + SAME_MS;
  if (reachesFar) return { kind: "restorePiece", id: beside.removedId };
  const point = pointAtSource(bundle, target);
  if (point === null) {
    return refuse(
      "These frames name no step, so there is nothing to move the edge by.",
    );
  }
  return side === "end"
    ? { kind: "setRemovedEdge", id: beside.removedId, start: point }
    : { kind: "setRemovedEdge", id: beside.removedId, end: point };
}
