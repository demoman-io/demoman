import { type FrameBundle, type KeyframeEntry, keyframeAt } from "../bundle.js";

/**
 * `keyframeAt` for a frame source, which has to hand back a picture: a
 * bundle with no keyframes cannot serve any instant, and saying so here is
 * what keeps that from surfacing later as a frame that failed to load.
 */
export function findKeyframe(
  bundle: FrameBundle,
  sourceTimeMs: number,
): KeyframeEntry {
  const keyframe = keyframeAt(bundle, sourceTimeMs);
  if (!keyframe)
    throw new Error("frame bundle has no keyframes; cannot resolve a frame");
  return keyframe;
}

/**
 * Every keyframe a frame source can answer with across a stretch of source
 * time: the one in force at `fromMs`, and each that takes over after it up
 * to `toMs`. What `FrameSource.warm` decodes.
 */
export function keyframesBetween(
  bundle: FrameBundle,
  fromMs: number,
  toMs: number,
): KeyframeEntry[] {
  const first = keyframeAt(bundle, fromMs);
  return bundle.keyframes.filter(
    (k) => k === first || (k.sourceTimeMs > fromMs && k.sourceTimeMs <= toMs),
  );
}
