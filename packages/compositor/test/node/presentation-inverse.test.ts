import { describe, expect, it } from "vitest";
import { cssRectToOutput, cssToOutput } from "../../src/render/compose";
import { outputRectToCss, outputToCss } from "../../src/render/presentation";

const VIEWPORT = { width: 1280, height: 800 };
const FRAME = { x: 192, y: 108, width: 3456, height: 2160 };

describe("outputToCss", () => {
  it("inverts cssToOutput at scale 1", () => {
    const camera = { center: { x: 640, y: 400 }, scale: 1 };
    const point = { x: 300, y: 220 };
    const round = outputToCss(
      cssToOutput(point, camera, FRAME, VIEWPORT),
      camera,
      FRAME,
      VIEWPORT,
    );
    expect(round.x).toBeCloseTo(point.x, 6);
    expect(round.y).toBeCloseTo(point.y, 6);
  });

  it("inverts under a zoomed, off-centre camera", () => {
    const camera = { center: { x: 980, y: 620 }, scale: 1.8 };
    const point = { x: 1040, y: 655 };
    const round = outputToCss(
      cssToOutput(point, camera, FRAME, VIEWPORT),
      camera,
      FRAME,
      VIEWPORT,
    );
    expect(round.x).toBeCloseTo(point.x, 6);
    expect(round.y).toBeCloseTo(point.y, 6);
  });

  it("inverts under cover, where the scale is taken off the other axis", () => {
    // A `cover` frame does not share the capture's aspect, so contentScale
    // reads the max of the two ratios. Getting this wrong is invisible in
    // landscape and puts every vertical-cut mask in the wrong place.
    const camera = { center: { x: 640, y: 400 }, scale: 1.15 };
    const frame = { x: 43, y: 76, width: 994, height: 1768 };
    const point = { x: 700, y: 300 };
    const round = outputToCss(
      cssToOutput(point, camera, frame, VIEWPORT),
      camera,
      frame,
      VIEWPORT,
    );
    expect(round.x).toBeCloseTo(point.x, 6);
    expect(round.y).toBeCloseTo(point.y, 6);
  });

  it("inverts rectangles, dimensions included", () => {
    const camera = { center: { x: 640, y: 400 }, scale: 1.4 };
    const rect = { x: 60, y: 380, width: 400, height: 24 };
    const round = outputRectToCss(
      cssRectToOutput(rect, camera, FRAME, VIEWPORT),
      camera,
      FRAME,
      VIEWPORT,
    );
    expect(round.x).toBeCloseTo(rect.x, 6);
    expect(round.y).toBeCloseTo(rect.y, 6);
    expect(round.width).toBeCloseTo(rect.width, 6);
    expect(round.height).toBeCloseTo(rect.height, 6);
  });
});
