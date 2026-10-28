import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import {
  type SceneBackground,
  wallpaperFile,
  wallpaperInfo,
} from "@demoman/scene-schema";
import type { WallpaperInput } from "../render.js";
import { messageOf } from "../report.js";

/** Rasters only: an SVG is rasterised where it enters (upload or run), so
 *  none reaches the render as a vector. */
export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/**
 * A take's wallpaper or uploaded image, as the export reads it: a built-in
 * id from `wallpapersDir` in the shape the target draws, or an image path,
 * absolute or relative to DEMOMAN_HOME (`readLogo`'s rule). Null for a
 * solid or gradient. Never throws: every way it cannot be had is a reason,
 * which the export says (`wallpaperWarning`) while the frame shows the
 * gradient — a background is decoration.
 */
export async function readWallpaper(
  home: string,
  wallpapersDir: string,
  background: SceneBackground,
  shape: "landscape" | "portrait",
): Promise<WallpaperInput | null> {
  let path: string;
  let name: string;
  if (background.kind === "wallpaper") {
    if (wallpaperInfo(background.id) === null) {
      return {
        ok: false,
        error: `the wallpaper "${background.id}" is not in this install`,
      };
    }
    path = join(wallpapersDir, wallpaperFile(background.id, shape));
    name = background.id;
  } else if (background.kind === "image") {
    path = isAbsolute(background.ref)
      ? background.ref
      : join(home, background.ref);
    name = path;
  } else {
    return null;
  }
  const contentType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (contentType === undefined) {
    return {
      ok: false,
      error: `${path} is not a PNG, WebP or JPEG file (by its extension)`,
    };
  }
  try {
    const bytes = await readFile(path);
    return { ok: true, bytes: new Uint8Array(bytes), contentType, name };
  } catch (error) {
    return {
      ok: false,
      error: `${path} could not be read (${messageOf(error)})`,
    };
  }
}
