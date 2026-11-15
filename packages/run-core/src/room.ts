import {
  CAMERA_DEFAULTS,
  motionTimings,
  pullOutLandsAt,
  returnsBetween,
} from "@demoman/compositor";
import { type RoomPolicy, SETTLE_MS } from "@demoman/replay-engine";
import type { SceneMotion, ZoomIntentOf } from "@demoman/scene-schema";
import { decideZoom, type LastZoom } from "./auto-zoom.js";

/**
 * How much nearer a return a click's gap must be before the walk paces it
 * as a pan. The walk judges the click where it projects it, before the
 * cursor's journey; the marker lands a little later (measured 75ms on the
 * executor's navigation case), and a pan adds no room to absorb that. Room
 * only widens a gap, so pacing the band as a return keeps the walk and the
 * camera agreeing: a click paced as a pan stays one.
 *
 * Under a beat plan the answer is the camera's record, so a click paced as
 * a return is also given a full return plus this margin (`returnShortMs`).
 * The video's gap is the designed gap, plus motion the designed clock does
 * not count (page paints, a scroll), which only widens it, less what the
 * designed clock counts that may play shorter: a journey's eased-out end
 * (measured 50–73 ms) and typing that runs ahead of its schedule. The margin
 * covers the first with room; a gap the second still takes below a return
 * renders as a pan (`arrivesOf` follows a recorded return only where one
 * fits), never as a squeezed return.
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
  intentOf?: ZoomIntentOf,
): RoomPolicy {
  let last: LastZoom | null = null;
  let clicks = 0;
  const timings = motionTimings(motion.smoothness);
  const pushIn =
    CAMERA_DEFAULTS.actSettleMs +
    timings.zoomInMs +
    Math.abs(CAMERA_DEFAULTS.leadInMs);
  // `returnsBetween`'s own terms: a plateau, the pull-out, the push-in and
  // a plateau, from what the zoom before holds until to this arrival.
  const fullReturn =
    2 * CAMERA_DEFAULTS.neutral.minPlateauMs +
    timings.zoomOutMs +
    timings.zoomInMs;
  const arrives: RoomPolicy["arrives"] = ({ heldUntilMs, clickMs }) =>
    heldUntilMs !== null &&
    !returnsBetween(
      heldUntilMs,
      clickMs + CAMERA_DEFAULTS.leadInMs + PAN_MARGIN_MS,
      timings,
    )
      ? "pan"
      : "return";
  return {
    arrives,
    // Defined by `arrives`, so 0 exactly when the camera pans.
    neededMs: (gap) => (arrives(gap) === "pan" ? 0 : pushIn),
    returnShortMs: ({ heldUntilMs, clickMs }) =>
      heldUntilMs === null
        ? 0
        : Math.max(
            0,
            heldUntilMs +
              fullReturn +
              PAN_MARGIN_MS -
              (clickMs + CAMERA_DEFAULTS.leadInMs),
          ),
    // The camera's own landing, plus a settle so the film ends still.
    settledAfterMs: (heldUntilMs) =>
      pullOutLandsAt(heldUntilMs, timings) + SETTLE_MS,
    zooms({ actionId, anchorId, rect, unwaitedMs, scale }) {
      const id = `click-${++clicks}`;
      const decided = decideZoom(
        last,
        { id, anchorId, timestamp: unwaitedMs, rect },
        viewport,
        () => scale,
        intentOf?.(actionId),
      );
      if (decided.zoom) last = { id, anchorId, timestamp: unwaitedMs };
      return decided.zoom;
    },
  };
}
