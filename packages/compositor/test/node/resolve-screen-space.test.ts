import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import { planScene } from "../../src/plan/plan";
import { resolvePlan, sampleCursor } from "../../src/plan/resolve";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

// The measured iPhone case (probe:tap-space): the page lays out 980 wide and
// is shown at 393, so a stored point is drawn at 0.401 of its page px.
const SCALE = 393 / 980;

describe("resolvePlan on a zoomed-out page", () => {
  const scene = readonlyScene();
  const base = proceduralBundle();
  // Two samples at one point, so nothing between them can move the cursor.
  const samples = [
    { sourceTimeMs: 0, x: 300, y: 600 },
    { sourceTimeMs: 5000, x: 300, y: 600 },
  ];
  const plain = { ...base, source: "replay" as const, cursorSamples: samples };
  const zoomed = {
    ...plain,
    viewportTransforms: [
      { sourceTimeMs: 0, scale: SCALE, offsetX: 0, offsetY: 0 },
    ],
  };
  const at = (b: typeof plain) =>
    sampleCursor(resolvePlan(planScene(scene), b, scene).cursor, 2500);

  it("draws the cursor where the screen showed it", () => {
    // The premise: without a transform the point is drawn as stored.
    expect(at(plain)?.x).toBeCloseTo(300, 0);
    expect(at(zoomed)?.x).toBeCloseTo(300 * SCALE, 0);
    expect(at(zoomed)?.y).toBeCloseTo(600 * SCALE, 0);
  });

  // A frozen-frame take has no samples: its cursor is drawn from the plan's
  // segments, which are page px too (and stay so, because replay reads them).
  it("draws a synthesized cursor where the screen showed it", () => {
    const frozen = { ...base, cursorSamples: [], viewportTransforms: [] };
    const frozenZoomed = {
      ...frozen,
      viewportTransforms: [
        { sourceTimeMs: 0, scale: SCALE, offsetX: 0, offsetY: 0 },
      ],
    };
    const plan = planScene(scene);
    const last = (b: FrameBundle) => resolvePlan(plan, b, scene).cursor.at(-1);
    const flat = last(frozen);
    const drawn = last(frozenZoomed);
    // The premise: the synthesized path ends somewhere off the origin.
    expect(flat?.x ?? 0).toBeGreaterThan(10);
    expect(drawn?.x).toBeCloseTo((flat?.x ?? 0) * SCALE, 3);
    expect(drawn?.y).toBeCloseTo((flat?.y ?? 0) * SCALE, 3);
  });
});
