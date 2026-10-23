import type { FrameBundle, FrameImage } from "@demoman/compositor";
import type { ReplayStatus } from "../../../pages/src/core/replay/status";
import type { CaptureStatus } from "../../../pages/src/core/storage/types";
import type { BundleSource } from "../../../pages/src/editor/ports";

/**
 * A take's frames held in memory: the bundle, and an image per ref. Every
 * preview and view test runs against this.
 *
 * Lived in the extension's `src/adapters/bundle-source.ts` beside its
 * messaging source until 2026-10-20, when the pages moved to apps/studio
 * and the extension was archived.
 */
export function createFixtureBundleSource(
  bundle: FrameBundle,
  images: Map<string, FrameImage>,
  replay: ReplayStatus | null = null,
  capture: CaptureStatus | null = null,
): BundleSource {
  return {
    active: async () => ({ bundle, replay, capture }),
    load: async (ref: string) => {
      const image = images.get(ref);
      if (!image) throw new Error(`fixture has no frame "${ref}"`);
      return image;
    },
  };
}
