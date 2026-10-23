import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import { createImageFrameSource } from "../../src/ports/frame-source-images";
import type { FrameImage } from "../../src/ports/types";

const stub = (ref: string): FrameImage => ({
  image: { ref } as unknown as CanvasImageSource,
  width: 1280,
  height: 800,
  sourceTimeMs: -1,
});

function bundle(): FrameBundle {
  return {
    bundleVersion: 1,
    sceneId: "scene-1",
    source: "capture",
    dpr: 1,
    viewport: { width: 1280, height: 800 },
    keyframes: [
      {
        ref: "kf:0",
        sourceTimeMs: 0,
        width: 1280,
        height: 800,
        actionId: null,
      },
      {
        ref: "kf:1",
        sourceTimeMs: 5000,
        width: 1280,
        height: 800,
        actionId: null,
      },
    ],
    motionSpans: [],
    cursorSamples: [],
    anchorRects: [],
    markers: [],
    degradations: [],
  } as unknown as FrameBundle;
}

describe("createImageFrameSource", () => {
  it("reports the keyframe time it served, not the time asked for", async () => {
    const frames = createImageFrameSource(bundle(), async (ref) => stub(ref));
    // 4900 falls between keyframes; the source serves kf:0 at 0.
    const served = await frames.at(4900);
    expect(served.sourceTimeMs).toBe(0);
  });

  it("gives two far-apart requests the same time when one keyframe serves both", async () => {
    const frames = createImageFrameSource(bundle(), async (ref) => stub(ref));
    const a = await frames.at(600);
    const b = await frames.at(1100);
    // This equality is the whole point: Task 3 uses it to refuse a verdict.
    expect(a.sourceTimeMs).toBe(b.sourceTimeMs);
  });
});
