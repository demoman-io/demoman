// apps/runner/src/executor/wallpaper-own.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import { WALLPAPER_LONG_SIDE } from "@demoman/compositor";
import { webpSize } from "@demoman/run-core";
import type { SceneBranding } from "@demoman/scene-schema";
import { fitWallpaperInPage } from "../render.js";
import { messageOf } from "../report.js";
import type { BrowserSession } from "./browser.js";
import { IMAGE_TYPES as RASTER_TYPES } from "./wallpaper-read.js";

/**
 * A fitted wallpaper (`fitWallpaperImage`'s WebP) written into
 * `<home>/assets/<name>.webp` (the studio's upload names it by a uuid, the
 * run door by its source's digest); answers that home-relative ref, which
 * is how `readWallpaper` resolves it. Written beside and renamed over, so a
 * killed process never leaves half an image under a ref. Throws naming the
 * path, and the temp file too when that could not be removed.
 * Shared by the studio's upload (`saveWallpaper`) and the run door.
 */
export async function writeWallpaperAsset(
  home: string,
  bytes: Uint8Array,
  name: string = randomUUID(),
): Promise<string> {
  const ref = `assets/${name}.webp`;
  const path = join(home, ref);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Owner-only, as everything under the home is.
    await mkdir(join(home, "assets"), { recursive: true, mode: 0o700 });
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, path).catch(async (error: unknown) => {
      // Another own of the same bytes won the race: its copy is this one.
      const there = await readFile(path).catch(() => null);
      if (there === null || !Buffer.from(bytes).equals(there)) throw error;
      await rm(temp, { force: true });
    });
  } catch (error) {
    const left = await rm(temp, { force: true }).then(
      () => "",
      (rmError: unknown) => `; ${temp} was left behind (${messageOf(rmError)})`,
    );
    throw new Error(`could not write ${path} (${messageOf(error)})${left}`);
  }
  return ref;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

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
 * hand-edited kit) made into the take's own copy, as an upload is, and the
 * ref rewritten to it. The copy is named by a digest of the source's bytes
 * (`assets/<sha256>.webp`), so owning the same file twice, or on every run,
 * answers the same ref and writes it once. A source that is already what a
 * fit makes — a WebP whose long side is at most `WALLPAPER_LONG_SIDE` — is
 * copied byte for byte (a re-encode would make new bytes, which refresh's
 * `lookDigest` would read as a new look), or left where it is when it is
 * already under `<home>/assets/`. Anything else, wherever it lives, is
 * fitted in a work page (`fitWallpaperImage`: resized, an SVG rasterised).
 * The original file is only read. A background that is not an image comes
 * back as it was. Every way it fails is `detail`, naming the path; what to
 * do with that is the caller's (the run door refuses a script's, and
 * leaves a kit's as the kit has it).
 */
export async function ownWallpaperImage(
  branding: SceneBranding,
  deps: {
    home: string;
    work: Pick<BrowserSession, "openWorkPage">;
    log: (line: string) => void;
  },
): Promise<
  { ok: true; branding: SceneBranding } | { ok: false; detail: string }
> {
  const background = branding.background;
  if (background.kind !== "image") return { ok: true, branding };
  const path = isAbsolute(background.ref)
    ? background.ref
    : join(deps.home, background.ref);
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
  const size = webpSize(bytes);
  // shortcut: the header is trusted, so a WebP whose body is damaged is
  // copied and its export says it was left out; decode it here if that bites.
  const fitAlready =
    size !== null && Math.max(size.width, size.height) <= WALLPAPER_LONG_SIDE;
  const inAssets = relative(join(deps.home, "assets"), path);
  if (fitAlready && !inAssets.startsWith("..") && !isAbsolute(inAssets)) {
    return { ok: true, branding };
  }
  const name = createHash("sha256").update(bytes).digest("hex");
  const owned = (ref: string) => ({
    ok: true as const,
    // Its blur, if it has one, stays: only where the image lives changed.
    branding: { ...branding, background: { ...background, ref } },
  });
  // Written whole or not at all (`writeWallpaperAsset`), and what is
  // written for these bytes is decided by the bytes alone, so one there is
  // this source's copy.
  if (await exists(join(deps.home, "assets", `${name}.webp`))) {
    return owned(`assets/${name}.webp`);
  }
  let fitted: Uint8Array;
  if (fitAlready) {
    fitted = bytes;
  } else {
    const made = await fitInPage(path, bytes, contentType, deps);
    if (!made.ok) return made;
    fitted = made.bytes;
  }
  try {
    return owned(await writeWallpaperAsset(deps.home, fitted, name));
  } catch (error) {
    return {
      ok: false,
      detail: `Demoman ${fitAlready ? "read" : "resized"} the image ${path} but could not save its copy: ${messageOf(error)}`,
    };
  }
}

async function fitInPage(
  path: string,
  bytes: Uint8Array,
  contentType: string,
  deps: {
    work: Pick<BrowserSession, "openWorkPage">;
    log: (line: string) => void;
  },
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; detail: string }> {
  const work = await deps.work.openWorkPage();
  if (!work.ok) {
    return {
      ok: false,
      detail: `Demoman could not open a page to resize the image ${path}: ${work.detail}`,
    };
  }
  try {
    return {
      ok: true,
      bytes: (
        await fitWallpaperInPage(work.page, { bytes, contentType, name: path })
      ).bytes,
    };
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
    // browser's own close takes it. Said, so a leak has a trail.
    await work.page
      .close()
      .catch((error: unknown) =>
        deps.log(
          `the page that resized ${path} would not close (${messageOf(error)})`,
        ),
      );
  }
}
