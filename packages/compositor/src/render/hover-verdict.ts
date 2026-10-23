import type { SceneDocument } from "@demoman/scene-schema";
import type { FrameBundle } from "../bundle.js";
import { inScreenSpace } from "../plan/screen-space.js";
import type { FrameImage, FrameSource } from "../ports/types.js";

/** The pointer arrived `HOVER_DWELL_MS` before the marker; sample before that. */
export const HOVER_PROBE_PRE_MS = 400;
/** The marker already sits after the transition, so a short tail suffices. */
export const HOVER_PROBE_POST_MS = 100;
/**
 * A JPEG macroblock is 8x8. Below that on a side there is no signal left to
 * separate a hover from compression noise, whatever the threshold.
 */
export const HOVER_MIN_CROP_PX = 8;

export interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type HoverProbeReason =
  | "notStyleSignalled"
  | "noMarker"
  | "noRect"
  | "crossFrameRect"
  | "degenerateRect"
  | "offFrame"
  | "cropTooSmall";

export type HoverProbe =
  | {
      kind: "probe";
      actionId: string;
      rect: ProbeRect;
      preMs: number;
      postMs: number;
    }
  | { kind: "unknown"; actionId: string; reason: HoverProbeReason };

/**
 * What can be asked of the pixels, and what cannot.
 *
 * Pure and frame-free by design: every reason a hover is uncheckable is
 * decided here, in the node lane, so none of them can hide behind a pixel
 * comparison that silently returns zero. See the spec's failure table — each
 * `unknown` below is a wrong `still` if it is not enumerated.
 */
export function planHoverProbes(
  givenScene: SceneDocument,
  givenBundle: FrameBundle,
): HoverProbe[] {
  // Cropped from the frames, so measured where the screen showed the target
  // (`screen-space.ts`), not in the page's own px.
  const { bundle, scene } = inScreenSpace(givenBundle, givenScene);
  const anchors = new Map(scene.anchors.map((a) => [a.id, a]));

  // An action's position on the bundle's SOURCE timeline comes from
  // `bundle.markers`, never from `action.timestamp` — same rule
  // `plan/resolve.ts:190`, `plan/timeline.ts:118` and `render/render.ts:251`
  // already follow. For a capture bundle the two agree, because markers are
  // built FROM `action.timestamp` (`replay/bundle.ts`). For a REPLAY bundle
  // they do not: markers are pushed on the replay clock
  // (`replay/engine.ts:908`), which drifts from the capture clock action by
  // action as replay adds its own settle and network waits. Probing on
  // `action.timestamp` there crops two frames from an unrelated, genuinely
  // static stretch of the replay and reports `still` with total confidence
  // about a hover it never looked at.
  const markerSourceMs = new Map(
    (bundle.markers ?? []).map((m) => [m.actionId, m.sourceTimeMs]),
  );

  // `anchorRects` wins over the fingerprint rect; the fingerprint rect is the
  // fallback for an action that has no entry of its own. Cropping from the
  // fingerprint rect when the layout at this action differs (a late-loading
  // header, a dismissed cookie banner, a different scroll position — the
  // entire reason `anchorRects` exists) lands both crops on the wrong region,
  // reads them as identical, and reports `still` with total confidence about
  // pixels nobody looked at.
  //
  // Two maps, not one — the same split, and for the same reason, as
  // `plan/resolve.ts`. `anchorRects` entries are per-ACTION
  // (`{actionId, anchorId, rect}`): replay re-measures the element at every
  // action and capture records the rect each sighting saw. Keying them all by
  // `anchorId` collapsed every action on one anchor onto whichever rect was
  // written last, so the second `moveTo` on a scrolled element cropped at a
  // different sighting's rect — the confident wrong answer this whole file
  // exists to refuse. Fixed here on 2026-09-04, after `resolve.ts` and
  // `plan.ts`: this file builds its map inline rather than calling `rectOf`,
  // so the caller search that found the others could not see it.
  const anchorRects = new Map<string, ProbeRect>();
  for (const anchor of scene.anchors) {
    if (anchor.fingerprint.boundingRect) {
      anchorRects.set(anchor.id, anchor.fingerprint.boundingRect);
    }
  }
  const actionRects = new Map<string, ProbeRect>();
  for (const entry of bundle.anchorRects ?? []) {
    actionRects.set(entry.actionId, entry.rect);
  }
  const rectOf = (anchorId: string, actionId: string): ProbeRect | null =>
    actionRects.get(actionId) ?? anchorRects.get(anchorId) ?? null;

  return scene.actions.flatMap((action): HoverProbe[] => {
    if (action.kind !== "moveTo") return [];
    const actionId = action.id;

    // Only a style-signalled hover is eligible. A mutation-signalled one was
    // witnessed by the DOM, and pixels do not get to overrule that.
    if (action.signal !== "style")
      return [{ kind: "unknown", actionId, reason: "notStyleSignalled" }];

    // No marker means no known position on the source timeline. Falling
    // back to `action.timestamp` here is precisely the defect this guard
    // exists to prevent — it would silently probe the wrong clock instead
    // of admitting the check cannot be made.
    const sourceTimeMs = markerSourceMs.get(actionId);
    if (sourceTimeMs === undefined)
      return [{ kind: "unknown", actionId, reason: "noMarker" }];

    const anchor =
      action.anchorId === null ? undefined : anchors.get(action.anchorId);
    const rect =
      action.anchorId === null ? null : rectOf(action.anchorId, actionId);
    if (rect === null) return [{ kind: "unknown", actionId, reason: "noRect" }];

    // A hop-prefixed treePath means this rect is in an iframe's coordinates.
    // Nothing stores the offset to the top document, so cropping the top
    // frame here lands on unrelated pixels — a confident wrong answer, which
    // is worse than no answer.
    if (anchor?.fingerprint.treePath?.startsWith("#frame(") === true)
      return [{ kind: "unknown", actionId, reason: "crossFrameRect" }];

    if (rect.width <= 0 || rect.height <= 0)
      return [{ kind: "unknown", actionId, reason: "degenerateRect" }];

    const { width: vw, height: vh } = bundle.viewport;
    if (
      rect.x < 0 ||
      rect.y < 0 ||
      rect.x + rect.width > vw ||
      rect.y + rect.height > vh
    )
      return [{ kind: "unknown", actionId, reason: "offFrame" }];

    if (rect.width < HOVER_MIN_CROP_PX || rect.height < HOVER_MIN_CROP_PX)
      return [{ kind: "unknown", actionId, reason: "cropTooSmall" }];

    return [
      {
        kind: "probe",
        actionId,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        preMs: sourceTimeMs - HOVER_PROBE_PRE_MS,
        postMs: sourceTimeMs + HOVER_PROBE_POST_MS,
      },
    ];
  });
}

