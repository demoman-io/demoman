import { describe, expect, it } from "vitest";
import {
  autoTarget,
  GIF_800,
  GIF_VERTICAL_450,
  LANDSCAPE_4K,
  LANDSCAPE_1080P,
  LANDSCAPE_1440P,
  landscapeFrame,
  pickAutoTier,
  pickLandscapeTarget,
  pickMp4Tier,
  STILL_VERTICAL_1080,
  VERTICAL_1080,
} from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";

describe("render targets", () => {
  it("uses a 60 fps fixed timeline for video", () => {
    expect(LANDSCAPE_1080P.fps).toBe(60);
    expect(LANDSCAPE_4K.fps).toBe(60);
    expect(VERTICAL_1080.fps).toBe(60);
  });

  it("keeps the GIF cheap enough to embed", () => {
    expect(GIF_800.fps).toBe(15);
    expect(GIF_800.width).toBeLessThanOrEqual(800);
  });

  it("makes the vertical target taller than it is wide", () => {
    expect(VERTICAL_1080.height).toBeGreaterThan(VERTICAL_1080.width);
    expect(VERTICAL_1080.width / VERTICAL_1080.height).toBeCloseTo(9 / 16, 3);
  });
});

describe("pickLandscapeTarget", () => {
  // Never claim a resolution the keyframes cannot back. Upscaling a whole
  // deliverable to hit a number on a spec sheet is exactly the shortcut a
  // side-by-side comparison punishes.
  it("chooses 4K when the keyframes are DPR-3", () => {
    expect(pickLandscapeTarget(proceduralBundle())).toBe(LANDSCAPE_4K);
  });

  it("steps down when the keyframes are smaller", () => {
    const bundle = proceduralBundle({
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 0,
          ref: "k",
          width: 2560,
          height: 1600,
          actionId: null,
        },
      ],
    });
    expect(pickLandscapeTarget(bundle)).toBe(LANDSCAPE_1440P);
  });

  it("falls back to 1080p for a DPR-1 capture", () => {
    const bundle = proceduralBundle({
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 0,
          ref: "k",
          width: 1280,
          height: 800,
          actionId: null,
        },
      ],
    });
    expect(pickLandscapeTarget(bundle)).toBe(LANDSCAPE_1080P);
  });
});

describe("pickAutoTier", () => {
  const withKeyframe = (width: number, height: number) =>
    proceduralBundle({
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 0,
          ref: "k",
          width,
          height,
          actionId: null,
        },
      ],
    });

  // Review 2026-10-06: an Auto frame takes the tier's long side, so a
  // portrait recording's keyframes back it along their height. Red if the
  // tier is measured by width (the premise: by width this is 1440).
  it("measures a portrait recording along its keyframes' long side", () => {
    const portrait = withKeyframe(2700, 4200);
    expect(pickLandscapeTarget(portrait)).toBe(LANDSCAPE_1440P);
    expect(pickAutoTier(portrait)).toBe(LANDSCAPE_4K);
    expect(pickAutoTier(withKeyframe(1800, 2800))).toBe(LANDSCAPE_1440P);
    expect(pickAutoTier(withKeyframe(900, 1400))).toBe(LANDSCAPE_1080P);
  });

  it("agrees with pickLandscapeTarget on landscape keyframes", () => {
    const sizes: Array<[number, number]> = [
      [3840, 2400],
      [2560, 1600],
      [1280, 800],
    ];
    for (const [w, h] of sizes) {
      const bundle = withKeyframe(w, h);
      expect(pickAutoTier(bundle)).toBe(pickLandscapeTarget(bundle));
    }
  });
});

describe("landscapeFrame", () => {
  const recording = { width: 1512, height: 820 };

  // Review 2026-10-06: "Auto reshapes the tier, else the tier" was written
  // out in targetFor, the film check and the runner. Red if Auto stops
  // reshaping, or a fixed shape starts.
  it("reshapes the tier for Auto and leaves it for 16:9 and 9:16", () => {
    expect(landscapeFrame("auto", LANDSCAPE_1080P, recording, 0.08)).toEqual(
      autoTarget(LANDSCAPE_1080P, recording, 0.08),
    );
    expect(landscapeFrame("16:9", LANDSCAPE_1080P, recording, 0.08)).toBe(
      LANDSCAPE_1080P,
    );
    // A 9:16 demo's landscape frame is 16:9's (the film check measures it
    // so; the runner renders it so).
    expect(landscapeFrame("9:16", LANDSCAPE_1080P, recording, 0.08)).toBe(
      LANDSCAPE_1080P,
    );
  });
});

describe("pickMp4Tier", () => {
  const portrait = proceduralBundle({
    keyframes: [
      {
        byteLength: 0,
        sourceTimeMs: 0,
        ref: "k",
        width: 2700,
        height: 4200,
        actionId: null,
      },
    ],
  });

  it("measures Auto along the keyframes' long side and a fixed shape by width", () => {
    expect(pickMp4Tier(portrait, "auto")).toBe(pickAutoTier(portrait));
    expect(pickMp4Tier(portrait, "16:9")).toBe(pickLandscapeTarget(portrait));
    // Premise: the two measures disagree on this bundle.
    expect(pickAutoTier(portrait)).not.toBe(pickLandscapeTarget(portrait));
  });
});

describe("portrait GIF and stills", () => {
  it("are the landscape presets turned on end, cropped like the vertical cut", () => {
    expect([GIF_VERTICAL_450.width, GIF_VERTICAL_450.height]).toEqual([
      450, 800,
    ]);
    expect(GIF_VERTICAL_450.format).toBe("gif");
    expect(GIF_VERTICAL_450.fps).toBe(GIF_800.fps);
    expect([STILL_VERTICAL_1080.width, STILL_VERTICAL_1080.height]).toEqual([
      1080, 1920,
    ]);
    expect(STILL_VERTICAL_1080.format).toBe("png");
    // `cameraIntentsForTarget` keys the vertical camera cap on `fit`, so a
    // portrait target that letterboxed would ship the landscape zoom on top
    // of the crop — the compounding VERTICAL_1080's docblock describes.
    expect(GIF_VERTICAL_450.fit).toBe("cover");
    expect(STILL_VERTICAL_1080.fit).toBe("cover");
  });
});
