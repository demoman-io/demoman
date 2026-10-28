// apps/runner/src/executor/wallpaper-own.ts
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import type { SceneBranding } from "@demoman/scene-schema";
import { fitWallpaperInPage } from "../render.js";
import { messageOf } from "../report.js";
import type { BrowserSession } from "./browser.js";
import { IMAGE_TYPES as RASTER_TYPES } from "./wallpaper-read.js";

/**
 * A fitted wallpaper (`fitWallpaperImage`'s WebP) written into
 * `<home>/assets/<uuid>.webp`; answers that home-relative ref, which is how
 * `readWallpaper` resolves it. Written beside and renamed over, so a killed
 * process never leaves half an image under a ref. Throws naming the path.
 * Shared by the studio's upload (`saveWallpaper`) and the run door.
 */
export async function writeWallpaperAsset(
  home: string,
  bytes: Uint8Array,
): Promise<string> {
  const ref = `assets/${randomUUID()}.webp`;
  const path = join(home, ref);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    // Owner-only, as everything under the home is.
    await mkdir(join(home, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new Error(`could not write ${path} (${messageOf(error)})`);
  }
  return ref;
}

/** What a path's image is, by its extension: the upload's four types, the
 *  render's rasters and the SVG this rasterises. */
const IMAGE_TYPES: Record<string, string> = {
  ...RASTER_TYPES,
  ".svg": "image/svg+xml",
};

/** A page's rejection as its own sentence: Playwright prefixes the call and
 *  the error's name, and appends the page's stack. */
const pageSentence = (error: unknown) =>
  (messageOf(error).split("\n")[0] ?? "")
    .replace(/^page\.evaluate: /, "")
    .replace(/^Error: /, "");

/**
 * An image named by path (an agent script's `look.branding`, or a
 * hand-edited kit) made into the take's own copy, as an upload is: read,
 * fitted in a work page (`fitWallpaperImage`: resized, an SVG rasterised),
 * written with `writeWallpaperAsset`, and the ref rewritten to it. The
 * original file is only read. A background that is not an image, or an
 * image already under `<home>/assets/`, comes back as it was, with no page
 * opened. Every way it fails is `detail`, naming the path; what to do with
 * that is the caller's (the run door refuses a script's, and leaves a
 * kit's as the kit has it).
 */
export async function ownWallpaperImage(
  branding: SceneBranding,
  deps: { home: string; work: Pick<BrowserSession, "openWorkPage"> },
): Promise<
  { ok: true; branding: SceneBranding } | { ok: false; detail: string }
> {
  const background = branding.background;
  if (background.kind !== "image") return { ok: true, branding };
  const path = isAbsolute(background.ref)
    ? background.ref
    : join(deps.home, background.ref);
  const inAssets = relative(join(deps.home, "assets"), path);
  if (!inAssets.startsWith("..") && !isAbsolute(inAssets)) {
    return { ok: true, branding };
  }
  const contentType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (contentType === undefined) {
    return {
      ok: false,
      detail: `The image ${path} is not a PNG, JPEG, WebP or SVG file (by its extension)`,
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    return {
      ok: false,
      detail: `The image ${path} could not be read (${messageOf(error)})`,
    };
  }
  const work = await deps.work.openWorkPage();
  if (!work.ok) {
    return {
      ok: false,
      detail: `Demoman could not open a page to resize the image ${path}: ${work.detail}`,
    };
  }
  let fitted: Buffer;
  try {
    fitted = (
      await fitWallpaperInPage(work.page, { bytes, contentType, name: path })
    ).bytes;
  } catch (error) {
    // The page's sentence names the file (`fitWallpaperImage`); a transport
    // failure's does not, so the path goes in front of it.
    const said = pageSentence(error);
    return {
      ok: false,
      detail: said.includes(path) ? said : `The image ${path}: ${said}`,
    };
  } finally {
    // A work page that will not close changes nothing this answers; the
    // browser's own close takes it.
    await work.page.close().catch(() => undefined);
  }
  let ref: string;
  try {
    ref = await writeWallpaperAsset(deps.home, fitted);
  } catch (error) {
    return {
      ok: false,
      detail: `Demoman resized the image ${path} but could not save its copy: ${messageOf(error)}`,
    };
  }
  return {
    ok: true,
    branding: { ...branding, background: { kind: "image", ref } },
  };
}
