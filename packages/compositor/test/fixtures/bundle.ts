import type { FrameBundle } from "../../src/bundle";

/**
 * A fixture bundle matching readonlyScene(): three markers, one genuine
 * motion span (a panel animating open between the scroll and the click), and
 * DPR-3 keyframes against a surface-capped motion stream — the SP1 mismatch
 * the compositor has to upscale through.
 */
export function proceduralBundle(
  overrides: Partial<FrameBundle> = {},
): FrameBundle {
  return {
    bundleVersion: 1,
    sceneId: "scene-readonly-001",
    source: "replay",
    dpr: 3,
    viewport: { width: 1280, height: 800 },
    keyframes: [
      {
        sourceTimeMs: 0,
        ref: "k-0",
        width: 3840,
        height: 2400,
        actionId: null,
        byteLength: 0,
      },
      {
        sourceTimeMs: 400,
        ref: "k-1",
        width: 3840,
        height: 2400,
        actionId: "act-1",
        byteLength: 0,
      },
      {
        sourceTimeMs: 3200,
        ref: "k-2",
        width: 3840,
        height: 2400,
        actionId: "act-2",
        byteLength: 0,
      },
      {
        sourceTimeMs: 9000,
        ref: "k-3",
        width: 3840,
        height: 2400,
        actionId: "act-3",
        byteLength: 0,
      },
    ],
    motionSpans: [
      // Surface-capped: 2560x1600, not 3840x2400. SP1's platform fact.
      {
        startMs: 3200,
        endMs: 4000,
        ref: "m-0",
        width: 2560,
        height: 1600,
        fps: 60,
        byteLength: 0,
      },
    ],
    cursorSamples: [
      { sourceTimeMs: 0, x: 120, y: 640 },
      { sourceTimeMs: 400, x: 200, y: 42 },
      { sourceTimeMs: 3200, x: 640, y: 328 },
      { sourceTimeMs: 9000, x: 1060, y: 642 },
    ],
    cursorGaps: [],
    anchorRects: [
      {
        actionId: "act-1",
        anchorId: "a-search",
        rect: { x: 40, y: 24, width: 320, height: 36 },
      },
      {
        actionId: "act-2",
        anchorId: "a-row",
        rect: { x: 60, y: 300, width: 1160, height: 56 },
      },
      {
        actionId: "act-3",
        anchorId: "a-checkout",
        rect: { x: 980, y: 620, width: 160, height: 44 },
      },
    ],
    markers: [
      { actionId: "act-1", sourceTimeMs: 400 },
      { actionId: "act-2", sourceTimeMs: 3200 },
      { actionId: "act-3", sourceTimeMs: 9000 },
    ],
    degradations: [],
    ...overrides,
  };
}
