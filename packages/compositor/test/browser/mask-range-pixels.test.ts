import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { toOutputMs } from "../../src/plan/timeline";
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
            start: { actionId: "act-2", sourceOffsetMs: 0 },
            end: { actionId: "act-2", sourceOffsetMs: 800 },
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

/** `readonlyScene` with one removed piece and one mask, both by source
 *  point. The fixture's frame markers: act-1 400, act-2 3200, act-3 9000. */
function cutAndMasked(
  removed: [string, number, string, number],
  mask: [string, number, string, number],
) {
  const scene = readonlyScene();
  const [ra, ro, rb, rbo] = removed;
  const [ma, mo, mb, mbo] = mask;
  return {
    ...scene,
    edits: {
      ...scene.edits,
      removed: [
        {
          id: "r-1",
          start: { actionId: ra, sourceOffsetMs: ro },
          end: { actionId: rb, sourceOffsetMs: rbo },
        },
      ],
      masks: [
        {
          id: "m",
          rect: RECT,
          start: { actionId: ma, sourceOffsetMs: mo },
          end: { actionId: mb, sourceOffsetMs: mbo },
        },
      ],
    },
  };
}

/** The pixel at `src`'s output instant, masked and with the mask taken off. */
async function atSource(scene: ReturnType<typeof cutAndMasked>, src: number) {
  const { resolved } = await probe(scene, 0);
  const outputMs = toOutputMs(resolved.timeline, src);
  const bare = { ...scene, edits: { ...scene.edits, masks: [] } };
  return {
    masked: (await probe(scene, outputMs)).pixel,
    bare: (await probe(bare, outputMs)).pixel,
  };
}

describe("a ranged mask after a cut (audit run 1)", () => {
  // Red: planCosmetics dropping a mask whose opening step is in a removed
  // piece — the frames after the piece played unmasked.
  it("paints the frames that survive a piece removed from its opening step", async () => {
    const scene = cutAndMasked(
      ["act-2", 0, "act-2", 2000],
      ["act-2", 0, "act-3", 0],
    );
    // 5300: the first stretch after the removed 3200..5200.
    const after = await atSource(scene, 5300);
    expect(after.bare).not.toEqual(MASK_FILL);
    expect(after.masked).toEqual(MASK_FILL);
  }, 60_000);

  // Red: a mask's ends on the output axis — removing 600..1000 slid it
  // 400 ms later, off frames 1400..1800 it was drawn over.
  it("stays on the frames it was drawn over when a piece is removed before them", async () => {
    const scene = cutAndMasked(
      ["act-1", 200, "act-1", 600],
      ["act-1", 1000, "act-1", 2500],
    );
    for (const src of [1500, 2850]) {
      const at = await atSource(scene, src);
      expect(at.bare, `source ${src}`).not.toEqual(MASK_FILL);
      expect(at.masked, `source ${src}`).toEqual(MASK_FILL);
    }
    // And off the frames after them.
    expect((await atSource(scene, 3100)).masked).not.toEqual(MASK_FILL);
  }, 60_000);
});
