import {
  coversViewport,
  type FrameBundle,
  keyframeAt,
  servingMotionSpan,
} from "../bundle.js";
import { clamp } from "../geometry.js";
import type { CameraKey } from "../plan/camera.js";
import { type Timeline, toOutputMs, toSourceMs } from "../plan/timeline.js";

export interface DetailViolation {
  outputTimeMs: number;
  requestedScale: number;
  grantedScale: number;
  sourceWidth: number;
  /**
   * Source pixels the output wanted across the drawn frame, at the GRANTED
   * scale — so `sourceWidth / neededWidth` is the sampling the deliverable
   * actually gets, and anything below 1.0 is an upscale.
   *
   * Carried rather than recomputed by the consumer, because recomputing it
   * needs `outputPxPerCssPx` and the viewport, neither of which survives
   * into the export panel. Without it a violation could say a zoom was cut
   * but never say the picture is still short of its own resolution.
   */
  neededWidth: number;
}

/** Pixel width of whatever the frame source will hand back at this source time. */
export function sourceWidthAt(
  bundle: FrameBundle,
  sourceTimeMs: number,
): number {
  const span = servingMotionSpan(bundle, sourceTimeMs);
  if (span) return span.width;
  return keyframeAt(bundle, sourceTimeMs)?.width ?? 0;
}

/**
 * Do not claim detail the frames do not carry.
 *
 * Effective sampling is source pixels per output pixel across the width the
 * app content is actually drawn into. Where a zoom would push that below 1.0,
 * the scale is cut back — but never below 1.0 itself, because refusing the
 * shot entirely is a worse deliverable than a slightly soft one, and the
 * camera track is authored intent.
 *
 * `outputPxPerCssPx` is `contentScale(presentation.frameRect,
 * viewport)`, never anything derived from `target.width`. Those differ,
 * always: the frame is inset by the branding's `padding` and, under `contain`, fitted
 * to the capture's aspect, so at 4K the content is drawn well under 3840px.
 * Measuring against the target overstates the output resolution and refuses
 * zoom the frames could comfortably back — on the harvested fixture it turned
 * 1.23x of real headroom into a flat refusal, and the 4K deliverable came out
 * with no camera move at all.
 *
 * The gap is not a fixed figure and this comment no longer quotes one: it
 * said "3110px wide, not 3840", which was true only at the 0.05 inset the
 * landscape presets carried until 2026-09-21. The branding's `padding` is
 * the number that moves it, and the widths follow from whatever it is.
 *
 * The margin is the cheapest detail the pipeline has: headroom is source
 * pixels over the width the app is drawn at, so a bigger padding is a
 * sharper zoom. Measured on 2026-09-21 against a real 1140x624 take at
 * 1440p, whose replay keyframes carry 3420px and whose motion spans carry
 * 2280px:
 *
 * | padding | drawn  | stills | motion          |
 * | ---     | ---    | ---    | ---             |
 * | 0.05    | 2368px | 1.44x  | 0.96 — upscaled |
 * | 0.15    | 1842px | 1.86x  | 1.24            |
 *
 * At 0.05 that take's authored 1.8x zoom was cut to 1.44x and every moving
 * beat was upscaled; at 0.15 the zoom was backed outright. Landscape exports
 * drew 0.15 for that reason until 2026-10-05, when the margin became the
 * author's (8% by default). The trade is theirs now, and every cut this
 * makes is reported, so a small margin never goes soft without saying so.
 *
 * Taking the scale factor rather than a width also keeps this honest under
 * `cover`, where the frame does not share the capture's aspect and the factor
 * comes off the *other* axis entirely.
 *
 * Every cut is recorded. Silently upscaling to hit a number on a spec sheet
 * is precisely the shortcut a side-by-side comparison punishes.
 */
