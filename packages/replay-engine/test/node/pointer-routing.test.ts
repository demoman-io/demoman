import { describe, expect, it } from "vitest";
import { buildCaptureBundle } from "../../src/index.js";
import { scene } from "../helpers/replay-scene";

const shots = [
  { sourceTimeMs: 0, ref: "kf:s:0", width: 1280, height: 800, byteLength: 0 },
];

describe("capture bundle cursor", () => {
  it("carries recorded samples and gaps", () => {
    const bundle = buildCaptureBundle(
      scene(),
      shots,
      { spans: [], degradations: [] },
      {
        samples: [
          { sourceTimeMs: 0, x: 1, y: 1 },
          { sourceTimeMs: 100, x: 9, y: 9 },
        ],
        gaps: [{ startMs: 20, endMs: 60 }],
      },
    );
    expect(bundle.cursorSamples).toHaveLength(2);
    expect(bundle.cursorGaps).toEqual([{ startMs: 20, endMs: 60 }]);
    expect(
      bundle.degradations.some((d) => d.kind === "cursorSynthesized"),
    ).toBe(false);
  });

  it("says so when there were no samples at all", () => {
    const bundle = buildCaptureBundle(scene(), shots);
    // Sampling that never started, a page that interfered, and an author who
    // never moved the mouse all produce this. All three get a drawn cursor
    // that is a reconstruction, so all three are owed the same warning.
    expect(bundle.cursorSamples).toEqual([]);
    expect(
      bundle.degradations.some((d) => d.kind === "cursorSynthesized"),
    ).toBe(true);
  });
});