/**
 * How far from the instant asked for a served frame may be and still answer
 * the question. Set equal to `SPAN_QUIET_MS`
 * (packages/replay-engine/src/constants.ts): that is already the
 * longest gap the take tolerates between frames during steady state, so a
 * served frame within that same gap is still describing the same instant.
 * Beyond it the frame is from a different moment of the take and says
 * nothing about this hover.
 */
export const HOVER_TIME_TOLERANCE_MS = 250;

/** Longest side of the probe grid. Small crops stay at native size. */
const PROBE_MAX = 64;

export type HoverVerdict =
  | { actionId: string; kind: "moved" }
  | { actionId: string; kind: "still" }
  | {
      actionId: string;
      kind: "unknown";
      reason:
        | HoverProbeReason
        | "sameFrame"
        | "outOfTolerance"
        | "nativeCropTooSmall"
        | "decodeFailed";
    };

function cropGreyscale(
  frame: FrameImage,
  rect: ProbeRect,
  viewport: { width: number; height: number },
  w: number,
  h: number,
): Float32Array {
  // `rect` is CSS pixels in the emulated viewport (bundle.ts), but the source
  // may be a DPR-3 keyframe or a surface-capped motion frame — the same fact
  // compose.ts's frame draw and detail.ts's sourceWidthAt already account
  // for. Scaling from this frame's own pixel dimensions, not a shared
  // factor, makes both the DPR upscale and the motion-span downscale
  // automatic: before and after can each be served by a keyframe or a
  // motion frame independently, so only a per-frame factor is honest.
  const sx = frame.width / viewport.width;
  const sy = frame.height / viewport.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(
    frame.image,
    rect.x * sx,
    rect.y * sy,
    rect.width * sx,
    rect.height * sy,
    0,
    0,
    w,
    h,
  );
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const r = data[i * 4] ?? 0;
    const g = data[i * 4 + 1] ?? 0;
    const b = data[i * 4 + 2] ?? 0;
    out[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  return out;
}

function meanAbsDiff(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / a.length;
}

/**
 * Did the screen change where the pointer was?
 *
 * `still` is the only verdict that costs the author anything, so it is the
 * only one requiring positive evidence: two frames, from two DIFFERENT source
 * times, both within tolerance of the instants asked for. Absence of frames is
 * never stillness — `motion-detect.ts` makes the general form of this point,
 * and here it is the difference between suggesting a removal and suggesting
 * one for no reason.
 */
export async function hoverVerdicts(
  scene: SceneDocument,
  bundle: FrameBundle,
  frames: FrameSource,
  threshold: number,
): Promise<HoverVerdict[]> {
  const out: HoverVerdict[] = [];

  for (const probe of planHoverProbes(scene, bundle)) {
    if (probe.kind === "unknown") {
      out.push({
        actionId: probe.actionId,
        kind: "unknown",
        reason: probe.reason,
      });
      continue;
    }

    let before: FrameImage;
    let after: FrameImage;
    try {
      before = await frames.at(probe.preMs);
      after = await frames.at(probe.postMs);
    } catch {
      out.push({
        actionId: probe.actionId,
        kind: "unknown",
        reason: "decodeFailed",
      });
      continue;
    }

    // Checked before tolerance: one frame serving both instants is the
    // specific way this comparison lies, and it deserves its own name in the
    // report rather than being folded into a distance complaint.
    if (before.sourceTimeMs === after.sourceTimeMs) {
      out.push({
        actionId: probe.actionId,
        kind: "unknown",
        reason: "sameFrame",
      });
      continue;
    }

    // This is also where the spec's "parking was suspended over that window"
    // case lands — a credential field or a spent byte budget leaves no frames,
    // so the nearest one is far away and the check declines here rather than
    // needing its own query against `bundle.degradations`.
    const drift = Math.max(
      Math.abs(before.sourceTimeMs - probe.preMs),
      Math.abs(after.sourceTimeMs - probe.postMs),
    );
    if (drift > HOVER_TIME_TOLERANCE_MS) {
      out.push({
        actionId: probe.actionId,
        kind: "unknown",
        reason: "outOfTolerance",
      });
      continue;
    }

    // planHoverProbes already enforces HOVER_MIN_CROP_PX once, in CSS pixels
    // — but that runs before any FrameSource is consulted, so it cannot know
    // what resolution the served frame actually carries. coversViewport only
    // requires the two axes to agree in scale, not that the scale is 1
    // (bundle.ts), so a motion-span frame legitimately captured below the
    // viewport turns an 8x8 CSS rect into a native crop under the macroblock
    // floor the upstream check exists to enforce. Re-checked here, in native
    // pixels, per frame — before and after can each be served at a different
    // scale, and either falling short is enough to starve the diff of signal.
    const nativeTooSmall = (frame: FrameImage): boolean => {
      const sx = frame.width / bundle.viewport.width;
      const sy = frame.height / bundle.viewport.height;
      return (
        probe.rect.width * sx < HOVER_MIN_CROP_PX ||
        probe.rect.height * sy < HOVER_MIN_CROP_PX
      );
    };
    if (nativeTooSmall(before) || nativeTooSmall(after)) {
      out.push({
        actionId: probe.actionId,
        kind: "unknown",
        reason: "nativeCropTooSmall",
      });
      continue;
    }

    const w = Math.max(1, Math.min(PROBE_MAX, Math.round(probe.rect.width)));
    const h = Math.max(1, Math.min(PROBE_MAX, Math.round(probe.rect.height)));
    let differ: number;
    try {
      differ = meanAbsDiff(
        cropGreyscale(before, probe.rect, bundle.viewport, w, h),
        cropGreyscale(after, probe.rect, bundle.viewport, w, h),
      );
    } catch {
      out.push({
        actionId: probe.actionId,
        kind: "unknown",
        reason: "decodeFailed",
      });
      continue;
    }

    out.push({
      actionId: probe.actionId,
      kind: differ > threshold ? "moved" : "still",
    });
  }

  return out;
}
