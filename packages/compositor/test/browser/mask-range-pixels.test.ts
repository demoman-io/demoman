import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { cssToOutput, renderFrame } from "../../src/render/compose";
import { derivePresentation } from "../../src/render/presentation";
import { LANDSCAPE_1080P } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene } from "../fixtures/scene";

// draw-cosmetics.ts's MASK_FILL, not exported on purpose.
const MASK_FILL = [75, 85, 99, 255];
const RECT = { x: 260, y: 120, width: 180, height: 16 }; // a table cell's grey bar

async function probe(
  scene: ReturnType<typeof readonlyScene>,
  outputTimeMs: number,
) {
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
  const at = cssToOutput(
    { x: RECT.x + RECT.width / 2, y: RECT.y + RECT.height / 2 },
    { center: { x: 640, y: 400 }, scale: 1 },
    presentation.frameRect,
    bundle.viewport,
  );
  return {
    pixel: Array.from(
      ctx.getImageData(Math.round(at.x), Math.round(at.y), 1, 1).data,
    ),
    resolved,
  };
}

describe("a ranged mask", () => {
  it("paints inside its range and nowhere else", async () => {
    const scene = readonlyScene();
    // Fixture guard: the probe is not already the mask colour.
    expect((await probe(scene, 1000)).pixel).not.toEqual(MASK_FILL);

    const masked = {
      ...scene,
      edits: {
        ...scene.edits,
        masks: [
          {
            id: "m",
            rect: RECT,
            start: { actionId: "act-2", offsetMs: 0 },
            end: { actionId: "act-2", offsetMs: 800 },
          },
        ],
      },
    };
    const { resolved } = await probe(masked, 0);
    const range = resolved.cosmetics[0]?.range;
    if (!range) throw new Error("mask has no range");
    expect((await probe(masked, range.startMs - 50)).pixel).not.toEqual(
      MASK_FILL,
    );
    expect((await probe(masked, range.startMs + 400)).pixel).toEqual(MASK_FILL);
    expect((await probe(masked, range.endMs + 50)).pixel).not.toEqual(
      MASK_FILL,
    );
    // measured 0.08s locally; CI is ~5x slower (CLAUDE.md) — 60_000ms
    // leaves headroom well beyond that, for a slow cold Chromium launch.
  }, 60_000);
});
