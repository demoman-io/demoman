import type { SourcePoint } from "@demoman/scene-schema";
import { clamp } from "../geometry.js";
import { type Timeline, toOutputMs } from "./timeline.js";
import type { PlannedMarker } from "./types.js";

/** A span of the untrimmed output axis. */
export interface OutputRange {
  startMs: number;
  endMs: number;
}

export type RangeKind =
  | "trim"
  | "zoom"
  /** A zoom a `cover` crop narrowed to keep its target whole
   *  (`CameraSegment.fitted`). Its end is untouched, so it is not a
   *  `zoom` clamp: the editor's "the end you set could not be reached" is
   *  about those alone. */
  | "zoomFit"
  | "mask";

/**
 * A range the render had to cut to nothing because its end resolved at or
 * before its start — a gap between its two steps was shortened after the
 * range was placed, or both sides saturated at the same end of a take a
 * Rebuild made shorter. Reported by name rather than silently rendered as
 * nothing: nothing-drawn and working-over-an-empty-region look identical.
 */
export interface ClampedRange {
  id: string;
  kind: RangeKind;
  note: string;
}

export interface ResolvedRange {
  range: OutputRange;
  /** Sides whose step the bundle carries no marker for. That side fell back
   *  to the take's own end; the caller says so. */
  unplaced: ("start" | "end")[];
  clamped: ClampedRange | null;
}

/**
 * A marker's instant on the untrimmed output axis, or null when the bundle
 * has no marker for its step — the partial-rebuild case, which
 * `holdInstants` drops silently and this does not.
 */
export function markerOutputMs(
  marker: PlannedMarker,
  timeline: Timeline,
  markerSourceMs: Map<string, number>,
): number | null {
  const sourceMs = markerSourceMs.get(marker.actionId);
  if (sourceMs === undefined) return null;
  return toOutputMs(timeline, sourceMs) + marker.offsetMs;
}

/**
 * The output stretch that shows source frames `srcStartMs` through
 * `srcEndMs`, both included: a hold or pace standing on one of them is in
 * it, a removed stretch between them is not. Null when no instant of the
 * video shows any of them.
 */
export function outputSpanOfSource(
  timeline: Timeline,
  srcStartMs: number,
  srcEndMs: number,
): OutputRange | null {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const s of timeline.segments) {
    const lo = Math.max(srcStartMs, s.srcStartMs);
    const hi = Math.min(srcEndMs, s.srcEndMs);
    if (lo > hi) continue;
    const span = s.srcEndMs - s.srcStartMs;
    // Source standing still (a hold, a pace): its frame is on screen for all
    // of it.
    const out = (src: number, still: number) =>
      span === 0
        ? still
        : s.outStartMs +
          ((s.outEndMs - s.outStartMs) * (src - s.srcStartMs)) / span;
    startMs = Math.min(startMs, out(lo, s.outStartMs));
    endMs = Math.max(endMs, out(hi, s.outEndMs));
  }
  return startMs <= endMs ? { startMs, endMs } : null;
}

/**
 * A mask's range: the output stretch showing the frames between its two
 * source points (`outputSpanOfSource`), so it follows them through every
 * cut, gap and hold made after it was drawn (audit run 1). An unplaced side
 * falls back to the take's own end on that side and is reported, as
 * `resolveRange`'s is; a range that shows no frame is reported, not drawn.
 */
export function resolveMaskRange(args: {
  id: string;
  start: SourcePoint;
  end: SourcePoint;
  timeline: Timeline;
  markerSourceMs: Map<string, number>;
}): ResolvedRange {
  const { timeline } = args;
  const unplaced: ("start" | "end")[] = [];
  const srcOf = (p: SourcePoint, side: "start" | "end", ifNone: number) => {
    const marker = args.markerSourceMs.get(p.actionId);
    if (marker === undefined) {
      unplaced.push(side);
      return ifNone;
    }
    return marker + p.sourceOffsetMs;
  };
  const srcStart = srcOf(args.start, "start", 0);
  const srcEnd = srcOf(args.end, "end", timeline.sourceDurationMs);
  const span = outputSpanOfSource(timeline, srcStart, srcEnd);
  if (span !== null && span.endMs > span.startMs) {
    return { range: span, unplaced, clamped: null };
  }
  const at =
    span?.startMs ??
    clamp(toOutputMs(timeline, srcStart), 0, timeline.outputDurationMs);
  const note =
    srcEnd < srcStart
      ? `mask "${args.id}" ends ${Math.round(srcStart - srcEnd)}ms before it starts in the recording, so it covers nothing`
      : `mask "${args.id}" covers no frame of the video: every frame between its ends was removed`;
  return {
    range: { startMs: at, endMs: at },
    unplaced,
    clamped: { id: args.id, kind: "mask", note },
  };
}

/**
 * Two optional markers to a range. A null side is the take's own end on that
 * side; an unplaced side is treated the same way AND reported. A pair that
 * resolves to zero length — inverted, or landing on the same instant — is
 * cut to zero length at its start and reported.
 */
export function resolveRange(args: {
  id: string;
  kind: RangeKind;
  start: PlannedMarker | null;
  end: PlannedMarker | null;
  timeline: Timeline;
  markerSourceMs: Map<string, number>;
}): ResolvedRange {
  const { timeline } = args;
  const duration = timeline.outputDurationMs;
  const unplaced: ("start" | "end")[] = [];

  const startRaw = args.start
    ? markerOutputMs(args.start, timeline, args.markerSourceMs)
    : 0;
  const endRaw = args.end
    ? markerOutputMs(args.end, timeline, args.markerSourceMs)
    : duration;
  if (args.start && startRaw === null) unplaced.push("start");
  if (args.end && endRaw === null) unplaced.push("end");

  const startMs = clamp(startRaw ?? 0, 0, duration);
  const endMs = clamp(endRaw ?? duration, 0, duration);
  // `<=`, not `<`. An end that resolves to EXACTLY its start covers nothing
  // just as surely as an inverted one, and it is the commoner of the two:
  // both sides of a trim saturate at `duration` whenever a Rebuild shortens
  // the take past them, and a mask's two markers land on one instant
  // whenever the pause between their steps is cut to zero. Left unreported,
  // `renderScene`'s `Math.max(1, ...)` turned it into a one-frame file with
  // non-empty bytes and no violation, and `drawCosmetics`' half-open
  // `>= startMs && < endMs` window simply never painted — success and
  // nothing-happened telling themselves apart nowhere.
  //
  // Only when a side was AUTHORED, though. An unauthored range is the whole
  // take by definition, so on a take whose own axis is zero long it comes
  // back zero long with nothing having been cut — reporting that as a
  // collapse announced "the trim covers nothing" over whatever real fault
  // left the take empty, which `apps/runner`'s missing-keyframe test caught.
  const authored = args.start !== null || args.end !== null;
  if (endMs <= startMs && authored) {
    const note =
      endMs < startMs
        ? `${args.kind} "${args.id}" ends ${Math.round(startMs - endMs)}ms before it starts, so it was cut to nothing — a pause between its two steps was shortened after it was placed`
        : `${args.kind} "${args.id}" starts and ends at the same instant (${Math.round(startMs)}ms), so it covers nothing — the pause between its two steps was cut to nothing after it was placed, or both its ends were pushed off the end of a shortened take`;
    return {
      range: { startMs, endMs: startMs },
      unplaced,
      clamped: { id: args.id, kind: args.kind, note },
    };
  }
  return { range: { startMs, endMs }, unplaced, clamped: null };
}
