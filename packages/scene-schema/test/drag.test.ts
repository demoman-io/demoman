import { describe, expect, it } from "vitest";
import { dragEndPoint, dragPoints, spotIn } from "../src/drag";

const box = { x: 100, y: 200, width: 400, height: 100 };

describe("drag points", () => {
  it("spotIn reads fractions of the box, centre when absent", () => {
    expect(spotIn(box, { x: 0.25, y: 0.5 })).toEqual({ x: 200, y: 250 });
    expect(spotIn(box, undefined)).toEqual({ x: 300, y: 250 });
  });

  it("dragEndPoint adds by to the start, and takes a spot in an end box", () => {
    expect(
      dragEndPoint({ x: 10, y: 20 }, { by: { x: -5, y: 40 } }, null),
    ).toEqual({ x: 5, y: 60 });
    expect(dragEndPoint({ x: 10, y: 20 }, { at: { x: 0, y: 0 } }, box)).toEqual(
      {
        x: 100,
        y: 200,
      },
    );
    expect(dragEndPoint({ x: 10, y: 20 }, {}, undefined)).toBeNull();
  });

  // Review of 2026-10-21: the walk pressed a slider at its thumb while the
  // film check and zoom measured a drag from its centre.
  it("starts where the walk pressed, before the script's spot or the centre", () => {
    const by = { by: { x: 120, y: 0 } };
    expect(
      dragPoints({ pressedAt: { x: 0.3, y: 0.5 }, to: by }, box, undefined),
    ).toEqual({ start: { x: 220, y: 250 }, end: { x: 340, y: 250 } });
    expect(
      dragPoints({ fromAt: { x: 0, y: 0 }, to: by }, box, undefined)?.start,
    ).toEqual({ x: 100, y: 200 });
    expect(dragPoints({ to: by }, box, undefined)?.start).toEqual({
      x: 300,
      y: 250,
    });
    expect(dragPoints({ to: {} }, box, undefined)).toBeNull();
  });
});
