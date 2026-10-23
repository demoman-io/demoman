import { describe, expect, it } from "vitest";
import type { CursorSample } from "../../src/bundle";
import type { Timeline } from "../../src/plan/timeline";
import { cursorTrailGhosts, cursorTrailPoints } from "../../src/render/compose";
import { cursorTiltRad } from "../../src/render/cursor-pose";

/** Source time and output time are the same thing: nothing is retimed. */
const straight: Timeline = {
  segments: [
    {
      outStartMs: 0,
      outEndMs: 4000,
      srcStartMs: 0,
      srcEndMs: 4000,
      kind: "motion",
    },
  ],
  outputDurationMs: 4000,
  sourceDurationMs: 4000,
  unplacedPaces: 0,
  nonMonotonicPaces: 0,
  // Hand-built timelines: these cases are about the camera, the
  // cursor's idle fade and its trail, none of which a cut touches.
  cuts: [],
  unplacedCuts: [],
  interruptions: [],
};

/**
 * The pointer's first recorded sample is at 500ms, not 0.
 *
 * This is the ordinary case, not a contrived one: `cursorSamples` comes from
 * the sensor, which emits nothing until the pointer first moves, and an
 * author who reads the page for half a second before touching the mouse
 * produces exactly this. It then travels 100px per 100ms, so a ghost 30ms
 * behind the pointer is a clearly separate point from it.
 */
const samples: CursorSample[] = Array.from({ length: 11 }, (_, i) => ({
  sourceTimeMs: 500 + i * 100,
  x: 100 + i * 100,
  y: 300,
}));

const plan = { cursor: samples, timeline: straight };

/** `cursorTrailStamps(1)`: what the product default asks for. */
const STAMPS_AT_FULL_BLUR = 10;

describe("cursorTrailPoints", () => {
  it("asks for ten stamps at the default blur, mid-take", () => {
    // The fixture assertion. Every case below is a departure from this one,
    // and a fixture that stopped producing a full-length trail would let
    // them pass by drawing nothing at all.
    const trail = cursorTrailPoints(plan, 1000, 1);
    expect(trail.length).toBe(STAMPS_AT_FULL_BLUR);
    // Oldest first, and each a distinct place: the pointer is moving, so a
    // repeated point here would mean two stamps resolved to one sample.
    const xs = trail.map((p) => p.x);
    expect(new Set(xs).size, `xs: ${xs.join(", ")}`).toBe(xs.length);
    expect(xs[0]).toBeLessThan(xs[xs.length - 1] as number);
  });

  it("shortens the trail at the first sample instead of piling ghosts on it", () => {
    // 505ms: the take's time has just crossed the pointer's first sample, so
    // nine of the ten stamps fall before the pointer has any recorded
    // history at all. `sampleCursor` CLAMPS those onto the first sample
    // rather than refusing them, so without the skip in `cursorTrailPoints`
    // this returns ten points with nine of them at (100, 300) — ghosts
    // stacking their alpha into a blob at the pointer's first position.
    const trail = cursorTrailPoints(plan, 505, 1);
    const shown = trail.map((p) => `${p.x},${p.y}`).join(" | ");
    expect(trail.length, shown).toBeLessThan(STAMPS_AT_FULL_BLUR);
    expect(new Set(shown.split(" | ")).size, shown).toBe(trail.length);
    // Not empty either: the one stamp that IS inside the take still draws,
    // so the trail shortens into the first sample rather than vanishing.
    expect(trail.length, shown).toBeGreaterThan(0);
    for (const point of trail) expect(point.x).toBeGreaterThanOrEqual(100);
  });

  it("draws nothing before the pointer's first sample", () => {
    // Earlier still: every stamp is outside the take. The pointer itself is
    // drawn here — clamped, parked at its first position — but it gets no
    // halo, because it has been nowhere.
    expect(cursorTrailPoints(plan, 300, 1)).toEqual([]);
  });

  it("draws nothing at a blur of zero", () => {
    expect(cursorTrailPoints(plan, 1000, 0)).toEqual([]);
  });

  it("draws nothing when the take has no cursor samples", () => {
    expect(
      cursorTrailPoints({ cursor: [], timeline: straight }, 1000, 1),
    ).toEqual([]);
  });
});

/**
 * A pointer that runs right at 1000 px/s, then turns and runs back left. Its
 * lean swings from one side to the other across the turn, so just after it
 * the oldest ghost — the pointer 32ms ago — leaned the other way from the
 * pointer now.
 */
describe("cursorTrailGhosts", () => {
  const turning: CursorSample[] = Array.from({ length: 21 }, (_, i) => ({
    sourceTimeMs: 500 + i * 50,
    x: i <= 10 ? 100 + i * 50 : 600 - (i - 10) * 50,
    y: 300,
  }));
  const resolved = {
    cursor: turning,
    timeline: straight,
    plan: { viewport: { width: 1280, height: 800 } },
  };
  const lean = (ms: number) => cursorTiltRad(resolved, ms, 1);

  // Red on ghosts that carry the frame's lean: every one would share the
  // sign of `lean(t)`, and the oldest would not.
  it("leans each ghost the way the pointer leaned at that ghost's instant", () => {
    // The instant: the first after the turn where the lean now and the lean
    // 32ms ago (the oldest ghost, at full blur) are clearly on opposite
    // sides. The fixture has to produce one, or the case below is vacuous.
    let t: number | undefined;
    for (let ms = 1000; ms < 1400 && t === undefined; ms++) {
      if (lean(ms) < -0.02 && lean(ms - 32) > 0.02) t = ms;
      if (lean(ms) > 0.02 && lean(ms - 32) < -0.02) t = ms;
    }
    if (t === undefined)
      throw new Error("fixture: the lean never flips inside 32ms");
    const ghosts = cursorTrailGhosts(resolved, t, 1, 1);
    expect(ghosts.length).toBe(STAMPS_AT_FULL_BLUR);
    const oldest = ghosts[0];
    const newest = ghosts[ghosts.length - 1];
    if (!oldest || !newest) throw new Error("fixture: no ghosts");
    expect(Math.sign(oldest.angleRad)).toBe(Math.sign(lean(t - 32)));
    expect(Math.sign(oldest.angleRad)).not.toBe(Math.sign(lean(t)));
    // Positions are the trail's own, unchanged.
    expect(ghosts.map(({ x, y }) => ({ x, y }))).toEqual(
      cursorTrailPoints(resolved, t, 1).map(({ x, y }) => ({ x, y })),
    );
  });

  it("stands every ghost upright at a tilt of zero", () => {
    const ghosts = cursorTrailGhosts(resolved, 1100, 1, 0);
    expect(ghosts.length).toBe(STAMPS_AT_FULL_BLUR); // guard
    expect(ghosts.every((g) => g.angleRad === 0)).toBe(true);
  });
});
