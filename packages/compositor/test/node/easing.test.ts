import { describe, expect, it } from "vitest";
import { catmullRom, easings, springEase } from "../../src/easing";

describe("easings", () => {
  it("pins every curve to 0 and 1 at the endpoints", () => {
    for (const [name, fn] of Object.entries(easings)) {
      expect(fn(0), `${name} at 0`).toBeCloseTo(0, 6);
      expect(fn(1), `${name} at 1`).toBeCloseTo(1, 6);
    }
  });

  it("makes easeInOutCubic symmetric about the midpoint", () => {
    expect(easings.easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
    expect(
      easings.easeInOutCubic(0.25) + easings.easeInOutCubic(0.75),
    ).toBeCloseTo(1, 6);
  });

  it("starts and stops minimumJerk with neither speed nor acceleration", () => {
    const f = easings.minimumJerk;
    const h = 1e-3;
    const speed = (t: number) => (f(t + h) - f(t - h)) / (2 * h);
    const accel = (t: number) => (f(t + h) - 2 * f(t) + f(t - h)) / (h * h);
    // One-sided at the ends, so the curve is never read outside [0, 1].
    expect((f(h) - f(0)) / h).toBeCloseTo(0, 4);
    expect((f(1) - f(1 - h)) / h).toBeCloseTo(0, 4);
    // f''(t) = 60t near 0, so a forward difference reads ~60h here.
    expect(Math.abs((f(2 * h) - 2 * f(h) + f(0)) / (h * h))).toBeLessThan(0.1);
    // easeInOutCubic also starts and stops at rest; what tells the two apart
    // is the middle: a 3x spike for the cubic, a 1.875x bell for this.
    expect(speed(0.5)).toBeCloseTo(1.875, 3);
    expect(accel(0.5)).toBeCloseTo(0, 1);
    expect(f(0.5)).toBeCloseTo(0.5, 9);
    expect(f(0.2) + f(0.8)).toBeCloseTo(1, 9);
  });

  it("overshoots on easeOutBackDamped but settles without bouncing", () => {
    const peak = Math.max(
      ...Array.from({ length: 101 }, (_, i) =>
        easings.easeOutBackDamped(i / 100),
      ),
    );
    // A visible overshoot, but a restrained one — a bounce reads as a toy.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.05);
  });
});

describe("springEase", () => {
  const STIFFNESSES = [5.5, 6.75, 8];

  it("starts at 0 and lands exactly on 1", () => {
    for (const a of STIFFNESSES) {
      expect(springEase(0, a), `a=${a}`).toBe(0);
      expect(springEase(1, a), `a=${a}`).toBe(1);
      // Clamped either side, so a sample outside the window holds its end.
      expect(springEase(-0.5, a)).toBe(0);
      expect(springEase(1.5, a)).toBe(1);
    }
  });

  it("is at rest at both ends", () => {
    const h = 1e-4;
    for (const a of STIFFNESSES) {
      // One-sided at the ends, so the curve is never read outside [0, 1].
      const start = (springEase(h, a) - springEase(0, a)) / h;
      const end = (springEase(1, a) - springEase(1 - h, a)) / h;
      expect(Math.abs(start), `start, a=${a}`).toBeLessThan(0.01);
      expect(Math.abs(end), `end, a=${a}`).toBeLessThan(0.01);
      // A positive control: the same difference, mid-move, is a real speed
      // — so the two above are not small because the curve never moves.
      const middle = (springEase(0.3 + h, a) - springEase(0.3, a)) / h;
      expect(middle, `middle, a=${a}`).toBeGreaterThan(0.5);
    }
  });

  it("never runs backwards", () => {
    for (const a of STIFFNESSES) {
      let previous = springEase(0, a);
      for (let i = 1; i <= 10_000; i++) {
        const value = springEase(i / 10_000, a);
        expect(value, `a=${a} at ${i / 10_000}`).toBeGreaterThanOrEqual(
          previous,
        );
        previous = value;
      }
    }
  });

  // What tells it apart from the curve the camera had: minimum jerk is
  // symmetric and sits at exactly 0.5 half way. The spring is most of the
  // way there by then (the plan's 0.865), with a long soft landing after.
  it("is front-loaded: well past half way at the midpoint", () => {
    expect(easings.minimumJerk(0.5)).toBeCloseTo(0.5, 9);
    expect(springEase(0.5, 6.75)).toBeGreaterThan(0.8);
    expect(springEase(0.5, 6.75)).toBeCloseTo(0.865, 2);
    // Stiffer departs faster.
    expect(springEase(0.3, 8)).toBeGreaterThan(springEase(0.3, 5.5));
  });

  it("refuses a stiffness that would make it NaN, rather than painting one", () => {
    for (const a of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => springEase(0.5, a), `a=${a}`).toThrow(RangeError);
    }
  });
});

describe("catmullRom", () => {
  it("passes through the first and last control points", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 50, y: 100 },
      { x: 200, y: 20 },
    ];
    expect(catmullRom(pts, 0)).toEqual({ x: 0, y: 0 });
    expect(catmullRom(pts, 1)).toEqual({ x: 200, y: 20 });
  });

  it("passes through interior control points", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 50, y: 100 },
      { x: 200, y: 20 },
    ];
    const mid = catmullRom(pts, 0.5);
    expect(mid.x).toBeCloseTo(50, 6);
    expect(mid.y).toBeCloseTo(100, 6);
  });

  it("degenerates to a straight line for two points", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ];
    expect(catmullRom(pts, 0.5)).toEqual({ x: 50, y: 50 });
  });
});
