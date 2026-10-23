// packages/run-core/src/render/mp4-cap.ts
//
// The ladder an MP4 with a size cap steps down (`export({ maxMB })`, spec
// 2026-10-18 §3.5 and §8). Pure: it decides what the next step is, and
// `renderOutput` decides whether to take it, from the bytes it rendered.
import { type RenderTarget, SHARE_QUALITY_FLOOR } from "@demoman/compositor";
import type { VideoStep } from "../export/report.js";

/**
 * At most this many steps, so four renders with the first. The ladder below
 * has three rungs and each applies once, so this only guards a share target
 * that would not end it (one without `encoder.quality`): a cap never loops.
 */
export const MAX_CAP_STEPS = 3;

/**
 * The next thing a cap lowers from `at`, or null when nothing is left. In
 * the order the author ruled on 2026-10-18 ("frame rate first, keep text
 * sharp"; "drop long videos to 0.35 to fit"), each skipped when it does not
 * apply:
 *
 * 1. `fps`: down to `share`'s frame rate (60 to 30), at the same frame and
 *    encoder, the bitrate scaled with it so each frame keeps its bits;
 * 2. `share`: the share target itself, frame and `quality` in one step, for
 *    a target that is not at the share frame or is encoded by bitrate (a
 *    full export already 1920x1080 still takes it);
 * 3. `quality`: `encoder.quality` down to `SHARE_QUALITY_FLOOR`.
 *
 * The frame never goes below `share`'s, and quality never below the floor.
 */
export function nextCapStep(
  at: RenderTarget,
  share: RenderTarget,
): { target: RenderTarget; step: VideoStep } | null {
  if (at.fps > share.fps) {
    return {
      target: {
        ...at,
        fps: share.fps,
        bitrate: Math.round((at.bitrate * share.fps) / at.fps),
      },
      step: { kind: "fps", from: at.fps, to: share.fps },
    };
  }
  const shareQuality = share.encoder?.quality;
  const quality = at.encoder?.quality;
  const atShare =
    at.width === share.width &&
    at.height === share.height &&
    (shareQuality === undefined ||
      (quality !== undefined && quality <= shareQuality));
  if (!atShare) {
    return {
      target: share,
      step: {
        kind: "share",
        from: { width: at.width, height: at.height },
        to: { width: share.width, height: share.height },
        ...(shareQuality === undefined ? {} : { quality: shareQuality }),
      },
    };
  }
  if (quality !== undefined && quality > SHARE_QUALITY_FLOOR) {
    return {
      target: {
        ...at,
        encoder: { ...at.encoder, quality: SHARE_QUALITY_FLOOR },
      },
      step: { kind: "quality", from: quality, to: SHARE_QUALITY_FLOOR },
    };
  }
  return null;
}
