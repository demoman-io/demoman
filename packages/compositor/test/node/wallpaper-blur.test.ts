import { describe, expect, it } from "vitest";
import { LANDSCAPE_1080P, type RenderTarget } from "../../src/render/target";
import { coverRect } from "../../src/render/wallpaper";
import {
  WALLPAPER_BLUR_MAX,
  wallpaperBlurPx,
} from "../../src/render/wallpaper-blur";

const at = (width: number, height: number): RenderTarget => ({
  ...LANDSCAPE_1080P,
  width,
  height,
});

describe("wallpaperBlurPx", () => {
  it("is 12% of the short side at blur 1", () => {
    expect(WALLPAPER_BLUR_MAX).toBe(0.12);
  });

  // The radius in FRAME pixels is the same fraction of the short side at
  // every shape and raster: what the raster's own size changes is only how
  // many raster pixels that is.
  it.each([
    [1920, 1080, { width: 4800, height: 3600 }],
    [1080, 1920, { width: 3600, height: 4800 }],
    [800, 450, { width: 2000, height: 1500 }],
    [1920, 1080, { width: 1600, height: 1200 }],
    [1440, 1080, { width: 1200, height: 900 }],
  ])(
    "blur 0.5 at %dx%d on a %o raster is 6%% of the short side",
    (w, h, raster) => {
      const target = at(w, h);
      const px = wallpaperBlurPx(target, raster, 0.5);
      // Raster pixels per frame pixel, under the cover crop at camera scale 1.
      const perFrame = coverRect(raster, target).sw / w;
      // Premise: the cases include rasters both larger and smaller than the
      // frame, so a radius in frame pixels would fail some of them.
      expect(perFrame).not.toBe(1);
      expect(px / perFrame / Math.min(w, h)).toBeCloseTo(0.06, 9);
    },
  );

  it("blur 0 is 0", () => {
    expect(
      wallpaperBlurPx(at(1920, 1080), { width: 4800, height: 3600 }, 0),
    ).toBe(0);
  });
});
