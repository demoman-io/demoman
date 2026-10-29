import {
  blurWallpaper,
  type FrameImage,
  type RenderTarget,
  wallpaperBlurPx,
  wallpaperRasterSize,
  wallpaperShape,
} from "@demoman/compositor";
import { decodeWallpaper } from "@demoman/run-core/wallpaper";
import {
  type SceneBackground,
  wallpaperFile,
  wallpaperInfo,
} from "@demoman/scene-schema";
import type { Platform } from "../platform/types";

/** A background that draws an image. */
export type ImageBackground = Extract<
  SceneBackground,
  { kind: "wallpaper" | "image" }
>;

export const isImageBackground = (bg: SceneBackground): bg is ImageBackground =>
  bg.kind === "wallpaper" || bg.kind === "image";

/** An uploaded image as the background, keeping the blur `current` has. */
export const uploadedBackground = (
  ref: string,
  current: SceneBackground,
): SceneBackground => ({
  kind: "image",
  ref,
  ...(isImageBackground(current) && current.blur !== undefined
    ? { blur: current.blur }
    : {}),
});

/** Where the studio serves a built-in's file: the pages' `public/` folder,
 *  at the root the page server serves the built pages from. */
export const wallpaperUrl = (
  id: string,
  shape: "landscape" | "portrait" | "thumb",
): string => `/wallpapers/${wallpaperFile(id, shape)}`;

export const wallpaperThumbUrl = (id: string): string =>
  wallpaperUrl(id, "thumb");

/** What one decoded image is of: its id or ref, and the master's shape. */
export function wallpaperKey(bg: ImageBackground, target: RenderTarget) {
  return bg.kind === "wallpaper"
    ? `id:${bg.id}@${wallpaperShape(target)}`
    : `ref:${bg.ref}`;
}

export interface DecodedWallpaper {
  image: FrameImage;
  /** The stored image's own size, for `wallpaperRasterSize`; null for a
   *  built-in, whose master's is the default. */
  natural: { width: number; height: number } | null;
}

/** The raster `target` needs from what `held` was decoded from. */
export const neededSize = (
  target: RenderTarget,
  natural: DecodedWallpaper["natural"],
) =>
  natural === null
    ? wallpaperRasterSize(target)
    : wallpaperRasterSize(target, natural);

const said = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * `bg`'s image decoded at `target`'s `wallpaperRasterSize`. Rejects with a
 * sentence naming the id or the file, never resolving to something to draw
 * in its place: the compositor paints the neutral gradient for a missing
 * image, and the caller has to say so.
 */
export async function decodeBackground(
  bg: ImageBackground,
  target: RenderTarget,
  wallpapers: Platform["wallpapers"],
): Promise<DecodedWallpaper> {
  if (bg.kind === "wallpaper") {
    if (wallpaperInfo(bg.id) === null) {
      throw new Error(`there is no built-in wallpaper "${bg.id}"`);
    }
    const url = wallpaperUrl(bg.id, wallpaperShape(target));
    let res: Response;
    try {
      res = await fetch(new URL(url, location.href));
    } catch (error) {
      throw new Error(
        `the built-in wallpaper "${bg.id}" could not be fetched: ${said(error)}`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `the built-in wallpaper "${bg.id}" could not be fetched: ${url} answered HTTP ${res.status}`,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      image: await decodeWallpaper(
        bytes,
        "image/webp",
        wallpaperRasterSize(target),
      ),
      natural: null,
    };
  }
  const load = await wallpapers.load(bg.ref);
  if (!load.ok) {
    throw new Error(`"${bg.ref}" could not be loaded: ${load.error}`);
  }
  const bytes = new Uint8Array(await load.blob.arrayBuffer());
  // At its own size first: the raster an upload needs follows its aspect.
  const full = await decodeWallpaper(bytes, load.blob.type || "image/webp");
  const natural = { width: full.width, height: full.height };
  const size = wallpaperRasterSize(target, natural);
  if (size.width >= full.width) return { image: full, natural };
  try {
    const bitmap = await createImageBitmap(full.image, {
      resizeWidth: size.width,
      resizeHeight: size.height,
      resizeQuality: "high",
    });
    return {
      image: { ...full, image: bitmap, ...size },
      natural,
    };
  } catch (error) {
    throw new Error(
      `"${bg.ref}" could not be resized to ${size.width}×${size.height}: ${said(error)}`,
    );
  } finally {
    if ("close" in full.image) full.image.close();
  }
}

/** The custom tile's picture: a small copy of a decoded image. */
export async function wallpaperThumbOf(image: FrameImage): Promise<string> {
  const height = 120;
  const width = Math.max(1, Math.round((image.width / image.height) * height));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image.image, 0, 0, width, height);
  return URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }));
}

/** Blurred rasters made from one decoded image, by radius: a kit tile and
 *  the hero share a decode at different blurs, and a drag revisits values. */
const blurredBy = new WeakMap<FrameImage, Map<number, FrameImage>>();
const BLURS_KEPT = 4;

/**
 * `image` as `bg` draws it on `target`: blurred by the take's own value,
 * once per image and radius rather than per frame — the export's rule
 * (`wallpaperAt`), at the preview's size. Throws when there is no canvas
 * to blur on; the caller says so.
 */
export function blurredBackground(
  image: FrameImage | null,
  bg: SceneBackground,
  target: RenderTarget,
): FrameImage | null {
  if (image === null || !isImageBackground(bg)) return image;
  const radius = wallpaperBlurPx(target, image, bg.blur ?? 0);
  if (radius === 0) return image;
  let held = blurredBy.get(image);
  if (held === undefined) {
    held = new Map();
    blurredBy.set(image, held);
  }
  let out = held.get(radius);
  if (out === undefined) {
    out = blurWallpaper(image, radius);
    held.set(radius, out);
    // Not closed: the scrubber may still be drawing a frame composed with
    // it. Dropped, it goes when the presentation holding it does.
    if (held.size > BLURS_KEPT) held.delete(held.keys().next().value as number);
  }
  return out;
}

const dragRasters = new WeakMap<FrameImage, FrameImage>();

/**
 * `image` at the size that covers `target` at camera scale 1, made once per
 * image: what a Blur drag re-blurs on every `input`, 2.5² fewer pixels than
 * the zoom's raster. A blurred picture has no detail the smaller raster
 * loses; the release commits, and the full raster is blurred once.
 */
export function dragRaster(
  image: FrameImage,
  target: RenderTarget,
): FrameImage {
  const scale = Math.max(
    target.width / image.width,
    target.height / image.height,
  );
  if (scale >= 1) return image;
  const width = Math.ceil(image.width * scale);
  const height = Math.ceil(image.height * scale);
  const held = dragRasters.get(image);
  if (held !== undefined && held.width === width && held.height === height)
    return held;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (ctx === null)
    throw new Error(`no 2D context to draw ${width}×${height} on`);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image.image, 0, 0, width, height);
  const small = {
    ...image,
    image: canvas.transferToImageBitmap(),
    width,
    height,
  };
  dragRasters.set(image, small);
  return small;
}
