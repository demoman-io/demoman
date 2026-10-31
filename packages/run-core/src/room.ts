import {
  CAMERA_DEFAULTS,
  motionTimings,
  returnsBetween,
} from "@demoman/compositor";
import { type RoomPolicy, SETTLE_MS } from "@demoman/replay-engine";
import type { SceneMotion } from "@demoman/scene-schema";
import { decideZoom, type LastZoom } from "./auto-zoom.js";

/**
 * How much nearer a return a click's gap must be before the walk paces it
 * as a pan. The walk judges the click where it projects it, before the
 * cursor's journey; the marker lands a little later (measured 75ms on the
 * executor's navigation case), and a pan adds no room to absorb that. Room
 * only widens a gap, so pacing the band as a return keeps the walk and the
 * camera agreeing: a click paced as a pan stays one.
 */
export const PAN_MARGIN_MS = 300;

/**
 * The CLI executor's unhurried beats (spec 2026-10-19): before a click the
 * camera will zoom to, the replay waits until there is room for the settle
 * after the last act, the zoom's push-in at the take's smoothness, and the
 * lead-in. Which clicks zoom is `zoomsForClicks`' own rule (`decideZoom`),
 * asked on time with the added room taken out, so waiting never makes a
 * zoom the take would not have had.
 *
 * A click the camera pans to from the zoom before it, without returning to
 * full frame, needs none of that (spec 2026-10-22, the author's pacing "C"):
 * there is no push-in, and the camera trails the pointer. Pan or return is
 * `returnsBetween`, the camera's own rule.
 */
export function createRoomPolicy(
  viewport: { width: number; height: number },
  motion: SceneMotion,
): RoomPolicy {
  let last: LastZoom | null = null;
  let clicks = 0;
  const timings = motionTimings(motion.smoothness);
  const pushIn =
    CAMERA_DEFAULTS.actSettleMs +
    timings.zoomInMs +
    Math.abs(CAMERA_DEFAULTS.leadInMs);
  return {
    neededMs: ({ heldUntilMs, clickMs }) =>
      heldUntilMs !== null &&
      !returnsBetween(
        heldUntilMs,
        clickMs + CAMERA_DEFAULTS.leadInMs + PAN_MARGIN_MS,
        timings,
      )
        ? 0
        : pushIn,
    // `insertNeutralKeys`' pull-out for a zoom with none after it, plus a
    // settle so the film ends on a still frame.
    settledAfterMs: (heldUntilMs) =>
      heldUntilMs +
      CAMERA_DEFAULTS.neutral.zoomHoldMs +
      timings.zoomOutMs +
      SETTLE_MS,
    zooms({ anchorId, rect, unwaitedMs, scale }) {
      const id = `click-${++clicks}`;
      const decided = decideZoom(
        last,
        { id, anchorId, timestamp: unwaitedMs, rect },
        viewport,
        () => scale,
      );
      if (decided.zoom) last = { id, anchorId, timestamp: unwaitedMs };
      return decided.zoom;
    },
  };
}
