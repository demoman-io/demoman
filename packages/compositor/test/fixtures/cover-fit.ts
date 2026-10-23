import type { SceneDocument } from "@demoman/scene-schema";
import type { FrameBundle } from "../../src/bundle";
import { CAMERA_DEFAULTS } from "../../src/plan/camera";
import { type RenderTarget, VERTICAL_1080 } from "../../src/render/target";
import { proceduralBundle } from "./bundle";
import { readonlyScene } from "./scene";

/**
 * A click on a row the landscape fit keeps whole and a 9:16 crop does not.
 *
 * The capture is 1280x800. A `cover` 9:16 frame at padding 0 shows
 * 800 x 9/16 = 450 CSS px across at camera scale 1, and 391 at the
 * vertical cap (1.15). The row is 440 wide, centred on the page: whole at
 * 1x, cut 24.5 px at each end at the cap. Its zoom is the default 1.8x —
 * what `zoomsForClicks` writes for it against the capture viewport, where
 * 440 + 48 fits 2.6 times over.
 *
 * Padding 0 so the window is that arithmetic and nothing else; the tests
 * assert the window from the composition rather than trusting it.
 */
export const COVER_ROW = { x: 420, y: 600, width: 440, height: 44 };
/** A button-sized target at the same place: fits the crop at the cap. */
export const COVER_BUTTON = { x: 560, y: 600, width: 160, height: 44 };

/** A small `cover` 9:16 target; the frame's shape, not its size, is what
 *  the window depends on. */
export const COVER_TARGET: RenderTarget = {
  ...VERTICAL_1080,
  width: 270,
  height: 480,
};

/** The zoom is on the fixture's middle click (act-2, 3.2 s into a 9 s
 *  take), so it has a plateau and a pull-out before the next beat. */
export function coverBundle(rect = COVER_ROW): FrameBundle {
  const base = proceduralBundle();
  return {
    ...base,
    anchorRects: base.anchorRects.map((entry) =>
      entry.actionId === "act-2" ? { ...entry, rect } : entry,
    ),
  };
}

export function coverScene(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    branding: { ...scene.branding, padding: 0 },
    camera: [
      {
        id: "cam-row",
        kind: "zoom",
        anchorId: "a-row",
        marker: { actionId: "act-2", offsetMs: CAMERA_DEFAULTS.leadInMs },
        scale: CAMERA_DEFAULTS.defaultZoomScale,
      },
    ],
  };
}

export const COVER_ZOOM_SCALE = CAMERA_DEFAULTS.defaultZoomScale;
