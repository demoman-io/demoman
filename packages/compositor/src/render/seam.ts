import type { FrameBundle } from "../bundle.js";
import type { FrameImage, FrameSource } from "../ports/types.js";
import { greyscaleProbe, meanAbsDiff } from "./frame-diff.js";

/**
 * Whether the frames either side of a cut join up.
 *
 * Decided by the FRAMES, not by the DOM (spec §1, decision 3): the frame the
 * compositor would show at the stretch's start against the one it would show
 * at its end. The cursor is drawn by the compositor AFTER this lookup, so it
 * is in neither frame and cannot make a still page look like a jump.
 *
 * `unknown` is never reported as `clean`, and is treated as a jump
 * everywhere downstream. That is the whole reason this returns a union
 * rather than a boolean: "the frames match" and "we could not look" have
 * opposite consequences for the author and the same shape in a boolean.
 */
export type Seam =
  | { kind: "clean" }
  | { kind: "jump"; diff: number }
  | { kind: "unknown"; reason: string };

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `frames` must be the SAME `FrameSource` the preview draws with — the
 * editor passes its `framesFor` cache. The test then measures what a viewer
 * would see rather than what the store holds: a motion span that will not
 * decode is served as the preceding keyframe by both, so the seam is judged
 * against the picture the author is actually looking at.
 *
 * `bundle` is here for the in-range check alone. A range outside the frames
 * is `unknown`, not an exception: a cut placed against one bundle and tested
 * against a shorter one is a reachable state, not a programming error.
 */
export async function seamAt(args: {
  frames: FrameSource;
  bundle: FrameBundle;
  range: { srcStartMs: number; srcEndMs: number };
  threshold: number;
}): Promise<Seam> {
  const { frames, bundle, range, threshold } = args;
  const lastKeyframe = bundle.keyframes[bundle.keyframes.length - 1];
  const endOfFrames = Math.max(
    lastKeyframe?.sourceTimeMs ?? 0,
    ...bundle.motionSpans.map((s) => s.endMs),
    ...bundle.markers.map((m) => m.sourceTimeMs),
  );
  if (range.srcStartMs < 0 || range.srcEndMs > endOfFrames) {
    return {
      kind: "unknown",
      reason: `this cut covers ${Math.round(range.srcStartMs)}–${Math.round(range.srcEndMs)}ms, which lies outside the frames (they end at ${Math.round(endOfFrames)}ms), so the two sides could not be compared`,
    };
  }

  let before: FrameImage;
  let after: FrameImage;
  try {
    before = await frames.at(range.srcStartMs);
  } catch (error) {
    return {
      kind: "unknown",
      reason: `the frame before this cut (${Math.round(range.srcStartMs)}ms) could not be read: ${message(error)}`,
    };
  }
  try {
    after = await frames.at(range.srcEndMs);
  } catch (error) {
    return {
      kind: "unknown",
      reason: `the frame after this cut (${Math.round(range.srcEndMs)}ms) could not be read: ${message(error)}`,
    };
  }

  // The frame SERVED, not the instant asked for. A keyframe-only stretch is
  // answered with the nearest preceding keyframe however far away it is, so
  // two instants seconds apart can come back as one image — which diffs to
  // exactly zero and would be reported as the cleanest seam in the take.
  // `FrameImage.sourceTimeMs` is required rather than optional for exactly
  // this comparison; see its docblock.
  if (before.sourceTimeMs === after.sourceTimeMs) {
    return {
      kind: "unknown",
      reason: `both sides of this cut are served by the same frame (${Math.round(before.sourceTimeMs)}ms) — the stretch it covers has no frames of its own — so nothing was compared`,
    };
  }

  const diff = meanAbsDiff(
    greyscaleProbe(before.image),
    greyscaleProbe(after.image),
  );
  return diff > threshold ? { kind: "jump", diff } : { kind: "clean" };
}
