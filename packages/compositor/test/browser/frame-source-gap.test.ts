import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import { createVideoFrameSource } from "../../src/ports/frame-source-video";
import { createMp4Sink } from "../../src/ports/sink-mp4";
import { createOffscreenSurface } from "../../src/ports/surface";
import { LANDSCAPE_1080P } from "../../src/render/target";

/**
 * What the picture is between a span's end and the next keyframe.
 *
 * There is always such a gap and it cannot be closed upstream: the engine
 * takes its post-motion keyframe as soon as the span closes, and a
 * `Page.captureScreenshot` of a 5130x2520 page is not instant. Measured on a
 * two-navigation take through the real engine, the gaps were 114ms and 157ms
 * — about nine output frames each at 60fps.
 *
 * `findKeyframe` answers a gap with the nearest keyframe *at or before* it,
 * and across a navigation that keyframe is the page the take has already
 * left. So the video arrived on the new page inside the span, snapped back to
 * the old one for the gap, and arrived a second time at the next keyframe:
 * the flip the author reported, once per navigation.
 *
 * The span's own last frame is the truth for that gap. It is the most recent
 * thing anyone photographed.
 */
const SIZE = { width: 320, height: 200 };

/** A span that starts dark and ends bright, so its two ends are tellable. */
async function encodeSpan(): Promise<Uint8Array> {
  const target = { ...LANDSCAPE_1080P, ...SIZE, bitrate: 2_000_000 };
  const sink = createMp4Sink(target);
  const canvas = createOffscreenSurface().create(SIZE.width, SIZE.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  for (let i = 0; i < 30; i++) {
    // 20 -> 240: the span's arrival is unmistakably brighter than its start.
    const level = 20 + Math.round((i / 29) * 220);
    ctx.fillStyle = `rgb(${level}, ${level}, ${level})`;
    ctx.fillRect(0, 0, SIZE.width, SIZE.height);
    await sink.addFrame(canvas, i / 60, 1 / 60);
  }
  return sink.finish();
}

function brightnessOf(image: CanvasImageSource, w: number, h: number): number {
  const probe = new OffscreenCanvas(w, h);
  const ctx = probe.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(Math.round(w / 2), Math.round(h / 2), 1, 1)
    .data[0] as number;
}

/** A mid-grey still standing in for the keyframe taken BEFORE the span. */
async function beforeTheSpan(): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(SIZE.width, SIZE.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = "rgb(10, 10, 10)";
  ctx.fillRect(0, 0, SIZE.width, SIZE.height);
  return createImageBitmap(canvas);
}

describe("the gap between a span's end and the next keyframe", () => {
  it("holds the span's last frame, not the page from before the span", async () => {
    const encoded = await encodeSpan();
    const before = await beforeTheSpan();
    const bundle: FrameBundle = {
      bundleVersion: 1,
      sceneId: "s",
      source: "replay",
      dpr: 1,
      viewport: { width: 320, height: 200 },
      // The shape the engine actually produces around a navigating click:
      // a keyframe before the verb, the span, then the next keyframe once
      // the screenshot has been taken.
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 3086,
          ref: "k-before",
          ...SIZE,
          actionId: "act-3",
        },
        {
          byteLength: 0,
          sourceTimeMs: 4201,
          ref: "k-after",
          ...SIZE,
          actionId: null,
        },
      ],
      motionSpans: [
        {
          byteLength: 0,
          startMs: 3086,
          endMs: 4044,
          ref: "m-0",
          ...SIZE,
          fps: 60,
        },
      ],
      cursorSamples: [{ sourceTimeMs: 0, x: 0, y: 0 }],
      cursorGaps: [],
      anchorRects: [],
      markers: [],
      degradations: [],
    };

    const frames = await createVideoFrameSource(bundle, async (ref) => {
      if (ref === "m-0") return encoded;
      // Overwritten by `at()` with the real keyframe's own sourceTimeMs
      // regardless, but naming it here keeps the fixture honest about which
      // keyframe it stands in for.
      const keyframe = bundle.keyframes.find((k) => k.ref === ref);
      return {
        image: before,
        width: SIZE.width,
        height: SIZE.height,
        sourceTimeMs: keyframe?.sourceTimeMs ?? 0,
      };
    });

    const insideSpan = await frames.at(4000);
    const inTheGap = await frames.at(4120);
    const brightInside = brightnessOf(
      insideSpan.image,
      insideSpan.width,
      insideSpan.height,
    );
    const brightGap = brightnessOf(
      inTheGap.image,
      inTheGap.width,
      inTheGap.height,
    );
    console.log(`[gap] inside=${brightInside} gap=${brightGap}`);

    // The premise: the span really does end bright, so falling back to the
    // dark keyframe is a visible snap rather than a subtle one.
    expect(brightInside).toBeGreaterThan(150);
    // The claim. Answering the gap with `k-before` draws 10 — the page as it
    // was before the motion started, after the motion has finished.
    expect(brightGap).toBeGreaterThan(150);
  });
});
