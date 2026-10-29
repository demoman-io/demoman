import { BRANDING_DEFAULTS, type SceneBackground } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import type { FrameImage } from "../../src/ports/types";
import {
  clipToFrame,
  derivePresentation,
  drawBackground,
  drawFrameChrome,
  drawLogo,
} from "../../src/render/presentation";
import { LANDSCAPE_1080P, VERTICAL_1080 } from "../../src/render/target";

const VIEWPORT = { width: 1280, height: 800 };
const SOLID_NAVY: SceneBackground = { kind: "solid", color: "#1b2a4a" };
/** Light enough that the frame's shadow darkens it measurably. */
const SOLID_PALE: SceneBackground = { kind: "solid", color: "#eceff2" };
const grad = (angle: number): SceneBackground => ({
  kind: "gradient",
  from: "#000000",
  to: "#ffffff",
  angle,
});

function paint(
  background: SceneBackground,
  {
    chrome = true,
    padding = BRANDING_DEFAULTS.padding,
    viewport = VIEWPORT,
  }: {
    chrome?: boolean;
    padding?: number;
    viewport?: { width: number; height: number };
  } = {},
) {
  const canvas = new OffscreenCanvas(
    LANDSCAPE_1080P.width,
    LANDSCAPE_1080P.height,
  );
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const presentation = derivePresentation(
    { background, logo: null, padding },
    LANDSCAPE_1080P,
    viewport,
  );
  drawBackground(ctx, LANDSCAPE_1080P, presentation);
  if (chrome) drawFrameChrome(ctx, presentation, 1);
  ctx.save();
  clipToFrame(ctx, presentation);
  ctx.fillStyle = "#ff0000";
  ctx.fillRect(0, 0, LANDSCAPE_1080P.width, LANDSCAPE_1080P.height);
  ctx.restore();
  return { ctx, presentation };
}

function at(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number) {
  const [r, g, b, a] = ctx.getImageData(
    Math.round(x),
    Math.round(y),
    1,
    1,
  ).data;
  return { r: r as number, g: g as number, b: b as number, a: a as number };
}

async function solidLogo(width: number, height: number): Promise<FrameImage> {
  const c = new OffscreenCanvas(width, height);
  const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  g.fillStyle = "#e03131";
  g.fillRect(0, 0, width, height);
  const image = await createImageBitmap(c);
  return { image, width, height, sourceTimeMs: 0 };
}

