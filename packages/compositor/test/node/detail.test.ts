import { describe, expect, it } from "vitest";
import { coversViewport } from "../../src/bundle";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { toOutputMs } from "../../src/plan/timeline";
import { clampToSourceDetail, sourceWidthAt } from "../../src/render/detail";
import {
  contentScale,
  derivePresentation,
} from "../../src/render/presentation";
import {
  LANDSCAPE_4K,
  LANDSCAPE_1080P,
  type RenderTarget,
} from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { cameraKey } from "../fixtures/camera-key";
import { readonlyScene } from "../fixtures/scene";

const scene = readonlyScene();
const bundle = proceduralBundle();
const resolved = resolvePlan(planScene(scene), bundle, scene);
const viewport = { width: 1280, height: 800 };

/**
 * Output pixels per CSS pixel at scale 1 — what the clamp measures against.
 * Derived rather than hardcoded, so these expectations follow
 * the branding's padding, the aspect fit and the fit mode if any of them
 * moves.
 */
function pxPerCss(target: RenderTarget): number {
  const { frameRect } = derivePresentation(scene.branding, target, viewport);
  return contentScale(frameRect, viewport);
}

/** Source pixels per CSS pixel from a DPR-3 keyframe of this viewport. */
const KEYFRAME_DETAIL = 3840 / 1280;

describe("sourceWidthAt", () => {
  it("reports the keyframe width outside any motion span", () => {
    expect(sourceWidthAt(bundle, 0)).toBe(3840);
  });

  // SP1's platform fact: the motion stream ignores emulated DPR and caps at
  // the compositor surface, so mid-span there is simply less detail.
  it("reports the surface-capped width inside a motion span", () => {
    expect(sourceWidthAt(bundle, 3600)).toBe(2560);
  });
});

