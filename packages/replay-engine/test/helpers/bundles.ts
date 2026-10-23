import type { FrameBundle } from "@demoman/compositor";

/**
 * Mirrors packages/compositor/test/fixtures/bundle.ts: three markers, one
 * genuine motion span, DPR-3 keyframes against a surface-capped motion
 * stream. Copied rather than imported — another package's test directory is
 * not published, and reaching into it is the deep import the boundary rules
 * exist to prevent.
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
      { sourceTimeMs: 0, x: 200, y: 42 },
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

/**
 * A bundle with stationary cursor samples (same x/y at all times). With the
 * cursor stationary, the stretches between markers are classified as genuine
 * dead air rather than motion — which is what an authored gap retimes and
 * what a `"pace"` segment is reconstructed over. They are no longer
 * COMPRESSED: the idle clamp was deleted on 2026-09-08 so a demo keeps the
 * pauses its author left.
 */
export function stillCursorBundle(
  overrides: Partial<FrameBundle> = {},
): FrameBundle {
  const bundle = proceduralBundle();
  return {
    ...bundle,
    cursorSamples: [
      { sourceTimeMs: 0, x: 200, y: 42 },
      { sourceTimeMs: 400, x: 200, y: 42 },
      { sourceTimeMs: 3200, x: 200, y: 42 },
      { sourceTimeMs: 9000, x: 200, y: 42 },
    ],
    ...overrides,
  };
}

/**
 * A bundle whose cursor is stationary over a long head (0–5000) and then
 * moves, so `cursorMotionSpans` yields spans well clear of the take's start.
 * Paired with a scene that authors a gap, the reconstructed shortfall shifts
 * every one of those spans and source-ms differs from output-ms when mapped
 * through `toOutputMs` — which is what proves the trace-mapping test
 * exercises the mapping logic rather than an identity.
 *
 * The head used to compress on its own (to RETIMING_DEFAULTS.maxIdleMs, then
 * 400ms). That clamp was deleted on 2026-09-08; the authored gap is what
 * retimes now.
 */
export function compressionBundle(
  overrides: Partial<FrameBundle> = {},
): FrameBundle {
  const bundle = proceduralBundle();
  return {
    ...bundle,
    cursorSamples: [
      { sourceTimeMs: 0, x: 200, y: 42 },
      { sourceTimeMs: 5000, x: 200, y: 42 },
      { sourceTimeMs: 7000, x: 400, y: 300 },
      { sourceTimeMs: 9000, x: 1060, y: 642 },
    ],
    ...overrides,
  };
}

/** What a mutating scene gets: frozen frames, no samples, no anchor rects. */
export function captureBundle(
  overrides: Partial<FrameBundle> = {},
): FrameBundle {
  const bundle = proceduralBundle();
  return {
    ...bundle,
    sceneId: "scene-mutating-001",
    source: "capture",
    motionSpans: [],
    cursorSamples: [],
    cursorGaps: [],
    anchorRects: [],
    ...overrides,
  };
}
