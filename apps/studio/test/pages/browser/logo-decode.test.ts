import { describe, expect, it } from "vitest";
import {
  decodeLogo,
  LOGO_THUMB_HEIGHT_PX,
  loadLogo,
  logoThumbnail,
  SVG_RASTER_CACHE_SIZE,
  sharpnessNote,
  svgAspect,
} from "../../../pages/src/adapters/logo";

const enc = (s: string) => new TextEncoder().encode(s);
// A hard vertical edge at x = 20 of 40: left half red, right half white.
const EDGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#ffffff"/><rect width="20" height="20" fill="#e03131"/></svg>`;

async function pixels(image: {
  image: CanvasImageSource;
  width: number;
  height: number;
}) {
  const c = new OffscreenCanvas(image.width, image.height);
  const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  g.drawImage(image.image, 0, 0);
  return g.getImageData(0, 0, image.width, image.height).data;
}

describe("svgAspect", () => {
  it("reads width/height, falls back to the viewBox, refuses neither", () => {
    expect(
      svgAspect(
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"/>`,
      ),
    ).toBe(3);
    expect(svgAspect(EDGE_SVG)).toBe(2);
    expect(() =>
      svgAspect(`<svg xmlns="http://www.w3.org/2000/svg"/>`),
    ).toThrow(
      "the SVG has no width, height or viewBox, so there is no size to draw it at",
    );
    expect(() => svgAspect("not xml")).toThrow("the file is not an SVG");
  });
});

describe("decodeLogo", () => {
  it("rasterises an SVG at the height it is asked for, with a hard edge", async () => {
    const source = await decodeLogo(enc(EDGE_SVG), "image/svg+xml");
    expect(source.naturalHeight).toBeNull();
    const big = await source.rasterAt(432); // a 0.2 logo at 4K's 2160 short side
    expect([big.width, big.height]).toEqual([864, 432]);
    const data = await pixels(big);
    const row = 216 * 864 * 4;
    // Premise: the fixture's edge exists — far left is red, far right white.
    expect([data[row], data[row + 1]]).toEqual([0xe0, 0x31]);
    expect(data[row + 863 * 4 + 1]).toBe(255);
    // Sharp: two pixels either side of x = 432 are already fully one colour.
    // A 40-px raster upscaled 21.6x would smear ~20 px across the edge.
    expect(data[row + 429 * 4 + 1]).toBe(0x31);
    expect(data[row + 434 * 4 + 1]).toBe(255);
  });

  it("caches a raster per height", async () => {
    const source = await decodeLogo(enc(EDGE_SVG), "image/svg+xml");
    expect(await source.rasterAt(100)).toBe(await source.rasterAt(100));
  });

  it("keeps only the most recently asked-for heights", async () => {
    const source = await decodeLogo(enc(EDGE_SVG), "image/svg+xml");
    const first = await source.rasterAt(100);
    const recent = await source.rasterAt(101);
    // One more height than the cache holds: 100 is the oldest, and goes.
    for (let h = 102; h < 101 + SVG_RASTER_CACHE_SIZE; h++) {
      await source.rasterAt(h);
    }
    await source.rasterAt(101); // 101 is touched, so 102 is now the oldest
    await source.rasterAt(200);
    // Premise: rasterising the same height again is a new bitmap, so identity
    // below means "served from the cache" and nothing else.
    expect(await source.rasterAt(100)).not.toBe(first);
    expect(await source.rasterAt(101)).toBe(recent);
  });

  it("decodes a PNG once and reports its natural height", async () => {
    const c = new OffscreenCanvas(60, 30);
    (c.getContext("2d") as OffscreenCanvasRenderingContext2D).fillRect(
      0,
      0,
      60,
      30,
    );
    const png = new Uint8Array(
      await (await c.convertToBlob({ type: "image/png" })).arrayBuffer(),
    );
    const source = await decodeLogo(png, "image/png");
    expect(source.naturalHeight).toBe(30);
    expect(source.aspect).toBe(2);
  });

  it("rejects bytes that are not the image they claim, with a reason", async () => {
    await expect(decodeLogo(enc("garbage"), "image/png")).rejects.toThrow(
      /could not be decoded/,
    );
    await expect(decodeLogo(enc("garbage"), "image/svg+xml")).rejects.toThrow(
      "the file is not an SVG",
    );
  });
});

describe("loadLogo", () => {
  it("says the asset is missing rather than answering nothing", async () => {
    // Review Focus 4: site data cleared, or another profile.
    const load = await loadLogo({ readAsset: async () => null }, "logo:gone");
    expect(load).toEqual({
      ok: false,
      error: 'the logo "logo:gone" is not in this browser\'s storage',
    });
  });

  it("carries a decode failure's reason", async () => {
    const load = await loadLogo(
      {
        readAsset: async () => ({
          bytes: enc("garbage"),
          contentType: "image/png",
        }),
      },
      "logo:bad",
    );
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.error).toMatch(/could not be decoded/);
  });

  it("carries a storage failure's reason", async () => {
    const load = await loadLogo(
      {
        readAsset: async () => {
          throw new Error("IDB closed");
        },
      },
      "logo:x",
    );
    expect(load).toEqual({
      ok: false,
      error: "the logo could not be read: IDB closed",
    });
  });
});

describe("sharpnessNote", () => {
  it("warns when a raster is smaller than the export draws it", async () => {
    const c = new OffscreenCanvas(60, 30);
    (c.getContext("2d") as OffscreenCanvasRenderingContext2D).fillRect(
      0,
      0,
      60,
      30,
    );
    const png = new Uint8Array(
      await (await c.convertToBlob({ type: "image/png" })).arrayBuffer(),
    );
    const source = await decodeLogo(png, "image/png");
    expect(sharpnessNote(source, 130, "Landscape video")).toBe(
      "Upscaled in a Landscape video export — an SVG or a larger PNG stays sharp",
    );
    expect(sharpnessNote(source, 30, "Landscape video")).toBeNull();
  });

  it("never warns for an SVG", async () => {
    const source = await decodeLogo(enc(EDGE_SVG), "image/svg+xml");
    expect(sharpnessNote(source, 5000, "Landscape video")).toBeNull();
  });
});

describe("logoThumbnail", () => {
  // The picture, not the string: a thumbnail drawn blank, at the wrong
  // shape, or of the wrong half would still be a valid data URL.
  it("draws the logo itself, at the thumbnail's height and the logo's shape", async () => {
    const source = await decodeLogo(enc(EDGE_SVG), "image/svg+xml");
    const url = await logoThumbnail(source);
    expect(url.startsWith("data:image/png")).toBe(true);
    const img = new Image();
    img.src = url;
    await img.decode();
    expect([img.naturalWidth, img.naturalHeight]).toEqual([
      LOGO_THUMB_HEIGHT_PX * 2,
      LOGO_THUMB_HEIGHT_PX,
    ]);
    const data = await pixels({
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
    const row = (LOGO_THUMB_HEIGHT_PX / 2) * img.naturalWidth * 4;
    // Red on the left quarter, white on the right: the fixture's edge.
    expect([data[row + 10 * 4], data[row + 10 * 4 + 1]]).toEqual([0xe0, 0x31]);
    expect(data[row + (img.naturalWidth - 10) * 4 + 1]).toBe(255);
  });

  it("makes one thumbnail per source", async () => {
    const source = await decodeLogo(enc(EDGE_SVG), "image/svg+xml");
    expect(logoThumbnail(source)).toBe(logoThumbnail(source));
  });
});