describe("clampToSourceDetail", () => {
  // Stills only. With the bundle's span the zoom, held to the end, is held
  // over a 2560px span it upscales — reported since 2026-10-11, and covered
  // by "a zoom that lands in a motion span" below. This case is the key's
  // own grant.
  it("leaves a modest zoom alone when the keyframes can back it", () => {
    const { keys, violations } = clampToSourceDetail({
      keys: [
        cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1.8 }),
      ],
      timeline: resolved.timeline,
      bundle: proceduralBundle({ motionSpans: [] }),
      outputPxPerCssPx: pxPerCss(LANDSCAPE_1080P),
      viewport,
    });
    expect(keys[0]?.scale).toBe(1.8);
    expect(violations).toEqual([]);
  });

  it("clamps a zoom the source cannot back", () => {
    // 4K output from a 2560-wide motion frame: even 1.0 is already
    // upsampling, so any zoom on top is refused. Locate the moment by
    // mapping the *bundle's own* span into output time — "the first motion
    // segment" no longer identifies it, because cursor travel is now a
    // motion span too and the cursor moves first.
    const span = bundle.motionSpans[0];
    expect(span).toBeDefined();
    if (!span) throw new Error("unreachable");
    const midSpanOutputMs = toOutputMs(
      resolved.timeline,
      (span.startMs + span.endMs) / 2,
    );
    expect(sourceWidthAt(bundle, (span.startMs + span.endMs) / 2)).toBe(2560);
    const { keys, violations } = clampToSourceDetail({
      keys: [
        cameraKey({
          outputTimeMs: midSpanOutputMs,
          center: { x: 640, y: 400 },
          scale: 2.5,
          transitionMs: 1234,
          stiffness: 7.25,
        }),
      ],
      timeline: resolved.timeline,
      bundle,
      outputPxPerCssPx: pxPerCss(LANDSCAPE_4K),
      viewport,
    });
    expect(keys[0]?.scale).toBeLessThan(2.5);
    // A cut key is still the same move: only its scale changes. The length
    // and stiffness of the move arriving at it must survive the clamp, or
    // every 4K export would ease on whatever a rebuilt key defaulted to.
    expect(keys[0]).toMatchObject({ transitionMs: 1234, stiffness: 7.25 });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      requestedScale: 2.5,
      sourceWidth: 2560,
    });
  });

  // Never below 1.0: refusing the zoom entirely would be a worse deliverable
  // than a slightly soft one, and the camera track is authored intent.
  it("never clamps below 1.0", () => {
    const { keys } = clampToSourceDetail({
      keys: [
        cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 2.5 }),
      ],
      timeline: resolved.timeline,
      bundle: proceduralBundle({
        keyframes: [
          {
            byteLength: 0,
            sourceTimeMs: 0,
            ref: "k",
            width: 640,
            height: 400,
            actionId: null,
          },
        ],
        motionSpans: [],
      }),
      outputPxPerCssPx: pxPerCss(LANDSCAPE_4K),
      viewport,
    });
    expect(keys[0]?.scale).toBe(1);
  });

  it("reports the granted scale alongside the requested one", () => {
    // 4K from 3840-wide keyframes of a 1280 viewport: at the branding's
    // default 8% padding the app is drawn ~2903px across, so the frames back
    // 3840/2903 = ~1.32x.
    // Asking for 2.5x lands the grant strictly between the 1.0 floor and the
    // request, which is the only arrangement that actually tests the reported
    // number.
    //
    // Was 1080p until 2026-09-21. The wider landscape inset draws the app
    // only ~1210px across there, which backs 3.18x — more than the 2.5x
    // asked for, so nothing was clamped and the assertions below had no
    // grant to read. The arrangement matters, not the preset.
    const granted = KEYFRAME_DETAIL / pxPerCss(LANDSCAPE_4K);
    const { keys, violations } = clampToSourceDetail({
      keys: [
        cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 2.5 }),
      ],
      timeline: resolved.timeline,
      bundle: proceduralBundle({
        keyframes: [
          {
            byteLength: 0,
            sourceTimeMs: 0,
            ref: "k",
            width: 3840,
            height: 2400,
            actionId: null,
          },
        ],
        motionSpans: [],
      }),
      outputPxPerCssPx: pxPerCss(LANDSCAPE_4K),
      viewport,
    });
    expect(granted).toBeGreaterThan(1);
    expect(granted).toBeLessThan(2.5);
    expect(keys[0]?.scale).toBeCloseTo(granted, 6);
    expect(violations[0]?.grantedScale).toBeCloseTo(granted, 6);
    expect(violations[0]?.requestedScale).toBe(2.5);
  });

  // The defect the harvested fixture exposed. The 4K target is 3840 wide, but
  // padding and the aspect fit draw the app ~3110px across, so DPR-3
  // keyframes of a 1280 viewport carry 3840/3110 = ~1.23x of real headroom.
  // Measured against 3840 the headroom read as exactly 1.00x and the whole
  // camera move was refused: the 4K deliverable came out with no zoom at all.
  it("measures against the drawn frame width, not the target's full width", () => {
    const bundle4k = proceduralBundle({
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 0,
          ref: "k",
          width: 3840,
          height: 2400,
          actionId: null,
        },
      ],
      motionSpans: [],
    });
    const headroom = KEYFRAME_DETAIL / pxPerCss(LANDSCAPE_4K);
    expect(headroom).toBeGreaterThan(1);
    expect(headroom).toBeLessThan(LANDSCAPE_4K.width / viewport.width);

    // Inside the headroom: untouched, no violation.
    const modest = clampToSourceDetail({
      keys: [
        cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1.2 }),
      ],
      timeline: resolved.timeline,
      bundle: bundle4k,
      outputPxPerCssPx: pxPerCss(LANDSCAPE_4K),
      viewport,
    });
    expect(modest.keys[0]?.scale).toBe(1.2);
    expect(modest.violations).toEqual([]);

    // Beyond it: cut back to the headroom, not to the 1.0 floor.
    const greedy = clampToSourceDetail({
      keys: [
        cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1.8 }),
      ],
      timeline: resolved.timeline,
      bundle: bundle4k,
      outputPxPerCssPx: pxPerCss(LANDSCAPE_4K),
      viewport,
    });
    expect(greedy.keys[0]?.scale).toBeCloseTo(headroom, 6);
    expect(greedy.keys[0]?.scale).toBeGreaterThan(1);
  });

  it("preserves key order and count", () => {
    const keys = [
      cameraKey({ outputTimeMs: 0, center: { x: 1, y: 1 }, scale: 1 }),
      cameraKey({ outputTimeMs: 500, center: { x: 2, y: 2 }, scale: 2 }),
      cameraKey({ outputTimeMs: 900, center: { x: 3, y: 3 }, scale: 1 }),
    ];
    const result = clampToSourceDetail({
      keys,
      timeline: resolved.timeline,
      bundle,
      outputPxPerCssPx: pxPerCss(LANDSCAPE_1080P),
      viewport,
    });
    expect(result.keys.map((k) => k.outputTimeMs)).toEqual([0, 500, 900]);
  });
});

