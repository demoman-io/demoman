import { CAMERA_DEFAULTS, fitScaleFor } from "@demoman/compositor";
import {
  dragPoints,
  type SceneDocument,
  type SceneZoomSkipped,
} from "@demoman/scene-schema";
import { pointRect } from "./drag-points.js";
import { MIN_ZOOM_GAP_MS } from "./zoom-defaults.js";

type CameraEvent = SceneDocument["camera"][number];

/** The zooms a take is saved with, and the clicks they leave out. Two halves
 *  of one answer, returned together so no caller can write the camera and
 *  drop the reasons. */
export interface ClickZooms {
  camera: CameraEvent[];
  zoomsSkipped: SceneZoomSkipped[];
}

/** The last click a zoom was made for, which the next is measured from. */
export interface LastZoom {
  id: string;
  anchorId: string;
  timestamp: number;
}

/**
 * Whether one click gets a zoom, given the last one that did: the gap rule
 * (`MIN_ZOOM_GAP_MS`, `sameTarget` or `tooClose`) and the width floor
 * (`ZOOM_FLOOR_SCALE`). `scale` is the page's zoom at the click (see
 * `zoomsForClicks`). `zoomsForClicks` applies it to a whole take; the
 * replay's room policy (`room.ts`) asks it one click at a time, so the
 * replay never waits for a zoom the take will not have.
 */
export function decideZoom(
  last: LastZoom | null,
  click: {
    id: string;
    anchorId: string;
    timestamp: number;
    rect?: { width: number; height: number } | undefined;
  },
  viewport: { width: number; height: number },
  /** Asked only once the gap rule has let the click through. */
  scaleOf: () => number,
): { zoom: true; scale: number } | { zoom: false; skipped: SceneZoomSkipped } {
  if (last !== null) {
    // Signed in the record, a distance in the rule: nothing orders action
    // timestamps, and a click stamped before the last zoom is as close to
    // it as one stamped after.
    const gapMs = click.timestamp - last.timestamp;
    if (Math.abs(gapMs) < MIN_ZOOM_GAP_MS) {
      return {
        zoom: false,
        skipped: {
          actionId: click.id,
          reason: click.anchorId === last.anchorId ? "sameTarget" : "tooClose",
          afterActionId: last.id,
          gapMs: Math.round(gapMs),
        },
      };
    }
  }
  const scale = scaleOf();
  const fitted = fittedScale(
    click.rect === undefined
      ? undefined
      : { width: click.rect.width * scale, height: click.rect.height * scale },
    viewport,
  );
  if (fitted < ZOOM_FLOOR_SCALE) {
    return {
      zoom: false,
      skipped: { actionId: click.id, reason: "targetTooWide", scale: fitted },
    };
  }
  return { zoom: true, scale: fitted };
}

/** The box around a drag's two points (`dragPoints`), or around its
 *  elements' boxes when an end cannot be placed; undefined with neither. */
function dragBox(
  action: Extract<SceneDocument["actions"][number], { kind: "drag" }>,
): { x: number; y: number; width: number; height: number } | undefined {
  const points = dragPoints(action, action.rect, action.toRect);
  const rects =
    points === null
      ? [action.rect, action.toRect].filter(
          (r): r is NonNullable<typeof r> => r !== undefined,
        )
      : [pointRect(points.start), pointRect(points.end)];
  if (rects.length === 0) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}

/**
 * A zoom on every click, generated once when the take is saved.
 *
 * Each event is exactly what the editor's "Zoom on this step" writes — an
 * element target, the default lead-in, the default scale, an automatic end
 * — so it is an ordinary segment on the Zoom lane: delete it, drag it,
 * extend its end. Nothing ever re-adds one. That is the difference from the
 * auto-zoom removed on 2026-08-30, which was a rule applied at render time
 * that refilled whatever the author deleted, so the lane could only be
 * argued with (v8 §6).
 *
 * Close clicks. Every click gets its zoom however close it follows the one
 * before: where there is no room to return to full frame between two
 * zooms, the camera glides from one straight to the next, and that glide
 * leaves only after the first click has landed and arrives before the
 * second (`insertNeutralKeys`), so the camera is settled on both. Until
 * 2026-10-09 a click whose zoom would start before the previous one's
 * return had room got none, so the camera never panned through a click
 * without arriving — about four seconds once the spring zooms lengthened
 * both moves, and a take of five clicks (a button, then two FAQ rows clicked
 * twice each) came out with one zoom. The glide answers that reason now.
 *
 * What is left is a floor on the glide itself: a click under
 * `MIN_ZOOM_GAP_MS` after the last zoomed click gets none, since the move
 * between them would be a whip rather than a glide. On the element that zoom
 * is already framing it is reported as `sameTarget` rather than `tooClose`:
 * the camera is on it either way. Judged on the take's own timestamps —
 * nothing has rendered yet — which gaps played back verbatim keep close to
 * output time. The editor measures every gesture on the Zoom lane against
 * the same number (`collides`, `placeZoom`).
 *
 * A same-target click past that gap gets its zoom like any other. Its glide
 * is no move at all when its rect is the one before — the compositor holds a
 * zero-distance key still — and the zoom keeps the camera on the target
 * through the second click's own hold rather than pulling out from under it
 * 850ms after the first.
 *
 * Scale. The default, unless the clicked element would not fit inside the
 * zoomed window with `ZOOM_FIT_MARGIN_PX` round it: then the largest scale at
 * which it does (`fittedScale`). A zoom whose fit ends below
 * `ZOOM_FLOOR_SCALE` is not made, and does not count as the last zoomed
 * click for the gap.
 *
 * The text on screen does not narrow it. From 2026-10-09 to 2026-10-10 it
 * did ("O2": the largest scale at which the window's edges cut no line of
 * text the sensor or the walk had measured at the click), and on a
 * text-dense page that is no zoom at all: every line beside the target is
 * one more edge the window has to miss, and on the author's KitchenLink FAQ
 * all four clicks came out under the floor, "too wide to zoom without
 * cutting text". The author dropped it on 2026-10-10 for the target fit,
 * which keeps what was clicked whole and lets the frame's edge fall where it
 * falls. Nothing measures the lines any more; see `Click.textLines`.
 *
 * Every click left without a zoom is in `zoomsSkipped`, with its reason, and
 * the take carries it to the editor's take notes (`zoomSkippedNote`).
 */
