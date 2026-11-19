// The painted result, sampled (CLAUDE.md, "Assert on the picture"): a rect
// says where a hairline would be, not whether it painted. Each probe takes
// a screenshot of the viewport and reads pixels from it, decoded inside the
// page (the workspace carries no PNG decoder; `createImageBitmap` on a Blob
// needs no fetch, so the studio's `default-src 'self'` allows it).
import type { BrowserContext, Page } from "playwright";

export type Rgb = [r: number, g: number, b: number];

declare global {
  interface Window {
    /** The last viewport `decodeViewport` decoded. */
    __lookProbesShot: {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      /** Bitmap pixels per CSS pixel. */
      scale: number;
    };
    /** `installDrawnOpacity`'s walk. */
    drawnOpacity: (el: Element) => number;
  }
}

/** Screenshots the viewport and decodes it inside the page, left on
 *  `window` for the probe's next evaluate: the one decode every probe here
 *  reads. */
async function decodeViewport(page: Page): Promise<void> {
  const png = (await page.screenshot({ type: "png" })).toString("base64");
  await page.evaluate(async (png) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", {
      willReadFrequently: true,
    }) as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);
    window.__lookProbesShot = {
      data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data,
      width: bitmap.width,
      height: bitmap.height,
      scale: bitmap.width / innerWidth,
    };
  }, png);
}

/** The painted colour at each CSS-pixel point of the viewport. Floored, so
 *  the middle of a 1px line (x.5) lands inside it at any device pixel ratio;
 *  a point off the viewport reads its nearest edge. */
export async function pixelsAt(
  page: Page,
  points: ReadonlyArray<readonly [x: number, y: number]>,
): Promise<Rgb[]> {
  await decodeViewport(page);
  return page.evaluate((points) => {
    const shot = window.__lookProbesShot;
    const at = (v: number, size: number) =>
      Math.min(size - 1, Math.max(0, Math.floor(v * shot.scale)));
    return points.map(([x, y]) => {
      const i = (at(y, shot.height) * shot.width + at(x, shot.width)) * 4;
      return [shot.data[i], shot.data[i + 1], shot.data[i + 2]] as Rgb;
    });
  }, points);
}

/** A painted box in CSS px, named for a failure message. `words` is where
 *  its painted text is laid out, 1px round, when it has any: a tile whose
 *  middle is a picture is read at its name. A field (a box, a text input)
 *  is read whole and 3px round, its edge against the page: an unticked
 *  box's middle is its own fill and nothing else. */
export type NamedBox = {
  name: string;
  field?: boolean;
  words?: { x: number; y: number; width: number; height: number } | null;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Each box's middle half as painted (its words' box when it has words; a
 * field's whole box and 3px round it), clamped to the viewport, from one
 * screenshot: the colour that fills most of it, and the WCAG contrast of
 * the colour that stands out most from that fill. A control's words or
 * glyph painted in its own fill's colour (a white pause glyph on a white
 * disc) reads 1:1 however its fill stands against the page. The middle
 * half, so a round disc's corners, which are the page, are not read as its
 * ink.
 */
export async function inkOnFill(page: Page, boxes: readonly NamedBox[]) {
  await decodeViewport(page);
  const read = await page.evaluate((boxes) => {
    const shot = window.__lookProbesShot;
    return boxes.map((b) => {
      const r =
        b.field === true
          ? { x: b.x - 3, y: b.y - 3, w: b.width + 6, h: b.height + 6 }
          : b.words != null
            ? {
                x: b.words.x,
                y: b.words.y,
                w: b.words.width,
                h: b.words.height,
              }
            : {
                x: b.x + b.width / 4,
                y: b.y + b.height / 4,
                w: b.width / 2,
                h: b.height / 2,
              };
      // Both ends clamped, so a box past the edge reads what is painted,
      // never the transparent black outside the bitmap.
      const clamp = (v: number, size: number) => Math.min(size, Math.max(0, v));
      const x0 = clamp(Math.floor(r.x * shot.scale), shot.width - 1);
      const y0 = clamp(Math.floor(r.y * shot.scale), shot.height - 1);
      const x1 = Math.max(
        x0 + 1,
        clamp(Math.ceil((r.x + r.w) * shot.scale), shot.width),
      );
      const y1 = Math.max(
        y0 + 1,
        clamp(Math.ceil((r.y + r.h) * shot.scale), shot.height),
      );
      const counts = new Map<number, number>();
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * shot.width + x) * 4;
          const key =
            ((shot.data[i] as number) << 16) |
            ((shot.data[i + 1] as number) << 8) |
            (shot.data[i + 2] as number);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const fill = [...counts.entries()].sort((p, q) => q[1] - p[1])[0]?.[0];
      return { name: b.name, fill: fill ?? 0, colours: [...counts.keys()] };
    });
  }, boxes);
  const rgb = (k: number): Rgb => [(k >> 16) & 255, (k >> 8) & 255, k & 255];
  return read.map((r) => {
    const fill = rgb(r.fill);
    let best = 1;
    let ink = fill;
    for (const k of r.colours) {
      const ratio = contrast(rgb(k), fill);
      if (ratio > best) {
        best = ratio;
        ink = rgb(k);
      }
    }
    return {
      name: r.name,
      fill: `rgb(${fill.join(", ")})`,
      ink: `rgb(${ink.join(", ")})`,
      contrast: Math.round(best * 100) / 100,
    };
  });
}

