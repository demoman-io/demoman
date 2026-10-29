import { describe, expect, it } from "vitest";
import type { FrameImage } from "../../src/ports/types";
import { LANDSCAPE_1080P } from "../../src/render/target";
import {
  blurWallpaper,
  wallpaperBlurPx,
} from "../../src/render/wallpaper-blur";

/** 8px blocks of pale and mid grey in a fixed pseudo-random pattern: edges
 *  everywhere for the Laplacian to find, and no dark value an edge could
 *  fade towards. */
const W = 240;
const H = 180;
const BLOCK = 8;
const LEVELS = [140, 250] as const;

function blockFixture(): OffscreenCanvas {
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  let seed = 7;
  for (let y = 0; y < H; y += BLOCK) {
    for (let x = 0; x < W; x += BLOCK) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const v = LEVELS[(seed >> 16) & 1] as number;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x, y, BLOCK, BLOCK);
    }
  }
  return c;
}

async function asFrameImage(c: OffscreenCanvas): Promise<FrameImage> {
  const image = await createImageBitmap(c);
  return { image, width: c.width, height: c.height, sourceTimeMs: 0 };
}

/** `image` drawn over opaque black, as grey: a pixel the blur left
 *  transparent reads dark. */
function greyOverBlack(image: FrameImage): Float64Array {
  const c = new OffscreenCanvas(image.width, image.height);
  const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  g.fillStyle = "#000";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(image.image, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const grey = new Float64Array(c.width * c.height);
  for (let i = 0; i < grey.length; i++) grey[i] = data[i * 4] as number;
  return grey;
}

function laplacianVariance(grey: Float64Array, w: number, h: number): number {
  const at = (x: number, y: number) => grey[y * w + x] as number;
  const values: number[] = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++)
      values.push(
        at(x - 1, y) +
          at(x + 1, y) +
          at(x, y - 1) +
          at(x, y + 1) -
          4 * at(x, y),
      );
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
}

/** The mean of the pixels `from` to `to` px in from the edge. */
function ringMean(
  grey: Float64Array,
  w: number,
  h: number,
  from: number,
  to: number,
): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (d >= from && d < to) {
        sum += grey[y * w + x] as number;
        n++;
      }
    }
  return sum / n;
}

// The raster is small against a 1080p frame (0.125 raster px per frame px),
// so blur 1 is 16 raster px: wide enough to show, small enough that the
// blurred image's detail stays above 8-bit rounding.
const TARGET = LANDSCAPE_1080P;
const radiusAt = (blur: number) =>
  wallpaperBlurPx(TARGET, { width: W, height: H }, blur);

describe("blurWallpaper", () => {
  it("the fixture is opaque, has both levels, and its edges carry its mean", async () => {
    const grey = greyOverBlack(await asFrameImage(blockFixture()));
    const seen = new Set(grey);
    expect([...seen].sort()).toEqual([...LEVELS]);
    // Unblurred, the 2px ring and the ring inside it average alike, so a
    // difference after the blur is the blur's.
    const outer = ringMean(grey, W, H, 0, 2);
    const inner = ringMean(grey, W, H, 2 * BLOCK, 3 * BLOCK);
    expect(Math.abs(outer - inner), `${outer} vs ${inner}`).toBeLessThan(15);
    expect(radiusAt(1)).toBeCloseTo(16.2, 6);
  });

  it("returns the same image for a radius of 0", async () => {
    const img = await asFrameImage(blockFixture());
    expect(blurWallpaper(img, 0)).toBe(img);
    expect(radiusAt(0)).toBe(0);
  });

  it("detail falls strictly from blur 0 to 0.25 to 0.5 to 1", async () => {
    const img = await asFrameImage(blockFixture());
    const variances = [0, 0.25, 0.5, 1].map((b) =>
      laplacianVariance(greyOverBlack(blurWallpaper(img, radiusAt(b))), W, H),
    );
    const said = JSON.stringify(variances);
    // The fixture really has detail to lose.
    expect(variances[0], said).toBeGreaterThan(1000);
    for (let i = 1; i < variances.length; i++)
      expect(variances[i], said).toBeLessThan(variances[i - 1] as number);
  });

  it("does not darken or fade the edges at blur 1", async () => {
    const img = await asFrameImage(blockFixture());
    const blurred = blurWallpaper(img, radiusAt(1));
    expect([blurred.width, blurred.height]).toEqual([W, H]);
    const grey = greyOverBlack(blurred);
    const outer = ringMean(grey, W, H, 0, 2);
    const inside = ringMean(grey, W, H, 2, 6);
    expect(
      Math.abs(outer - inside),
      `${outer} vs ${inside}`,
    ).toBeLessThanOrEqual(6);
    // And the corner pixel, where an unpadded blur is darkest.
    expect(grey[0], `corner ${grey[0]}, ring ${outer}`).toBeGreaterThan(
      LEVELS[0] - 10,
    );
  });
});
