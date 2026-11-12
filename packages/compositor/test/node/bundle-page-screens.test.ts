import { describe, expect, it } from "vitest";
import { type PageScreen, validateBundle } from "../../src/index.js";
import { proceduralBundle } from "../fixtures/bundle.js";

const screen = (over: Partial<PageScreen> = {}): PageScreen => ({
  after: 0,
  sourceTimeMs: 10,
  ref: "ps:s:0",
  width: 1280,
  height: 800,
  heldAnimations: 0,
  waitedMs: 300,
  ...over,
});

describe("FrameBundle.pageScreens", () => {
  it("accepts a bundle without them, and one with them", () => {
    expect(validateBundle(proceduralBundle()).pageScreens).toBeUndefined();
    const bundle = { ...proceduralBundle(), pageScreens: [screen()] };
    expect(validateBundle(bundle).pageScreens).toHaveLength(1);
  });

  it("refuses a screen with no bytes that does not say why", () => {
    const silent = {
      ...proceduralBundle(),
      pageScreens: [screen({ ref: "" })],
    };
    expect(() => validateBundle(silent)).toThrow(/must say why/);
    const said = {
      ...proceduralBundle(),
      pageScreens: [
        screen({
          ref: "",
          unsettled: "the page screen could not be taken (x)",
        }),
      ],
    };
    expect(validateBundle(said).pageScreens?.[0]?.ref).toBe("");
  });
});
