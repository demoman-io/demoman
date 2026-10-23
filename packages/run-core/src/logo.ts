// packages/run-core/src/logo.ts
import type { FrameImage } from "@demoman/compositor";

// In-page only (Image, OffscreenCanvas, createImageBitmap): its own subpath,
// `@demoman/run-core/logo`, so a node consumer of the main entry never loads
// it, and the extension's bundles do not pull the snapshot walk in with it.

export interface LogoSource {
  contentType: string;
  /** width ÷ height. */
  aspect: number;
  /** A raster's own pixel height; null for SVG, which has none that matters. */
  naturalHeight: number | null;
  /** The logo at `heightPx` tall. SVG is re-rendered at that size, so a 4K
   *  export draws a 4K mark; a raster is returned as decoded (the painter
   *  scales it). Cached for the last few heights asked for: the editor's
   *  preview height changes on every play and pause (`previewHeightFor`). */
  rasterAt(heightPx: number): Promise<FrameImage>;
}

/**
 * How many SVG rasters a source keeps. Play and pause alternate between two
 * heights and an export adds a third, so four covers them; every window
 * resize and Size-slider move asks for another, so an unbounded cache held a
 * bitmap per height for the life of the tab. An evicted raster is dropped,
 * not `close()`d: a caller may still hold it mid-swap (the editor keeps its
 * current `logo` until the next one resolves), and drawing a closed bitmap
 * throws. Unreferenced, it is collected.
 */
export const SVG_RASTER_CACHE_SIZE = 4;

const frame = (image: ImageBitmap): FrameImage => ({
  image,
  width: image.width,
  height: image.height,
  // A logo is branding, not a timeline sample — it has no source instant.
  sourceTimeMs: 0,
});

function parseSvg(text: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (
    doc.querySelector("parsererror") !== null ||
    root.nodeName.toLowerCase() !== "svg"
  ) {
    throw new Error("the file is not an SVG");
  }
  return root as unknown as SVGSVGElement;
}

const length = (value: string | null): number | null => {
  if (value === null) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 && !value.trim().endsWith("%") ? n : null;
};

export function svgAspect(svgText: string): number {
  const root = parseSvg(svgText);
  const w = length(root.getAttribute("width"));
  const h = length(root.getAttribute("height"));
  if (w !== null && h !== null) return w / h;
  const box = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    box &&
    box.length === 4 &&
    (box[2] as number) > 0 &&
    (box[3] as number) > 0
  ) {
    return (box[2] as number) / (box[3] as number);
  }
  throw new Error(
    "the SVG has no width, height or viewBox, so there is no size to draw it at",
  );
}

/**
 * SVG goes through `<img>`: Chrome's `createImageBitmap` rejects SVG blobs
 * (pinned by `test/browser/logo-svg-premise.test.ts`). Drawn into a canvas
 * at the wanted pixel size, Chrome renders the SVG as vector at that size —
 * measured 2026-09-22 with both a viewBox-only SVG and one declaring a
 * 40x20 intrinsic size: the edge is hard at 864x432 either way — so a 4K
 * export gets a 4K mark without rewriting the file's own dimensions. The
 * `<img>` sandbox runs no script and fetches nothing external.
 */
async function svgSource(bytes: Uint8Array): Promise<LogoSource> {
  const text = new TextDecoder().decode(bytes);
  const aspect = svgAspect(text);
  const cache = new Map<number, Promise<FrameImage>>();
  const render = async (heightPx: number): Promise<FrameImage> => {
    const width = Math.max(1, Math.round(heightPx * aspect));
    const height = Math.max(1, Math.round(heightPx));
    const url = URL.createObjectURL(
      new Blob([bytes.slice()], { type: "image/svg+xml" }),
    );
    try {
      const img = new Image();
      img.src = url;
      await img.decode().catch((error: unknown) => {
        throw new Error(
          `the SVG could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      const canvas = new OffscreenCanvas(width, height);
      (canvas.getContext("2d") as OffscreenCanvasRenderingContext2D).drawImage(
        img,
        0,
        0,
        width,
        height,
      );
      return frame(await createImageBitmap(canvas));
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  return {
    contentType: "image/svg+xml",
    aspect,
    naturalHeight: null,
    rasterAt(heightPx) {
      const key = Math.max(1, Math.round(heightPx));
      let hit = cache.get(key);
      if (hit === undefined) {
        const fresh = render(key);
        hit = fresh;
        // A failed raster must not be cached as the answer for that height —
        // unless a later request for the same height already replaced it.
        fresh.catch(() => {
          if (cache.get(key) === fresh) cache.delete(key);
        });
      } else {
        cache.delete(key); // re-inserted below as the most recent
      }
      cache.set(key, hit);
      // A Map iterates in insertion order, so the first key is the least
      // recently asked for.
      while (cache.size > SVG_RASTER_CACHE_SIZE) {
        cache.delete(cache.keys().next().value as number);
      }
      return hit;
    },
  };
}

export async function decodeLogo(
  bytes: Uint8Array,
  contentType: string,
): Promise<LogoSource> {
  if (contentType === "image/svg+xml") {
    const source = await svgSource(bytes);
    // Decode once at a nominal size now, so an SVG that parses but will not
    // render is refused at upload rather than at the first export.
    await source.rasterAt(64);
    return source;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      new Blob([bytes.slice()], { type: contentType }),
    );
  } catch (error) {
    throw new Error(
      `the ${contentType} could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const image = frame(bitmap);
  return {
    contentType,
    aspect: bitmap.width / bitmap.height,
    naturalHeight: bitmap.height,
    rasterAt: async () => image,
  };
}
