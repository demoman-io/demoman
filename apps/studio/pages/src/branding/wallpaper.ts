import {
  type FrameImage,
  type RenderTarget,
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
