import type { FrameBundle, FrameImage } from "@demoman/compositor";

/**
 * Frames drawn programmatically, so a preview assertion is about the
 * preview and not about whatever a harvested JPEG happened to contain.
 * Each ref gets a distinct flat colour plus a marker square, which is what
 * lets a probe say *which* frame was served.
 */
export function proceduralFrames(bundle: FrameBundle): Map<string, FrameImage> {
  const frames = new Map<string, FrameImage>();
  const refs = [
    ...bundle.keyframes.map((k) => k.ref),
    ...bundle.motionSpans.map((s) => s.ref),
  ];

  refs.forEach((ref, index) => {
    const width = 1280;
    const height = 800;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.fillStyle = `rgb(${40 + index * 50}, 90, 140)`;
    ctx.fillRect(0, 0, width, height);
    // A landmark at a known CSS coordinate, for the mask probe.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(60, 380, 400, 24);
    // Overwritten by `createImageFrameSource`'s `at()` with the real
    // keyframe time regardless of what is set here.
    frames.set(ref, {
      image: canvas.transferToImageBitmap(),
      width,
      height,
      sourceTimeMs: 0,
    });
  });

  return frames;
}
