import { BRANDING_DEFAULTS, type SceneBackground } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { containRect } from "../../src/geometry";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { renderFrame } from "../../src/render/compose";
import {
  clipToFrame,
  derivePresentation,
  drawBackground,
} from "../../src/render/presentation";
import {
  autoTarget,
  LANDSCAPE_1080P,
  type RenderTarget,
} from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { cameraKey } from "../fixtures/camera-key";
import { readonlyScene } from "../fixtures/scene";

const NAVY: SceneBackground = { kind: "solid", color: "#1b2a4a" };

/** The background in navy, the recording's box filled red. */
function paint(viewport: { width: number; height: number }, padding: number) {
  const target: RenderTarget = autoTarget(LANDSCAPE_1080P, viewport, padding);
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const presentation = derivePresentation(
    { ...BRANDING_DEFAULTS, background: NAVY, padding },
    target,
    viewport,
  );
  drawBackground(ctx, target, presentation);
  ctx.save();
  clipToFrame(ctx, presentation);
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.restore();
  return { ctx, target };
}

function isRecording(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
) {
  const [r, g, b] = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return (r as number) > 200 && (g as number) < 60 && (b as number) < 60;
}

/** Pixels of background from an edge, walking inward along a middle line. */
function margin(
  ctx: OffscreenCanvasRenderingContext2D,
  t: RenderTarget,
  side: "top" | "bottom" | "left" | "right",
): number {
  for (let d = 0; d < Math.max(t.width, t.height); d++) {
    const [x, y] =
      side === "top"
        ? [t.width / 2, d]
        : side === "bottom"
          ? [t.width / 2, t.height - 1 - d]
          : side === "left"
            ? [d, t.height / 2]
            : [t.width - 1 - d, t.height / 2];
    if (isRecording(ctx, x, y)) return d;
  }
  throw new Error(`no recording found from the ${side}`);
}

describe("the Auto frame, as painted", () => {
  // Spec 2026-10-06 §4. Red if Auto falls back to a 16:9 frame: the
  // author's 1512x820 tab would show background top and bottom.
  it.each([
    { width: 1512, height: 820 },
    { width: 1280, height: 800 },
  ])("is recording to every edge and corner at padding 0 (%o)", (viewport) => {
    const { ctx, target: t } = paint(viewport, 0);
    // Premise: background and recording are told apart at a probe.
    const probe = paint(viewport, 0.08);
    expect(
      isRecording(probe.ctx, 2, 2),
      "premise: a margin pixel is background",
    ).toBe(false);
    for (const [x, y] of [
      [0, 0],
      [t.width - 1, 0],
      [0, t.height - 1],
      [t.width - 1, t.height - 1],
      [t.width / 2, 0],
      [t.width / 2, t.height - 1],
      [0, t.height / 2],
      [t.width - 1, t.height / 2],
    ] as const) {
      expect(
        isRecording(ctx, x, y),
        `${x},${y} of ${t.width}x${t.height}`,
      ).toBe(true);
    }
  });

  // Red if the margin is uneven (the frame is the recording's exact shape).
  it("paints the same margin on all four sides at padding 0.08", () => {
    const { ctx, target: t } = paint({ width: 1512, height: 820 }, 0.08);
    const sides = (["top", "bottom", "left", "right"] as const).map((s) =>
      margin(ctx, t, s),
    );
    // Premise: there is a margin to measure.
    expect(Math.min(...sides)).toBeGreaterThan(50);
    expect(
      Math.max(...sides) - Math.min(...sides),
      JSON.stringify(sides),
    ).toBeLessThanOrEqual(2);
  });
});

