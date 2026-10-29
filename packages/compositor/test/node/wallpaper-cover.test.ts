import { describe, expect, it } from "vitest";
import { CAMERA_DEFAULTS } from "../../src/plan/camera";
import {
  LANDSCAPE_4K,
  LANDSCAPE_1080P,
  type RenderTarget,
  VERTICAL_1080,
} from "../../src/render/target";
import {
  coverRect,
  WALLPAPER_LONG_SIDE,
  wallpaperRasterSize,
  wallpaperShape,
} from "../../src/render/wallpaper";

const LANDSCAPE_MASTER = { width: 9600, height: 7200 };

describe("coverRect", () => {
  // 16:9 is wider than 4:3, so the cover spans the master's full width and
  // crops its height (the brief had sx and sy the other way round, which
  // would need a 12800px-wide crop of a 9600px image).
  it("crops a 4:3 master to 16:9 across its full width, centred", () => {
    const r = coverRect(LANDSCAPE_MASTER, { width: 1920, height: 1080 });
    expect(r.sw / r.sh).toBeCloseTo(16 / 9, 9);
    expect(r.sx).toBe(0);
    expect(r.sw).toBe(9600);
    expect(r.sy).toBe(900);
    expect(r.sy + r.sh / 2).toBeCloseTo(7200 / 2, 9);
  });

  it("crops the landscape master to 9:16 across its full height, centred", () => {
    const r = coverRect(LANDSCAPE_MASTER, { width: 1080, height: 1920 });
    expect(r.sy).toBe(0);
    expect(r.sh).toBe(7200);
    expect(r.sw / r.sh).toBeCloseTo(9 / 16, 9);
    expect(r.sx + r.sw / 2).toBeCloseTo(9600 / 2, 9);
  });

  it.each([
    ["1:1", { width: 1080, height: 1080 }],
    ["21:9", { width: 2520, height: 1080 }],
  ])("is centred with no negative offset at %s", (_, box) => {
    const r = coverRect(LANDSCAPE_MASTER, box);
    expect(r.sx).toBeGreaterThanOrEqual(0);
    expect(r.sy).toBeGreaterThanOrEqual(0);
    expect(r.sx + r.sw).toBeLessThanOrEqual(9600 + 1e-9);
    expect(r.sy + r.sh).toBeLessThanOrEqual(7200 + 1e-9);
    expect(r.sw / r.sh).toBeCloseTo(box.width / box.height, 9);
    expect(r.sx + r.sw / 2).toBeCloseTo(9600 / 2, 9);
    expect(r.sy + r.sh / 2).toBeCloseTo(7200 / 2, 9);
  });

  it("21:9 crops the height, not the width", () => {
    const r = coverRect(LANDSCAPE_MASTER, { width: 2520, height: 1080 });
    expect(r.sx).toBe(0);
    expect(r.sy).toBeGreaterThan(0);
  });
});

describe("wallpaper sizing", () => {
  it("the long side is the 4K tier at the deepest zoom", () => {
    expect(WALLPAPER_LONG_SIDE).toBe(9600);
    expect(WALLPAPER_LONG_SIDE).toBe(
      LANDSCAPE_4K.width * CAMERA_DEFAULTS.maxScale,
    );
  });

  it("names the shape by the target's orientation", () => {
    expect(wallpaperShape(LANDSCAPE_1080P)).toBe("landscape");
    expect(wallpaperShape(VERTICAL_1080)).toBe("portrait");
    const square: RenderTarget = { ...LANDSCAPE_1080P, width: 1080 };
    expect(wallpaperShape(square)).toBe("landscape");
  });

  it("decodes a 1080p target to its cover at the deepest zoom", () => {
    const size = wallpaperRasterSize(LANDSCAPE_1080P);
    expect(size.width).toBeLessThanOrEqual(9600);
    // 16:9 on a 4:3 master: width is the bound axis.
    expect(size.width).toBeGreaterThanOrEqual(1920 * 2.5);
    expect(size.height).toBeGreaterThanOrEqual(1080 * 2.5);
    expect(size.width / size.height).toBeCloseTo(4 / 3, 2);
  });

  it("decodes a 9:16 target from the portrait master", () => {
    const size = wallpaperRasterSize(VERTICAL_1080);
    expect(size.height).toBeLessThanOrEqual(9600);
    expect(size.height).toBeGreaterThanOrEqual(1920 * 2.5);
    expect(size.width).toBeGreaterThanOrEqual(1080 * 2.5);
    expect(size.width / size.height).toBeCloseTo(3 / 4, 2);
  });

  it("caps at the master's size", () => {
    expect(wallpaperRasterSize(LANDSCAPE_4K)).toEqual({
      width: 9600,
      height: 7200,
    });
    const huge: RenderTarget = { ...LANDSCAPE_4K, width: 7680, height: 4320 };
    expect(wallpaperRasterSize(huge)).toEqual({ width: 9600, height: 7200 });
  });

  it("sizes an upload from its own size and aspect", () => {
    // A square: the 16:9 cover is width-bound, 0.2 × 2.5 of it.
    expect(
      wallpaperRasterSize(LANDSCAPE_1080P, { width: 9600, height: 9600 }),
    ).toEqual({ width: 4800, height: 4800 });
    // Smaller than the cover needs: never upscaled.
    expect(
      wallpaperRasterSize(LANDSCAPE_1080P, { width: 640, height: 480 }),
    ).toEqual({ width: 640, height: 480 });
  });
});
