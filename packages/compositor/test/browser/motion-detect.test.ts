import { describe, expect, it } from "vitest";
import type { FrameImage, FrameSource } from "../../src/ports/types";
import { detectKeyframeMotion } from "../../src/render/motion-detect";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";

// `createProceduralFrameSource`'s only source of visual difference is the
// panel-open step tied to a motion span's end: with `motionSpans: []` (as
// the two tests below need, to leave the probed gap uncovered) `panelOpen`
// is 0 for every timestamp, so any two frames it renders are pixel-identical
// by construction — there is no override of the shared fixture that can make
// them differ. This tiny source paints two flat colours instead, so the
// tests exercise the real `detectKeyframeMotion` → greyscale → meanAbsDiff
// pipeline against frames that actually differ, without touching the shared
// fixture other tests rely on.
function flatColorFrameSource(colorAt: Record<number, string>): FrameSource {
  return {
    async at(sourceTimeMs: number): Promise<FrameImage> {
      const canvas = new OffscreenCanvas(64, 64);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.fillStyle = colorAt[sourceTimeMs] ?? "#000000";
      ctx.fillRect(0, 0, 64, 64);
      // This fake paints exactly the colour for the millisecond asked, so
      // unlike a real source the time served IS the time requested.
      return { image: canvas, width: 64, height: 64, sourceTimeMs };
    },
    describe: () => ({ keyframes: [], motionSpans: [] }),
  };
}

describe("detectKeyframeMotion", () => {
  it("finds nothing between identical keyframes", async () => {
    // Two keyframes before the panel opens: the fixture app is static there.
    const bundle = proceduralBundle({
      motionSpans: [],
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 0,
          ref: "k0",
          width: 1280,
          height: 800,
          actionId: null,
        },
        {
          byteLength: 0,
          sourceTimeMs: 400,
          ref: "k1",
          width: 1280,
          height: 800,
          actionId: "act-1",
        },
      ],
    });
    const spans = await detectKeyframeMotion(
      bundle,
      createProceduralFrameSource(bundle),
      0.02,
    );
    expect(spans).toEqual([]);
  });

  // The case this exists for: SP1 measured a still page emitting 0.2 fps of
  // screencast, so "no motion span" is not proof of stillness. A keyframe-only
  // stretch that visibly changed must not be compressed as dead air.
  it("flags a gap whose bracketing keyframes differ", async () => {
    const bundle = proceduralBundle({
      motionSpans: [],
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 3000,
          ref: "k0",
          width: 1280,
          height: 800,
          actionId: null,
        },
        {
          byteLength: 0,
          sourceTimeMs: 5000,
          ref: "k1",
          width: 1280,
          height: 800,
          actionId: "act-2",
        },
      ],
    });
    const spans = await detectKeyframeMotion(
      bundle,
      flatColorFrameSource({ 3000: "#ffffff", 5000: "#808080" }),
      0.02,
    );
    expect(spans).toEqual([{ startMs: 3000, endMs: 5000 }]);
  });

  it("respects the threshold", async () => {
    const bundle = proceduralBundle({
      motionSpans: [],
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 3000,
          ref: "k0",
          width: 1280,
          height: 800,
          actionId: null,
        },
        {
          byteLength: 0,
          sourceTimeMs: 5000,
          ref: "k1",
          width: 1280,
          height: 800,
          actionId: "act-2",
        },
      ],
    });
    const spans = await detectKeyframeMotion(
      bundle,
      flatColorFrameSource({ 3000: "#ffffff", 5000: "#808080" }),
      0.99,
    );
    expect(spans).toEqual([]);
  });

  it("skips gaps a motion span already covers, so it costs nothing on a normal render", async () => {
    const bundle = proceduralBundle();
    const spans = await detectKeyframeMotion(
      bundle,
      createProceduralFrameSource(bundle),
      0.02,
    );
    expect(spans.some((s) => s.startMs === 3200 && s.endMs === 4000)).toBe(
      false,
    );
  });
});
