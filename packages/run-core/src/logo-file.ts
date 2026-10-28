export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

const ACCEPTED = new Set([
  "image/svg+xml",
  "image/png",
  "image/webp",
  "image/jpeg",
]);

/**
 * What an upload is allowed to be, before any bytes are read. Pure, so the
 * node lane pins every refusal's wording.
 */
export function checkLogoFile(file: {
  name: string;
  type: string;
  size: number;
}): { ok: true; note: string | null } | { ok: false; reason: string } {
  if (file.type === "") {
    return {
      ok: false,
      reason: `The logo "${file.name}" has no file type — use SVG, PNG, WebP or JPEG`,
    };
  }
  if (!ACCEPTED.has(file.type)) {
    return {
      ok: false,
      reason: `The logo "${file.name}" is a ${file.type} file — use SVG, PNG, WebP or JPEG`,
    };
  }
  if (file.size > LOGO_MAX_BYTES) {
    return {
      ok: false,
      reason: `The logo "${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB — logos are limited to 2 MB`,
    };
  }
  return {
    ok: true,
    note:
      file.type === "image/jpeg"
        ? "JPEG has no transparency — the logo shows as a box on the background"
        : null,
  };
}

/**
 * The studio's sanity bound on a stored wallpaper. What reaches it is the
 * page's resized WebP (`fitWallpaperImage`), never the user's file, so no
 * person meets this; it stops a body that skipped the resize.
 */
export const WALLPAPER_MAX_BYTES = 64 * 1024 * 1024;

/**
 * What a wallpaper upload may be, by its type alone: any size goes, since
 * the page scales it down before it is stored (spec 2026-10-28, "Uploads").
 */
export function checkWallpaperFile(file: {
  name: string;
  type: string;
}): { ok: true } | { ok: false; reason: string } {
  if (file.type === "") {
    return {
      ok: false,
      reason: `The image "${file.name}" has no file type — use PNG, JPEG, WebP or SVG`,
    };
  }
  if (!ACCEPTED.has(file.type)) {
    return {
      ok: false,
      reason: `The image "${file.name}" is a ${file.type} file — use PNG, JPEG, WebP or SVG`,
    };
  }
  return { ok: true };
}