export function zoomsForClicks(
  actions: SceneDocument["actions"],
  viewport: { width: number; height: number },
  // The page's zoom at a click (`ViewportTransform`): a phone shows a page
  // with no meta viewport at 0.401 of its own px, and a click's rect is in
  // those px. Scaled onto the screen before the fit, so the margin stays the
  // compositor's screen px.
  scaleAt: (action: SceneDocument["actions"][number]) => number = () => 1,
): ClickZooms {
  const { leadInMs } = CAMERA_DEFAULTS;
  const camera: CameraEvent[] = [];
  const zoomsSkipped: SceneZoomSkipped[] = [];
  let last: LastZoom | null = null;
  for (const action of actions) {
    if (action.kind !== "click" && action.kind !== "drag") continue;
    // A drag is framed by the box around both its ends, aimed at its middle:
    // a zoom on its start alone would lose the drop.
    const box = action.kind === "drag" ? dragBox(action) : undefined;
    const decided = decideZoom(
      last,
      box === undefined ? action : { ...action, rect: box },
      viewport,
      () => scaleAt(action),
    );
    if (!decided.zoom) {
      zoomsSkipped.push(decided.skipped);
      continue;
    }
    camera.push({
      id: `zoom-${camera.length + 1}`,
      kind: "zoom",
      ...(box === undefined
        ? { anchorId: action.anchorId }
        : {
            point: {
              x: box.x + box.width / 2,
              y: box.y + box.height / 2,
            },
          }),
      marker: { actionId: action.id, offsetMs: leadInMs },
      scale: decided.scale,
    });
    last = {
      id: action.id,
      anchorId: action.anchorId,
      timestamp: action.timestamp,
    };
  }
  return { camera, zoomsSkipped };
}

/**
 * The take note for one click its generated zooms left out: one line, the
 * click and the rule, in the words the editor shows.
 */
export function zoomSkippedNote(skip: SceneZoomSkipped): string {
  const head = `No zoom on click ${skip.actionId}`;
  const gap =
    "gapMs" in skip
      ? `${Math.abs(skip.gapMs)}ms ${skip.gapMs < 0 ? "before" : "after"} ${skip.afterActionId}`
      : "";
  switch (skip.reason) {
    case "tooClose":
      return `${head}: too close to the previous zoom (${gap}, minimum ${MIN_ZOOM_GAP_MS}ms).`;
    case "sameTarget":
      return `${head}: same target as the previous zoom, already zoomed in (${gap}).`;
    case "targetTooWide":
      return `${head}: target too wide to zoom (fits at ${skip.scale}x, floor ${ZOOM_FLOOR_SCALE}x).`;
    // Written only from 2026-10-09 to 2026-10-10, while the zoom was also
    // narrowed to the text on screen; nothing writes it now. A take saved
    // then still carries it, and its note still says what happened at that
    // save: the camera it holds has no zoom on that click for this reason.
    case "textTooWide":
      return `${head}: target too wide to zoom without cutting text (would be ${skip.scale}x, floor ${ZOOM_FLOOR_SCALE}x).`;
  }
}

/**
 * CSS px of page kept round a zoomed target on every side, so its edges and
 * the cursor on it are not flush with the frame. The compositor's, so a
 * `cover` render fits its crop with the same margin this fits the viewport
 * with.
 */
export const ZOOM_FIT_MARGIN_PX = CAMERA_DEFAULTS.fitMarginPx;

/**
 * The default zoom, narrowed until `rect` and its margin fit the window the
 * camera shows. M2's second run (2026-10-01) is why: at 1.8x a 900 px window
 * shows 500 px, and every click on a 678 px FAQ row cropped the row, and the
 * answer that opened under it, mid-word at both sides.
 *
 * No rect (a sighting that had none) keeps the default: there is nothing to
 * fit, which is what every generated zoom did before. The fit itself is the
 * compositor's (`fitScaleFor`), which a `cover` render applies again
 * against its narrower crop.
 */
function fittedScale(
  rect: { width: number; height: number } | undefined,
  viewport: { width: number; height: number },
): number {
  const { defaultZoomScale } = CAMERA_DEFAULTS;
  if (!rect) return defaultZoomScale;
  return Math.min(defaultZoomScale, fitScaleFor(rect, viewport));
}

/**
 * The smallest zoom worth making. Below it a push-in barely reads as one,
 * and it still costs the camera a push-in and a pull-out (and, until
 * 2026-10-09, the room the next click's zoom needed). The fit falls under it
 * only for a target nearly as wide (or tall) as the window: at the 24 px
 * margin a 1200 px viewport fits a 952 px target at 1.2x and an 1100 px one
 * at 1.04x. 1.2 keeps M6's measured FAQ zooms (1.23, accepted by the author
 * on 2026-10-01). It came in on 2026-10-09 as the floor of "O2 with a floor"
 * (`reports/2026-10-09-agent-video-defects.md`), where the text-safe scale
 * put the KitchenLink hero at 1.18; the author kept it for the target fit
 * when O2 was dropped on 2026-10-10. This is the floor's one number, and the
 * place to change it.
 */
export const ZOOM_FLOOR_SCALE = 1.2;
