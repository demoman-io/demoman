import {
  clampCameraCenter,
  contentScale,
  cssRectToOutput,
  derivePresentation,
  LANDSCAPE_1080P,
  planScene,
  resolvePlan,
} from "@demoman/compositor";
import { MOTION_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { applyCommand } from "../../../pages/src/editor/commands";
import { buildLaneModel, type ZoomSeg } from "../../../pages/src/editor/lanes";
import {
  cameraAt,
  canvasRectToCss,
  cssRectToCanvas,
  maskRectFromDrag,
  zoomFocusRect,
} from "../../../pages/src/editor/masks";
import { previewTarget } from "../../../pages/src/editor/preview";
import { buildTimelineView } from "../../../pages/src/editor/timeline";

const scene = readonlyScene();
const bundle = proceduralBundle();
const target = previewTarget(LANDSCAPE_1080P);
const resolved = resolvePlan(planScene(scene), bundle, scene);
const presentation = derivePresentation(
  scene.branding,
  target,
  scene.meta.capture.viewport,
  null,
);
const viewport = scene.meta.capture.viewport;

describe("maskRectFromDrag", () => {
  it("round-trips a rect drawn over where that rect renders", () => {
    const at = 500;
    const camera = cameraAt({
      resolved,
      outputTimeMs: at,
      presentation,
      target,
      viewport,
    });
    const css = { x: 60, y: 380, width: 400, height: 24 };
    const drawn = cssRectToOutput(
      css,
      camera,
      presentation.frameRect,
      viewport,
    );

    const back = maskRectFromDrag({
      from: { x: drawn.x, y: drawn.y },
      to: { x: drawn.x + drawn.width, y: drawn.y + drawn.height },
      resolved,
      target,
      presentation,
      outputTimeMs: at,
    });

    expect(back.x).toBeCloseTo(css.x, 4);
    expect(back.y).toBeCloseTo(css.y, 4);
    expect(back.width).toBeCloseTo(css.width, 4);
    expect(back.height).toBeCloseTo(css.height, 4);
  });

  it("normalizes a drag made right-to-left and upwards", () => {
    const rect = maskRectFromDrag({
      from: { x: 400, y: 300 },
      to: { x: 200, y: 100 },
      resolved,
      target,
      presentation,
      outputTimeMs: 0,
    });
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });

  it("clamps a drag that runs off the frame into the viewport", () => {
    // The rect is stored in capture-space CSS and the schema requires
    // non-negative dimensions; a drag onto the background must not produce
    // a mask outside the page it is meant to redact.
    const rect = maskRectFromDrag({
      from: { x: -5000, y: -5000 },
      to: { x: 5000, y: 5000 },
      resolved,
      target,
      presentation,
      outputTimeMs: 0,
    });
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
  });
});

describe("cameraAt", () => {
  it("applies the same containment clamp the renderer applies", () => {
    // renderFrame clamps once so the image, the cosmetics and the cursor
    // all use one camera. Authoring against an unclamped camera would put
    // masks somewhere the pixels underneath them are not.
    const camera = cameraAt({
      resolved,
      outputTimeMs: 4000,
      presentation,
      target,
      viewport,
    });
    expect(camera.scale).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(camera.center.x)).toBe(true);
    expect(Number.isFinite(camera.center.y)).toBe(true);
  });

  // The renderer zooms the whole composition and keeps that view inside the
  // canvas, which reaches closer to a page edge than a window-bound camera.
  // A mask authored against the old clamp would land beside its pixels.
  it("reaches as close to a page corner as the renderer's scene camera", () => {
    const zoomed = applyCommand(
      scene,
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "point", x: 60, y: 40 },
        scale: 2,
      },
      () => "z",
    );
    // Follow off: the fixture's pointer is across the page from this
    // corner, and the follow-cam would pan after it. The case is about how
    // far the zoom itself reaches.
    const still = { ...zoomed, motion: { ...MOTION_DEFAULTS, follow: false } };
    const r = resolvePlan(planScene(still), bundle, still);
    const at = (r.cameraSegments[0]?.startMs ?? 0) + 200;
    const camera = cameraAt({
      resolved: r,
      outputTimeMs: at,
      presentation,
      target,
      viewport,
    });
    // Fixture guard: the camera really is zoomed here.
    expect(camera.scale).toBeGreaterThan(1.5);
    const windowBound = clampCameraCenter(
      { x: 60, y: 40 },
      contentScale(presentation.frameRect, viewport) * camera.scale,
      presentation.frameRect,
      viewport,
    );
    // The scene camera centres on the canvas corner: its own corner on the
    // output's, so the page point drawn at the centre is nearer the target.
    expect(camera.center.x).toBeLessThan(windowBound.x - 50);
    expect(camera.center.y).toBeLessThan(windowBound.y - 30);
    const corner = cssRectToOutput(
      { x: 0, y: 0, width: 0, height: 0 },
      camera,
      presentation.frameRect,
      viewport,
    );
    expect(corner.x).toBeCloseTo(presentation.frameRect.x * camera.scale, 3);
    expect(corner.y).toBeCloseTo(presentation.frameRect.y * camera.scale, 3);
  });
});

