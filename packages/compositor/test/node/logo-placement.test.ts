import { BRANDING_DEFAULTS, LOGO_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { derivePresentation, placeLogo } from "../../src/render/presentation";
import {
  GIF_800,
  LANDSCAPE_1080P,
  VERTICAL_1080,
} from "../../src/render/target";

const VIEWPORT = { width: 1280, height: 800 };
const frameOf = (target: typeof LANDSCAPE_1080P) =>
  derivePresentation(
    {
      background: { kind: "solid", color: "#000000" },
      logo: null,
      padding: 0.08,
    },
    target,
    VIEWPORT,
  ).frameRect;
const logo = (
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right",
  size = 0.06,
) => ({ ref: "logo:a", corner, size, opacity: 0.9 });

/** Overlap of more than a millionth of a pixel. A band that exactly holds
 *  the logo (Vertical's, at the upload default) touches the frame, and float
 *  arithmetic puts that edge a few 1e-13 px either side. */
const EDGE = 1e-6;
const intersects = (
  a: { x: number; y: number; width: number; height: number },
  b: typeof a,
) =>
  a.x < b.x + b.width - EDGE &&
  b.x < a.x + a.width - EDGE &&
  a.y < b.y + b.height - EDGE &&
  b.y < a.y + a.height - EDGE;

describe("placeLogo", () => {
  const frame = frameOf(LANDSCAPE_1080P);
  const short = Math.min(LANDSCAPE_1080P.width, LANDSCAPE_1080P.height);
  const margin = short * 0.02;

  it.each([
    ["top-left", (r: { x: number; y: number }) => [r.x, r.y], [margin, margin]],
    [
      "bottom-right",
      (r: { x: number; y: number; width: number; height: number }) => [
        r.x + r.width,
        r.y + r.height,
      ],
      [LANDSCAPE_1080P.width - margin, LANDSCAPE_1080P.height - margin],
    ],
  ] as const)("anchors a %s logo at the margin", (corner, point, expected) => {
    const placed = placeLogo(logo(corner), 2, LANDSCAPE_1080P, frame);
    const [x, y] = point(placed.rect);
    expect(x).toBeCloseTo(expected[0], 6);
    expect(y).toBeCloseTo(expected[1], 6);
  });

  it("draws at the authored size when it fits, in every corner", () => {
    for (const corner of [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ] as const) {
      const placed = placeLogo(logo(corner, 0.06), 2, LANDSCAPE_1080P, frame);
      expect(placed).toMatchObject({ effectiveSize: 0.06, capped: false });
      expect(placed.rect.height).toBeCloseTo(0.06 * short, 6);
      expect(placed.rect.width).toBeCloseTo(0.12 * short, 6);
      expect(intersects(placed.rect, frame), corner).toBe(false);
    }
  });

  it("caps a logo that would reach the recording, and says so", () => {
    const placed = placeLogo(
      logo("bottom-right", 0.2),
      2,
      LANDSCAPE_1080P,
      frame,
    );
    expect(placed.capped).toBe(true);
    expect(placed.effectiveSize).toBeLessThan(0.2);
    expect(placed.effectiveSize).toBeGreaterThan(0.02);
    expect(intersects(placed.rect, frame)).toBe(false);
  });

  it("draws the upload default at full size in vertical, and caps anything larger", () => {
    // The default 8% padding is the smallest whose band holds the upload
    // default exactly. Premise, asserted so a change to either constant
    // re-reads this: the band is 0.06 of the short side.
    const f = frameOf(VERTICAL_1080);
    const s = Math.min(VERTICAL_1080.width, VERTICAL_1080.height);
    expect((f.y - s * 0.02) / s).toBeCloseTo(LOGO_DEFAULTS.size, 9);
    const fits = placeLogo(
      logo("bottom-right", LOGO_DEFAULTS.size),
      2,
      VERTICAL_1080,
      f,
    );
    expect(fits).toMatchObject({
      effectiveSize: LOGO_DEFAULTS.size,
      capped: false,
    });
    expect(intersects(fits.rect, f)).toBe(false);
    const big = placeLogo(logo("bottom-right", 0.12), 2, VERTICAL_1080, f);
    expect(big.capped).toBe(true);
    expect(big.effectiveSize).toBeCloseTo(LOGO_DEFAULTS.size, 9);
    expect(intersects(big.rect, f)).toBe(false);
  });

  it.each([
    720, 810, 900, 990, 1080, 1170, 1260, 1350, 1440, 1530, 1620, 1710, 1800,
    1890, 1920,
  ])(
    "does not call the default logo capped in a %ipx vertical preview",
    (height) => {
      // The band equals the default exactly, so float noise at the editor's
      // scaled preview sizes decides the comparison unless placeLogo
      // guards it. previewTarget's shape: width rounded from the height.
      const target = {
        ...VERTICAL_1080,
        width: Math.round(
          (VERTICAL_1080.width * height) / VERTICAL_1080.height,
        ),
        height,
      };
      const placed = placeLogo(
        logo("bottom-right", LOGO_DEFAULTS.size),
        2,
        target,
        frameOf(target),
      );
      expect(placed.capped, `at ${height}`).toBe(false);
      expect(intersects(placed.rect, frameOf(target))).toBe(false);
    },
  );

  it("fits beside the frame in the GIF, where a 16:10 capture leaves side bands", () => {
    const f = frameOf(GIF_800);
    // Premise: the side band is wider than the top band.
    expect(f.x).toBeGreaterThan(f.y);
    const placed = placeLogo(logo("bottom-right", 0.06), 2, GIF_800, f);
    expect(placed).toMatchObject({ effectiveSize: 0.06, capped: false });
    expect(intersects(placed.rect, f)).toBe(false);
  });

  it("keeps a very wide wordmark inside the frame's width, and says it was capped", () => {
    // A 21:9 recording in landscape at a 15% padding leaves tall bands above
    // and below it; a 12:1 wordmark sized to that band's HEIGHT is wider than
    // the frame. (At the default 8% the band is too short for that: the
    // premise below says so.)
    const f = derivePresentation(
      { ...BRANDING_DEFAULTS, padding: 0.15 },
      LANDSCAPE_1080P,
      { width: 2520, height: 1080 },
    ).frameRect;
    const aspect = 12;
    const bandV = f.y - margin;
    // Premise: the band alone would admit a mark wider than the frame.
    expect(Math.min(0.2 * short, bandV) * aspect).toBeGreaterThan(
      LANDSCAPE_1080P.width - 2 * margin,
    );
    for (const corner of ["top-right", "bottom-left"] as const) {
      const placed = placeLogo(logo(corner, 0.2), aspect, LANDSCAPE_1080P, f);
      expect(placed.capped, corner).toBe(true);
      expect(placed.rect.x, corner).toBeGreaterThanOrEqual(margin - 1e-6);
      expect(placed.rect.x + placed.rect.width, corner).toBeLessThanOrEqual(
        LANDSCAPE_1080P.width - margin + 1e-6,
      );
      expect(intersects(placed.rect, f), corner).toBe(false);
    }
  });

  it("draws nothing and says so when no legal size fits", () => {
    // An author's 3% padding leaves a band of 0.01 of the short side, under
    // the 2% minimum: the branch must not draw over the frame.
    const f = derivePresentation(
      { ...BRANDING_DEFAULTS, padding: 0.03 },
      VERTICAL_1080,
      VIEWPORT,
    ).frameRect;
    const s = Math.min(VERTICAL_1080.width, VERTICAL_1080.height);
    expect((f.y - s * 0.02) / s, "premise: the band").toBeCloseTo(0.01, 9);
    const placed = placeLogo(logo("bottom-right", 0.06), 2, VERTICAL_1080, f);
    expect(placed).toMatchObject({ effectiveSize: 0, capped: true });
  });

  it.each([720, 810, 1170, 1440])(
    "does not call a fitting logo capped at a %ipx preview",
    (height) => {
      // The editor reads `capped` off the PREVIEW target, whose short side
      // is 720 at rest. (size * short) / short is float-lossy there: 0.06,
      // the upload default, came back as 0.0599…, so every fresh upload
      // read "Shown at 6%… to stay clear" with nothing capped.
      // The editor's previewTarget: the deliverable scaled to this height.
      const target = {
        ...LANDSCAPE_1080P,
        width: Math.round((height * 16) / 9),
        height,
      };
      // Premise: this preview height is one where the round trip is lossy
      // for at least one of the sizes below.
      const short = Math.min(target.width, target.height);
      const sizes = [0.03, 0.06, 0.09, 0.11, 0.12];
      expect(sizes.some((s) => (s * short) / short < s)).toBe(true);
      // At a 15% padding, whose bands hold every size below: at the default
      // 8% the larger ones are capped for real, which is not this case.
      const f = derivePresentation(
        { ...BRANDING_DEFAULTS, padding: 0.15 },
        target,
        VIEWPORT,
      ).frameRect;
      for (const size of sizes) {
        const placed = placeLogo(logo("bottom-right", size), 2, target, f);
        expect(placed.capped, `size ${size} at ${height}`).toBe(false);
      }
    },
  );
});
