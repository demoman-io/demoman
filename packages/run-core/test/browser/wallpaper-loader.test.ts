import { describe, expect, it } from "vitest";
import { wallpaperLoader } from "../../src/wallpaper.js";

/** A `width`x`height` image of `type`, encoded by the browser itself. */
async function encoded(
  width: number,
  height: number,
  type: string,
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  g.fillStyle = "#36c";
  g.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type });
  return new Uint8Array(await blob.arrayBuffer());
}

describe("wallpaperLoader", () => {
  // Review finding 7 (2026-10-28): every export decoded the 9600x7200
  // master whole. Red if a WebP is decoded at its own size rather than the
  // size asked for, or decoded again for a smaller ask.
  it("decodes a WebP at the size asked, once, and again only for more", async () => {
    const load = await wallpaperLoader(
      await encoded(800, 600, "image/webp"),
      "image/webp",
      "w",
    );
    // Its own size, read from the header before any decode.
    expect(load.natural).toEqual({ width: 800, height: 600 });
    const first = await load.image({ width: 400, height: 300 });
    expect([first.width, first.height]).toEqual([400, 300]);
    // Smaller: the held decode answers, not a new one.
    expect(await load.image({ width: 200, height: 150 })).toBe(first);
    // Larger: decoded again, and never above its own size.
    const larger = await load.image({ width: 1000, height: 750 });
    expect(larger).not.toBe(first);
    expect([larger.width, larger.height]).toEqual([800, 600]);
    load.close();
  });

  it("decodes anything else whole, to learn its size, and holds that", async () => {
    const load = await wallpaperLoader(
      await encoded(320, 240, "image/png"),
      "image/png",
      "p",
    );
    expect(load.natural).toEqual({ width: 320, height: 240 });
    const held = await load.image({ width: 160, height: 120 });
    expect([held.width, held.height]).toEqual([320, 240]);
    load.close();
  });

  it("rejects bytes that will not decode, naming the type", async () => {
    await expect(
      wallpaperLoader(new Uint8Array([1, 2, 3]), "image/png", "x"),
    ).rejects.toThrow(/the image\/png could not be decoded/);
  });
});