describe("presentation", () => {
  it("insets the app frame from every edge", () => {
    const { presentation } = paint(SOLID_NAVY);
    const { frameRect } = presentation;
    expect(frameRect.x).toBeGreaterThan(0);
    expect(frameRect.y).toBeGreaterThan(0);
    expect(frameRect.x + frameRect.width).toBeLessThan(LANDSCAPE_1080P.width);
    expect(frameRect.y + frameRect.height).toBeLessThan(LANDSCAPE_1080P.height);
  });

  it("keeps the app frame at the capture aspect so nothing is stretched", () => {
    const { presentation } = paint(SOLID_NAVY);
    expect(
      presentation.frameRect.width / presentation.frameRect.height,
    ).toBeCloseTo(VIEWPORT.width / VIEWPORT.height, 3);
  });

  it("paints an opaque background everywhere outside the frame", () => {
    const { ctx } = paint(SOLID_NAVY);
    expect(at(ctx, 8, 8).a).toBe(255);
    expect(
      at(ctx, LANDSCAPE_1080P.width - 8, LANDSCAPE_1080P.height - 8).a,
    ).toBe(255);
  });

  it("paints a solid background in exactly the stored colour", () => {
    const { ctx } = paint(SOLID_NAVY);
    expect(at(ctx, 8, 8)).toEqual({ r: 0x1b, g: 0x2a, b: 0x4a, a: 255 });
    expect(
      at(ctx, LANDSCAPE_1080P.width - 8, LANDSCAPE_1080P.height - 8),
    ).toEqual({
      r: 0x1b,
      g: 0x2a,
      b: 0x4a,
      a: 255,
    });
  });

  it.each([
    // [angle, dark end, light end] — sampled in the margin, outside the frame.
    [
      180,
      [LANDSCAPE_1080P.width / 2, 4],
      [LANDSCAPE_1080P.width / 2, LANDSCAPE_1080P.height - 4],
    ],
    [
      0,
      [LANDSCAPE_1080P.width / 2, LANDSCAPE_1080P.height - 4],
      [LANDSCAPE_1080P.width / 2, 4],
    ],
    [
      90,
      [4, LANDSCAPE_1080P.height / 2],
      [LANDSCAPE_1080P.width - 4, LANDSCAPE_1080P.height / 2],
    ],
  ] as const)(
    "runs a %i° gradient from its first stop to its second",
    (angle, darkAt, lightAt) => {
      const { ctx } = paint(grad(angle));
      const dark = at(ctx, darkAt[0], darkAt[1]);
      const light = at(ctx, lightAt[0], lightAt[1]);
      // Premise: the stops differ, or a flat fill would pass "dark < light"
      // vacuously as equal-and-not-less. Asserted on the painted ends.
      expect(light.r - dark.r, JSON.stringify({ dark, light })).toBeGreaterThan(
        200,
      );
    },
  );

  it("puts a gradient's stops on the corners, as CSS does", () => {
    const { ctx } = paint(grad(135));
    const topLeft = at(ctx, 0, 0);
    const bottomRight = at(
      ctx,
      LANDSCAPE_1080P.width - 1,
      LANDSCAPE_1080P.height - 1,
    );
    expect(topLeft.r).toBeLessThanOrEqual(2);
    expect(bottomRight.r).toBeGreaterThanOrEqual(253);
  });

  /**
   * Spec §1: a migrated v5 demo keeps its look. The reference is the retired
   * v5 derivation, frozen here as the fixture — the painter no longer has it.
   */
  it("paints a migrated v5 tint close to what v5 painted", () => {
    const w = LANDSCAPE_1080P.width;
    const h = LANDSCAPE_1080P.height;
    const old = new OffscreenCanvas(w, h).getContext(
      "2d",
    ) as OffscreenCanvasRenderingContext2D;
    // v5, for #3B5BDB: oklchCss of the derived stops, along (0,0) -> (0.35w, h).
    const v5 = old.createLinearGradient(0, 0, w * 0.35, h);
    v5.addColorStop(0, "oklch(0.94 0.06 268.038)");
    v5.addColorStop(1, "oklch(0.82 0.1 268.038)");
    old.fillStyle = v5;
    old.fillRect(0, 0, w, h);

    const { ctx } = paint({
      kind: "gradient",
      from: "#daebff",
      to: "#a8c2ff",
      angle: 150,
    });
    const points: [number, number][] = [
      [8, 8],
      [w / 2, 8],
      [w - 8, 8],
      [8, h / 2],
      [w - 8, h / 2],
      [8, h - 8],
      [w / 2, h - 8],
    ];
    const diffs = points.map(([x, y]) => {
      const a = at(old, x, y);
      const b = at(ctx, x, y);
      return Math.max(
        Math.abs(a.r - b.r),
        Math.abs(a.g - b.g),
        Math.abs(a.b - b.b),
      );
    });
    // Measured 2026-09-22: 0, 8, 14, 6, 12, 12, 12 — max 14, at the top-right
    // corner. The stops match exactly (the migration clips as Chrome did);
    // what remains is geometry: v5's vector ran (0,0) -> (0.35w, h) and
    // saturated before the far corner, where a CSS 150-degree line spans
    // corner to corner.
    //
    // Premise: the two stops are distinguishable, so "close" means something.
    const top = at(ctx, w / 2, 8);
    const bottom = at(ctx, w / 2, h - 8);
    expect(top.b - bottom.b + (top.r - bottom.r)).not.toBe(0);
    expect(
      Math.max(...diffs),
      `per-point max channel diff: ${diffs.join(", ")}`,
    ).toBeLessThanOrEqual(16);
  });

  it.each(["top-left", "top-right", "bottom-left", "bottom-right"] as const)(
    "draws the logo in the %s corner at its opacity",
    async (corner) => {
      const image = await solidLogo(200, 100);
      const canvas = new OffscreenCanvas(
        LANDSCAPE_1080P.width,
        LANDSCAPE_1080P.height,
      );
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      const presentation = derivePresentation(
        {
          background: { kind: "solid", color: "#ffffff" },
          logo: { ref: "logo:a", corner, size: 0.06, opacity: 1 },
          padding: 0.08,
        },
        LANDSCAPE_1080P,
        VIEWPORT,
        image,
      );
      drawBackground(ctx, LANDSCAPE_1080P, presentation);
      drawLogo(ctx, LANDSCAPE_1080P, presentation);
      const rect = presentation.logo?.rect;
      expect(rect, "the logo was placed").toBeDefined();
      const r = rect as NonNullable<typeof rect>;
      expect(at(ctx, r.x + r.width / 2, r.y + r.height / 2)).toEqual({
        r: 0xe0,
        g: 0x31,
        b: 0x31,
        a: 255,
      });
      // Outside the rect, one margin's width away: background, not logo.
      expect(
        at(
          ctx,
          r.x + r.width / 2,
          corner.startsWith("top") ? r.y + r.height + 6 : r.y - 6,
        ),
      ).toEqual({
        r: 255,
        g: 255,
        b: 255,
        a: 255,
      });
    },
  );

  it("draws a half-opacity logo half way to the background", async () => {
    const image = await solidLogo(200, 100);
    const canvas = new OffscreenCanvas(
      LANDSCAPE_1080P.width,
      LANDSCAPE_1080P.height,
    );
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const presentation = derivePresentation(
      {
        background: { kind: "solid", color: "#ffffff" },
        logo: { ref: "logo:a", corner: "top-left", size: 0.06, opacity: 0.5 },
        padding: 0.08,
      },
      LANDSCAPE_1080P,
      VIEWPORT,
      image,
    );
    drawBackground(ctx, LANDSCAPE_1080P, presentation);
    drawLogo(ctx, LANDSCAPE_1080P, presentation);
    const r = presentation.logo?.rect as NonNullable<
      NonNullable<typeof presentation.logo>["rect"]
    >;
    const px = at(ctx, r.x + r.width / 2, r.y + r.height / 2);
    expect(px.g).toBeGreaterThan(0x31 + 40);
    expect(px.g).toBeLessThan(255 - 40);
  });

  it("clips content to rounded corners", () => {
    const { ctx, presentation } = paint(SOLID_NAVY);
    const { frameRect, cornerRadius } = presentation;
    // Just inside the frame's bounding box but outside its rounded corner:
    // the background is light (l=0.94) and the gradient runs diagonally, so
    // this pixel is not reliably "dark" — what it must never be is the red
    // content fill, which proves the corner is actually clipped.
    const corner = at(ctx, frameRect.x + 2, frameRect.y + 2);
    expect([corner.r, corner.g, corner.b]).not.toEqual([255, 0, 0]);
    // Well inside the frame: content.
    const inside = at(
      ctx,
      frameRect.x + cornerRadius + 20,
      frameRect.y + cornerRadius + 20,
    );
    expect(inside).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("casts a shadow just outside the frame edge", () => {
    // The background gradient itself darkens toward the bottom, so comparing
    // a pixel below the frame against one near the bottom edge would test
    // the gradient, not the shadow. Instead render the identical scene at
    // the identical coordinate with and without drawFrameChrome and compare.
    const withChrome = paint(SOLID_PALE);
    const withoutChrome = paint(SOLID_PALE, { chrome: false });
    const { frameRect } = withChrome.presentation;
    const x = frameRect.x + frameRect.width / 2;
    const y = frameRect.y + frameRect.height + 6;
    const luma = (p: { r: number; g: number; b: number }) => p.r + p.g + p.b;
    expect(luma(at(withChrome.ctx, x, y))).toBeLessThan(
      luma(at(withoutChrome.ctx, x, y)),
    );
  });
});

describe("padding", () => {
  const isFrame = (p: { r: number; g: number; b: number }) =>
    p.r > 200 && p.g < 60 && p.b < 60;
  const luma = (p: { r: number; g: number; b: number }) => p.r + p.g + p.b;

  it.each([
    [0.08, 86.4],
    [0.2, 216],
  ])(
    "insets the frame by %s of the short side (%s px at 1080p)",
    (padding, px) => {
      const { ctx, presentation } = paint(SOLID_NAVY, { padding });
      // The capture is 16:10 in a 16:9 frame, so the top is the tight axis.
      expect(presentation.frameRect.y).toBeCloseTo(px, 6);
      const x = LANDSCAPE_1080P.width / 2;
      expect(isFrame(at(ctx, x, px - 4)), "4px above the inset").toBe(false);
      expect(isFrame(at(ctx, x, px + 4)), "4px below the inset").toBe(true);
    },
  );

  // A capture the frame's own shape fills it: every edge is the recording,
  // and the corners are square. Red if the radius survives at 0.
  it("fills the whole frame at 0 when the capture has the frame's shape", () => {
    const { ctx } = paint(SOLID_NAVY, {
      padding: 0,
      viewport: { width: 1280, height: 720 },
    });
    const { width: w, height: h } = LANDSCAPE_1080P;
    for (const [x, y] of [
      [0, 0],
      [w - 1, 0],
      [0, h - 1],
      [w - 1, h - 1],
      [w / 2, 0],
      [0, h / 2],
    ] as const) {
      expect(isFrame(at(ctx, x, y)), `${x},${y}`).toBe(true);
    }
  });

  // Review Focus 4. A 16:10 capture in a 16:9 frame at 0: the recording
  // reaches top and bottom with square corners, the sides stay background
  // (that is the "Auto" frame shape's job, out of scope), and no shadow
  // darkens them. Red if the shadow passes still run at 0.
  it("at 0 with another shape, keeps the side bars clean and the corners square", () => {
    const plain = paint(SOLID_NAVY, { padding: 0, chrome: false });
    const dressed = paint(SOLID_NAVY, { padding: 0, chrome: true });
    const { frameRect } = dressed.presentation;
    // Premise: there are bars to look at.
    expect(frameRect.y).toBe(0);
    expect(frameRect.x).toBeGreaterThan(40);
    expect(
      isFrame(at(dressed.ctx, frameRect.x + 1, 0)),
      "square top-left",
    ).toBe(true);
    expect(
      isFrame(at(dressed.ctx, frameRect.x / 2, LANDSCAPE_1080P.height / 2)),
    ).toBe(false);
    for (const dx of [2, 10, 30]) {
      const x = frameRect.x - dx;
      const y = LANDSCAPE_1080P.height / 2;
      expect(
        luma(at(dressed.ctx, x, y)),
        `${dx}px left of the frame`,
      ).toBeCloseTo(luma(at(plain.ctx, x, y)), 0);
    }
  });
});

// The defect this guards: a 9:16 target was fitted to the *capture's* 16:10
// aspect, so the app landed in a 994x621 band with roughly two thirds of the
// canvas as empty gradient. The human was shown follow-crop against
// fit-and-letterbox during brainstorming and chose the crop, on the grounds
// that a letterboxed 9:16 leaves the UI too small to read on a phone — which
// is the entire point of the format. Shipping the letterbox would have
// silently delivered the option that was declined.
describe("fit", () => {
  const padded = (target: typeof VERTICAL_1080) => {
    const pad =
      Math.min(target.width, target.height) * BRANDING_DEFAULTS.padding;
    return {
      width: target.width - pad * 2,
      height: target.height - pad * 2,
    };
  };

  it("gives a cover target the whole padded box, at the target's own aspect", () => {
    const { frameRect } = derivePresentation(
      BRANDING_DEFAULTS,
      VERTICAL_1080,
      VIEWPORT,
    );
    const box = padded(VERTICAL_1080);
    expect(frameRect.width).toBeCloseTo(box.width, 6);
    expect(frameRect.height).toBeCloseTo(box.height, 6);
    // Not exactly the target's aspect — a uniform pad takes the same absolute
    // margin off both dimensions — but it is the padded box's, which is the
    // target's shape, and nowhere near the capture's 1.6.
    const aspect = frameRect.width / frameRect.height;
    expect(aspect).toBeCloseTo(box.width / box.height, 6);
    expect(aspect).toBeLessThan(1);
  });

  it("fills the canvas with the app rather than leaving it mostly background", () => {
    const { frameRect } = derivePresentation(
      BRANDING_DEFAULTS,
      VERTICAL_1080,
      VIEWPORT,
    );
    const covered =
      (frameRect.width * frameRect.height) /
      (VERTICAL_1080.width * VERTICAL_1080.height);
    // Letterboxed into the capture's aspect this was 0.30. The padding alone
    // accounts for the rest (0.88 at a 0.04 inset, 0.76 at 0.08, 0.66 at the
    // default 0.12), so the app fills the padded box, all of it.
    const box = padded(VERTICAL_1080);
    const boxShare =
      (box.width * box.height) / (VERTICAL_1080.width * VERTICAL_1080.height);
    // Premise: the padded box is most of the canvas, far from 0.30.
    expect(boxShare).toBeGreaterThan(0.6);
    expect(covered).toBeGreaterThan(boxShare * 0.99);
  });

  it("still fits a contain target to the capture's aspect", () => {
    const { frameRect } = derivePresentation(
      BRANDING_DEFAULTS,
      LANDSCAPE_1080P,
      VIEWPORT,
    );
    expect(frameRect.width / frameRect.height).toBeCloseTo(
      VIEWPORT.width / VIEWPORT.height,
      6,
    );
    const box = padded(LANDSCAPE_1080P);
    // Height-limited: it uses the box's full height and less than its width.
    expect(frameRect.height).toBeCloseTo(box.height, 6);
    expect(frameRect.width).toBeLessThan(box.width);
  });
});
