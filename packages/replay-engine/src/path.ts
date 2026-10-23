import {
  type CursorSegment,
  easings,
  sampleSegment,
  segmentDurationMs,
  type Vec,
} from "@demoman/compositor";

/**
 * Move a planned segment onto the rects replay actually resolved.
 *
 * The compositor plans from capture-time rects (`action.rect`); the page may
 * have scrolled or re-laid-out since, and a rect capture measured late
 * describes a place the element never was. Both ends are pinned to the
 * truth — where the cursor is, and where the click must land — and the
 * curve in between is carried across relative to the travel: each control
 * point keeps its fraction of the way along the chord and its offset to the
 * side as a fraction of the chord's length. The duration is the compositor's
 * own rule for the new travel.
 *
 * Relative, not absolute, since the author's take of 2026-09-29. Each point
 * used to be displaced by the change at its end, so the planned bend kept
 * its size in pixels whatever the new travel was. The click's plan was a
 * 2310px move bowed 185px to the side (its start came from a bad hover
 * rect), the cursor was already on the button, and replay swung it 180px
 * off and back over the planned 700ms.
 */
export function retargetSegment(
  segment: CursorSegment,
  from: Vec,
  to: Vec,
): CursorSegment {
  const first = segment.via.at(0) ?? segment.from;
  const last = segment.via.at(-1) ?? segment.to;
  const travel = { x: to.x - from.x, y: to.y - from.y };
  // Already there. Nothing to show, and nothing to wait for: `dispatchPath`
  // sends one move, straight to the target, for a segment of no duration.
  // Asked before whether the page agrees, because a plan with no travel of
  // its own still carries the shortest move's duration — a click on the
  // element a hover just reached held the cursor still for all of it.
  if (Math.hypot(travel.x, travel.y) < 0.5) {
    return {
      ...segment,
      from,
      to,
      via: segment.via.map(() => ({ x: to.x, y: to.y })),
      durationMs: 0,
    };
  }
  // The page agrees with the plan: nothing to carry, and no rounding to add.
  if (
    first.x === from.x &&
    first.y === from.y &&
    last.x === to.x &&
    last.y === to.y
  ) {
    return { ...segment, from, to };
  }
  const chord = { x: last.x - first.x, y: last.y - first.y };
  const chordSq = chord.x * chord.x + chord.y * chord.y;
  return {
    ...segment,
    from,
    to,
    via: segment.via.map((point, i) => {
      if (i === 0) return { x: from.x, y: from.y };
      if (i === segment.via.length - 1) return { x: to.x, y: to.y };
      // A plan with no travel of its own has no chord to be relative to;
      // its interior points can only be spread evenly along the new one.
      if (chordSq === 0) {
        const w = i / Math.max(segment.via.length - 1, 1);
        return { x: from.x + travel.x * w, y: from.y + travel.y * w };
      }
      const d = { x: point.x - first.x, y: point.y - first.y };
      const along = (d.x * chord.x + d.y * chord.y) / chordSq;
      const across = (chord.x * d.y - chord.y * d.x) / chordSq;
      return {
        x: from.x + along * travel.x - across * travel.y,
        y: from.y + along * travel.y + across * travel.x,
      };
    }),
    durationMs: segmentDurationMs(from, to),
  };
}

/**
 * Where replay's cursor is `elapsedMs` into a segment: eased along the curve,
 * and exactly on `to` once the segment's time is up. This is what
 * `Input.dispatchMouseEvent` sends and what the bundle records, so the drawn
 * cursor is literally the input that drove the app.
 *
 * A point for the moment of sending rather than a list planned ahead. The
 * list was 8ms apart and Chrome answers a move about every 16.7ms, so each
 * send took the latest point due — 16ms of plan per 16.7ms of clock, until
 * one send skipped three and the cursor jumped 1.4-1.7x its neighbours near
 * top speed, once in every move of the author's probe of 2026-10-07.
 */
export function pathPointAt(segment: CursorSegment, elapsedMs: number): Vec {
  if (elapsedMs >= segment.durationMs) {
    return { x: segment.to.x, y: segment.to.y };
  }
  const progress = Math.max(0, elapsedMs / segment.durationMs);
  return sampleSegment(segment, easings[segment.easing](progress));
}
