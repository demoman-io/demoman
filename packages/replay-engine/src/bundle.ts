import {
  type CursorGap,
  type CursorSample,
  type Degradation,
  type FrameBundle,
  type KeyframeEntry,
  type MotionSpanEntry,
  madeFromOf,
  type ViewportTransform,
  validateBundle,
} from "@demoman/compositor";
import type { SceneAction, SceneDocument } from "@demoman/scene-schema";
import type { RenderMode } from "./mode.js";
import { degradation } from "./span.js";

export interface Shot {
  sourceTimeMs: number;
  ref: string;
  width: number;
  height: number;
  byteLength: number;
}

/**
 * Which action each capture-time shot belongs to.
 *
 * The harvester learns of an action as it happens and can only shoot after
 * it, so a shot belongs to the last action whose timestamp precedes it. That
 * is a different instant from a replay keyframe, which is taken *at* the
 * marker before the verb fires — for a frozen scene the result is the right
 * frame anyway, but the two are not interchangeable.
 */
export function tagKeyframes(
  shots: Shot[],
  actions: SceneAction[],
): KeyframeEntry[] {
  const ordered = [...actions].sort((a, b) => a.timestamp - b.timestamp);
  return shots.map((shot) => {
    const preceding = ordered.filter((a) => a.timestamp <= shot.sourceTimeMs);
    return {
      sourceTimeMs: shot.sourceTimeMs,
      ref: shot.ref,
      width: shot.width,
      height: shot.height,
      actionId: preceding.at(-1)?.id ?? null,
      byteLength: shot.byteLength,
    };
  });
}

/**
 * Which bundle a render should use.
 *
 * Screen mode serves the frames the take itself recorded. The replay bundle
 * is kept rather than deleted, so a scene can move back to demo — and back to
 * screen again — without re-recording anything.
 *
 * In demo mode the older rule stands: a complete replay wins outright, and a
 * partial one stops mid-flow where the capture bundle covers the whole take,
 * so frozen frames win there — the partial bundle is kept, never chosen.
 */
export function chooseActiveBundle(
  replay: FrameBundle | null,
  capture: FrameBundle | null,
  replayComplete: boolean,
  mode: RenderMode,
): FrameBundle | null {
  if (mode === "screen" && capture !== null) return capture;
  if (replay !== null && replayComplete) return replay;
  if (capture !== null) return capture;
  return replay;
}

/**
 * The CSS viewport the frames were *actually* taken through, recovered from
 * the pixels rather than assumed.
 *
 * The recorded width is taken as correct and used to derive the scale the
 * frames came back at; the height is then rescaled by it. Anchored on width
 * because the thing this corrects for — the debugger infobar raised when the
 * capture harvester attaches — shortens the page and never narrows it.
 *
 * **Not** `frame ÷ dpr`, which is what this was until it was measured.
 * Against real Chromium, `Page.captureScreenshot` with the harvester's
 * parameters and *no* `Emulation.setDeviceMetricsOverride` returns CSS
 * pixels: at a 1280x800 viewport it came back 1280x800 at every one of
 * `devicePixelRatio` 1, 2 and 3. Dividing by a DPR of 2 there would have
 * reported a 640x400 viewport — further from the truth than the stale value
 * it was meant to correct. Under an explicit override the same call returns
 * 2560x1530 and 3840x2295, so both regimes exist and neither is inferable
 * from the bytes. A ratio against a known-good width spans both.
 *
 * The last shot is used because it is the closing one, taken at Stop — long
 * after any reflow on the way in, which the opening shot can race.
 *
 * This is a backstop, not the fix: the fix is `correctViewport`, measured in
 * the page. But that correction can be missed — an unscriptable tab, a popup
 * dismissed early — and this at least records the disagreement on disk rather
 * than letting the bundle repeat a claim its own pixels contradict.
 *
 * Note what "records" means and does not mean. It lands on `bundle.viewport`,
 * and the *drawing* still does not read that field: the compositor composes
 * from `scene.meta.capture.viewport` and always has. So a bundle whose
 * viewport was recovered here still renders stretched — this is a record of
 * the disagreement for whoever comes looking, not a correction of it. The
 * correction has to happen before `finalize` writes the document, which is
 * where `correctViewport` does it.
 *
 * One consumer does read it, and it is a different question. SP6's
 * `servingMotionSpan` asks whether a motion span's frames are a uniform
 * scale of this viewport and refuses to draw them when they are not — a
 * claim about the pixels, which is exactly what this field recovers from the
 * pixels. See `coversViewport`.
 */
