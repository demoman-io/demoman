import { WALLPAPER_LONG_SIDE } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import { fitWallpaperImage } from "../../src/wallpaper.js";

// Big canvases encode in seconds here; CI composes ~5x slower (CLAUDE.md,
// `fff4505`). Measured locally 2026-10-28: the 12000x9000 PNG 4.9 s, the
// 30 MB noise JPEG 15.3 s (making it and encoding its WebP).
const BIG_MS = 120_000;

/** A `width`x`height` image of `type`, encoded by the browser itself. */
async function generated(
  width: number,
  height: number,
  type: string,
  paint: (g: OffscreenCanvasRenderingContext2D) => void,
  quality?: number,
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  paint(canvas.getContext("2d") as OffscreenCanvasRenderingContext2D);
  return canvas.convertToBlob(
    quality === undefined ? { type } : { type, quality },
  );
}

const gradient =
  (w: number, h: number) => (g: OffscreenCanvasRenderingContext2D) => {
    const fill = g.createLinearGradient(0, 0, w, h);
    fill.addColorStop(0, "#d43");
    fill.addColorStop(1, "#36c");
    g.fillStyle = fill;
    g.fillRect(0, 0, w, h);
  };

/** The decoded size of `blob`, read the way any page would. */
async function sizeOf(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

const named = (blob: Blob, name: string) =>
  new File([blob], name, { type: blob.type });

describe("fitWallpaperImage", () => {
  it("is held to the wallpaper size the compositor draws from (premise)", () => {
    expect(WALLPAPER_LONG_SIDE).toBe(9600);
  });

  it(
    "scales a 12000x9000 PNG down to 9600x7200 WebP",
    async () => {
      const png = await generated(
        12000,
        9000,
        "image/png",
        gradient(12000, 9000),
      );
      // The fixture: a PNG of that size really went in.
      expect(png.type).toBe("image/png");
      expect(await sizeOf(png)).toEqual({ width: 12000, height: 9000 });
      const fitted = await fitWallpaperImage(named(png, "huge.png"));
      expect(fitted.blob.type).toBe("image/webp");
      expect({ width: fitted.width, height: fitted.height }).toEqual({
        width: 9600,
        height: 7200,
      });
      expect(await sizeOf(fitted.blob)).toEqual({ width: 9600, height: 7200 });
    },
    BIG_MS,
  );

  it("leaves a 640x480 at 640x480: never upscaled", async () => {
    const png = await generated(640, 480, "image/png", gradient(640, 480));
    expect(await sizeOf(png)).toEqual({ width: 640, height: 480 });
    const fitted = await fitWallpaperImage(named(png, "small.png"));
    expect(fitted.blob.type).toBe("image/webp");
    expect(await sizeOf(fitted.blob)).toEqual({ width: 640, height: 480 });
    expect({ width: fitted.width, height: fitted.height }).toEqual({
      width: 640,
      height: 480,
    });
  });

  it(
    "rasterises an SVG with a 9600 long side, at its own aspect",
    async () => {
      const svg = new File(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 40"><rect width="30" height="40" fill="#3a6"/></svg>',
        ],
        "tall.svg",
        { type: "image/svg+xml" },
      );
      const fitted = await fitWallpaperImage(svg);
      expect(fitted.blob.type).toBe("image/webp");
      expect(await sizeOf(fitted.blob)).toEqual({ width: 7200, height: 9600 });
    },
    BIG_MS,
  );

  it(
    "accepts a 30 MB JPEG (8000x6000 noise) and bounds it",
    async () => {
      const jpeg = await generated(
        8000,
        6000,
        "image/jpeg",
        (g) => {
          const data = g.createImageData(8000, 6000);
          const px = new Uint32Array(data.data.buffer);
          // xorshift: noise JPEG cannot compress, so the file is large.
          let s = 0x9e3779b9;
          for (let i = 0; i < px.length; i++) {
            s ^= s << 13;
            s ^= s >>> 17;
            s ^= s << 5;
            px[i] = s | 0xff000000;
          }
          g.putImageData(data, 0, 0);
        },
        0.9,
      );
      // The fixture: a JPEG of 30 MB or more, of that size.
      expect(jpeg.type).toBe("image/jpeg");
      expect(jpeg.size).toBeGreaterThanOrEqual(30 * 1024 * 1024);
      expect(await sizeOf(jpeg)).toEqual({ width: 8000, height: 6000 });
      const fitted = await fitWallpaperImage(named(jpeg, "noise.jpg"));
      expect(fitted.blob.type).toBe("image/webp");
      expect(await sizeOf(fitted.blob)).toEqual({ width: 8000, height: 6000 });
    },
    BIG_MS,
  );

  it("rejects a text file named .png, naming it", async () => {
    const text = new File(["just some notes"], "notes.png", {
      type: "image/png",
    });
    // The fixture: the bytes really are not an image.
    await expect(createImageBitmap(text)).rejects.toThrow();
    await expect(fitWallpaperImage(text)).rejects.toThrow(
      'The image "notes.png" could not be opened as an image',
    );
  });
});
