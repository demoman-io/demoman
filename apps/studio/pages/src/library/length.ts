// apps/studio/pages/src/library/length.ts
import {
  createImageFrameSource,
  detectKeyframeMotion,
  type FrameBundle,
  type FrameImage,
  planScene,
  resolvePlan,
} from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";

/**
 * How long a take's export will run, or why it has no length to show.
 *
 * `nothing` is the two takes `renderScene` refuses with "nothing left to
 * render" — every step cut, or a trim whose ends meet. Kept apart from a
 * throw, which is a fault: a take with nothing left is a state the author
 * made on purpose, and the badge simply has no number to put up.
 */
export type EditedLength =
  | { kind: "measured"; ms: number }
  | { kind: "nothing"; reason: string };

/**
 * The edited length: what the exported video will run, after cuts, trims
 * and gaps — not the span of the raw recording, which disagrees with the
 * export as soon as the author has cut anything.
 *
 * The same front half the render takes (`render.ts`): the plan, the
 * keyframe-motion hints, then `resolvePlan`, whose `range` is the trimmed
 * stretch of the output axis the render walks. The render goes through
 * `composeForTarget`, which adds only `framedPlan` on the way in — a change
 * to camera intents, never to time — so the range is the same one.
 *
 * The hints are decoded only for a take with an authored gap, because
 * that is the only place motion moves the length: a gap retimes the idle
 * stretch beside it and leaves motion at 1.0, so whatever counts as motion
 * there is length. Everywhere else idle and motion both play at 1.0 and the
 * split between them changes nothing — measured on a capture take, 9330ms
 * with or without strong keyframe motion, uncut, cut or trimmed, against
 * 9330 / 6641ms once a gap is added. `library-length.test.ts` pins both
 * halves, so a timeline that starts retiming somewhere else turns it red
 * rather than leaving every badge short. A card without gaps decodes
 * nothing; one with them pays two decodes per uncovered keyframe gap.
 *
 * Hints from keyframes alone, where the export reads a video source too:
 * `detectKeyframeMotion` probes only the gaps no motion span covers, and
 * both sources answer a time in such a gap from its keyframe. They can
 * differ only at a gap's edge where a span begins on the very keyframe,
 * and there the span's first frame is that keyframe's moment.
 *
 * Every image decoded for the probe is closed before this returns: a
 * library of full-viewport bitmaps would otherwise wait on the collector.
 */
export async function editedLength(
  scene: SceneDocument,
  bundle: FrameBundle,
  load: (ref: string) => Promise<Uint8Array | FrameImage>,
): Promise<EditedLength> {
  const decoded: FrameImage[] = [];
  const tracked = async (ref: string): Promise<Uint8Array | FrameImage> => {
    const value = await load(ref);
    if (!(value instanceof Uint8Array)) decoded.push(value);
    return value;
  };
  try {
    const plan = planScene(scene);
    const hints =
      (scene.edits.gaps ?? []).length > 0
        ? await detectKeyframeMotion(
            bundle,
            createImageFrameSource(bundle, tracked),
            plan.retiming.motionDiffThreshold,
          )
        : [];
    const resolved = resolvePlan(plan, bundle, scene, hints);
    // The render's two refusals, in its order and on its terms.
    if (
      resolved.timeline.outputDurationMs === 0 &&
      resolved.timeline.cuts.length > 0
    ) {
      return { kind: "nothing", reason: "its removed pieces leave no frames" };
    }
    const { startMs, endMs } = resolved.range;
    if (resolved.timeline.outputDurationMs > 0 && endMs <= startMs) {
      return { kind: "nothing", reason: "its trim leaves no frames" };
    }
    return { kind: "measured", ms: endMs - startMs };
  } finally {
    for (const frame of decoded) {
      const image = frame.image as { close?: () => void };
      image.close?.();
    }
  }
}

/**
 * A length as a video player writes it: `0:05`, `1:24`, `1:02:03`.
 *
 * Rounded to the nearest second, not floored: a 9.6s export reads `0:10`,
 * the way every player's total does. A length under half a second still
 * shows `0:01` — a take with frames in it is never `0:00`, which reads as
 * empty.
 */
export function formatLength(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
