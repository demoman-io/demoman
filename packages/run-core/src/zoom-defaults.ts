import { CAMERA_DEFAULTS, motionTimings } from "@demoman/compositor";
import { MOTION_DEFAULTS } from "@demoman/scene-schema";

/**
 * The numbers every zoom-spacing rule shares — the editor's gesture resolver
 * (`src/editor/gestures.ts`) and the zooms generated when a take is saved
 * (`auto-zoom.ts`). One definition, so a bound the author is told about on
 * the timeline is the bound the saved take was laid out to.
 */

/** How long a freshly added zoom runs before its automatic return: the
 *  hold, then the pull-out back to full frame, whose length follows the
 *  document's smoothness (`motionTimings`). The editor reads it for the
 *  document it is drawing, as `LaneModel.zoomDefaultMs`. */
export function zoomDefaultMs(smoothness: number): number {
  return (
    CAMERA_DEFAULTS.neutral.zoomHoldMs + motionTimings(smoothness).zoomOutMs
  );
}

/** `zoomDefaultMs` at the default smoothness. For a take with no `motion`
 *  block; anything drawing a document's zooms reads
 *  `LaneModel.zoomDefaultMs`, which follows that document's slider. */
export const ZOOM_DEFAULT_MS = zoomDefaultMs(MOTION_DEFAULTS.smoothness);

/**
 * The shortest glide between two zooms that reads as a move. Below it the
 * camera whips from one target to the next; the compositor's own floor
 * (`MIN_PAN_MS`, 150ms) is where a move becomes a cut, and this sits well
 * above that — twelve frames at 30fps, long enough for the eye to follow
 * where the frame went.
 */
export const ZOOM_GLIDE_MIN_MS = 400;

/**
 * The least time between the clicks of two zooms, so the glide between
 * them is at least `ZOOM_GLIDE_MIN_MS`: 1000ms. The
 * one spacing rule every zoom answers to — the zooms generated at save
 * (`zoomsForClicks`) and every gesture on the Zoom lane (`collides`,
 * `placeZoom` in `src/editor/gestures.ts`) — so the editor never refuses a
 * layout auto-zoom wrote. The editor measures it between the zooms' STARTS,
 * which for two generated zooms is the same number (each arrives `leadInMs`
 * before its click) and for a zoom added on the lane, which takes no
 * lead-in and so departs sooner, errs long.
 *
 * Derived from how the compositor glides when two zooms are too close to
 * return to full frame between (`insertNeutralKeys`): the move to the next
 * zoom departs `minPlateauMs` after this zoom's click (the camera is settled
 * on every click it glides between) and arrives `|leadInMs|` before the next
 * click. So a gap of `g` between the clicks leaves
 * `g - |leadInMs| - minPlateauMs` of travel, and the sum below is the gap
 * that leaves `ZOOM_GLIDE_MIN_MS`. Neither term moves with the smoothness
 * slider — a smoother take's longer push-in is only ever shortened to fit
 * the glide — so a layout made at the default holds at any smoothness,
 * which the room rule before it could not say.
 *
 * It replaced `ZOOM_ROOM_MS` (2026-10-09), which was the room for a full
 * return between two zooms — `minPlateauMs + zoomInMs`, 1550ms, on top of a
 * zoom's whole `ZOOM_DEFAULT_MS` — and so ruled any two zooms closer than
 * about four seconds apart out of the take and off the lane. It was right
 * while a glide could pan straight through a click without ever arriving;
 * once the glide waited for each click, a return was a nicety rather than
 * the only way to land.
 */
export const MIN_ZOOM_GAP_MS =
  Math.abs(CAMERA_DEFAULTS.leadInMs) +
  CAMERA_DEFAULTS.neutral.minPlateauMs +
  ZOOM_GLIDE_MIN_MS;