/**
 * The silent half of the clamp, added 2026-09-21.
 *
 * `clampToSourceDetail` floors the grant at 1.0, so when the frames cannot
 * even supply one source pixel per output pixel there is nothing left to cut
 * — and until now that meant nothing was reported either: `granted < scale`
 * is false when both are 1.0. Every moving beat of an export whose target
 * outruns the capture was upscaled and the export panel said so only if a
 * zoom happened to be authored over it.
 *
 * Measured on a real 1140x624 take on 2026-09-21: replay keyframes arrive at
 * REPLAY_DPR (3420px) but `Page.startScreencast` ignores the emulation
 * override and follows the display's own DPR (2280px), so at 1440p the
 * motion spans sampled 0.96 and the author was told nothing at all.
 */
describe("clampToSourceDetail, under-sampling with no zoom to cut", () => {
  /** A 4K target against a 1920-wide motion frame: 0.79 source px per output
   *  px at scale 1.0, with the grant already on its floor.
   *
   *  Was 2560px until the landscape inset moved to 0.15 on 2026-09-21, which
   *  narrowed the drawn app to ~2419px and left 2560 comfortably OVER it —
   *  the fixture stopped under-sampling and the premise guard below caught
   *  it. That is the guard earning its place: without it these cases would
   *  have gone green reporting coverage they no longer supplied. */
  const underSampled = {
    keys: [
      cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1 }),
    ],
    timeline: resolved.timeline,
    bundle: proceduralBundle({
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 0,
          ref: "k",
          width: 1920,
          height: 1200,
          actionId: null,
        },
      ],
      motionSpans: [],
    }),
    outputPxPerCssPx: pxPerCss(LANDSCAPE_4K),
    viewport,
  };

  // The premise, asserted rather than described: if the fixture ever stops
  // under-sampling, every case below passes trivially.
  it("under-samples at scale 1.0 on this fixture", () => {
    expect(1920 / viewport.width).toBeLessThan(pxPerCss(LANDSCAPE_4K));
  });

  it("reports a violation although no zoom was reduced", () => {
    const { keys, violations } = clampToSourceDetail(underSampled);
    expect(keys[0]?.scale).toBe(1);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.requestedScale).toBe(1);
    expect(violations[0]?.grantedScale).toBe(1);
  });

  it("names how many source pixels the output wanted", () => {
    const { violations } = clampToSourceDetail(underSampled);
    const needed = pxPerCss(LANDSCAPE_4K) * 1 * viewport.width;
    expect(violations[0]?.neededWidth).toBeCloseTo(needed, 6);
    expect(violations[0]?.sourceWidth).toBe(1920);
    // The whole point: the frames carried less than the output asked for.
    expect(violations[0]?.sourceWidth).toBeLessThan(needed);
  });

  // The other direction, so this cannot go green by reporting everything.
  it("stays silent when the frames cover the output", () => {
    const { violations } = clampToSourceDetail({
      ...underSampled,
      outputPxPerCssPx: pxPerCss(LANDSCAPE_1080P),
    });
    expect(1920 / viewport.width).toBeGreaterThan(pxPerCss(LANDSCAPE_1080P));
    expect(violations).toEqual([]);
  });
});

/**
 * A zoom's scale is the stills' to grant, not whichever frame happens to be
 * on screen when it arrives (author's ruling, 2026-10-11).
 *
 * Measured on screen-sized agent runs that day: six clicks a second apart,
 * a 1.8x zoom on each, and in some exports the camera pulled out at one
 * click and pushed back in at the next. A zoom key that arrived while the
 * page was repainting was measured against the motion span serving that
 * instant — the display's 2x, against stills at 3x — and cut to about 1.1x.
 * Whether a repaint fell there was run timing, so the same take zoomed
 * steadily in one export and breathed out in the next. The follow-cam's
 * glides were spared that on 2026-10-09 by inheriting their zoom's grant;
 * a zoom's own key now takes the still's measure the same way, and the span
 * it lands in is reported as drawn from fewer pixels instead.
 */
