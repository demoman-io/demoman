import { BRANDING_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { containRect } from "../../src/geometry";
import { derivePresentation } from "../../src/render/presentation";
import {
  autoTarget,
  fitH264Frame,
  GIF_800,
  LANDSCAPE_4K,
  LANDSCAPE_1080P,
  LANDSCAPE_1440P,
  STILL_1440,
} from "../../src/render/target";

const MACBOOK_TAB = { width: 1512, height: 820 };
const SIXTEEN_TEN = { width: 1280, height: 800 };
const NARROW = { width: 1000, height: 1200 };

describe("autoTarget", () => {
  // Spec 2026-10-06 §2's table. Red if the long side is not the tier's
  // (the NARROW rows), or if the margin is solved against the wrong side.
  it.each([
    [MACBOOK_TAB, 0, 1920, 1042],
    [MACBOOK_TAB, 0.08, 1920, 1124],
    [MACBOOK_TAB, 0.2, 1920, 1274],
    [SIXTEEN_TEN, 0, 1920, 1200],
    [SIXTEEN_TEN, 0.08, 1920, 1276],
    [SIXTEEN_TEN, 0.2, 1920, 1412],
    [NARROW, 0, 1600, 1920],
    [NARROW, 0.08, 1644, 1920],
    [NARROW, 0.2, 1714, 1920],
  ])("sizes %o at padding %s as %i x %i", (viewport, padding, w, h) => {
    const t = autoTarget(LANDSCAPE_1080P, viewport, padding);
    expect([t.width, t.height]).toEqual([w, h]);
    expect(t.fit).toBe("contain");
  });

  it("takes the long side from the tier, for every format", () => {
    expect(autoTarget(LANDSCAPE_4K, MACBOOK_TAB, 0)).toMatchObject({
      width: 3840,
      height: 2082,
    });
    expect(autoTarget(LANDSCAPE_1440P, MACBOOK_TAB, 0.08)).toMatchObject({
      width: 2560,
      height: 1498,
    });
    expect(autoTarget(GIF_800, SIXTEEN_TEN, 0.08)).toMatchObject({
      width: 800,
      height: 532,
    });
    expect(autoTarget(STILL_1440, SIXTEEN_TEN, 0.08)).toMatchObject({
      width: 2560,
      height: 1702,
    });
  });

  // Final review, Critical (2026-10-06): the formula alone gives 3840x2554,
  // 3840x3840 and 3288x3840 here — over H.264 level 5.2's 36,864
  // macroblocks, which the encoder refuses. Scaled down whole, the shape and
  // the even margin survive. Red if the MP4 ceiling is dropped, or applied
  // to the tiers below 4K (the spec's 1080 table above stays exact).
  it.each([
    [SIXTEEN_TEN, 0.08, 3754, 2496],
    [{ width: 1000, height: 1000 }, 0, 3072, 3072],
    [NARROW, 0.08, 2836, 3312],
    [MACBOOK_TAB, 0.08, 3840, 2248],
  ])(
    "holds a 4K Auto MP4 of %o at %s to %i x %i",
    (viewport, padding, w, h) => {
      const t = autoTarget(LANDSCAPE_4K, viewport, padding);
      expect([t.width, t.height]).toEqual([w, h]);
      expect(Math.ceil(w / 16) * Math.ceil(h / 16)).toBeLessThanOrEqual(36_864);
      const { frameRect: f } = derivePresentation(
        { ...BRANDING_DEFAULTS, padding },
        t,
        viewport,
      );
      const margins = [
        f.x,
        f.y,
        t.width - f.x - f.width,
        t.height - f.y - f.height,
      ];
      expect(
        Math.max(...margins) - Math.min(...margins),
        JSON.stringify(margins),
      ).toBeLessThanOrEqual(1);
    },
  );

  it("leaves GIF and stills at the formula's size, which no encoder limits", () => {
    expect(
      autoTarget(STILL_1440, { width: 1000, height: 1000 }, 0),
    ).toMatchObject({ width: 2560, height: 2560 });
  });

  // Reported 2026-10-06: at padding 0 a hairline of background ran down
  // both sides, because even rounding leaves the frame a hair off the
  // recording's shape and a plain contain fit fell short of it. Every Auto
  // frame must hand the recording its whole box, exactly, on every tier,
  // padding and window shape. Red if derivePresentation stops snapping a
  // near-exact fit to its box.
  it("gives the recording its whole box, exactly, for every window", () => {
    let snappedFrames = 0;
    let shortOfBox = 0;
    for (const tier of [
      LANDSCAPE_1080P,
      LANDSCAPE_1440P,
      LANDSCAPE_4K,
      GIF_800,
      STILL_1440,
    ]) {
      for (const padding of [0, 0.08, 0.2]) {
        for (let w = 400; w <= 4000; w += 37) {
          for (let h = 300; h <= 2400; h += 41) {
            const viewport = { width: w, height: h };
            const t = autoTarget(tier, viewport, padding);
            const pad = Math.min(t.width, t.height) * padding;
            const { frameRect: f } = derivePresentation(
              { ...BRANDING_DEFAULTS, padding },
              t,
              viewport,
            );
            const exact =
              f.x === pad &&
              f.y === pad &&
              f.width === t.width - 2 * pad &&
              f.height === t.height - 2 * pad;
            if (!exact) {
              throw new Error(
                `${w}x${h} at ${padding} on ${tier.width}: frame ${JSON.stringify(f)} in ${t.width}x${t.height}`,
              );
            }
            snappedFrames++;
            const fit = containRect(viewport, {
              x: pad,
              y: pad,
              width: t.width - 2 * pad,
              height: t.height - 2 * pad,
            });
            if (fit.x - pad > 0.01 || fit.y - pad > 0.01) shortOfBox++;
          }
        }
      }
    }
    // Premise: the sweep is large, and in most of it a plain contain fit
    // really does fall short of the box — the case the snap exists for.
    expect(snappedFrames).toBeGreaterThan(10_000);
    expect(shortOfBox).toBeGreaterThan(snappedFrames / 2);
  });

  // Review Focus 3: an ultrawide strip still gives even, positive sides.
  it("keeps an ultrawide strip even and positive", () => {
    const t = autoTarget(LANDSCAPE_1080P, { width: 4000, height: 600 }, 0.08);
    expect([t.width, t.height]).toEqual([1920, 334]);
  });

  it("scales the bitrate with the area, keeping the tier's radius and fps", () => {
    const t = autoTarget(LANDSCAPE_1080P, SIXTEEN_TEN, 0);
    // 10 Mb/s at 1920x1080, so 1920x1200 is 10 x 1200/1080.
    expect(t.bitrate).toBe(11_111_111);
    expect(t.cornerRadius).toBe(LANDSCAPE_1080P.cornerRadius);
    expect(t.fps).toBe(LANDSCAPE_1080P.fps);
    expect(autoTarget(GIF_800, SIXTEEN_TEN, 0).bitrate).toBe(0);
  });

  // The point of the shape: the inset derivePresentation draws is the same
  // on all four sides. Red if the frame is the recording's exact shape
  // (spec approach B), which leaves the sides wider.
  it.each([0, 0.08, 0.2])("draws an even margin at padding %s", (padding) => {
    for (const viewport of [MACBOOK_TAB, SIXTEEN_TEN, NARROW]) {
      const t = autoTarget(LANDSCAPE_1080P, viewport, padding);
      const { frameRect: f } = derivePresentation(
        { ...BRANDING_DEFAULTS, padding },
        t,
        viewport,
      );
      const margins = [
        f.x,
        f.y,
        t.width - f.x - f.width,
        t.height - f.y - f.height,
      ];
      expect(
        Math.max(...margins) - Math.min(...margins),
        JSON.stringify(margins),
      ).toBeLessThanOrEqual(1);
    }
  });
});

describe("fitH264Frame", () => {
  const macroblocks = (w: number, h: number) =>
    Math.ceil(w / 16) * Math.ceil(h / 16);

  it("leaves a frame the encoder takes as it is", () => {
    expect(fitH264Frame(3420, 2214)).toEqual({ width: 3420, height: 2214 });
  });

  // The span Excalidraw and Actual lost on 2026-10-21: a 1710x1107 window
  // screencast at REPLAY_DPR 3.
  it("scales a 5130x3320 span down whole, to even sides, under level 5.2", () => {
    expect(macroblocks(5130, 3320)).toBeGreaterThan(36_864);
    const fit = fitH264Frame(5130, 3320);
    expect(macroblocks(fit.width, fit.height)).toBeLessThanOrEqual(36_864);
    expect((fit.width % 2) + (fit.height % 2)).toBe(0);
    expect(fit.width / fit.height).toBeCloseTo(5130 / 3320, 2);
    // As large as fits: one more step of 16 on the long side would not.
    expect(macroblocks(fit.width + 16, fit.height + 10)).toBeGreaterThan(
      36_864,
    );
  });
});
