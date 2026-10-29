import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  checkLogoFile,
  checkWallpaperFile,
  WALLPAPER_MAX_BYTES,
} from "@demoman/run-core";
import { writeWallpaperAsset } from "@demoman/runner/studio";
import type { AssetAnswer, Refusal } from "@demoman/studio-protocol";
import { messageOf, writeAtomic } from "./files.js";

/** The file extension each accepted logo type is written under. */
const EXTENSION: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
};

/**
 * A logo upload, checked by the extension's own `checkLogoFile`, written to
 * `<home>/assets/<uuid>.<ext>`. The ref is relative to the home, which is
 * how `readLogo` (and so every export) resolves it.
 */
export async function saveLogo(
  home: string,
  file: { name: string; type: string; bytes: Buffer },
): Promise<
  | { ok: true; answer: AssetAnswer }
  | { ok: false; status: number; refusal: Refusal }
> {
  const check = checkLogoFile({
    name: file.name,
    type: file.type,
    size: file.bytes.byteLength,
  });
  if (!check.ok) {
    return {
      ok: false,
      status: 400,
      refusal: { reason: "logoRefused", detail: check.reason },
    };
  }
  const ext = EXTENSION[file.type];
  if (ext === undefined) {
    // `checkLogoFile` accepted a type this table does not name: the two
    // lists have drifted. Said, rather than written under a guessed name.
    throw new Error(
      `no file extension for the accepted logo type ${file.type}`,
    );
  }
  const ref = `assets/${randomUUID()}.${ext}`;
  try {
    await writeAtomic(join(home, ref), file.bytes);
  } catch (error) {
    return {
      ok: false,
      status: 500,
      refusal: {
        reason: "studioUnwritable",
        detail: `The logo was not saved: ${messageOf(error)}.`,
      },
    };
  }
  return { ok: true, answer: { ref } };
}

/**
 * A wallpaper upload: the page's resized WebP (`fitWallpaperImage`), written
 * by the runner's `writeWallpaperAsset` to `<home>/assets/<uuid>.webp`, the
 * ref `readWallpaper` resolves. Any size of picture is accepted because the
 * page bounds it first; what is refused here is a body that is not that
 * WebP, named by type, or one past `WALLPAPER_MAX_BYTES`, a sanity bound.
 */
export async function saveWallpaper(
  home: string,
  file: { name: string; type: string; bytes: Buffer },
): Promise<
  | { ok: true; answer: AssetAnswer }
  | { ok: false; status: number; refusal: Refusal }
> {
  const refused = (detail: string) => ({
    ok: false as const,
    status: 400,
    refusal: { reason: "wallpaperRefused" as const, detail },
  });
  const check = checkWallpaperFile(file);
  if (!check.ok) return refused(check.reason);
  if (file.type !== "image/webp") {
    // An accepted type the page did not resize: stored as .webp it would
    // be a lie, and unbounded.
    return refused(
      `The image "${file.name}" reached the studio as ${file.type}, not the resized WebP the page makes — upload it again`,
    );
  }
  if (file.bytes.byteLength > WALLPAPER_MAX_BYTES) {
    return refused(
      `The image "${file.name}" is ${(file.bytes.byteLength / 1024 / 1024).toFixed(1)} MB after resizing — the studio stores at most ${WALLPAPER_MAX_BYTES / 1024 / 1024} MB`,
    );
  }
  try {
    return {
      ok: true,
      answer: { ref: await writeWallpaperAsset(home, file.bytes) },
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      refusal: {
        reason: "studioUnwritable",
        detail: `The image was not saved: ${messageOf(error)}.`,
      },
    };
  }
}
