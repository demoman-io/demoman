import { CAMERA_DEFAULTS } from "../plan/camera.js";
import { LANDSCAPE_4K, type RenderTarget } from "./target.js";

/**
 * The built-in masters' long side. The background is drawn inside the
 * camera transform, so it scales with the zoom: the widest export at the
 * deepest zoom is what it has to carry (spec 2026-10-28, "Resolution comes
 * from the real limits").
 */
export const WALLPAPER_LONG_SIDE =
  LANDSCAPE_4K.width * CAMERA_DEFAULTS.maxScale;
/** The masters are 4:3 (landscape) and 3:4 (portrait). */
const WALLPAPER_SHORT_SIDE = (WALLPAPER_LONG_SIDE * 3) / 4;

/** The centred source crop of `image` that covers `box` at its aspect. */
export function coverRect(
  image: { width: number; height: number },
  box: { width: number; height: number },
): { sx: number; sy: number; sw: number; sh: number } {
  const scale = Math.max(box.width / image.width, box.height / image.height);
  const sw = Math.min(image.width, box.width / scale);
  const sh = Math.min(image.height, box.height / scale);
  return { sx: (image.width - sw) / 2, sy: (image.height - sh) / 2, sw, sh };
}

/** Which master a target draws from. */
export function wallpaperShape(target: RenderTarget): "landscape" | "portrait" {
  return target.height > target.width ? "portrait" : "landscape";
}

/** The built-in master `target` draws from. */
function masterFor(target: RenderTarget): { width: number; height: number } {
  return wallpaperShape(target) === "portrait"
    ? { width: WALLPAPER_SHORT_SIDE, height: WALLPAPER_LONG_SIDE }
    : { width: WALLPAPER_LONG_SIDE, height: WALLPAPER_SHORT_SIDE };
}

/**
 * The size to decode an image to for `target`: the image scaled to cover
 * the target, times the deepest zoom, never above the image. `image` is the
 * built-in master unless given (an upload keeps its own size and aspect).
 */
export function wallpaperRasterSize(
  target: RenderTarget,
  image: { width: number; height: number } = masterFor(target),
): {
  width: number;
  height: number;
} {
  const cover = Math.max(
    target.width / image.width,
    target.height / image.height,
  );
  const scale = Math.min(1, cover * CAMERA_DEFAULTS.maxScale);
  return {
    width: Math.ceil(image.width * scale),
    height: Math.ceil(image.height * scale),
  };
}
