import type { SceneDocument } from "@demoman/scene-schema";
import { type FrameBundle, servingMotionSpan } from "../src/bundle";
import { planScene } from "../src/plan/plan";
import { createImageFrameSource } from "../src/ports/frame-source-images";
import { createGifSink } from "../src/ports/sink-gif";
import { createMp4Sink } from "../src/ports/sink-mp4";
import { createPngSink } from "../src/ports/sink-png";
import { createOffscreenSurface } from "../src/ports/surface";
import type { FrameImage, FrameSource } from "../src/ports/types";
import type { DetailViolation } from "../src/render/detail";
import { renderScene, renderStills } from "../src/render/render";
import {
  GIF_800,
  pickLandscapeTarget,
  STILL_1440,
  VERTICAL_1080,
} from "../src/render/target";

/** One entry per screencast frame the harvest wrote, at its real arrival time. */
interface MotionFrame {
  ms: number;
  ref: string;
}

interface RenderManifest {
  files: { name: string; byteLength: number }[];
  detailViolations: Record<string, DetailViolation[]>;
}

async function loadImage(ref: string): Promise<FrameImage> {
  const blob = await (await fetch(`/${ref}`)).blob();
  const bitmap = await createImageBitmap(blob);
  // Both callers below stamp the real source time over this one before it
  // is ever handed to a renderer, so it never leaks past `loadImage` itself.
  return {
    image: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    sourceTimeMs: 0,
  };
}

/**
 * The harvested bundle's frame source.
 *
 * `createImageFrameSource` serves keyframes, which is right everywhere the
 * page is still — but the harvest also wrote the individual JPEGs of the
 * panel transition, and a motion span is precisely the stretch the retimer
 * passes through at rate 1.0. Served by the keyframe rule, that whole span
 * would render frozen and the one piece of real in-app motion in the fixture
 * would be invisible. So: inside a span, pick the nearest harvested frame by
 * time; everywhere else, delegate.
 *
 * This lives in the script, not in `src/`. Production's motion spans arrive
 * as encoded video and go through `createVideoFrameSource`; a directory of
 * numbered JPEGs is a harvest artefact, not a shape the compositor ships.
 */
function createHarvestFrameSource(
  bundle: FrameBundle,
  motionIndex: MotionFrame[],
  load: (ref: string) => Promise<FrameImage>,
): FrameSource {
  const keyframes = createImageFrameSource(bundle, load);
  // One-entry memo, not a cache: consecutive output frames often land on the
  // same source JPEG, but holding fifty decoded bitmaps of a 4K-adjacent
  // span is exactly the accumulation the streaming loop exists to avoid.
  let held: { ref: string; image: FrameImage } | null = null;

  const nearest = (sourceTimeMs: number): MotionFrame | null => {
    let best: MotionFrame | null = null;
    for (const frame of motionIndex) {
      if (
        !best ||
        Math.abs(frame.ms - sourceTimeMs) < Math.abs(best.ms - sourceTimeMs)
      ) {
        best = frame;
      }
    }
    return best;
  };

  return {
    async at(sourceTimeMs: number): Promise<FrameImage> {
      // `servingMotionSpan`, not a raw containment test: a keyframe sitting
      // exactly on a span boundary outranks the span, which is what lets a
      // still of `act-3` reach its 4K keyframe instead of the JPEG the span
      // also covers at that instant.
      const span = servingMotionSpan(bundle, sourceTimeMs);
      const frame = span ? nearest(sourceTimeMs) : null;
      if (!frame) return keyframes.at(sourceTimeMs);
      if (held?.ref === frame.ref) return held.image;
      const loaded = await load(frame.ref);
      // The harvested frame's own arrival time, not whatever instant landed
      // on it: two nearby requests can pick the same JPEG, and they must
      // report the same time served for the same reason the keyframe path
      // does — a diff between them must see zero, not a fabricated gap.
      const image = { ...loaded, sourceTimeMs: frame.ms };
      if (held?.image.image instanceof ImageBitmap) held.image.image.close();
      held = { ref: frame.ref, image };
      return image;
    },
    describe: () => keyframes.describe(),
  };
}

// A 4K MP4 is tens of megabytes. Base64-ing the whole set into one
// `page.evaluate` return value is a single enormous CDP message; the driver
// pulls it back in chunks instead, so the transport size is bounded.
const rendered = new Map<string, Uint8Array>();

(globalThis as unknown as { readChunk: unknown }).readChunk = (
  name: string,
  offset: number,
  length: number,
): string => {
  const bytes = rendered.get(name);
  if (!bytes) throw new Error(`no rendered output named ${name}`);
  const slice = bytes.subarray(offset, offset + length);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < slice.length; i += CHUNK) {
    binary += String.fromCharCode(...slice.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

(globalThis as unknown as { renderAll: unknown }).renderAll =
  async (): Promise<RenderManifest> => {
    const bundle: FrameBundle = await (await fetch("/bundle.json")).json();
    const scene: SceneDocument = await (await fetch("/scene.json")).json();
    const motionIndex: MotionFrame[] = bundle.motionSpans.length
      ? await (await fetch("/motion-index.json")).json()
      : [];

    const plan = planScene(scene);
    const frames = (): FrameSource =>
      createHarvestFrameSource(bundle, motionIndex, loadImage);
    const surface = createOffscreenSurface();
    const detailViolations: Record<string, DetailViolation[]> = {};

    const landscape = pickLandscapeTarget(bundle);
    console.log(
      `landscape target: ${landscape.width}x${landscape.height} @ ${landscape.fps}fps`,
    );
    const landscapeResult = await renderScene({
      plan,
      bundle,
      scene,
      target: landscape,
      ports: { frames: frames(), surface, video: createMp4Sink(landscape) },
    });
    rendered.set("landscape.mp4", landscapeResult.bytes);
    detailViolations["landscape.mp4"] = landscapeResult.detailViolations;

    // The same plan the landscape got. `renderScene` applies the vertical
    // camera cap itself now, from `target.fit`, so the caller does not have
    // to know that a `cover` crop is already a magnification.
    const verticalResult = await renderScene({
      plan,
      bundle,
      scene,
      target: VERTICAL_1080,
      ports: { frames: frames(), surface, video: createMp4Sink(VERTICAL_1080) },
    });
    rendered.set("vertical.mp4", verticalResult.bytes);
    detailViolations["vertical.mp4"] = verticalResult.detailViolations;

    const gifResult = await renderScene({
      plan,
      bundle,
      scene,
      target: GIF_800,
      ports: { frames: frames(), surface, gif: createGifSink(GIF_800) },
    });
    rendered.set("preview.gif", gifResult.bytes);
    detailViolations["preview.gif"] = gifResult.detailViolations;

    const stills = await renderStills({
      plan,
      bundle,
      scene,
      target: STILL_1440,
      ports: { frames: frames(), surface, images: createPngSink() },
    });
    for (const file of stills.files) rendered.set(file.name, file.bytes);
    detailViolations.stills = stills.detailViolations;

    return {
      files: [...rendered].map(([name, bytes]) => ({
        name,
        byteLength: bytes.byteLength,
      })),
      detailViolations,
    };
  };
