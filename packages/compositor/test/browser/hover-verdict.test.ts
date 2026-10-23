import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import type { FrameImage, FrameSource } from "../../src/ports/types";
import { hoverVerdicts } from "../../src/render/hover-verdict";

function painted(fill: string, badge: string | null): OffscreenCanvas {
  const canvas = new OffscreenCanvas(1280, 800);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 1280, 800);
  ctx.fillStyle = fill;
  ctx.fillRect(100, 100, 200, 60);
  if (badge !== null) {
    ctx.fillStyle = badge;
    ctx.fillRect(900, 400, 120, 40);
  }
  return canvas;
}

const frame = (canvas: OffscreenCanvas, sourceTimeMs: number): FrameImage => ({
  image: canvas,
  width: 1280,
  height: 800,
  sourceTimeMs,
});

// DPR-2 native canvas against a CSS 1280x800 viewport. The block sits at the
// correctly-scaled native rect (CSS {100,100,200,60} * 2 = {200,200,400,120})
// so a correct crop lands on it and an unscaled crop — which would read CSS
// pixels straight into native ones and land at {100,100,200,60} — misses it
// entirely, since that has no vertical overlap with the block at all.
function paintedNativeDpr2(blockFill: string): OffscreenCanvas {
  const canvas = new OffscreenCanvas(2560, 1600);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 2560, 1600);
  ctx.fillStyle = blockFill;
  ctx.fillRect(200, 200, 400, 120);
  return canvas;
}

const frameDpr2 = (
  canvas: OffscreenCanvas,
  sourceTimeMs: number,
): FrameImage => ({
  image: canvas,
  width: 2560,
  height: 1600,
  sourceTimeMs,
});

// Scale-0.5 native canvas: a motion-span frame legitimately captured below
// the viewport (bundle.ts's coversViewport only requires the two axes to
// agree in scale, not that the scale is 1). The block at native
// (40,40)-(100,100) fully covers both the 5x5 crop CSS{100,100,10,10} maps
// to (native (50,50)-(55,55)) and the 20x20 crop CSS{100,100,40,40} maps to
// (native (50,50)-(70,70)), so before and after genuinely differ in either
// crop region — a check that skips the diff must do so on its own evidence,
// not because there was nothing to see.
function paintedNativeHalf(blockFill: string): OffscreenCanvas {
  const canvas = new OffscreenCanvas(640, 400);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 640, 400);
  ctx.fillStyle = blockFill;
  ctx.fillRect(40, 40, 60, 60);
  return canvas;
}

const frameHalf = (
  canvas: OffscreenCanvas,
  sourceTimeMs: number,
): FrameImage => ({
  image: canvas,
  width: 640,
  height: 400,
  sourceTimeMs,
});

// `action.timestamp` below is 2000; the marker echoes it so every test in
// this file except the marker-resolution one exercises exactly what it did
// before markers existed as a source of truth for an action's source time.
const bundle = {
  viewport: { width: 1280, height: 800 },
  markers: [{ actionId: "act-1", sourceTimeMs: 2000 }],
} as unknown as FrameBundle;

const scene: SceneDocument = {
  anchors: [
    {
      id: "a1",
      fingerprint: {
        stableId: "menu",
        role: null,
        accessibleName: null,
        textContent: null,
        treePath: "div:0/button:1",
        boundingRect: { x: 100, y: 100, width: 200, height: 60 },
        imagePatchRef: null,
        dataKey: null,
      },
    },
  ],
  actions: [
    {
      id: "act-1",
      kind: "moveTo",
      anchorId: "a1",
      timestamp: 2000,
      marker: "m1",
      signal: "style",
    },
  ],
} as unknown as SceneDocument;

function sceneWithRect(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): SceneDocument {
  const clone = JSON.parse(JSON.stringify(scene)) as SceneDocument;
  (
    clone.anchors[0] as { fingerprint: { boundingRect: unknown } }
  ).fingerprint.boundingRect = rect;
  return clone;
}

function source(map: { at: number; frame: FrameImage }[]): FrameSource {
  return {
    async at(t: number) {
      // Nearest AT OR BEFORE, falling back to the first — the same rule the
      // real `findKeyframe` uses. A plain "nearest" fake would resolve the
      // out-of-tolerance fixture's two requests onto one late frame and turn
      // that case into `sameFrame`, testing the wrong guard.
      const entry = [...map].reverse().find((e) => e.at <= t) ?? map[0];
      return (entry as { frame: FrameImage }).frame;
    },
    describe: () => ({ keyframes: [], motionSpans: [] }),
  };
}

