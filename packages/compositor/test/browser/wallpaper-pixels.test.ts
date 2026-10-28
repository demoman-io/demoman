import {
  NEUTRAL_BACKGROUND,
  type SceneBackground,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import type { FrameImage } from "../../src/ports/types";
import {
  derivePresentation,
  drawBackground,
} from "../../src/render/presentation";
import { LANDSCAPE_1080P, type RenderTarget } from "../../src/render/target";
import { coverRect } from "../../src/render/wallpaper";

const VIEWPORT = { width: 1280, height: 800 };
const WALLPAPER: SceneBackground = { kind: "wallpaper", id: "vivid-1" };

/** 4:3, four saturated quadrants, and a 1px red/blue checker down the middle
 *  column. None of the colours is near the pale neutral. */
const FW = 400;
const FH = 300;
const CORNERS = {
  topLeft: [220, 30, 30],
  topRight: [30, 180, 40],
  bottomLeft: [40, 60, 220],
  bottomRight: [200, 160, 20],
} as const;
const CHECKER = [
  [0, 0, 0],
  [200, 0, 200],
] as const;
const CHECKER_X = FW / 2;

type Rgba = [number, number, number, number];
const css = ([r, g, b]: readonly number[]) => `rgb(${r},${g},${b})`;

function quadrantFixture(): OffscreenCanvas {
  const c = new OffscreenCanvas(FW, FH);
  const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const half = { w: FW / 2, h: FH / 2 };
  g.fillStyle = css(CORNERS.topLeft);
  g.fillRect(0, 0, half.w, half.h);
  g.fillStyle = css(CORNERS.topRight);
  g.fillRect(half.w, 0, half.w, half.h);
  g.fillStyle = css(CORNERS.bottomLeft);
  g.fillRect(0, half.h, half.w, half.h);
  g.fillStyle = css(CORNERS.bottomRight);
  g.fillRect(half.w, half.h, half.w, half.h);
  for (let y = 0; y < FH; y++) {
    g.fillStyle = css(CHECKER[y % 2] as readonly number[]);
    g.fillRect(CHECKER_X, y, 1, 1);
  }
  return c;
}

/** Left half fully transparent, right half opaque teal. */
function halfTransparentFixture(): OffscreenCanvas {
  const c = new OffscreenCanvas(FW, FH);
  const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  g.fillStyle = "rgb(0,140,140)";
  g.fillRect(FW / 2, 0, FW / 2, FH);
  return c;
}

async function asFrameImage(c: OffscreenCanvas): Promise<FrameImage> {
  const image = await createImageBitmap(c);
  return { image, width: c.width, height: c.height, sourceTimeMs: 0 };
}

function pixels(c: OffscreenCanvas) {
  const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const data = g.getImageData(0, 0, c.width, c.height).data;
  return (x: number, y: number): Rgba => {
    const i = (y * c.width + x) * 4;
    return [
      data[i] as number,
      data[i + 1] as number,
      data[i + 2] as number,
      data[i + 3] as number,
    ];
  };
}

function paint(
  target: RenderTarget,
  background: SceneBackground,
  wallpaper: FrameImage | null,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const presentation = derivePresentation(
    { background, logo: null, padding: 0.08 },
    target,
    VIEWPORT,
    null,
    wallpaper,
  );
  drawBackground(ctx, target, presentation);
  return canvas;
}

const near = (a: readonly number[], b: readonly number[], tol: number) =>
  [0, 1, 2].every((i) => Math.abs((a[i] as number) - (b[i] as number)) <= tol);

const neutral = NEUTRAL_BACKGROUND;
const hex = (h: string) =>
  [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const NEUTRAL_STOPS = [hex(neutral.from), hex(neutral.to)];
/** Further than 40 per channel, on some channel, from both neutral stops. */
const nonNeutral = (p: readonly number[]) =>
  NEUTRAL_STOPS.every((s) => !near(p, s, 40));

const at = (target: RenderTarget, width: number, height: number) => ({
  ...target,
  width,
  height,
});

describe("wallpaper pixels", () => {
  it("the fixture carries its corner colours and its checker", () => {
    const px = pixels(quadrantFixture());
    expect(px(0, 0).slice(0, 3)).toEqual([...CORNERS.topLeft]);
    expect(px(FW - 1, 0).slice(0, 3)).toEqual([...CORNERS.topRight]);
    expect(px(0, FH - 1).slice(0, 3)).toEqual([...CORNERS.bottomLeft]);
    expect(px(FW - 1, FH - 1).slice(0, 3)).toEqual([...CORNERS.bottomRight]);
    for (let y = 0; y < FH; y++) {
      expect(px(CHECKER_X, y).slice(0, 3)).toEqual([
        ...(CHECKER[y % 2] as readonly number[]),
      ]);
    }
    for (const c of [...Object.values(CORNERS), ...CHECKER]) {
      expect(nonNeutral(c), `${c} is near the neutral`).toBe(true);
    }
    const half = pixels(halfTransparentFixture());
    expect(half(10, 10)[3]).toBe(0);
    expect(half(FW / 2 - 1, FH - 1)[3]).toBe(0);
    expect(half(FW - 1, 0)).toEqual([0, 140, 140, 255]);
  });

  it.each([
    [1920, 1080],
    [1080, 1920],
    [1440, 1080],
    [2520, 1080],
  ])("cover leaves no bands at %dx%d", async (w, h) => {
    const fixture = quadrantFixture();
    const source = pixels(fixture);
    const target = at(LANDSCAPE_1080P, w, h);
    const painted = pixels(
      paint(target, WALLPAPER, await asFrameImage(fixture)),
    );
    const crop = coverRect({ width: FW, height: FH }, target);
    const bad: string[] = [];
    let compared = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ring = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
        if (!ring) continue;
        const p = painted(x, y);
        if (p[3] !== 255 || !nonNeutral(p)) {
          bad.push(`(${x},${y}) ${p} is neutral or not opaque`);
          continue;
        }
        // Where this pixel samples the fixture. Pixels within 2 source px
        // of a quadrant seam or the checker blend under smoothing: skip them.
        const sx = crop.sx + ((x + 0.5) / w) * crop.sw;
        const sy = crop.sy + ((y + 0.5) / h) * crop.sh;
        if (Math.abs(sx - CHECKER_X) < 3 || Math.abs(sy - FH / 2) < 2) continue;
        const want = source(
          Math.min(FW - 1, Math.floor(sx)),
          Math.min(FH - 1, Math.floor(sy)),
        );
        compared++;
        if (!near(p, want, 8)) bad.push(`(${x},${y}) ${p} wants ${want}`);
      }
    }
    expect(bad.slice(0, 10), `${bad.length} bad ring pixels`).toEqual([]);
    // The ring is 2px all round; most of it is away from a seam.
    expect(compared).toBeGreaterThan((2 * (w + h) * 2) / 2);
  });

  it("transparent pixels show the neutral gradient", async () => {
    const target = LANDSCAPE_1080P;
    const painted = pixels(
      paint(target, WALLPAPER, await asFrameImage(halfTransparentFixture())),
    );
    const reference = pixels(paint(target, NEUTRAL_BACKGROUND, null));
    const crop = coverRect({ width: FW, height: FH }, target);
    // The transparent half ends at this target column; stay clear of it.
    const seam = ((FW / 2 - crop.sx) / crop.sw) * target.width;
    expect(seam).toBeGreaterThan(400);
    const bad: string[] = [];
    for (let y = 0; y < target.height; y += 37) {
      for (let x = 0; x < seam - 10; x += 41) {
        const p = painted(x, y);
        const r = reference(x, y);
        if (p[3] !== 255 || !near(p, r, 2))
          bad.push(`(${x},${y}) ${p} vs ${r}`);
      }
    }
    expect(bad.slice(0, 10), `${bad.length} pixels off the gradient`).toEqual(
      [],
    );
    // And the opaque half is the image, not the gradient.
    expect(painted(target.width - 20, 540).slice(0, 3)).toEqual([0, 140, 140]);
  });

  it("no image paints NEUTRAL_BACKGROUND", () => {
    const target = LANDSCAPE_1080P;
    const painted = pixels(paint(target, WALLPAPER, null));
    const reference = pixels(paint(target, NEUTRAL_BACKGROUND, null));
    // The reference really is a gradient: its corners differ.
    const a = reference(0, 0);
    const b = reference(target.width - 1, target.height - 1);
    expect(near(a, b, 8), `${a} vs ${b}`).toBe(false);
    for (let y = 0; y < target.height; y += 53) {
      for (let x = 0; x < target.width; x += 59) {
        const p = painted(x, y);
        expect(p[3]).toBe(255);
        expect(near(p, reference(x, y), 2), `(${x},${y}) ${p}`).toBe(true);
      }
    }
  });

  it("smoothing is high", async () => {
    const target = LANDSCAPE_1080P;
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.imageSmoothingQuality = "low";
    const presentation = derivePresentation(
      { background: WALLPAPER, logo: null, padding: 0.08 },
      target,
      VIEWPORT,
      null,
      await asFrameImage(quadrantFixture()),
    );
    expect(presentation.wallpaper).not.toBeNull();
    drawBackground(ctx, target, presentation);
    expect(ctx.imageSmoothingEnabled).toBe(true);
    expect(ctx.imageSmoothingQuality).toBe("high");
  });
});
