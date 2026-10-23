import { describe, expect, it } from "vitest";
import {
  containRect,
  lerp,
  lerpVec,
  padRect,
  rectCenter,
} from "../../src/geometry";

describe("geometry", () => {
  it("finds a rect's centre", () => {
    expect(rectCenter({ x: 10, y: 20, width: 100, height: 40 })).toEqual({
      x: 60,
      y: 40,
    });
  });

  it("pads a rect outward on all sides", () => {
    expect(padRect({ x: 10, y: 10, width: 100, height: 50 }, 5)).toEqual({
      x: 5,
      y: 5,
      width: 110,
      height: 60,
    });
  });

  it("never pads a rect to negative dimensions", () => {
    const r = padRect({ x: 10, y: 10, width: 20, height: 20 }, -30);
    expect(r.width).toBe(0);
    expect(r.height).toBe(0);
  });

  it("interpolates numbers and points", () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(lerpVec({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({
      x: 5,
      y: 10,
    });
  });

  it("contains an aspect inside an outer rect, centred", () => {
    // 16:10 content inside a 16:9 box letterboxes left/right.
    const fitted = containRect(
      { width: 1280, height: 800 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );
    expect(fitted.height).toBe(1080);
    expect(fitted.width).toBe(1728);
    expect(fitted.x).toBe(96);
    expect(fitted.y).toBe(0);
  });
});
