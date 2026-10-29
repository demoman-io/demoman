import type { FrameImage } from "../ports/types.js";
import type { RenderTarget } from "./target.js";
import { coverRect } from "./wallpaper.js";

/** The blur radius at blur 1, as a fraction of the frame's short side (spec
 *  2026-10-28, "Blur": the default 0.5 is the author's 6%). */
export const WALLPAPER_BLUR_MAX = 0.12;

/**
 * The radius, in `raster`'s own pixels, that `blur` asks for when `raster`
 * covers `target`: measured against the frame, so a value looks the same at
 * every shape and size, and zooms with the camera as the wallpaper does.
 */
export function wallpaperBlurPx(
  target: RenderTarget,
  raster: { width: number; height: number },
  blur: number,
): number {
  const perFramePx = coverRect(raster, target).sw / target.width;
  return (
    blur *
    WALLPAPER_BLUR_MAX *
    Math.min(target.width, target.height) *
    perFramePx
  );
}

/**
 * `image` blurred by `radiusPx` (the filter's standard deviation), at its own
 * size; the same object for 0. The edges are padded by mirroring before the
 * blur: the filter reads transparent past an image's edge, so an unpadded
 * blur darkens and fades the frame's border. Made once per raster, never
 * per frame. Throws when there is no canvas to blur on; the caller says so.
 */
export function blurWallpaper(image: FrameImage, radiusPx: number): FrameImage {
  if (radiusPx <= 0) return image;
  const { width: w, height: h } = image;
  // Three standard deviations hold all but 0.3% of the kernel; never more
  // than the image, so one mirrored copy each side fills the pad.
  const pad = Math.min(Math.ceil(radiusPx * 3), w, h);
  const padded = new OffscreenCanvas(w + 2 * pad, h + 2 * pad);
  const p = padded.getContext("2d");
  if (p === null) throw new Error(`no 2D context to blur ${w}×${h} on`);
  for (const i of [-1, 0, 1]) {
    for (const j of [-1, 0, 1]) {
      // Mirrored about the edge it touches: the tile left of the image is
      // flipped so its right edge meets the image's left edge.
      p.setTransform(
        i === 0 ? 1 : -1,
        0,
        0,
        j === 0 ? 1 : -1,
        i === 1 ? pad + 2 * w : pad,
        j === 1 ? pad + 2 * h : pad,
      );
      p.drawImage(image.image, 0, 0, w, h);
    }
  }
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext("2d");
  if (ctx === null) throw new Error(`no 2D context to blur ${w}×${h} on`);
  ctx.filter = `blur(${radiusPx}px)`;
  ctx.drawImage(padded, -pad, -pad);
  // A bitmap, so whoever holds it frees it as it frees a decoded one.
  return { ...image, image: out.transferToImageBitmap() };
}