export function clampToSourceDetail(args: {
  keys: CameraKey[];
  timeline: Timeline;
  bundle: FrameBundle;
  /** Output pixels per CSS pixel at camera scale 1 — `contentScale(...)`. */
  outputPxPerCssPx: number;
  viewport: { width: number; height: number };
}): { keys: CameraKey[]; violations: DetailViolation[] } {
  const { keys, timeline, bundle, outputPxPerCssPx, viewport } = args;
  const violations: DetailViolation[] = [];

  const clampKey = (key: CameraKey): CameraKey => {
    const sourceWidth = sourceWidthAt(
      bundle,
      toSourceMs(timeline, key.outputTimeMs),
    );

    if (sourceWidth === 0) return key;

    // The grant is the still's, not the instant's (author's ruling,
    // 2026-10-11). Measured against whatever served this instant, a zoom
    // that arrived while the page was repainting took the motion span's
    // measure — the display's 2x against stills at 3x — and on screen-sized
    // runs a 1.8x zoom fell to ~1.1x at one click and came back at the next:
    // a pull-out nobody authored, present or absent by run timing alone.
    // The span is still owed its report, below and in `spansUnderZoom`.
    const stillWidth = keyframeAt(
      bundle,
      toSourceMs(timeline, key.outputTimeMs),
    )?.width;
    const backing =
      stillWidth === undefined || stillWidth === 0 ? sourceWidth : stillWidth;
    const available = backing / viewport.width; // source px per CSS px
    const needed = outputPxPerCssPx * key.scale; // output px per CSS px
    if (needed <= available && sourceWidth >= needed * viewport.width) {
      return key;
    }

    const granted = clamp(available / outputPxPerCssPx, 1, key.scale);
    // What the output wants across the drawn frame once the cut is applied.
    // Below the 1.0 floor this stays ABOVE `sourceWidth`, which is precisely
    // the case the old `granted < key.scale` test could not see.
    const neededWidth = outputPxPerCssPx * granted * viewport.width;
    // Two distinct faults, and reporting only the first was the defect.
    //
    // A cut zoom is the loud one: the author asked for 1.8x and got 1.44x.
    // Under-sampling is the quiet one: the grant is already on its 1.0 floor
    // and the frames STILL cannot fill the output, so there is nothing left
    // to cut and `granted < key.scale` is false. That is an upscaled picture
    // reported exactly like a clean one — measured on a real 1140x624 take
    // on 2026-09-21, where every motion span of a 1440p export sampled 0.96
    // and the panel said nothing at all.
    const cut = granted < key.scale;
    const underSampled = sourceWidth < neededWidth;
    if (cut || underSampled) {
      violations.push({
        outputTimeMs: key.outputTimeMs,
        requestedScale: key.scale,
        grantedScale: granted,
        sourceWidth,
        neededWidth,
      });
    }
    return { ...key, scale: granted };
  };

  const clamped = keys.map(clampKey);
  violations.push(
    ...spansUnderZoom(
      clamped,
      violations,
      timeline,
      bundle,
      outputPxPerCssPx,
      viewport,
    ),
  );
  return { keys: clamped, violations };
}

/**
 * Every motion span drawn under a zoom its pixels cannot fill.
 *
 * The keys above are measured at their own instants, so a span that falls
 * wholly inside a held zoom — the page repainting between two clicks — was
 * upscaled and reported only if some key happened to land in it. Since the
 * grant became the stills' (2026-10-11) that is the ordinary case rather
 * than the rare one, and the softness the author accepted in exchange for a
 * camera that does not breathe out has to be said, not just drawn.
 *
 * The scale held over a span is the largest of the key standing at its
 * start and any key arriving inside it: a key's scale is where the camera is
 * going, which over-reads the scale during a push-in and so errs toward
 * reporting. One violation per span, at its first output instant, and none
 * for a span a key inside it already reported against the span's own width:
 * the same stretch said twice reads as two. A span a cut removes from the
 * film has no output length and is not drawn at all, and neither is one that
 * does not cover the viewport: `servingMotionSpan` draws a still there.
 *
 * Only a zoom (author's ruling, 2026-10-11). A span short of the drawn frame
 * with the camera at rest is the capture's resolution, not the camera's
 * doing, and said here it put "drawn from fewer pixels" on every phone export
 * and every screen-sized 4K one.
 */
function spansUnderZoom(
  keys: readonly CameraKey[],
  byKey: readonly DetailViolation[],
  timeline: Timeline,
  bundle: FrameBundle,
  outputPxPerCssPx: number,
  viewport: { width: number; height: number },
): DetailViolation[] {
  const out: DetailViolation[] = [];
  for (const span of bundle.motionSpans) {
    const startMs = toOutputMs(timeline, span.startMs);
    const endMs = toOutputMs(timeline, span.endMs);
    if (endMs <= startMs) continue;
    if (!coversViewport(span, bundle.viewport)) continue;
    const said = byKey.some(
      (v) =>
        v.outputTimeMs >= startMs &&
        v.outputTimeMs < endMs &&
        v.sourceWidth === span.width,
    );
    if (said) continue;
    let held = 1;
    for (const key of keys) {
      if (key.outputTimeMs <= startMs) held = key.scale;
      else if (key.outputTimeMs < endMs) held = Math.max(held, key.scale);
      else break;
    }
    if (held <= 1) continue;
    const neededWidth = outputPxPerCssPx * held * viewport.width;
    if (span.width < neededWidth) {
      out.push({
        outputTimeMs: startMs,
        requestedScale: held,
        grantedScale: held,
        sourceWidth: span.width,
        neededWidth,
      });
    }
  }
  return out;
}
