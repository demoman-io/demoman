import type { FrameBundle } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import { chooseActiveBundle } from "../../src/index.js";

const bundle = (source: "replay" | "capture"): FrameBundle =>
  ({ source }) as FrameBundle;

describe("chooseActiveBundle", () => {
  it("serves capture in screen mode even when a complete replay exists", () => {
    const replay = bundle("replay");
    const capture = bundle("capture");
    expect(chooseActiveBundle(replay, capture, true, "screen")).toBe(capture);
  });

  it("still prefers a complete replay in demo mode", () => {
    const replay = bundle("replay");
    const capture = bundle("capture");
    expect(chooseActiveBundle(replay, capture, true, "demo")).toBe(replay);
  });

  it("keeps serving a partial replay's capture frames in demo mode", () => {
    const replay = bundle("replay");
    const capture = bundle("capture");
    expect(chooseActiveBundle(replay, capture, false, "demo")).toBe(capture);
  });

  it("falls back to replay in screen mode when the take has no capture bundle", () => {
    // Not silent: `bundle.source` is what a surface reads to label this, and
    // it says "replay" here. Serving nothing would be the worse answer.
    const replay = bundle("replay");
    expect(chooseActiveBundle(replay, null, true, "screen")).toBe(replay);
  });
});
