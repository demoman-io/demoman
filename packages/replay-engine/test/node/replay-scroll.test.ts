import { describe, expect, it } from "vitest";
import {
  SCROLL_MARKER,
  scrollIntoViewFunction,
  scrollWillMove,
} from "../../src/index.js";

const VIEWPORT = { width: 1280, height: 800 };

describe("scrollWillMove", () => {
  const inView = { x: 10, y: 20, width: 100, height: 40 };

  it("is false for an element already wholly in view", () => {
    expect(scrollWillMove(inView, VIEWPORT, "nearest")).toBe(false);
  });

  // The four ways out of frame, each on its own, because a predicate that
  // checked only the vertical would pass every test written against a page
  // that scrolls down and fail on the one that scrolls sideways.
  it("is true for an element off any edge", () => {
    expect(scrollWillMove({ ...inView, y: -1 }, VIEWPORT, "nearest")).toBe(
      true,
    );
    expect(scrollWillMove({ ...inView, x: -1 }, VIEWPORT, "nearest")).toBe(
      true,
    );
    expect(scrollWillMove({ ...inView, y: 780 }, VIEWPORT, "nearest")).toBe(
      true,
    );
    expect(scrollWillMove({ ...inView, x: 1200 }, VIEWPORT, "nearest")).toBe(
      true,
    );
  });

  // `scrollTo` is the beat, not a correction: its travel is the thing the
  // viewer is meant to watch, so it is recorded wherever the target starts.
  it("is always true for a centring scroll", () => {
    expect(scrollWillMove(inView, VIEWPORT, "center")).toBe(true);
  });

  // A recorded scroll returns its anchor to where the author left it, so it
  // has travel to show exactly when the anchor is somewhere else.
  it("is true for a recorded landing only when the anchor is not already there", () => {
    expect(scrollWillMove(inView, VIEWPORT, { top: 20 })).toBe(false);
    expect(scrollWillMove(inView, VIEWPORT, { top: 20.4 })).toBe(false);
    expect(scrollWillMove(inView, VIEWPORT, { top: 318 })).toBe(true);
    expect(scrollWillMove(inView, VIEWPORT, { top: -300 })).toBe(true);
  });
});

describe("scrollIntoViewFunction", () => {
  it("asks for the alignment it was given, smoothly", () => {
    expect(scrollIntoViewFunction("center", 1500)).toContain('block: "center"');
    expect(scrollIntoViewFunction("nearest", 1500)).toContain(
      'block: "nearest"',
    );
    // Smooth is the whole point: an instant scroll paints once and gives the
    // screencast nothing to record, which is the defect this replaced.
    expect(scrollIntoViewFunction("nearest", 1500)).toContain(
      'behavior: "smooth"',
    );
  });

  // Not `scrollIntoView`: no `block` puts an element at an arbitrary offset,
  // and a centred 909px anchor landed 352px short of the author's scroll.
  it("aims a recorded landing at the recorded top, not at an alignment", () => {
    const fn = scrollIntoViewFunction({ top: 318 }, 1500);
    expect(fn).toContain("318");
    expect(fn).not.toContain("block:");
    expect(fn).toContain('behavior: "smooth"');
  });

  it("carries its deadline and its marker", () => {
    const fn = scrollIntoViewFunction("nearest", 1234);
    expect(fn).toContain("1234");
    // The marker is how the CDP fake — and anything else reading the wire —
    // tells this call apart from the other `callFunctionOn`s the engine makes.
    expect(fn).toContain(SCROLL_MARKER);
  });
});
