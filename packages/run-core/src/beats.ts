import {
  SETTLE_MS,
  TAKE_TAIL_MS,
  TYPE_LEAD_MS,
  typeGapMs,
  typeKeysOf,
} from "@demoman/replay-engine";
import type { SceneAction } from "@demoman/scene-schema";

// The designed clock: every number here comes from constants and the script,
// never from a measurement, so the same script gets the same pauses on any
// machine. No I/O, no clock.

/** Dead air before a step's journey. Provisional: a later task replaces it from measurement. */
export const BASE_REST_MS = 700;
/** Dead air before the first step's journey. Provisional, as `BASE_REST_MS`. */
export const OPENING_REST_MS = 800;
/** Dead air after the cursor arrives. */
export const ARRIVE_MS = SETTLE_MS;

/**
 * Planned margin on the room a cursor journey is counted toward. The
 * journey's eased-out end (measured 50–73 ms on 2026-11-13) moves the
 * pointer less than the timeline's cursor-motion threshold
 * (`CURSOR_MOTION_EPSILON_PX`), so it renders as idle inside the arrive,
 * which plays `ARRIVE_MS` in all: the rendered journey is that much shorter
 * than its designed length. 100 covers the measured range with room. It is a
 * constant added to planned numbers, never compared with a measurement, so
 * nothing decides across it and it cannot jitter.
 */
export const JOURNEY_TAIL_MS = 100;

/** The room left to plan once the journey and the arrive have given theirs:
 *  the journey counted less its eased-out end. */
function roomLeft(roomMs: number, journeyMs: number): number {
  return roomMs - journeyMs - ARRIVE_MS + (journeyMs > 0 ? JOURNEY_TAIL_MS : 0);
}

/**
 * Dead air before a step's journey. `roomMs` is what the camera needs from
 * the last act's designed end to this click, 0 when it does not zoom or pans.
 */
export function restBefore(i: {
  first: boolean;
  pauseMs: number;
  roomMs: number;
  journeyMs: number;
}): number {
  return Math.max(
    (i.first ? OPENING_REST_MS : BASE_REST_MS) + i.pauseMs,
    i.roomMs > 0
      ? roomLeft(i.roomMs, i.journeyMs)
      : i.roomMs - i.journeyMs - ARRIVE_MS,
  );
}

/**
 * Dead air between a step's approach scroll and its journey: an arrive's
 * worth, or, before a click the camera zooms to, the room it needs after
 * the page moved (`roomMs` as for `restBefore`). The rest before the scroll
 * then keeps its base.
 */
export function afterScroll(i: {
  zooms: boolean;
  roomMs: number;
  journeyMs: number;
}): number {
  return Math.max(ARRIVE_MS, i.zooms ? roomLeft(i.roomMs, i.journeyMs) : 0);
}

/**
 * A step's own designed length: typing is the type verb's own schedule (the
 * lead, then a gap between keys), every other act is 0. A type with no text
 * (redacted) is the lead alone.
 */
export function actMs(action: SceneAction): number {
  if (action.kind !== "type") return 0;
  const n = typeKeysOf(action.text ?? "").length;
  return TYPE_LEAD_MS + Math.max(0, n - 1) * typeGapMs(n);
}

/**
 * How long the take runs on after its last act. A closing `pause` is added
 * to the take tail, as a pause before a step is to the base rest. The end
 * trim counts from the zoom's settle, or from the act when it says
 * `after: "action"` (`trimAfterAction`).
 */
export function tailMs(i: {
  zoomSettleMs: number | null;
  trimEndMs: number | null;
  trimAfterAction: boolean;
  pauseMs: number;
}): number {
  const z = i.zoomSettleMs ?? 0;
  return Math.max(
    TAKE_TAIL_MS + i.pauseMs,
    z,
    (i.trimAfterAction ? 0 : z) + (i.trimEndMs ?? 0),
  );
}
