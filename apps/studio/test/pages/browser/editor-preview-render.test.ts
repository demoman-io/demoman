import {
  createImageFrameSource,
  derivePresentation,
  LANDSCAPE_1080P,
  planScene,
  renderFrame,
  resolvePlan,
} from "@demoman/compositor";
import { describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { maskRectFromDrag } from "../../../pages/src/editor/masks";
import {
  createScrubber,
  previewTarget,
} from "../../../pages/src/editor/preview";
import { createFixtureBundleSource } from "../helpers/fixture-bundle-source";
import { proceduralFrames } from "../helpers/frames";

function setup() {
  const scene = readonlyScene();
  const bundle = proceduralBundle();
  const target = previewTarget(LANDSCAPE_1080P);
  const source = createFixtureBundleSource(bundle, proceduralFrames(bundle));
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const presentation = derivePresentation(
    scene.branding,
    target,
    scene.meta.capture.viewport,
    null,
  );
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  return { scene, bundle, target, source, resolved, presentation, canvas, ctx };
}

const pixelAt = (
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
): number[] => Array.from(ctx.getImageData(x, y, 1, 1).data);

// draw-cosmetics.ts's MASK_FILL ("#4b5563"), not exported, so an outside
// probe can assert it did NOT land the mask colour rather than only that it
// matches the unmasked render (which a background pixel would too).
const MASK_FILL = [75, 85, 99, 255];

describe("preview render path", () => {
  it("draws a frame into a context whose type renderFrame actually declares", async () => {
    // A real OffscreenCanvas, not a CanvasRenderingContext2D cast into the
    // parameter. The blit to the visible canvas costs one drawImage and
    // keeps the type honest.
    const { target, source, resolved, presentation, canvas, ctx, bundle } =
      setup();
    await renderFrame({
      resolved,
      target,
      presentation,
      frames: createImageFrameSource(bundle, source.load),
      ctx,
      outputTimeMs: 0,
    });
    expect(canvas.width).toBe(target.width);
    const centre = pixelAt(
      ctx,
      Math.round(target.width / 2),
      Math.round(target.height / 2),
    );
    expect(centre[3]).toBe(255);
  });

  it("reuses one presentation across a scrub instead of recomputing per frame", async () => {
    const { target, source, resolved, presentation, ctx, bundle } = setup();
    const frames = createImageFrameSource(bundle, source.load);
    const draw = vi.fn(async (outputTimeMs: number) => {
      await renderFrame({
        resolved,
        target,
        presentation,
        frames,
        ctx,
        outputTimeMs,
      });
    });
    const scrubber = createScrubber({ draw, schedule: (fn) => fn() });
    for (const t of [0, 100, 200, 300]) scrubber.seek(t);
    await scrubber.idle();
    // Latest-wins: four seeks, at most two draws, and the last one is 300.
    expect(draw.mock.calls.length).toBeLessThanOrEqual(2);
    expect(draw).toHaveBeenLastCalledWith(300);
  });

  it("holds at most one source frame while scrubbing", async () => {
    // The invariant SP6's render loop keeps, kept here too: MV3 memory is a
    // named platform risk and a scrub is the easiest way to violate it.
    const { target, source, resolved, presentation, ctx, bundle } = setup();
    let inFlight = 0;
    let peak = 0;
    // Hoisted outside `at` so the memo inside createImageFrameSource is
    // actually shared across calls — constructing a fresh inner source per
    // call would defeat the very cache this test is trying to measure.
    const inner = createImageFrameSource(bundle, source.load);
    const counted = {
      ...inner,
      async at(sourceTimeMs: number) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          return await inner.at(sourceTimeMs);
        } finally {
          inFlight -= 1;
        }
      },
    };
    const scrubber = createScrubber({
      draw: (outputTimeMs) =>
        renderFrame({
          resolved,
          target,
          presentation,
          frames: counted,
          ctx,
          outputTimeMs,
        }),
      schedule: (fn) => fn(),
    });
    for (const t of [0, 500, 1200, 2400]) scrubber.seek(t);
    await scrubber.idle();
    expect(peak).toBe(1);
  });

  it("renders a mask where the author drew it, and only there", async () => {
    // The round trip that matters: drag on the preview, store capture-space
    // CSS, render it back through the camera, and find opaque fill under
    // the drag. This is what outputToCss exists for.
    //
    // A centre-only probe cannot pin position: a mask displaced by a
    // fraction of its own width — the exact failure a drifting coordinate
    // inverse produces — still covers the drag's centre, so it would still
    // pass. Probing just outside the drag, and asserting those points are
    // untouched, is what actually bounds the mask to where it was drawn.
    const { scene, bundle, target, source, presentation } = setup();
    const at = 0;
    const base = resolvePlan(planScene(scene), bundle, scene);
    const rect = maskRectFromDrag({
      from: { x: target.width * 0.35, y: target.height * 0.5 },
      to: { x: target.width * 0.55, y: target.height * 0.56 },
      resolved: base,
      target,
      presentation,
      outputTimeMs: at,
    });

    const masked = {
      ...scene,
      edits: { ...scene.edits, masks: [{ id: "m-1", rect }] },
    };
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    await renderFrame({
      resolved: resolvePlan(planScene(masked), bundle, masked),
      target,
      presentation,
      frames: createImageFrameSource(bundle, source.load),
      ctx,
      outputTimeMs: at,
    });

    const unmaskedCanvas = new OffscreenCanvas(target.width, target.height);
    const unmaskedCtx = unmaskedCanvas.getContext(
      "2d",
    ) as OffscreenCanvasRenderingContext2D;
    await renderFrame({
      resolved: base,
      target,
      presentation,
      frames: createImageFrameSource(bundle, source.load),
      ctx: unmaskedCtx,
      outputTimeMs: at,
    });

    // Inside the drag, centred on it: opaque mask fill, different from the
    // unmasked render underneath.
    const inside = pixelAt(
      ctx,
      Math.round(target.width * 0.45),
      Math.round(target.height * 0.53),
    );
    const before = pixelAt(
      unmaskedCtx,
      Math.round(target.width * 0.45),
      Math.round(target.height * 0.53),
    );
    expect(inside).not.toEqual(before);

    // Just outside the drag, but still inside the app frame (not the
    // letterbox background, which is identical in both renders and would
    // prove nothing): unchanged by the mask, and not mask-coloured.
    const outsidePoints = [
      { x: target.width * 0.3, y: target.height * 0.53 }, // left of the drag
      { x: target.width * 0.45, y: target.height * 0.62 }, // below the drag
    ];
    for (const point of outsidePoints) {
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      const maskedPixel = pixelAt(ctx, x, y);
      const unmaskedPixel = pixelAt(unmaskedCtx, x, y);
      expect(maskedPixel).toEqual(unmaskedPixel);
      expect(maskedPixel).not.toEqual(MASK_FILL);
    }
  });
});
