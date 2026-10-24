import type { FrameBundle } from "../bundle.js";
import { findKeyframe, keyframesBetween } from "./keyframe.js";
import type { FrameImage, FrameSource } from "./types.js";

/**
 * Every frame is a still. This is the shape a keyframe-only bundle takes —
 * a v9 degradation, or a mutating scene's frozen frames — and it is also
 * what the harvested fixture uses.
 */
export function createImageFrameSource(
  bundle: FrameBundle,
  load: (ref: string) => Promise<Uint8Array | FrameImage>,
): FrameSource {
  const cache = new Map<string, Promise<FrameImage>>();
  const get = (ref: string): Promise<FrameImage> => {
    const hit = cache.get(ref);
    if (hit) return hit;
    // The mirror of `createVideoFrameSource`'s keyframe guard, and for the
    // same reason: `load` is one function serving both ref kinds, so the
    // wrong kind is a caller bug that must name itself rather than surface
    // later as an undecodable frame.
    const pending = load(ref).then((value) => {
      if (value instanceof Uint8Array) {
        throw new Error(
          `keyframe "${ref}" must load as an image, not encoded bytes`,
        );
      }
      return value;
    });
    cache.set(ref, pending);
    return pending;
  };

  return {
    async at(sourceTimeMs: number): Promise<FrameImage> {
      const keyframe = findKeyframe(bundle, sourceTimeMs);
      const image = await get(keyframe.ref);
      return { ...image, sourceTimeMs: keyframe.sourceTimeMs };
    },
    warm(fromSourceMs: number, toSourceMs: number): void {
      for (const keyframe of keyframesBetween(
        bundle,
        fromSourceMs,
        toSourceMs,
      )) {
        // Only this reference forgives: the failed load stays cached, and the
        // draw that reaches this still rejects with its reason.
        get(keyframe.ref).catch(() => undefined);
      }
    },
    describe: () => ({
      keyframes: bundle.keyframes,
      motionSpans: bundle.motionSpans,
    }),
  };
}
