import { decodeLogo, type LogoSource } from "@demoman/run-core/logo";
import type { LogoLoad } from "@demoman/run-core/render";
import type { EditorStore } from "../editor/ports";

// Moved to @demoman/run-core/logo (CLI executor plan 2, Task 2): the CLI's
// render decodes a kit's logo with the same code. Re-exported so this
// module's importers, and the tests that doMock it, are unchanged.
export {
  decodeLogo,
  type LogoSource,
  SVG_RASTER_CACHE_SIZE,
  svgAspect,
} from "@demoman/run-core/logo";

export type { LogoLoad } from "@demoman/run-core/render";

/**
 * A stored logo, decoded — or the reason it is not. Replaces the old
 * `loadLogo`'s bare `catch { return null }`, which drew a frame with no logo
 * and said nothing, in the editor and the export alike.
 */
export async function loadLogo(
  store: Pick<EditorStore, "readAsset">,
  ref: string,
): Promise<LogoLoad> {
  let asset: Awaited<ReturnType<EditorStore["readAsset"]>>;
  try {
    asset = await store.readAsset(ref);
  } catch (error) {
    return {
      ok: false,
      error: `the logo could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (asset === null)
    return {
      ok: false,
      error: `the logo "${ref}" is not in this browser's storage`,
    };
  try {
    return {
      ok: true,
      source: await decodeLogo(asset.bytes, asset.contentType),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function sharpnessNote(
  source: LogoSource,
  neededHeightPx: number,
  formatTitle: string,
): string | null {
  if (source.naturalHeight === null || source.naturalHeight >= neededHeightPx)
    return null;
  return `Upscaled in a ${formatTitle} export — an SVG or a larger PNG stays sharp`;
}

/** The logo's thumbnail in the Background panel and the brand kit's
 *  controls: 40px tall in CSS, drawn at 2x for a sharp mark on a Retina
 *  screen. */
/** 160 since the logo well grew to ~62 CSS px of image (mockup A,
 *  2026-10-08): 80 was soft on a 2x screen at that size. */
export const LOGO_THUMB_HEIGHT_PX = 160;

const thumbnails = new WeakMap<LogoSource, Promise<string>>();

/**
 * A small PNG of the logo, as a `data:` URL for an `<img>`.
 *
 * A data URL rather than an object URL so it has no lifetime to manage:
 * the controls are rebuilt on every commit, on two pages, and an object URL
 * would need revoking by whichever of them dropped the source last. At 80px
 * tall it is a few kilobytes. Memoised per source, so a re-render assigns
 * the same string and the browser shows the image it already decoded.
 */
export function logoThumbnail(source: LogoSource): Promise<string> {
  let hit = thumbnails.get(source);
  if (hit === undefined) {
    hit = (async () => {
      const raster = await source.rasterAt(LOGO_THUMB_HEIGHT_PX);
      const height = LOGO_THUMB_HEIGHT_PX;
      const width = Math.max(1, Math.round(height * source.aspect));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("the thumbnail has no 2D context to draw in");
      }
      context.drawImage(raster.image, 0, 0, width, height);
      return canvas.toDataURL("image/png");
    })();
    thumbnails.set(source, hit);
    // A failure is not the answer for good: the next ask tries again.
    hit.catch(() => {
      if (thumbnails.get(source) === hit) thumbnails.delete(source);
    });
  }
  return hit;
}