function harvestedViewport(
  shots: Shot[],
  viewport: { width: number; height: number },
): { width: number; height: number } | null {
  const last = shots.at(-1);
  if (last === undefined) return null;
  if (viewport.width < 1 || last.width < 1 || last.height < 1) return null;
  const scale = last.width / viewport.width;
  const height = Math.round(last.height / scale);
  if (height < 1) return null;
  return { width: viewport.width, height };
}

/**
 * The deliverable a scene gets when replay does not run: frozen frames.
 *
 * Every take gets one of these, and for a mutating scene it is the whole
 * deliverable whenever the author's setting refuses replay — that decision
 * lives in `./policy.ts` and nowhere else; v9's older "a
 * mutating scene never replays" is no longer the rule. The pixels are
 * whatever the take itself recorded — one keyframe after each action.
 *
 * The take is screencast now, so there ARE motion spans: whatever the page
 * painted between the author's actions, which the action-triggered stills
 * never held. There are still no cursor samples — nothing was dispatched —
 * and `anchorRects` carries the rect each action saw, falling back to the
 * fingerprint's capture-time rect only where an action had none — which is
 * the truth for a frame no replay produced.
 *
 * Validated rather than trusted: a bundle assembled here is written straight
 * to disk and read back by the compositor much later, so the one moment it
 * can still be rejected usefully is this one. A take with no shots at all
 * throws here rather than storing a bundle SP6 will refuse.
 */
export function buildCaptureBundle(
  scene: SceneDocument,
  shots: Shot[],
  motion: { spans: MotionSpanEntry[]; degradations: Degradation[] } = {
    spans: [],
    degradations: [],
  },
  cursor: { samples: CursorSample[]; gaps: CursorGap[] } = {
    samples: [],
    gaps: [],
  },
  // The page's zoom over the take (`ViewportTransform`): every coordinate
  // above is in the page's own px, and the compositor draws them through it.
  transforms: ViewportTransform[] = [],
): FrameBundle {
  // No samples means the drawn cursor will be `synthesizeCursor`'s
  // reconstruction from the action log. That is a usable picture and not a
  // reason to fail the take — but it is not the same picture as a recorded
  // path, and a bundle that reported the two identically would be the
  // defect this field exists to prevent.
  const cursorDegradation: Degradation[] =
    cursor.samples.length === 0
      ? [
          degradation(
            "cursorSynthesized",
            0,
            Math.max(0, ...shots.map((s) => s.sourceTimeMs)),
            "no recorded pointer path; the drawn cursor is reconstructed from the action log",
          ),
        ]
      : [];

  return validateBundle({
    bundleVersion: 1,
    sceneId: scene.meta.id,
    source: "capture",
    dpr: scene.meta.capture.dpr,
    viewport:
      harvestedViewport(shots, scene.meta.capture.viewport) ??
      scene.meta.capture.viewport,
    keyframes: tagKeyframes(shots, scene.actions),
    motionSpans: motion.spans,
    cursorSamples: cursor.samples,
    cursorGaps: cursor.gaps,
    ...(transforms.length === 0 ? {} : { viewportTransforms: transforms }),
    // Was `[]` with a comment saying SP6 should fall back to the
    // fingerprint's capture-time rect. That fallback is still right for an
    // action with no rect — but an action that HAS one knows better than the
    // fingerprint does, because the fingerprint is the element's first
    // sighting and this is where it actually was.
    anchorRects: scene.actions.flatMap((action) =>
      action.rect === undefined || action.anchorId === null
        ? []
        : [
            {
              actionId: action.id,
              anchorId: action.anchorId,
              rect: action.rect,
            },
          ],
    ),
    markers: scene.actions.map((action) => ({
      actionId: action.id,
      sourceTimeMs: action.timestamp,
    })),
    degradations: [...motion.degradations, ...cursorDegradation],
    // The log this take recorded, so the editor can tell later which of the
    // author's edits the frames contain. Capture performs every step, so
    // nothing here is `cut` unless the document already carried cuts when
    // the take was finalized.
    madeFrom: madeFromOf(scene),
  } satisfies FrameBundle);
}
