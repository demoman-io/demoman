import type { FrameBundle } from "../../src/bundle";
import type { FrameImage, FrameSource } from "../../src/ports/types";

/**
 * A deliberately plain fake app: header bar, sidebar, a table of rows, and a
 * panel that slides open across the motion span. Drawn in *viewport* CSS
 * coordinates then scaled to whatever the frame's real pixel size is, so a
 * DPR-3 keyframe and a surface-capped motion frame show the same layout at
 * different resolutions — which is the mismatch the compositor upscales through.
 *
 * Procedural frames prove correctness. They cannot prove the output looks
 * produced; that is what the harvested fixture is for.
 */
function drawApp(
  ctx: OffscreenCanvasRenderingContext2D,
  viewport: { width: number; height: number },
  panelOpen: number,
): void {
  ctx.fillStyle = "#f6f7f9";
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  ctx.fillStyle = "#1f2937";
  ctx.fillRect(0, 0, viewport.width, 72);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(40, 24, 320, 36);

  ctx.fillStyle = "#e5e7eb";
  ctx.fillRect(0, 72, 220, viewport.height - 72);

  for (let row = 0; row < 8; row++) {
    const y = 100 + row * 70;
    ctx.fillStyle = row % 2 === 0 ? "#ffffff" : "#f0f1f4";
    ctx.fillRect(240, y, viewport.width - 280, 56);
    ctx.fillStyle = "#9ca3af";
    ctx.fillRect(260, y + 20, 180, 16);
  }

  ctx.fillStyle = "#3b5bdb";
  ctx.fillRect(980, 620, 160, 44);

  // The animating panel: its width is the only thing that moves, which makes
  // "did this span have motion" a visible fact rather than an assertion.
  if (panelOpen > 0) {
    ctx.fillStyle = "#111827";
    ctx.globalAlpha = 0.9;
    ctx.fillRect(
      viewport.width - 360 * panelOpen,
      72,
      360 * panelOpen,
      viewport.height - 72,
    );
    ctx.globalAlpha = 1;
  }
}

export function createProceduralFrameSource(bundle: FrameBundle): FrameSource {
  // Keyframes are served from a cache. A render allocates a canvas at the
  // keyframe's full pixel size — 3840x2400 is 36 MB — and paints the app
  // into it, and a keyframe-only stretch asks for the same keyframe on every
  // output frame. Two tests in compose.test.ts do that 50 times each, and on
  // a GitHub runner that put them at 14–16s against a 15s budget
  // (2026-09-05). Sharing is safe: every consumer only draws from `image`,
  // and `frame-source-images.ts` already hands out one image many times.
  // Span frames are not cached — each carries its own interpolated `t`.
  const keyframeCache = new Map<string, FrameImage>();
  const render = (
    width: number,
    height: number,
    panelOpen: number,
    sourceTimeMs: number,
  ): FrameImage => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.scale(width / bundle.viewport.width, height / bundle.viewport.height);
    drawApp(ctx, bundle.viewport, panelOpen);
    return { image: canvas, width, height, sourceTimeMs };
  };

  return {
    async at(sourceTimeMs: number): Promise<FrameImage> {
      const span = bundle.motionSpans.find(
        (s) => sourceTimeMs >= s.startMs && sourceTimeMs <= s.endMs,
      );
      if (span) {
        const t =
          (sourceTimeMs - span.startMs) /
          Math.max(1, span.endMs - span.startMs);
        // Interpolated exactly for the instant asked, unlike a real decoder:
        // the requested time IS the time served.
        return render(span.width, span.height, t, sourceTimeMs);
      }
      // Nearest keyframe at or before the requested time.
      const keyframe =
        [...bundle.keyframes]
          .reverse()
          .find((k) => k.sourceTimeMs <= sourceTimeMs) ??
        (bundle.keyframes[0] as (typeof bundle.keyframes)[number]);
      const lastSpan = bundle.motionSpans[bundle.motionSpans.length - 1];
      const panelOpen =
        lastSpan && keyframe.sourceTimeMs >= lastSpan.endMs ? 1 : 0;
      const key = `${keyframe.width}x${keyframe.height}:${panelOpen}:${keyframe.sourceTimeMs}`;
      let cached = keyframeCache.get(key);
      if (!cached) {
        cached = render(
          keyframe.width,
          keyframe.height,
          panelOpen,
          keyframe.sourceTimeMs,
        );
        keyframeCache.set(key, cached);
      }
      return cached;
    },
    describe: () => ({
      keyframes: bundle.keyframes,
      motionSpans: bundle.motionSpans,
    }),
  };
}