/** Installs `window.drawnOpacity(el)`, an element's opacity as drawn (its
 *  own times every ancestor's), on every page `context` opens from now: an
 *  init script, which the pages' `default-src 'self'` does not refuse, so
 *  each probe's evaluate reads the one walk. */
export async function installDrawnOpacity(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(() => {
    window.drawnOpacity = (el: Element): number => {
      let o = 1;
      for (let n: Element | null = el; n !== null; n = n.parentElement) {
        o *= Number(getComputedStyle(n).opacity);
      }
      return o;
    };
  });
}

/** Rec. 709 luma of a painted colour, 0–255. */
export function luma([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * A hairline across `axis` at (x, y): the luma on the line and 3px either
 * side of it, across the line (`"h"`: above and below; `"v"`: left and
 * right). A painted hairline is lighter than both sides.
 */
export async function hairlineAt(
  page: Page,
  x: number,
  y: number,
  axis: "h" | "v",
): Promise<{ line: number; before: number; after: number }> {
  const [d0, d1] = axis === "h" ? [0, 3] : [3, 0];
  const [before, line, after] = await pixelsAt(page, [
    [x - d0, y - d1],
    [x, y],
    [x + d0, y + d1],
  ]);
  return {
    line: luma(line as Rgb),
    before: luma(before as Rgb),
    after: luma(after as Rgb),
  };
}

/** WCAG contrast ratio between two painted colours. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (p, q) => q - p,
  ) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG relative luminance of a painted colour, 0 to 1. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** The site's lime. */
export const LIME: Rgb = [205, 235, 69];

/** Where lime may paint (spec 2026-10-19 §3.5): the default kit's star, a
 *  text link, an export's progress bar. The scan blurs focus first, from
 *  when the focus ring was lime's fourth place. */
const LIME_PLACES = [
  '.kit-star[aria-pressed="true"]',
  "a[href]",
  ".export-progress",
].join(", ");

/**
 * Every point of a 24px grid over the viewport that paints lime outside
 * lime's three places, each as "x,y rgb on <element>". Empty is the claim.
 */
export async function limeOutsideItsPlaces(page: Page): Promise<string[]> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const grid = await page.evaluate(() => {
    const points: Array<[number, number]> = [];
    for (let y = 2; y < innerHeight; y += 24) {
      for (let x = 2; x < innerWidth; x += 24) points.push([x, y]);
    }
    return points;
  });
  const painted = await pixelsAt(page, grid);
  const lime = grid.filter((_, i) => distance(painted[i] as Rgb, LIME) <= 12);
  return page.evaluate(
    ({ points, places }) => {
      const allowed = [...document.querySelectorAll(places)].map((el) =>
        el.getBoundingClientRect(),
      );
      return points
        .filter(
          ([x, y]) =>
            !allowed.some(
              (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
            ),
        )
        .map(([x, y]) => {
          const el = document.elementFromPoint(x, y);
          const name =
            el === null
              ? "nothing"
              : `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${
                  el.classList.length > 0
                    ? `.${[...el.classList].join(".")}`
                    : ""
                }`;
          return `${x},${y} on ${name}`;
        });
    },
    { points: lime, places: LIME_PLACES },
  );
}

/** How far apart two colours are: the largest channel difference. */
export function distance(a: Rgb, b: Rgb): number {
  return Math.max(...a.map((v, i) => Math.abs(v - (b[i] as number))));
}