/**
 * Reported by the author on 2026-10-06, in the editor and in the exported
 * file: at padding 0 in Auto, a hairline of background down both sides of
 * the video. The frame's sides are rounded to even pixels, so its shape is
 * a hair off the recording's; `contain` then leaves up to a pixel of slack
 * on one axis, the recording is drawn from a fractional edge, and the
 * background blends into the edge columns (H.264's chroma smears it wider).
 * The paint() above missed it: it fills the clip, not the recording, and its
 * probe counted any mostly-red pixel as recording.
 *
 * Through the real `renderFrame`: the recording is one solid colour, the
 * frame is painted over two backgrounds, and any pixel that differs between
 * the two is background showing.
 */
describe("the Auto frame at padding 0, through renderFrame", () => {
  const RECORDING = "#22aa55";

  function solidSource(viewport: { width: number; height: number }) {
    const width = viewport.width * 2;
    const height = viewport.height * 2;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.fillStyle = RECORDING;
    ctx.fillRect(0, 0, width, height);
    return {
      at: async (sourceTimeMs: number) => ({
        image: canvas,
        width,
        height,
        sourceTimeMs,
      }),
      describe: () => ({ keyframes: [], motionSpans: [] }),
    };
  }

  async function paint(
    viewport: { width: number; height: number },
    padding: number,
    background: string,
  ) {
    const bundle = { ...proceduralBundle(), viewport };
    const scene = readonlyScene();
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const target = autoTarget(LANDSCAPE_1080P, viewport, padding);
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const presentation = derivePresentation(
      { background: { kind: "solid", color: background }, logo: null, padding },
      target,
      viewport,
    );
    await renderFrame({
      resolved: {
        ...resolved,
        cameraKeys: [
          cameraKey({
            outputTimeMs: 0,
            center: { x: viewport.width / 2, y: viewport.height / 2 },
            scale: 1,
          }),
        ],
        cursorLook: { ...resolved.cursorLook, hidden: true },
        clickOutputMs: [],
      },
      target,
      presentation,
      frames: solidSource(viewport),
      ctx,
      outputTimeMs: 0,
    });
    return {
      pixels: ctx.getImageData(0, 0, target.width, target.height).data,
      target,
      presentation,
    };
  }

  /** Pixels that differ between two backgrounds, with where the first is. */
  async function backgroundShowing(
    viewport: { width: number; height: number },
    padding: number,
  ) {
    const warm = await paint(viewport, padding, "#db3b3b");
    const cool = await paint(viewport, padding, "#3b5bdb");
    let count = 0;
    let first = "";
    const { width } = warm.target;
    for (let i = 0; i < warm.pixels.length; i += 4) {
      if (
        warm.pixels[i] !== cool.pixels[i] ||
        warm.pixels[i + 1] !== cool.pixels[i + 1] ||
        warm.pixels[i + 2] !== cool.pixels[i + 2]
      ) {
        if (count === 0) {
          const p = i / 4;
          first = `${p % width},${Math.floor(p / width)}`;
        }
        count++;
      }
    }
    return { count, first, warm };
  }

  it.each([
    ["the sides", { width: 1512, height: 862 }],
    ["top and bottom", { width: 1512, height: 820 }],
  ])("shows no background along %s (%o)", async (_axis, viewport) => {
    const { count, first, warm } = await backgroundShowing(viewport, 0);
    // Premise: even rounding leaves a plain contain fit short of the frame
    // on this axis, so there is a sliver for the background to show through.
    const t = warm.target;
    const f = containRect(viewport, {
      x: 0,
      y: 0,
      width: t.width,
      height: t.height,
    });
    expect(
      Math.max(f.x, f.y),
      `contain fit ${JSON.stringify(f)} in ${t.width}x${t.height}`,
    ).toBeGreaterThan(0.2);
    expect(
      count,
      `${count} background pixels in ${warm.target.width}x${warm.target.height}, first at ${first}`,
    ).toBe(0);
  });

  // Premise: the two-background diff does see a margin when there is one.
  it("sees the margin at padding 0.08", async () => {
    const { count } = await backgroundShowing(
      { width: 1512, height: 862 },
      0.08,
    );
    expect(count).toBeGreaterThan(10_000);
  });
});
