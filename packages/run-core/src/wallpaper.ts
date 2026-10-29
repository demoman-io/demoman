// packages/run-core/src/wallpaper.ts
import { type FrameImage, WALLPAPER_LONG_SIDE } from "@demoman/compositor";
import { decodeLogo } from "./logo.js";
import type { WallpaperLoad } from "./render/output.js";
import { webpSize } from "./webp-size.js";

// In-page only (createImageBitmap): its own subpath,
// `@demoman/run-core/wallpaper`, as `./logo` is, so a node consumer of the
// main entry never loads it.

/**
 * A wallpaper or uploaded image, decoded. With `size`, resized to it with
 * the best filter (`wallpaperRasterSize`); without, at its own size.
 * Rejects, naming the type, on bytes that will not decode.
 */
export async function decodeWallpaper(
  bytes: Uint8Array,
  contentType: string,
  size?: { width: number; height: number },
): Promise<FrameImage> {
  const blob = new Blob([bytes.slice()], { type: contentType });
  let image: ImageBitmap;
  try {
    image = await (size === undefined
      ? createImageBitmap(blob)
      : createImageBitmap(blob, {
          resizeWidth: size.width,
          resizeHeight: size.height,
          resizeQuality: "high",
        }));
  } catch (error) {
    throw new Error(
      `the ${contentType} could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A background is not a timeline sample: it has no source instant.
  return { image, width: image.width, height: image.height, sourceTimeMs: 0 };
}

/**
 * An image's bytes as a render loads them (`WallpaperLoad`): decoded once,
 * at the first size an output asks for, not at its own size — a built-in
 * master is 9600x7200, 276 MB decoded, where a 1080p export needs a
 * quarter of it. Outputs ask largest first (the target, then a cap's or a
 * GIF ladder's narrower rungs), so a later, smaller one resizes from that;
 * one that asks for more decodes again, larger. A WebP's own size is read
 * from its header (every built-in and every stored upload is one);
 * anything else is decoded whole to learn it, and held at that size.
 * Rejects, naming the type, on bytes that will not decode.
 */
export async function wallpaperLoader(
  bytes: Uint8Array,
  contentType: string,
  name: string,
): Promise<Extract<WallpaperLoad, { ok: true }>> {
  let held: FrameImage | null = null;
  let natural = webpSize(bytes);
  if (natural === null) {
    held = await decodeWallpaper(bytes, contentType);
    natural = { width: held.width, height: held.height };
  }
  const own = natural;
  const free = (image: FrameImage | null) => {
    if (image !== null && "close" in image.image) image.image.close();
  };
  return {
    ok: true,
    name,
    natural: own,
    async image(size) {
      if (held === null || held.width < size.width) {
        const next = await decodeWallpaper(
          bytes,
          contentType,
          size.width >= own.width ? undefined : size,
        );
        free(held);
        held = next;
      }
      return held;
    },
    close: () => {
      free(held);
      held = null;
    },
  };
}

/** What an upload (or an image named by path) becomes before it is stored. */
const FITTED_TYPE = "image/webp";
// The built-ins' quality: at 0.92 the encoder banded soft gradients
// (apps/studio/scripts/wallpapers/README.md, "Size").
const FITTED_QUALITY = 0.97;

/**
 * An image of any size made into what a wallpaper stores: a WebP whose long
 * side is at most `WALLPAPER_LONG_SIDE`, never upscaled. An SVG is
 * rasterised with that long side, so no vector or unbounded file reaches a
 * render. Rejects, naming the file, on one that will not decode.
 */
export async function fitWallpaperImage(
  file: Blob,
): Promise<{ blob: Blob; width: number; height: number }> {
  const name = file instanceof File ? file.name : "(unnamed)";
  let image: CanvasImageSource;
  let width: number;
  let height: number;
  try {
    if (file.type === "image/svg+xml") {
      const svg = await decodeLogo(
        new Uint8Array(await file.arrayBuffer()),
        file.type,
      );
      const raster = await svg.rasterAt(
        svg.aspect >= 1
          ? WALLPAPER_LONG_SIDE / svg.aspect
          : WALLPAPER_LONG_SIDE,
      );
      ({ image, width, height } = raster);
    } else {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(
        1,
        WALLPAPER_LONG_SIDE / Math.max(bitmap.width, bitmap.height),
      );
      width = Math.max(1, Math.round(bitmap.width * scale));
      height = Math.max(1, Math.round(bitmap.height * scale));
      image =
        scale === 1
          ? bitmap
          : await createImageBitmap(bitmap, {
              resizeWidth: width,
              resizeHeight: height,
              resizeQuality: "high",
            });
      if (image !== bitmap) bitmap.close();
    }
  } catch (error) {
    throw new Error(`The image "${name}" could not be opened as an image`, {
      cause: error,
    });
  }
  const canvas = new OffscreenCanvas(width, height);
  (canvas.getContext("2d") as OffscreenCanvasRenderingContext2D).drawImage(
    image,
    0,
    0,
  );
  if ("close" in image) image.close();
  let blob: Blob;
  try {
    blob = await canvas.convertToBlob({
      type: FITTED_TYPE,
      quality: FITTED_QUALITY,
    });
  } catch (error) {
    throw new Error(
      `The image "${name}" opened but could not be saved as WebP: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // A browser without a WebP encoder answers PNG rather than failing.
  if (blob.type !== FITTED_TYPE) {
    throw new Error(
      `The image "${name}" opened but this browser saved it as ${blob.type || "nothing"}, not WebP`,
    );
  }
  return { blob, width, height };
}
