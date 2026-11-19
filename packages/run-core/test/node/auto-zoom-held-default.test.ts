import { BRANDING_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { takeOf } from "../../../replay-engine/test/helpers/film";
import {
  ZOOM_FLOOR_SCALE,
  zoomDefaultFor,
  zoomsForClicks,
} from "../../src/auto-zoom.js";

/**
 * DEM-164 under held: a held take's stills are at the flow's scale, 2x, and
 * the default export cut every 1.8x zoom to what they back. Measured
 * 2026-11-19 (`apps/runner/compare/pacing-pairs.mjs`, held, 1440x900@2,
 * default branding, default export): `grantedScale` 1.3470029185063235 at
 * every zoomed click. The default a held take is saved with is that grant,
 * so the export no longer cuts it.
 */
describe("the default zoom a held take's stills back", () => {
  const held = (stillScale: number) => ({
    stillScale,
    branding: BRANDING_DEFAULTS,
    aspect: "auto" as const,
  });
  const viewport = { width: 1440, height: 900 };

  it("is the grant the export measured at 2x", () => {
    expect(zoomDefaultFor(held(2), viewport)).toBeCloseTo(1.347, 3);
  });

  it("is the camera's default where the stills back it (real time's 3x)", () => {
    expect(zoomDefaultFor(held(3), viewport)).toBe(1.8);
  });

  it("stays at the floor, so the floor alone still decides which clicks zoom", () => {
    // 1280 px at 2x backs about 1.19, under the floor: without the floor
    // this answers that, and every click there would lose its zoom.
    const narrow = { width: 1280, height: 800 };
    expect(zoomDefaultFor(held(2), narrow)).toBe(ZOOM_FLOOR_SCALE);
  });

  it("is what zoomsForClicks writes on a click whose target fits", () => {
    const actions = takeOf(["click"]).actions.map((a) => ({
      ...a,
      rect: { x: 600, y: 400, width: 120, height: 40 },
    }));
    const plain = zoomsForClicks(actions, viewport);
    const backed = zoomsForClicks(
      actions,
      viewport,
      () => 1,
      undefined,
      held(2),
    );
    expect(plain.camera[0]?.scale).toBe(1.8);
    expect(backed.camera[0]?.scale).toBeCloseTo(1.347, 3);
  });
});
