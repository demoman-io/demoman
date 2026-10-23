import type { FrameBundle } from "@demoman/compositor";
import type { SceneAction, SceneDocument } from "@demoman/scene-schema";
import { proceduralBundle } from "./bundles";
import { scene } from "./replay-scene";

type Kind = Exclude<SceneAction["kind"], "waitFor">;

/**
 * A take of one step per kind, on anchors `a1`, `a2`, … (the replay-scene
 * helper's shape), stamped a second apart. Kinds the helper does not build
 * (it builds clicks) are rebuilt here with exactly the schema's fields.
 */
export function takeOf(kinds: Kind[]): SceneDocument {
  const doc = scene({ anchorIds: kinds.map((_, i) => `a${i + 1}`) });
  return {
    ...doc,
    actions: doc.actions.map((a, i) => {
      const kind = kinds[i] as Kind;
      const base = {
        id: a.id,
        anchorId: a.anchorId as string,
        timestamp: 1000 * (i + 1),
        marker: `${kind}:${a.anchorId}`,
      };
      if (kind === "click") return { ...base, kind, button: "left" as const };
      if (kind === "type") return { ...base, kind, text: "x", redacted: false };
      return { ...base, kind };
    }),
  } as SceneDocument;
}

/** A replay bundle with nothing in it but what the caller names. */
export function framesOf(over: Partial<FrameBundle>): FrameBundle {
  return proceduralBundle({
    markers: [],
    anchorRects: [],
    cursorSamples: [],
    motionSpans: [],
    degradations: [],
    ...over,
  });
}

/** For report fixtures whose subject is not the film: both fields present,
 *  each saying plainly there was nothing checked. `look: null` is the
 *  re-shoot's reading — no take of its own, so no look — and a fixture whose
 *  subject is the look sets its own after the spread. `size: null` is the
 *  same reading for the run size (`RunReport.size`). */
export const NOT_CHECKED = {
  film: { unavailable: "noFrames" },
  recording: { unavailable: "noRecording" },
  look: null,
  size: null,
} as const;
