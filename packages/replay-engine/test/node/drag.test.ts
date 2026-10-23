import { describe, expect, it } from "vitest";
import {
  DRAG_LEAD_PX,
  DRAG_LEAD_STEPS,
  heldPath,
  inViewport,
  rangeThumb,
} from "../../src/drag";

const box = { x: 100, y: 200, width: 400, height: 100 };
const tall = { x: 100, y: 200, width: 20, height: 300 };
const range = { value: 30, min: 0, max: 100 };

describe("drag geometry", () => {
  it("rangeThumb puts a 30-of-100 thumb 30% along the track", () => {
    expect(
      rangeThumb(box, { ...range, vertical: false, reversed: false }),
    ).toEqual({ x: 220, y: 250 });
    // No range to move along: the start of the track.
    expect(
      rangeThumb(box, {
        value: 5,
        min: 5,
        max: 5,
        vertical: false,
        reversed: false,
      }),
    ).toEqual({ x: 100, y: 250 });
  });

  // Measured in Chromium (2026-10-21): a press 10% down a vertical-lr or
  // vertical-rl range reads 8, and 10% from the left of an rtl one reads 92.
  it("rangeThumb runs a vertical range top to bottom, and rtl the other way", () => {
    expect(
      rangeThumb(tall, { ...range, vertical: true, reversed: false }),
    ).toEqual({ x: 110, y: 290 });
    expect(
      rangeThumb(tall, { ...range, vertical: true, reversed: true }),
    ).toEqual({ x: 110, y: 410 });
    expect(
      rangeThumb(box, { ...range, vertical: false, reversed: true }),
    ).toEqual({ x: 380, y: 250 });
  });

  it("heldPath leads three 3px steps toward the end", () => {
    const { lead, segment } = heldPath({ x: 0, y: 0 }, { x: 300, y: 400 }, "a");
    expect(DRAG_LEAD_STEPS).toBe(3);
    expect(DRAG_LEAD_PX).toBe(3);
    expect(lead).toHaveLength(3);
    // Along the 3-4-5 direction, 3px apart.
    expect(lead[0]?.x).toBeCloseTo(1.8, 9);
    expect(lead[0]?.y).toBeCloseTo(2.4, 9);
    expect(lead[2]?.x).toBeCloseTo(5.4, 9);
    const last = segment.via[segment.via.length - 1];
    expect(last).toEqual({ x: 300, y: 400 });
    expect(segment.via[0]).toEqual(lead[2]);
  });

  // A stroke on a canvas follows the pointer: "from here to there" is a line,
  // so the held move goes straight where the cursor's travel bows.
  it("heldPath goes straight from the lead to the end", () => {
    const { lead, segment } = heldPath({ x: 0, y: 0 }, { x: 300, y: 400 }, "a");
    const from = lead[2] as { x: number; y: number };
    for (const p of segment.via) {
      // On the line through `from` and the end: the cross product is zero.
      const cross =
        (p.x - from.x) * (400 - from.y) - (p.y - from.y) * (300 - from.x);
      expect(Math.abs(cross), JSON.stringify(segment.via)).toBeLessThan(1e-6);
    }
  });

  it("inViewport is false past any edge", () => {
    const vp = { width: 800, height: 600 };
    expect(inViewport({ x: 0, y: 0 }, vp)).toBe(true);
    expect(inViewport({ x: 800, y: 600 }, vp)).toBe(true);
    expect(inViewport({ x: -1, y: 10 }, vp)).toBe(false);
    expect(inViewport({ x: 10, y: 601 }, vp)).toBe(false);
  });
});
