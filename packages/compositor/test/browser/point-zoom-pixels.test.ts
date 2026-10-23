import { MOTION_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { renderFrame } from "../../src/render/compose";
import { derivePresentation } from "../../src/render/presentation";
import { LANDSCAPE_1080P } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene } from "../fixtures/scene";

/** The checkout button's centre: the one saturated blue on the fixture page. */
const BUTTON = { x: 1060, y: 642 };
const isBlue = ([r, g, b]: number[]) =>
  (b ?? 0) > 150 && (r ?? 255) < 120 && (g ?? 255) < 140;

async function centrePixel(scene = readonlyScene(), outputTimeMs: number) {
  const bundle = proceduralBundle();
  const target = { ...LANDSCAPE_1080P, width: 960, height: 540 };
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const presentation = derivePresentation(
    scene.branding,
    target,
    bundle.viewport,
    null,
  );
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  await renderFrame({
    resolved,
    target,
    presentation,
    frames: createProceduralFrameSource(bundle),
    ctx,
    outputTimeMs,
  });
  const { frameRect } = presentation;
  const cx = Math.round(frameRect.x + frameRect.width / 2);
  const cy = Math.round(frameRect.y + frameRect.height / 2);
  return { pixel: Array.from(ctx.getImageData(cx, cy, 1, 1).data), resolved };
}

describe("a point-targeted zoom", () => {
  it("frames the point at the centre of the picture on its plateau", async () => {
    // Fixture guard: at 1:1 the frame centre is a table row, not the button.
    const plain = await centrePixel(readonlyScene(), 5000);
    expect(isBlue(plain.pixel)).toBe(false);

    const scene = readonlyScene();
    const zoomed = {
      ...scene,
      // Follow off: the fixture's pointer is 500px from this point when the
      // zoom lands and walks toward it for six seconds, so the follow-cam
      // would rightly pan after it — and this case is about where the zoom
      // itself frames. (A pointer parked on the button instead would paint
      // over the very pixel sampled.)
      motion: { ...MOTION_DEFAULTS, follow: false },
      camera: [
        {
          id: "cam-p",
          kind: "zoom" as const,
          point: BUTTON,
          marker: { actionId: "act-2", offsetMs: 0 },
          scale: 2.4,
        },
      ],
    };
    const { resolved } = await centrePixel(zoomed, 0);
    const seg = resolved.cameraSegments[0];
    if (!seg) throw new Error("no segment");
    // Mid-plateau: after the push-in has arrived, before the pull-out starts.
    const at = seg.startMs + 200;
    const { pixel } = await centrePixel(zoomed, at);
    expect(isBlue(pixel)).toBe(true);
    // measured 0.045s locally; CI is ~5x slower (CLAUDE.md) — 60_000ms
    // leaves headroom well beyond that, for a slow cold Chromium launch.
  }, 60_000);
});
