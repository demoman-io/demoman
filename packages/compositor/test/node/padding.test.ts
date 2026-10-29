import { BRANDING_DEFAULTS, LOGO_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { derivePresentation, placeLogo } from "../../src/render/presentation";
import {
  GIF_800,
  GIF_VERTICAL_450,
  LANDSCAPE_4K,
  LANDSCAPE_1080P,
  LANDSCAPE_1440P,
  type RenderTarget,
  STILL_1440,
  STILL_VERTICAL_1080,
  VERTICAL_1080,
} from "../../src/render/target";

const VIEWPORT = { width: 1280, height: 800 };
const PRESETS: [string, RenderTarget][] = [
  ["LANDSCAPE_4K", LANDSCAPE_4K],
  ["LANDSCAPE_1440P", LANDSCAPE_1440P],
  ["LANDSCAPE_1080P", LANDSCAPE_1080P],
  ["VERTICAL_1080", VERTICAL_1080],
  ["GIF_800", GIF_800],
  ["GIF_VERTICAL_450", GIF_VERTICAL_450],
  ["STILL_1440", STILL_1440],
  ["STILL_VERTICAL_1080", STILL_VERTICAL_1080],
];

describe("the author's padding, in every format", () => {
  // The margin on the frame's tight axis is the padding exactly; the other
  // axis may carry more where the capture's shape is not the frame's
  // (`contain`). Red if any preset still draws its own inset.
  it.each(PRESETS)(
    "%s insets the frame by the branding's padding",
    (_n, target) => {
      for (const padding of [0.03, 0.12, 0.2]) {
        const { frameRect } = derivePresentation(
          { ...BRANDING_DEFAULTS, padding },
          target,
          VIEWPORT,
        );
        const short = Math.min(target.width, target.height);
        const margin = Math.min(frameRect.x, frameRect.y);
        expect(
          margin / short,
          `${target.width}x${target.height} at ${padding}`,
        ).toBeCloseTo(padding, 6);
      }
    },
  );

  it("squares the corners at 0 and keeps the target's radius above it", () => {
    const at = (padding: number) =>
      derivePresentation(
        { ...BRANDING_DEFAULTS, padding },
        LANDSCAPE_1080P,
        VIEWPORT,
      );
    // Premise: the preset has a radius to drop.
    expect(LANDSCAPE_1080P.cornerRadius).toBeGreaterThan(0);
    expect(at(0).cornerRadius).toBe(0);
    expect(at(0.01).cornerRadius).toBe(LANDSCAPE_1080P.cornerRadius);
    expect(at(0).padding).toBe(0);
  });

  // Spec §4: the logo keeps to the margin. The default mark (0.06) needs a
  // padding of 0.06 + 0.02; the default 0.12 (2026-10-28) clears it, and at
  // 0 a recording that fills the frame leaves no margin and nothing is
  // drawn. Red if the default padding drops below 0.08, or if a logo is
  // drawn over a full-screen recording.
  const image = {
    image: {} as never,
    width: 200,
    height: 100,
    sourceTimeMs: 0,
  };
  const branding = {
    ...BRANDING_DEFAULTS,
    logo: { ref: "logo:a", ...LOGO_DEFAULTS },
  };
  it("draws the default logo uncapped at the default padding, and no logo at 0", () => {
    // Premise: the default mark is the size the comment reasons about, and
    // the default padding has room for it.
    expect(LOGO_DEFAULTS.size).toBe(0.06);
    expect(BRANDING_DEFAULTS.padding).toBeGreaterThanOrEqual(0.08);
    for (const [target, viewport] of [
      [LANDSCAPE_1080P, { width: 1280, height: 720 }],
      [VERTICAL_1080, VIEWPORT],
    ] as const) {
      const name = `${target.width}x${target.height}`;
      const roomy = derivePresentation(branding, target, viewport, image);
      expect(roomy.logoPlacement?.capped, name).toBe(false);
      expect(roomy.logo, name).not.toBeNull();
      const full = derivePresentation(
        { ...branding, padding: 0 },
        target,
        viewport,
        image,
      );
      // Premise: the recording really fills the frame here.
      expect(full.frameRect, name).toEqual({
        x: 0,
        y: 0,
        width: target.width,
        height: target.height,
      });
      expect(full.logo, name).toBeNull();
      expect(full.logoPlacement, name).toMatchObject({
        effectiveSize: 0,
        capped: true,
      });
    }
  });

  // Padding 0 is full screen, and full screen draws no logo, even where a
  // capture of another shape (16:10 in 16:9) leaves bars a mark would fit
  // in (the author's call, 2026-10-06). The placement reports no room, so the
  // panel says "No room for the logo…". Red if padding 0 lets the logo into a
  // side bar again.
  it("at 0, draws no logo even in the side bars a capture of another shape leaves", () => {
    const full = derivePresentation(
      { ...branding, padding: 0 },
      LANDSCAPE_1080P,
      VIEWPORT,
      image,
    );
    // Premise: there are bars, and a bar has room for the mark — so what
    // keeps the logo out is padding 0, not a lack of room.
    expect(full.frameRect.x).toBeGreaterThan(0);
    const inBar = placeLogo(
      branding.logo,
      image.width / image.height,
      LANDSCAPE_1080P,
      full.frameRect,
    );
    expect(inBar.effectiveSize).toBeGreaterThanOrEqual(0.02);
    expect(full.logo).toBeNull();
    expect(full.logoPlacement).toMatchObject({
      effectiveSize: 0,
      capped: true,
    });
  });
});
