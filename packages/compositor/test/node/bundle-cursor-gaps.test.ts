import { describe, expect, it } from "vitest";
import { validateBundle } from "../../src/bundle";
import { proceduralBundle } from "../fixtures/bundle";

describe("cursorGaps", () => {
  it("defaults to empty for a bundle written before the field existed", () => {
    const legacy = { ...proceduralBundle() } as Record<string, unknown>;
    delete legacy.cursorGaps;
    // Old bundles on disk must still read. `.default([])` is what makes the
    // absence mean "no gaps recorded" instead of failing the parse.
    expect(validateBundle(legacy).cursorGaps).toEqual([]);
  });

  it("round-trips recorded gaps", () => {
    const withGap = {
      ...proceduralBundle(),
      cursorGaps: [{ startMs: 400, endMs: 900 }],
    };
    expect(validateBundle(withGap).cursorGaps).toEqual([
      { startMs: 400, endMs: 900 },
    ]);
  });

  it("accepts cursorSynthesized as a degradation kind", () => {
    const degraded = {
      ...proceduralBundle(),
      degradations: [
        { startMs: 0, endMs: 5000, kind: "cursorSynthesized", note: "" },
      ],
    };
    expect(validateBundle(degraded).degradations[0]?.kind).toBe(
      "cursorSynthesized",
    );
  });
});
