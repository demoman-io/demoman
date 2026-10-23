import { describe, expect, it } from "vitest";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";

function pixelAt(
  image: CanvasImageSource,
  w: number,
  h: number,
  x: number,
  y: number,
) {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(image, 0, 0);
  const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
  return { r, g, b, a };
}

describe("procedural frame source", () => {
  const bundle = proceduralBundle();
  const frames = createProceduralFrameSource(bundle);

  it("serves a keyframe at full DPR-3 resolution", async () => {
    const frame = await frames.at(400);
    expect(frame.width).toBe(3840);
    expect(frame.height).toBe(2400);
  });

  it("serves the surface-capped motion resolution inside a motion span", async () => {
    const frame = await frames.at(3600);
    expect(frame.width).toBe(2560);
    expect(frame.height).toBe(1600);
  });

  it("draws something, so a blank composite is never a false pass", async () => {
    const frame = await frames.at(0);
    const px = pixelAt(frame.image, frame.width, frame.height, 20, 20);
    expect(px.a).toBe(255);
  });

  it("changes visibly across the motion span, so retiming has something to see", async () => {
    const early = await frames.at(3250);
    const late = await frames.at(3950);
    // The sliding panel only ever occupies the rightmost 360 viewport px
    // (viewport.width=1280, so viewport-x >= 920). Probing the viewport
    // center (physical 1280,800) never crosses it at any panelOpen in
    // [0,1]; probing physical (2200,800) — viewport (1100,400), scale 2x —
    // sits inside the panel's sweep: uncovered at panelOpen=0.0625 (panel
    // starts at viewport-x 1257.5) and covered at panelOpen=0.9375 (panel
    // starts at viewport-x 942.5).
    const a = pixelAt(early.image, early.width, early.height, 2200, 800);
    const b = pixelAt(late.image, late.width, late.height, 2200, 800);
    expect([a.r, a.g, a.b]).not.toEqual([b.r, b.g, b.b]);
  });

  it("reports what it holds", () => {
    expect(frames.describe().keyframes).toHaveLength(4);
    expect(frames.describe().motionSpans).toHaveLength(1);
  });
});
