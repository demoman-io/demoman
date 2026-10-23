// The painted result, sampled (CLAUDE.md, "Assert on the picture"): a rect
// says where a hairline would be, not whether it painted. Each probe takes
// a screenshot of the viewport and reads pixels from it, decoded inside the
// page (the workspace carries no PNG decoder; `createImageBitmap` on a Blob
// needs no fetch, so the studio's `default-src 'self'` allows it).
import type { Page } from "playwright";

export type Rgb = [r: number, g: number, b: number];

/** The painted colour at each CSS-pixel point of the viewport. Floored, so
 *  the middle of a 1px line (x.5) lands inside it at any device pixel ratio. */
export async function pixelsAt(
  page: Page,
  points: ReadonlyArray<readonly [x: number, y: number]>,
): Promise<Rgb[]> {
  const png = (await page.screenshot({ type: "png" })).toString("base64");
  return page.evaluate(
    async ({ png, points }) => {
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/png" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d", {
        willReadFrequently: true,
      }) as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / innerWidth;
      return points.map(([x, y]) => {
        const px = ctx.getImageData(
          Math.min(bitmap.width - 1, Math.floor(x * scale)),
          Math.min(bitmap.height - 1, Math.floor(y * scale)),
          1,
          1,
        ).data;
        return [px[0], px[1], px[2]] as [number, number, number];
      });
    },
    { png, points },
  );
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
  const rel = ([r, g, b]: Rgb): number => {
    const [R, G, B] = [r, g, b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  const [hi, lo] = [rel(a), rel(b)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
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