describe("clampToSourceDetail, a zoom that lands in a motion span", () => {
  const span = bundle.motionSpans[0];
  if (!span) throw new Error("the procedural bundle has no motion span");
  const midSourceMs = (span.startMs + span.endMs) / 2;
  const spanStartOut = toOutputMs(resolved.timeline, span.startMs);
  const spanEndOut = toOutputMs(resolved.timeline, span.endMs);
  const midOut = toOutputMs(resolved.timeline, midSourceMs);
  const at1080 = pxPerCss(LANDSCAPE_1080P);

  // The premise, asserted: at 1080p the stills back 1.8x and the span does
  // not, so the span is what would cut it. Were the span to back 1.8x too,
  // the cases below would pass under the old per-instant rule.
  it("has stills that back 1.8x and a span that does not, at 1080p", () => {
    expect(sourceWidthAt(bundle, midSourceMs)).toBe(2560);
    expect(KEYFRAME_DETAIL).toBeGreaterThan(at1080 * 1.8);
    expect(2560 / viewport.width).toBeLessThan(at1080 * 1.8);
    expect(spanEndOut).toBeGreaterThan(spanStartOut);
  });

  it("grants a zoom arriving inside the span the scale the stills back", () => {
    const { keys, violations } = clampToSourceDetail({
      keys: [
        cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1 }),
        cameraKey({
          outputTimeMs: midOut,
          center: { x: 640, y: 400 },
          scale: 1.8,
        }),
      ],
      timeline: resolved.timeline,
      bundle,
      outputPxPerCssPx: at1080,
      viewport,
    });
    expect(keys[1]?.scale).toBe(1.8);
    // Not cut — and not silent: the span under it is upscaled, and says so.
    expect(violations.some((v) => v.grantedScale < v.requestedScale)).toBe(
      false,
    );
    const short = violations.filter((v) => v.sourceWidth === 2560);
    expect(short.length).toBeGreaterThan(0);
    expect(short[0]?.grantedScale).toBe(1.8);
    expect(short[0]?.sourceWidth).toBeLessThan(short[0]?.neededWidth ?? 0);
  });

  it("reports a span upscaled under a held zoom although no key lands in it", () => {
    const { keys, violations } = clampToSourceDetail({
      keys: [
        cameraKey({
          outputTimeMs: spanStartOut - 200,
          center: { x: 640, y: 400 },
          scale: 1.8,
        }),
        cameraKey({
          outputTimeMs: spanEndOut + 200,
          center: { x: 640, y: 400 },
          scale: 1,
        }),
      ],
      timeline: resolved.timeline,
      bundle,
      outputPxPerCssPx: at1080,
      viewport,
    });
    // The premise: neither key is inside the span, and the zoom's own
    // instant is served by a still that backs it.
    expect(sourceWidthAt(bundle, span.startMs - 200)).toBe(3840);
    expect(keys[0]?.scale).toBe(1.8);
    const short = violations.filter((v) => v.sourceWidth === 2560);
    expect(short).toHaveLength(1);
    expect(short[0]).toMatchObject({
      outputTimeMs: spanStartOut,
      requestedScale: 1.8,
      grantedScale: 1.8,
    });
  });

  // The other direction, so the span check cannot go green by reporting
  // every span: at scale 1 a 2560 span covers a 1080p frame.
  it("says nothing of a span the camera is not zoomed over", () => {
    expect(2560 / viewport.width).toBeGreaterThan(at1080);
    const { violations } = clampToSourceDetail({
      keys: [
        cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1 }),
      ],
      timeline: resolved.timeline,
      bundle,
      outputPxPerCssPx: at1080,
      viewport,
    });
    expect(violations).toEqual([]);
  });

  // Unzoomed upscaling is not this check's to report (author's ruling,
  // 2026-10-11): at 4K a 2560 span is short of the drawn frame even at
  // scale 1, so this goes red if the span check measures a camera at rest.
  it("says nothing of a span the frame outruns while the camera is at rest", () => {
    const at4k = pxPerCss(LANDSCAPE_4K);
    expect(2560 / viewport.width).toBeLessThan(at4k);
    expect(KEYFRAME_DETAIL).toBeGreaterThan(at4k);
    const { violations } = clampToSourceDetail({
      keys: [
        cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1 }),
      ],
      timeline: resolved.timeline,
      bundle,
      outputPxPerCssPx: at4k,
      viewport,
    });
    expect(violations).toEqual([]);
  });

  // A span that does not cover the viewport is never drawn —
  // `servingMotionSpan` serves a still there — so it cannot be upscaled.
  // Same zoom, same width as the span reported above; only the aspect moves.
  it("says nothing of a span the renderer draws a still for", () => {
    const cropped = { ...span, height: 1000 };
    expect(coversViewport(cropped, viewport)).toBe(false);
    expect(coversViewport(span, viewport)).toBe(true);
    const { violations } = clampToSourceDetail({
      keys: [
        cameraKey({
          outputTimeMs: spanStartOut - 200,
          center: { x: 640, y: 400 },
          scale: 1.8,
        }),
        cameraKey({
          outputTimeMs: spanEndOut + 200,
          center: { x: 640, y: 400 },
          scale: 1,
        }),
      ],
      timeline: resolved.timeline,
      bundle: proceduralBundle({ motionSpans: [cropped] }),
      outputPxPerCssPx: at1080,
      viewport,
    });
    expect(violations.filter((v) => v.sourceWidth === 2560)).toEqual([]);
  });
});