describe("hoverVerdicts", () => {
  it("reports moved when the crop changed", async () => {
    const frames = source([
      { at: 1600, frame: frame(painted("#dddddd", null), 1600) },
      { at: 2100, frame: frame(painted("#333333", null), 2100) },
    ]);
    expect(await hoverVerdicts(scene, bundle, frames, 0.02)).toEqual([
      { actionId: "act-1", kind: "moved" },
    ]);
  });

  it("reports still when only pixels outside the crop changed", async () => {
    // The badge at 900,400 is nowhere near the hovered rect. A whole-frame
    // diff would call this motion; a cropped one must not.
    const frames = source([
      { at: 1600, frame: frame(painted("#dddddd", null), 1600) },
      { at: 2100, frame: frame(painted("#dddddd", "#ff0000"), 2100) },
    ]);
    expect(await hoverVerdicts(scene, bundle, frames, 0.02)).toEqual([
      { actionId: "act-1", kind: "still" },
    ]);
  });

  it("refuses a verdict when both requests resolved to the same frame", async () => {
    // 1850 is the ONLY instant within tolerance of both 1600 and 2100 (they
    // are 500ms apart and tolerance is +-250), so this fixture isolates the
    // same-frame guard from the tolerance guard. At any other time tolerance
    // fires first and this test would prove nothing about same-frame.
    const one = frame(painted("#dddddd", null), 1850);
    const frames = source([{ at: 1850, frame: one }]);
    expect(await hoverVerdicts(scene, bundle, frames, 0.02)).toEqual([
      { actionId: "act-1", kind: "unknown", reason: "sameFrame" },
    ]);
  });

  it("refuses a verdict when the nearest frame is too far from the instant asked for", async () => {
    const frames = source([
      { at: 0, frame: frame(painted("#dddddd", null), 0) },
      { at: 2100, frame: frame(painted("#333333", null), 2100) },
    ]);
    expect(await hoverVerdicts(scene, bundle, frames, 0.02)).toEqual([
      { actionId: "act-1", kind: "unknown", reason: "outOfTolerance" },
    ]);
  });

  it("scales the crop rect into a DPR-2 frame's native pixels", async () => {
    // bundle.viewport stays CSS 1280x800; these frames report their own
    // native 2560x1600. Without per-frame scaling this crop would read
    // {100,100,200,60} straight out of the native buffer, which has no
    // vertical overlap with the block at native {200,200,400,120}, so both
    // crops would come back plain white and report `still` where the block
    // actually changed color.
    const frames = source([
      { at: 1600, frame: frameDpr2(paintedNativeDpr2("#888888"), 1600) },
      { at: 2100, frame: frameDpr2(paintedNativeDpr2("#000000"), 2100) },
    ]);
    expect(await hoverVerdicts(scene, bundle, frames, 0.02)).toEqual([
      { actionId: "act-1", kind: "moved" },
    ]);
  });

  it("refuses a verdict when the native crop falls under the macroblock floor", async () => {
    // CSS {100,100,10,10} clears planHoverProbes's CSS-pixel HOVER_MIN_CROP_PX
    // gate (10 >= 8), but at this frame's 0.5 scale the native crop is only
    // 5x5 — under the same floor, just discovered a stage later. The block
    // genuinely differs between before and after in that exact region, so
    // without the native-space check this would reach the diff and report
    // `moved`, not fail by accident.
    const rectScene = sceneWithRect({ x: 100, y: 100, width: 10, height: 10 });
    const frames = source([
      { at: 1600, frame: frameHalf(paintedNativeHalf("#888888"), 1600) },
      { at: 2100, frame: frameHalf(paintedNativeHalf("#000000"), 2100) },
    ]);
    expect(await hoverVerdicts(rectScene, bundle, frames, 0.02)).toEqual([
      { actionId: "act-1", kind: "unknown", reason: "nativeCropTooSmall" },
    ]);
  });

  it("still reaches the diff when the native crop clears the floor", async () => {
    // Same 0.5-scale frames, but CSS {100,100,40,40} maps to a 20x20 native
    // crop — above HOVER_MIN_CROP_PX — so the native-space check must not
    // block it, and the genuine color change in that region reports `moved`.
    const rectScene = sceneWithRect({ x: 100, y: 100, width: 40, height: 40 });
    const frames = source([
      { at: 1600, frame: frameHalf(paintedNativeHalf("#888888"), 1600) },
      { at: 2100, frame: frameHalf(paintedNativeHalf("#000000"), 2100) },
    ]);
    expect(await hoverVerdicts(rectScene, bundle, frames, 0.02)).toEqual([
      { actionId: "act-1", kind: "moved" },
    ]);
  });

  it("prefers the bundle's replay-measured rect over the fingerprint's capture-time rect", async () => {
    // The fingerprint rect (100,100,200,60) is IDENTICAL between the two
    // frames below — using it would report `still`. The bundle supplies a
    // different rect for the same anchor, keyed by anchorId exactly as
    // `resolve.ts` does: the badge region at (900,400,120,40), which
    // genuinely differs between the frames (absent, then painted red). Only
    // an implementation that prefers the bundle's rect can see that
    // difference and report `moved`; one that falls back to the fingerprint
    // sees two identical crops and reports `still`, so this fails if C1
    // regresses.
    const bundleWithReplayRect = {
      viewport: { width: 1280, height: 800 },
      anchorRects: [
        {
          actionId: "act-1",
          anchorId: "a1",
          rect: { x: 900, y: 400, width: 120, height: 40 },
        },
      ],
      markers: [{ actionId: "act-1", sourceTimeMs: 2000 }],
    } as unknown as FrameBundle;
    const frames = source([
      { at: 1600, frame: frame(painted("#dddddd", null), 1600) },
      { at: 2100, frame: frame(painted("#dddddd", "#ff0000"), 2100) },
    ]);
    expect(
      await hoverVerdicts(scene, bundleWithReplayRect, frames, 0.02),
    ).toEqual([{ actionId: "act-1", kind: "moved" }]);
  });

  it("carries a planning refusal through unchanged", async () => {
    const noRect = JSON.parse(JSON.stringify(scene)) as SceneDocument;
    (
      noRect.anchors[0] as { fingerprint: { boundingRect: unknown } }
    ).fingerprint.boundingRect = null;
    const frames = source([
      { at: 1600, frame: frame(painted("#dddddd", null), 1600) },
    ]);
    expect(await hoverVerdicts(noRect, bundle, frames, 0.02)).toEqual([
      { actionId: "act-1", kind: "unknown", reason: "noRect" },
    ]);
  });

  it("probes the marker's source time, not the action's own capture-clock timestamp", async () => {
    // `scene.actions[0].timestamp` is 2000 (capture clock). This bundle's
    // marker for the same action sits at 6000 — the way a REPLAY bundle's
    // marker (pushed on the replay clock, `engine.ts:908`) drifts from the
    // capture clock `action.timestamp` was authored against. Frames are
    // planted so the two clocks disagree about what happened: around 2000
    // the pixels genuinely change (`moved`); around 6000 they do not
    // (`still`, from two distinct source times so the same-frame guard
    // cannot mask the point). An implementation that reads
    // `action.timestamp` probes 1600/2100 and reports `moved`; only one that
    // resolves through `bundle.markers` probes 5600/6100 and reports
    // `still`.
    const driftedBundle = {
      viewport: { width: 1280, height: 800 },
      markers: [{ actionId: "act-1", sourceTimeMs: 6000 }],
    } as unknown as FrameBundle;
    const frames = source([
      { at: 1600, frame: frame(painted("#dddddd", null), 1600) },
      { at: 2100, frame: frame(painted("#333333", null), 2100) },
      { at: 5600, frame: frame(painted("#dddddd", null), 5600) },
      { at: 6100, frame: frame(painted("#dddddd", null), 6100) },
    ]);
    expect(await hoverVerdicts(scene, driftedBundle, frames, 0.02)).toEqual([
      { actionId: "act-1", kind: "still" },
    ]);
  });

  it("refuses a verdict when the bundle has no marker for the action, rather than falling back to its timestamp", async () => {
    const noMarkerBundle = {
      viewport: { width: 1280, height: 800 },
      markers: [],
    } as unknown as FrameBundle;
    const frames = source([
      { at: 1600, frame: frame(painted("#dddddd", null), 1600) },
      { at: 2100, frame: frame(painted("#333333", null), 2100) },
    ]);
    expect(await hoverVerdicts(scene, noMarkerBundle, frames, 0.02)).toEqual([
      { actionId: "act-1", kind: "unknown", reason: "noMarker" },
    ]);
  });
});
