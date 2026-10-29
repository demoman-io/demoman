import {
  contentScale,
  cssRectToOutput,
  frameTrack,
  outputRectToCss,
  outputToCss,
  type Presentation,
  type Rect,
  type RenderTarget,
  type ResolvedPlan,
  type Vec,
} from "@demoman/compositor";
import type { ZoomSeg } from "./lanes";

/**
 * The camera the renderer will actually use at this instant.
 *
 * `renderFrame` samples, then clamps the centre once so that the image, the
 * cosmetic rects and the cursor all share one camera. Authoring a mask
 * against an unclamped camera would place it somewhere the pixels
 * underneath it are not — so this mirrors that sequence exactly rather than
 * approximating it.
 */
export function cameraAt(args: {
  resolved: ResolvedPlan;
  outputTimeMs: number;
  presentation: Presentation;
  target: RenderTarget;
  viewport: { width: number; height: number };
}): { center: Vec; scale: number } {
  const { resolved, outputTimeMs, presentation, target, viewport } = args;
  return frameTrack(
    resolved,
    outputTimeMs,
    contentScale(presentation.frameRect, viewport),
    presentation.frameRect,
    viewport,
    target,
  );
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * A new mask's box: one quarter of the frame (half the width, half the
 * height) centred on `centre`, pushed inside the viewport. Capture-space
 * CSS, like every stored rect.
 */
export function defaultMaskRect(
  viewport: { width: number; height: number },
  centre: Vec,
): Rect {
  const width = viewport.width / 2;
  const height = viewport.height / 2;
  const x = clamp(centre.x - width / 2, 0, viewport.width - width);
  const y = clamp(centre.y - height / 2, 0, viewport.height - height);
  return { x, y, width, height };
}

/**
 * A drag on the preview canvas, in capture-space CSS.
 *
 * Masks target *data* — emails, numbers, table values — so they live in the
 * page's own coordinates and are re-applied on every render at whatever
 * camera that render is using. Storing output pixels instead would bake one
 * camera into a document layer that is supposed to survive re-rendering.
 */
export function maskRectFromDrag(args: {
  from: Vec;
  to: Vec;
  resolved: ResolvedPlan;
  target: RenderTarget;
  presentation: Presentation;
  outputTimeMs: number;
}): Rect {
  const { from, to, resolved, target, presentation, outputTimeMs } = args;
  const viewport = resolved.plan.viewport;
  const camera = cameraAt({
    resolved,
    outputTimeMs,
    presentation,
    target,
    viewport,
  });

  const corners = [from, to].map((point) =>
    outputToCss(point, camera, presentation.frameRect, viewport),
  );
  const [a, b] = corners;
  if (!a || !b) throw new Error("a drag needs two corners");

  // Normalized before clamping: a right-to-left drag is the same rectangle,
  // and clamping an inverted one would produce a negative width the schema
  // rejects.
  const left = clamp(Math.min(a.x, b.x), 0, viewport.width);
  const top = clamp(Math.min(a.y, b.y), 0, viewport.height);
  const right = clamp(Math.max(a.x, b.x), 0, viewport.width);
  const bottom = clamp(Math.max(a.y, b.y), 0, viewport.height);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Capture-space CSS → the canvas bitmap's own pixels, through the camera the
 * renderer uses at this instant. The overlay drags in canvas px (matching
 * `drawnBox`'s scale) and every stored rect is capture CSS, so this and its
 * inverse below are what let the box track the render without a second
 * geometry implementation to drift against the first.
 */
export function cssRectToCanvas(args: {
  rect: Rect;
  resolved: ResolvedPlan;
  target: RenderTarget;
  presentation: Presentation;
  outputTimeMs: number;
}): Rect {
  const { rect, resolved, target, presentation, outputTimeMs } = args;
  const viewport = resolved.plan.viewport;
  const camera = cameraAt({
    resolved,
    outputTimeMs,
    presentation,
    target,
    viewport,
  });
  return cssRectToOutput(rect, camera, presentation.frameRect, viewport);
}

/** The inverse of `cssRectToCanvas`, clamped to the capture viewport — the
 *  same clamp `maskRectFromDrag` applies, so a drag that lands off the
 *  frame still authors a rect the schema accepts. */
export function canvasRectToCss(args: {
  rect: Rect;
  resolved: ResolvedPlan;
  target: RenderTarget;
  presentation: Presentation;
  outputTimeMs: number;
}): Rect {
  const { rect, resolved, target, presentation, outputTimeMs } = args;
  const viewport = resolved.plan.viewport;
  const camera = cameraAt({
    resolved,
    outputTimeMs,
    presentation,
    target,
    viewport,
  });
  const css = outputRectToCss(rect, camera, presentation.frameRect, viewport);
  const left = clamp(css.x, 0, viewport.width);
  const top = clamp(css.y, 0, viewport.height);
  const right = clamp(css.x + css.width, 0, viewport.width);
  const bottom = clamp(css.y + css.height, 0, viewport.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * What the camera frames on this zoom's plateau, in capture CSS: the whole
 * output mapped back onto the page. The camera zooms the composition, so
 * near a page edge this runs past the viewport into the margin — which is
 * in shot, and is what the overlay should show.
 */
export function zoomFocusRect(args: {
  zoom: ZoomSeg;
  resolved: ResolvedPlan;
  viewport: { width: number; height: number };
  presentation: Presentation;
  target: RenderTarget;
}): Rect {
  const { zoom, resolved, viewport, presentation, target } = args;
  const camera = cameraAt({
    resolved,
    outputTimeMs: (zoom.startMs + zoom.endMs) / 2,
    presentation,
    target,
    viewport,
  });
  return outputRectToCss(
    { x: 0, y: 0, width: target.width, height: target.height },
    camera,
    presentation.frameRect,
    viewport,
  );
}
