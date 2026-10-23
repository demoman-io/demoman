import { describe, expect, it } from "vitest";
import { drawCosmetics, drawMask } from "../../src/render/draw-cosmetics";

function canvasWith(fill: string) {
  const c = new OffscreenCanvas(400, 200);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, 400, 200);
  return ctx;
}

function at(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number) {
  const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
  return { r: r as number, g: g as number, b: b as number, a: a as number };
}

describe("drawMask", () => {
  // Opaque, never blur. A blur is statistically reversible, and v8's data
  // posture requires that redacted material does not survive redaction.
  it("fully replaces the pixels underneath", () => {
    const ctx = canvasWith("#ffffff");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(100, 50, 100, 30);
    drawMask(ctx, { x: 100, y: 50, width: 100, height: 30 });
    for (let y = 51; y < 79; y++) {
      for (let x = 101; x < 199; x++) {
        const px = at(ctx, x, y);
        expect(px.a).toBe(255);
        expect(px.r).not.toBe(255);
      }
    }
  });

  it("leaves everything outside the rect untouched", () => {
    const ctx = canvasWith("#ffffff");
    drawMask(ctx, { x: 100, y: 50, width: 100, height: 30 });
    expect(at(ctx, 90, 50)).toMatchObject({ r: 255, g: 255, b: 255 });
  });
});

describe("drawCosmetics", () => {
  it("maps rects through the supplied transform", () => {
    const ctx = canvasWith("#ffffff");
    drawCosmetics(
      ctx,
      [
        {
          id: "m",
          kind: "mask",
          rect: { x: 0, y: 0, width: 10, height: 10 },
          range: null,
          unplaced: [],
        },
      ],
      (r) => ({ x: r.x + 200, y: r.y + 100, width: r.width, height: r.height }),
    );
    expect(at(ctx, 5, 5)).toMatchObject({ r: 255 });
    expect(at(ctx, 205, 105).r).not.toBe(255);
  });
});
