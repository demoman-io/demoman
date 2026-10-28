// packages/run-core/src/wallpaper.ts
import type { FrameImage } from "@demoman/compositor";

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
