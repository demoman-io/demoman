import {
  composeForTarget,
  createImageFrameSource,
  drawBackground,
  type Presentation,
  planScene,
  type RenderTarget,
  renderFrame,
} from "@demoman/compositor";
import type { SceneAspect } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { targetFor } from "../../../pages/src/editor/formats";
import { frameOf } from "../../../pages/src/editor/jobs";
import { previewTarget } from "../../../pages/src/editor/preview";
import { createFixtureBundleSource } from "../helpers/fixture-bundle-source";
import { proceduralFrames } from "../helpers/frames";

/**
 * The bounding box of every pixel the frame put on the stage bed: the
 * picture the compositor drew, measured from the pixels rather than from
 * any rect.
 *
 * Against a second render of the backdrop alone, not against the colour at
 * (0,0). `derivePresentation`'s backdrop is a *linear gradient*
 * (`drawBackground`), so "differs from the pixel at (0,0)" is true of
 * almost every backdrop pixel too — measured on 2026-09-14, that probe
 * reported the drawn box as the full 1280x720 canvas for the landscape
 * preview, which is the target's own aspect and would have made both tests
 * below pass without looking at the frame at all. Differencing against the
 * same backdrop this render painted leaves only what the frame, its shadow
 * and its cosmetics added.
 *
 * `DELTA` is 96, not a hair above zero, because the frame is seated on two
 * soft shadow passes that fade into the bed for tens of pixels (see
 * `presentation.ts`). Measured against `presentation.frameRect` on the same
 * two renders: at a threshold of 24 the vertical box came out 405x707 —
 * the shadow reaching both canvas edges — and at 96 it is 373x693 against a
 * frameRect of 372.6x687.6 at (16.2, 16.2), and the landscape box is
 * 1038x654 against 1036.8x648 at (121.6, 36). So this measures the frame,
 * and the bed is still visible around it on every side.
 */
const DELTA = 96;

function drawnBounds(
  ctx: OffscreenCanvasRenderingContext2D,
  target: RenderTarget,
  presentation: Presentation,
) {
  const { width: w, height: h } = target;
  const bed = new OffscreenCanvas(w, h);
  const bedCtx = bed.getContext("2d") as OffscreenCanvasRenderingContext2D;
  drawBackground(bedCtx, target, presentation);
  const data = ctx.getImageData(0, 0, w, h).data;
  const bare = bedCtx.getImageData(0, 0, w, h).data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const delta =
        Math.abs((data[i] ?? 0) - (bare[i] ?? 0)) +
        Math.abs((data[i + 1] ?? 0) - (bare[i + 1] ?? 0)) +
        Math.abs((data[i + 2] ?? 0) - (bare[i + 2] ?? 0));
      if (delta > DELTA) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { width: maxX - minX + 1, height: maxY - minY + 1, found: maxX >= 0 };
}

/**
 * One frame of the preview, for one export format, composed the way the
 * page composes it.
 *
 * `composeForTarget`, not `resolvePlan` + `derivePresentation`: the vertical
 * cut's shape depends on the camera cap that only `composeForTarget` applies
 * (`cameraIntentsForTarget`, see `compose-for-target.ts`), and it is what
 * `main.ts`'s `refreshDerived` calls. A hand-assembled front half here would
 * be asserting about a composition the editor never draws.
 */
async function draw(aspect: SceneAspect) {
  const scene = readonlyScene();
  const bundle = proceduralBundle();
  const target = previewTarget(
    targetFor("mp4", aspect, bundle, frameOf(scene)),
  );
  const source = createFixtureBundleSource(bundle, proceduralFrames(bundle));
  const { resolved, presentation } = composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target,
  });
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  await renderFrame({
    resolved,
    target,
    presentation,
    frames: createImageFrameSource(bundle, source.load),
    ctx,
    outputTimeMs: 0,
  });
  return { target, bounds: drawnBounds(ctx, target, presentation) };
}

describe("the preview follows the format", () => {
  // 15s, not vitest's 5s default: composing one frame costs ~1-3s locally
  // and the CI runner is about 5x slower at it (CLAUDE.md, "CI runs on a
  // different machine than you do").
  it("draws the vertical cut taller than wide, from pixels", async () => {
    const { target, bounds } = await draw("9:16");
    const evidence = `target ${target.width}x${target.height}, drawn ${JSON.stringify(bounds)}`;
    expect(target.width / target.height, evidence).toBeCloseTo(9 / 16, 2);
    expect(bounds.found, evidence).toBe(true);
    // Fixture guard: the probe measures what the frame added over the
    // stage bed, so it says nothing unless some bed is still visible on
    // every side. A drawn box that reached the canvas edges would only be
    // reporting the target's own aspect back, and 405x720 is taller than
    // wide too — this test would pass on a probe that had stopped
    // measuring the picture.
    expect(bounds.width, evidence).toBeLessThan(target.width);
    expect(bounds.height, evidence).toBeLessThan(target.height);
    expect(bounds.height, evidence).toBeGreaterThan(bounds.width);
  }, 15_000);

  it("draws landscape wider than tall — the fixture guard for the test above", async () => {
    const { target, bounds } = await draw("16:9");
    const evidence = `target ${target.width}x${target.height}, drawn ${JSON.stringify(bounds)}`;
    expect(bounds.found, evidence).toBe(true);
    // The same fixture guard, for the same reason.
    expect(bounds.width, evidence).toBeLessThan(target.width);
    expect(bounds.height, evidence).toBeLessThan(target.height);
    expect(bounds.width, evidence).toBeGreaterThan(bounds.height);
  }, 15_000);
});
