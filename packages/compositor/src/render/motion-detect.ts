import type { FrameBundle } from "../bundle.js";
import { isUnkeptMotion, type TimeSpan } from "../plan/timeline.js";
import type { FrameSource } from "../ports/types.js";
// The probe moved to its own module on 2026-09-23 so `seamAt` measures a cut
// the same way this measures motion, against the same threshold. Unchanged
// in the move; see `frame-diff.ts`.
import { greyscaleProbe as greyscale, meanAbsDiff } from "./frame-diff.js";

/**
 * The bracketing-keyframe test from the design doc.
 *
 * It exists because SP1 measured a still page emitting almost no screencast
 * frames, so "no motion span here" is not evidence of stillness — a v9
 * keyframe-only degradation would otherwise be read as dead air and
 * compressed, retiming straight through in-app motion.
 *
 * Only gaps no motion span already covers are probed, so on a healthy render
 * this costs two downsamples per uncovered gap and nothing else.
 */
export async function detectKeyframeMotion(
  bundle: FrameBundle,
  frames: FrameSource,
  threshold: number,
): Promise<TimeSpan[]> {
  const covered = (start: number, end: number): boolean =>
    bundle.motionSpans.some((s) => s.startMs < end && s.endMs > start) ||
    bundle.degradations.some(
      (d) => isUnkeptMotion(d) && d.startMs < end && d.endMs > start,
    );

  const spans: TimeSpan[] = [];
  for (let i = 1; i < bundle.keyframes.length; i++) {
    const from = bundle.keyframes[i - 1];
    const to = bundle.keyframes[i];
    if (!from || !to) continue;
    if (to.sourceTimeMs <= from.sourceTimeMs) continue;
    if (covered(from.sourceTimeMs, to.sourceTimeMs)) continue;

    const a = greyscale((await frames.at(from.sourceTimeMs)).image);
    const b = greyscale((await frames.at(to.sourceTimeMs)).image);
    if (meanAbsDiff(a, b) > threshold) {
      spans.push({ startMs: from.sourceTimeMs, endMs: to.sourceTimeMs });
    }
  }
  return spans;
}
