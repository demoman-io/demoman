import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import { planScene } from "../../src/plan/plan";
import type { FrameImage, FrameSource } from "../../src/ports/types";
import { renderFrame } from "../../src/render/compose";
import { composeForTarget } from "../../src/render/compose-for-target";
import { LANDSCAPE_1080P, type RenderTarget } from "../../src/render/target";
import {
  COVER_ROW,
  COVER_TARGET,
  coverBundle,
  coverScene,
} from "../fixtures/cover-fit";

/**
 * The picture half of `test/node/cover-fit.test.ts`: a 9:16 `cover` render
 * of a click on a 440 px row shows both of the row's ends on the zoom's
 * plateau. Before the fit, the vertical cap (1.15) showed 391 CSS px of
 * the 1280 px page and cut 24.5 px off each end of the row.
 *
 * The page is drawn here rather than taken from the procedural fixture: grey,
 * the row blue, and a 16 px cap at each end of it — red at the left, green
 * at the right — so "both ends are in frame" is a count of two colours.
 */
const CAP_PX = 16;

function rowFrames(bundle: FrameBundle): FrameSource {
  const { width, height } = bundle.viewport;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, width, height);
  const { x, y, width: w, height: h } = COVER_ROW;
  ctx.fillStyle = "#0000ff";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(x, y, CAP_PX, h);
  ctx.fillStyle = "#00ff00";
  ctx.fillRect(x + w - CAP_PX, y, CAP_PX, h);
  return {
    at: async (sourceTimeMs): Promise<FrameImage> => ({
      image: canvas,
      width,
      height,
      sourceTimeMs,
    }),
    describe: () => ({
      keyframes: bundle.keyframes,
      motionSpans: bundle.motionSpans,
    }),
  };
}

/** Pixels of the two cap colours in the frame drawn at the zoom's plateau. */
async function capsOnPlateau(
  target: RenderTarget,
): Promise<{ left: number; right: number; scale: number }> {
  const scene = coverScene();
  const bundle = coverBundle();
  const composed = composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target,
  });
  const segment = composed.resolved.cameraSegments[0];
  if (!segment) throw new Error("the zoom has no segment");
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  await renderFrame({
    resolved: composed.resolved,
    target,
    presentation: composed.presentation,
    frames: rowFrames(bundle),
    ctx,
    outputTimeMs: segment.startMs + 200,
  });
  const { data } = ctx.getImageData(0, 0, target.width, target.height);
  let left = 0;
  let right = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] as number;
    const g = data[i + 1] as number;
    const b = data[i + 2] as number;
    if (r > 200 && g < 60 && b < 60) left++;
    if (g > 200 && r < 60 && b < 60) right++;
  }
  const key = composed.resolved.cameraKeys.find(
    (k) => Math.abs(k.outputTimeMs - segment.startMs) < 1e-6,
  );
  return { left, right, scale: key?.scale ?? Number.NaN };
}

describe("a 9:16 cover render of a click on a wide row", () => {
  // The fixture draws both caps where the landscape render, whose 1.8x
  // window is 711 CSS px, shows them. Without this the vertical case below
  // could pass on a page that never had caps to show.
  it("draws both of the row's ends, as the landscape render shows them", async () => {
    const landscape = await capsOnPlateau({
      ...LANDSCAPE_1080P,
      width: 960,
      height: 540,
    });
    expect(landscape.scale).toBeGreaterThan(1.5);
    expect(landscape.left).toBeGreaterThan(100);
    expect(landscape.right).toBeGreaterThan(100);
  }, 60_000);

  // Red with the fit removed: at the 1.15 cap both caps are outside the
  // crop and neither colour is drawn. 16 x 44 CSS px at 0.6 output px per
  // CSS px is about 250 pixels a cap, so 150 leaves room for the edges.
  it("shows both of the row's ends on the zoom's plateau", async () => {
    const vertical = await capsOnPlateau(COVER_TARGET);
    expect(vertical.left, JSON.stringify(vertical)).toBeGreaterThan(150);
    expect(vertical.right, JSON.stringify(vertical)).toBeGreaterThan(150);
    // measured well under 1 s locally; 60 s for CI's ~5x and a cold launch.
  }, 60_000);
});
