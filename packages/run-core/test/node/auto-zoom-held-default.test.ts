import type { FrameBundle } from "@demoman/compositor";
import { BRANDING_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { takeOf } from "../../../replay-engine/test/helpers/film";
import {
  ZOOM_FLOOR_SCALE,
  zoomDefaultFor,
  zoomsForClicks,
} from "../../src/auto-zoom.js";

/**
 * Auto zoom under held: a held take's stills are at the flow's scale, 2x, and
 * the default export cut every 1.8x zoom to what they back. Measured
 * 2026-11-19 (`apps/runner/compare/pacing-pairs.mjs`, held, 1440x900@2,
 * default branding, default export): `grantedScale` 1.3470029185063235 at
 * every zoomed click. The default a held take is saved with is that grant,
 * so the export no longer cuts it.
 */
describe("the default zoom a held take's stills back", () => {
  /** The stills `targetFor` and the clamp read: their sizes and the
   *  recording's. Nothing else of a bundle is asked. */
  const held = (
    viewport: { width: number; height: number },
    ...widths: number[]
  ) => ({
    bundle: {
      viewport,
      keyframes: widths.map((w) => ({
        width: w,
        height: Math.round((w * viewport.height) / viewport.width),
      })),
    } as unknown as FrameBundle,
    branding: BRANDING_DEFAULTS,
    aspect: "auto" as const,
  });
  const desktop = { width: 1440, height: 900 };

  it("is the grant the export measured at 2x", () => {
    expect(zoomDefaultFor(held(desktop, 2880), desktop)).toEqual({
      scale: expect.closeTo(1.347, 3),
      stillScale: 2,
    });
  });

  it("is the camera's default where the stills back it (real time's 3x)", () => {
    expect(zoomDefaultFor(held(desktop, 4320), desktop).scale).toBe(1.8);
  });

  it("frames a phone as its export does, at the tier its stills back", () => {
    // 393x852 at 3x: stills 1179 px wide, whose export is the 1080p tier,
    // not 1440p. Framed against 1440p, every zoom fell to the floor.
    const phone = { width: 393, height: 852 };
    expect(zoomDefaultFor(held(phone, 1179), phone).scale).toBeGreaterThan(
      ZOOM_FLOOR_SCALE + 0.2,
    );
  });

  it("is sized from the narrowest still, which the clamp reads before its zoom", () => {
    const at2x = zoomDefaultFor(held(desktop, 2880), desktop);
    const mixed = zoomDefaultFor(held(desktop, 2880, 2160), desktop);
    expect(mixed.stillScale).toBe(1.5);
    expect(mixed.scale).toBeLessThan(at2x.scale);
  });

  it("stays at the floor, so the floor alone still decides which clicks zoom", () => {
    // 1280 px at 2x backs about 1.19, under the floor: without the floor
    // this answers that, and every click there would lose its zoom.
    const narrow = { width: 1280, height: 800 };
    expect(zoomDefaultFor(held(narrow, 2560), narrow).scale).toBe(
      ZOOM_FLOOR_SCALE,
    );
  });

  it("is what zoomsForClicks writes, and records it only when it lowers the default", () => {
    const actions = takeOf(["click"]).actions.map((a) => ({
      ...a,
      rect: { x: 600, y: 400, width: 120, height: 40 },
    }));
    const plain = zoomsForClicks(actions, desktop);
    const at2x = zoomsForClicks(
      actions,
      desktop,
      () => 1,
      undefined,
      held(desktop, 2880),
    );
    const at3x = zoomsForClicks(
      actions,
      desktop,
      () => 1,
      undefined,
      held(desktop, 4320),
    );
    expect(plain.camera[0]?.scale).toBe(1.8);
    expect(plain.zoomDefault).toBeUndefined();
    expect(at2x.camera[0]?.scale).toBeCloseTo(1.347, 3);
    expect(at2x.zoomDefault?.scale).toBe(at2x.camera[0]?.scale);
    expect(at3x.camera[0]?.scale).toBe(1.8);
    expect(at3x.zoomDefault).toBeUndefined();
  });
});
