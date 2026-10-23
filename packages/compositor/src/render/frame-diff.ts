/**
 * The 64x64 greyscale mean-absolute-difference probe.
 *
 * One body, two readers: `detectKeyframeMotion` asks "was the page moving
 * between these two keyframes", and `seamAt` asks "do the frames either side
 * of a cut match". They are the same measurement against the same
 * `RetimingPolicy.motionDiffThreshold`, and two copies of it would be two
 * numbers to drift — a seam the retimer calls motion and the cut calls clean
 * is a video that jumps where the editor promised it would not.
 *
 * Lifted out of `motion-detect.ts` unchanged on 2026-09-23. The threshold
 * does NOT live here: it is the policy's, and every caller passes its own.
 */

export const PROBE = 64;

export function greyscaleProbe(image: CanvasImageSource): Float32Array {
  const canvas = new OffscreenCanvas(PROBE, PROBE);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(image, 0, 0, PROBE, PROBE);
  const { data } = ctx.getImageData(0, 0, PROBE, PROBE);
  const out = new Float32Array(PROBE * PROBE);
  for (let i = 0; i < out.length; i++) {
    const r = data[i * 4] ?? 0;
    const g = data[i * 4 + 1] ?? 0;
    const b = data[i * 4 + 2] ?? 0;
    out[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  return out;
}

export function meanAbsDiff(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length;
}