describe("cssRectToCanvas / canvasRectToCss", () => {
  it("round-trip through the camera the renderer uses at that instant", () => {
    const zoomed = applyCommand(
      scene,
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 2,
      },
      () => "z",
    );
    const r = resolvePlan(planScene(zoomed), bundle, zoomed);
    const at = (r.cameraSegments[0]?.startMs ?? 0) + 200;
    // Fixture guard: the camera really is zoomed here.
    expect(
      cameraAt({
        resolved: r,
        outputTimeMs: at,
        presentation,
        target,
        viewport,
      }).scale,
    ).toBeGreaterThan(1.5);
    const css = { x: 300, y: 320, width: 200, height: 30 };
    const canvas = cssRectToCanvas({
      rect: css,
      resolved: r,
      target,
      presentation,
      outputTimeMs: at,
    });
    const back = canvasRectToCss({
      rect: canvas,
      resolved: r,
      target,
      presentation,
      outputTimeMs: at,
    });
    for (const k of ["x", "y", "width", "height"] as const)
      expect(back[k]).toBeCloseTo(css[k], 4);
  });
});

describe("zoomFocusRect", () => {
  // What the camera frames is the whole output — window, margin and all —
  // so the focus is the canvas mapped back onto the page. It is wider than
  // the viewport divided by the scale, which is what a window-bound zoom
  // showed, because the window grows past the output's edges.
  it("is the whole output mapped back onto the page", () => {
    const zoomed = applyCommand(
      scene,
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "point", x: 1200, y: 700 },
        scale: 2,
      },
      () => "z",
    );
    const r = resolvePlan(planScene(zoomed), bundle, zoomed);
    const model = buildLaneModel({
      scene: zoomed,
      view: buildTimelineView({ scene: zoomed, bundle, resolved: r }),
      bundle,
      resolved: r,
      hoverReport: null,
    });
    const focus = zoomFocusRect({
      zoom: model.zooms[0] as ZoomSeg,
      resolved: r,
      viewport,
      presentation,
      target,
    });
    expect(focus.width).toBeGreaterThan(viewport.width / 2 + 100);
    // Measured at the plateau the focus was taken from.
    const mid = cssRectToCanvas({
      rect: focus,
      resolved: r,
      target,
      presentation,
      outputTimeMs:
        ((model.zooms[0] as ZoomSeg).startMs +
          (model.zooms[0] as ZoomSeg).endMs) /
        2,
    });
    expect(mid.x).toBeCloseTo(0, 3);
    expect(mid.y).toBeCloseTo(0, 3);
    expect(mid.width).toBeCloseTo(target.width, 3);
    expect(mid.height).toBeCloseTo(target.height, 3);
  });
});
