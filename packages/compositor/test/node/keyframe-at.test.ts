import { describe, expect, it } from "vitest";
import { keyframeAt } from "../../src/bundle";
import { proceduralBundle } from "../fixtures/bundle";

// One body now serves both frame sources and the detail clamp. These pin the
// three answers it has to give, so a change here is a change to all three.
describe("keyframeAt", () => {
  const bundle = proceduralBundle();

  it("answers with the nearest keyframe at or before the instant", () => {
    expect(keyframeAt(bundle, 3200)?.ref).toBe("k-2");
    expect(keyframeAt(bundle, 3199)?.ref).toBe("k-1");
    expect(keyframeAt(bundle, 20_000)?.ref).toBe("k-3");
  });

  it("falls back to the first keyframe before any keyframe exists", () => {
    const late = proceduralBundle({
      keyframes: bundle.keyframes.filter((k) => k.sourceTimeMs >= 400),
    });
    expect(keyframeAt(late, 10)?.ref).toBe("k-1");
  });

  it("is null only for a bundle with no keyframes at all", () => {
    expect(keyframeAt(proceduralBundle({ keyframes: [] }), 0)).toBeNull();
  });
});
