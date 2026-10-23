import type { SceneDocument } from "@demoman/scene-schema";
import { z } from "zod";
import { VERBS } from "./plan/verbs.js";

// The frame bundle is SP6's input contract and SP5's output obligation.
// It deliberately lives here rather than in scene-schema: it describes a
// render's raw material, not the document, and SP4 owns the schema this wave.
//
// All coordinates are CSS pixels in the emulated viewport, so the bundle is
// DPR-independent; each frame's width/height records what pixels arrived.

const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

const KeyframeSchema = z.object({
  sourceTimeMs: z.number().nonnegative(),
  ref: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  actionId: z.string().min(1).nullable(),
  // Bytes the blob at `ref` occupies. 0 means "unmeasured": every row
  // written before 2026-09-07 lacks it, and the frame store's
  // `measureUnsized` fills it in once. The row is the ledger — see the
  // storage-lifecycle design.
  byteLength: z.number().int().nonnegative().default(0),
});

// SP1: screencast frames are capped at the physical compositor surface and
// ignore emulated DPR, so a motion span is routinely smaller than
// viewport x dpr. The compositor upscales it; keyframes carry the resolution.
const MotionSpanSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  ref: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  byteLength: z.number().int().nonnegative().default(0),
});

const CursorSampleSchema = z.object({
  sourceTimeMs: z.number().nonnegative(),
  x: z.number(),
  y: z.number(),
});

/**
 * A stretch where the pointer's position is unknown, not still.
 *
 * The pointer produces no events over browser chrome, a native `<select>`
 * popup, or another window. Interpolating across that renders a straight
 * line the pointer never travelled — a failure path drawn exactly like a
 * success. The compositor holds position across a gap instead.
 */
const CursorGapSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
});

const AnchorRectSchema = z.object({
  actionId: z.string().min(1),
  anchorId: z.string().min(1),
  rect: RectSchema,
  /** A drag's end, measured with its start; absent for every other verb. */
  end: RectSchema.optional(),
});

/** A drag's button held down: pressed at its marker, released later. */
const HeldPressSchema = z.object({
  actionId: z.string().min(1),
  pressMs: z.number().nonnegative(),
  releaseMs: z.number().nonnegative(),
});

/**
 * The page's visual viewport against its layout viewport at an instant. A
 * page with no `<meta name="viewport">` on a phone lays out 980 CSS px wide
 * and is shown zoomed out (scale 0.401 on an iPhone), and a pinch-zoom moves
 * the offset. Every coordinate a bundle stores is in LAYOUT px, the space
 * replay input and the page's own APIs speak, and `inScreenSpace` maps it
 * onto the frames through this. Absent or empty: scale 1, no offset.
 */
const ViewportTransformSchema = z.object({
  sourceTimeMs: z.number().nonnegative(),
  scale: z.number().positive(),
  offsetX: z.number(),
  offsetY: z.number(),
});
export type ViewportTransform = z.infer<typeof ViewportTransformSchema>;

const MarkerSchema = z
  .object({
    actionId: z.string().min(1),
    sourceTimeMs: z.number().nonnegative(),
    /**
     * When the step's act was over: the verb had returned and the page had
     * stopped reacting to it (the last paint of real motion, capped). The
     * camera starts no move toward a later zoom before it, plus
     * `CAMERA_DEFAULTS.actSettleMs`. Absent on every take filmed before
     * 2026-10-19, on captures, and on steps that do not act: "unknown",
     * which every reader treats as today's behaviour.
     */
    actEndSourceTimeMs: z.number().nonnegative().optional(),
    /** Time the replay waited before this step so the camera had room to
     *  move unhurried (spec 2026-10-19). Absent when it waited nothing. */
    roomMs: z.number().nonnegative().optional(),
    /** The longest single hold within `roomMs` (a settle or the camera's
     *  room, not a wait for the page to go quiet): what the film check may
     *  take for Demoman's pacing inside one still stretch. */
    roomHeldMs: z.number().nonnegative().optional(),
  })
  .superRefine((marker, ctx) => {
    if (
      marker.actEndSourceTimeMs !== undefined &&
      marker.actEndSourceTimeMs < marker.sourceTimeMs
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actEndSourceTimeMs"],
        message: `act end ${marker.actEndSourceTimeMs}ms is before the step's marker at ${marker.sourceTimeMs}ms`,
      });
    }
  });

/**
 * One step of the action log the frames were made from.
 *
 * Five facts, not a whole `SceneAction`, and the difference is load-bearing.
 * `approximations` (the editor) compares a scene against this record to
 * answer "which of the author's edits are in this video", and the fields it
 * may compare are exactly the ones that decide what the frames SHOW: which
 * step (`actionId`), what it did (`kind`), what it did it to (`anchorId`),
 * what it typed (`text`). A `timestamp` is not one of them — `resequence` rewrites every
 * timestamp in the log after any reorder, so a whole-action comparison would
 * report untouched steps as changed.
 *
 * `cut` is on frames a rebuild made before step cuts became removed pieces
 * (2026-10-22): whether that rebuild skipped the step. Nothing writes it
 * now, and nothing makes frames without a step any more.
 */
export const MadeFromStepSchema = z.object({
  actionId: z.string().min(1),
  kind: z.string().min(1),
  anchorId: z.string().min(1).nullable(),
  /** The typed text; null for every verb that types nothing, and for a
   *  redacted field whose value was never recorded. */
  text: z.string().nullable(),
  cut: z.boolean().optional(),
});
export type MadeFromStep = z.infer<typeof MadeFromStepSchema>;

const DegradationSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  kind: z.enum([
    "keyframeOnly",
    "budgetBreach",
    "occlusionPause",
    "pageNeverSettled",
    // Motion the harvest saw and could not keep, because the frames it got
    // back were of the window's surface rather than of the emulated
    // viewport. Distinct from `keyframeOnly`, which is the same outcome for
    // a reason the author can act on (memory pressure) — this one names a
    // Chrome behaviour, and telling the two apart is the difference between
    // "your machine was busy" and "the replay window disagreed with the
    // page". See `coversViewport`.
    "surfaceMismatch",
    // Motion the harvest saw and the encoder refused. Distinct from the two
    // above because it is neither the machine being busy nor Chrome handing
    // back the wrong pixels: the frames were right and the encode of them
    // failed, which is the only one of the three a fix belongs in this
    // codebase for.
    "encodeRefused",
    // The sharp still a real-time replay takes when the page goes quiet
    // could not be taken. The stretch it would have served shows the last
    // motion frame instead — softer, not missing. Not unkept motion: the
    // motion was kept; a still was not.
    "stillFailed",
    // The corrective scroll was still moving when the run stopped waiting.
    // Not about frames at all: it is about the rect everything downstream was
    // then measured against, and a rect read mid-scroll aims the click at
    // wherever the target used to be.
    "scrollUnsettled",
    // A recorded scroll whose landing was off screen, so replay centred its
    // anchor instead of returning it to where the author left it. The
    // anchor is picked from the centre of the screen, so an off-screen rect
    // was measured after the page moved; the frames show a scroll position
    // the author did not have, and the note names the rect.
    "scrollLandingOffscreen",
    // A click the page could not vouch for: the check on it could not be
    // placed or read (the click navigated, most often), or a `type`'s release
    // went astray after its press had already focused the field. Not a miss
    // — a miss stops the run as `clickNotDelivered` — and not a confirmed
    // hit either, so it is said rather than counted as one (2026-10-13).
    "clickUnconfirmed",
    // A click whose surrounding text was not measured, when a generated
    // zoom was narrowed to the text on screen (2026-10-09 to 2026-10-10).
    // Nothing writes it now: the zoom fits its target alone, so there is no
    // measurement to miss (`Click.textLines`). Still accepted, because a
    // bundle saved in those two days carries it and must still parse.
    "textLinesUnmeasured",
    // The drawn cursor is a reconstruction from the action log, not a
    // recording of the pointer. Capture emits this whenever it ends a take
    // with no pointer samples — sampling that never started, a page that
    // interfered with it, or an author who never moved the mouse. All three
    // produce the same picture and the author is owed the same warning.
    "cursorSynthesized",
    // Motion the store held and the storage lifecycle reclaimed to free
    // space, because the demo was hosted and unedited since. The keyframes
    // stay; a replay restores motion. Rendered like `keyframeOnly`.
    "motionReclaimed",
    // A reconstructed pause the render has no marker to hang on: replay
    // stopped early, or the step was added to the scene after the rebuild
    // ran. Reported rather than dropped —
    // `holdInstants` drops such a hold silently, and under gaps that shortens
    // the video with no explanation, which is the defect §1 exists to fix.
    // Nothing in the compositor writes this value into a bundle, and that is
    // deliberate: a bundle records what capture or replay produced, while an
    // unplaced pace is a fact about a PLAN read against that bundle, which is
    // why `timeline.ts` surfaces the count as `Timeline.unplacedPaces` and
    // leaves the reporting to the caller. The editor is that caller —
    // `buildLaneModel` turns a nonzero count into a capture-lane clip and a
    // lane-label chip under this name. Named here so the two surfaces share
    // one word for one condition.
    "pacingUnplaced",
    // A drag whose press and release both arrived and that changed nothing
    // on screen: no native drag began and the pixels between its ends were
    // the same after as before. The page ignored it, so the step is listed
    // as diverged rather than read as done (2026-10-21).
    "notDragged",
    // A native drag's picture could not be drawn in the page (the element
    // the page named for it was gone, or copying it threw). The drag still
    // ran; the film shows the card jump to its drop instead of travelling.
    "dragPictureMissing",
  ]),
  note: z.string(),
});

function assertAscending(
  values: number[],
  label: string,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  for (let i = 1; i < values.length; i++) {
    if ((values[i] as number) < (values[i - 1] as number)) {
      ctx.addIssue({
        code: "custom",
        message: `${label} must be in ascending sourceTimeMs order`,
        path,
      });
      return;
    }
  }
}

export const FrameBundleSchema = z
  .object({
    bundleVersion: z.literal(1),
    sceneId: z.string().min(1),
    /**
     * Author-facing: `capture` is "your recording", `replay` is "a rebuild".
     * See spec §0. This discriminator is what keeps the editor's mode banner
     * honest and is not renamed.
     */
    source: z.enum(["replay", "capture"]),
    /**
     * Present only on a replay whose frames are continuous and whose pacing
     * is already in source time (spec 2026-10-03 §1). Absent on every
     * sampled replay and every capture bundle; `isRealTime` is the one
     * reader of what it means.
     */
    timing: z.literal("real").optional(),
    /**
     * A real-time replay only: the gaps the author edited that the engine
     * waited out live, each at the duration it waited. The pause is then
     * already in source time, and `gapPacedLive` is how the compositor knows
     * not to apply it a second time — which on a page that never stops
     * painting doubled it (review of 2026-10-03). A gap changed after the
     * run no longer matches and is applied to idle as on a capture.
     */
    pacedGaps: z
      .array(
        z.object({
          afterActionId: z.string().min(1),
          durationMs: z.number().nonnegative(),
        }),
      )
      .optional(),
    dpr: z.number().positive(),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    keyframes: z.array(KeyframeSchema),
    motionSpans: z.array(MotionSpanSchema),
    cursorSamples: z.array(CursorSampleSchema),
    // `.default([])` rather than required: every bundle already on disk was
    // written without this field, and they are all still readable.
    cursorGaps: z.array(CursorGapSchema).default([]),
    anchorRects: z.array(AnchorRectSchema),
    // Optional, and absent is none: only a run with a drag writes any.
    heldPresses: z.array(HeldPressSchema).optional(),
    // Optional, and absent is identity: every bundle written before
    // 2026-10-11 carries none, and identity is what they were drawn as.
    // See `ViewportTransformSchema`.
    viewportTransforms: z.array(ViewportTransformSchema).optional(),
    markers: z.array(MarkerSchema),
    degradations: z.array(DegradationSchema),
    /**
     * The action log these frames were made from, in take order.
     *
     * OPTIONAL, and absent is not empty. Every bundle written before
     * 2026-09-24 carries none, and the editor answers that with
     * "can't tell which edits are in the video" and a rebuild at export —
     * never with "nothing is approximated", which is what an empty array
     * would mean. Do not give this a `.default([])`: the default would be
     * the cheerful answer to the one question that must not be answered
     * cheerfully.
     */
    madeFrom: z.array(MadeFromStepSchema).optional(),
  })
  .superRefine((bundle, ctx) => {
    if (bundle.source === "capture" && bundle.timing !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "a capture bundle is real time by definition and carries no timing field",
        path: ["timing"],
      });
    }
    if (bundle.pacedGaps !== undefined && bundle.timing !== "real") {
      ctx.addIssue({
        code: "custom",
        message:
          "only a real-time replay waits out gaps live; pacedGaps needs timing: real",
        path: ["pacedGaps"],
      });
    }
    if (bundle.keyframes.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a bundle needs at least one keyframe",
        path: ["keyframes"],
      });
    }
    assertAscending(
      bundle.keyframes.map((k) => k.sourceTimeMs),
      "keyframes",
      ctx,
      ["keyframes"],
    );
    assertAscending(
      bundle.cursorSamples.map((c) => c.sourceTimeMs),
      "cursorSamples",
      ctx,
      ["cursorSamples"],
    );

    bundle.motionSpans.forEach((span, i) => {
      if (span.endMs < span.startMs) {
        ctx.addIssue({
          code: "custom",
          message: "endMs must not precede startMs",
          path: ["motionSpans", i, "endMs"],
        });
      }
    });

    const spans = [...bundle.motionSpans].sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < spans.length; i++) {
      if (
        (spans[i] as MotionSpanEntry).startMs <
        (spans[i - 1] as MotionSpanEntry).endMs
      ) {
        ctx.addIssue({
          code: "custom",
          message: "motion spans must not overlap",
          path: ["motionSpans"],
        });
        break;
      }
    }

    // Inversion only closes when replay hands back what it dispatched.
    // A replay bundle without samples is a broken seam, not an empty one —
    // unless nothing it performed moved the cursor. Since the film check
    // (spec 2026-09-30 §1) a scroll leaves the pointer where it is, so a
    // take of nothing but scrolls dispatches no path at all and has no
    // samples to hand back; refusing it threw away every frame the run
    // recorded (`replay-scroll.test.ts`). So the exemption is proved, not
    // assumed: every marker has to name a step in `madeFrom` whose kind
    // does not travel. A bundle with no `madeFrom` cannot prove it and is
    // refused, as before — and neither can one with no markers, over which
    // `every` would be vacuously true.
    if (bundle.source === "replay" && bundle.cursorSamples.length === 0) {
      const kinds = new Map(
        (bundle.madeFrom ?? []).map((s) => [s.actionId, s.kind]),
      );
      const stillCursor =
        bundle.madeFrom !== undefined &&
        bundle.markers.length > 0 &&
        bundle.markers.every((m) => {
          const kind = kinds.get(m.actionId);
          return (
            kind !== undefined &&
            Object.hasOwn(VERBS, kind) &&
            !VERBS[kind as keyof typeof VERBS].cursorTravels
          );
        });
      if (!stillCursor) {
        ctx.addIssue({
          code: "custom",
          message:
            "a replay bundle must carry the cursor samples it dispatched",
          path: ["cursorSamples"],
        });
      }
    }
  });

export type FrameBundle = z.infer<typeof FrameBundleSchema>;

/**
 * Whether source time is real elapsed time with the pacing already in it —
 * a capture, or a continuous replay. Every timing decision the compositor
 * and editor used to make on `source` asks this instead; decisions about
 * identity (storage, the recording's banner) and the cursor stay on
 * `source`. Spec 2026-10-03 §1.
 */
export function isRealTime(
  bundle: Pick<FrameBundle, "source" | "timing">,
): boolean {
  return bundle.source === "capture" || bundle.timing === "real";
}

/**
 * Whether the engine already waited out the gap after `afterActionId` live,
 * at exactly `durationMs` — so the bundle's source time holds it and
 * nothing may apply it again. The duration must match: a gap the author
 * changed since the run is a new instruction, applied to idle as usual.
 */
export function gapPacedLive(
  bundle: Pick<FrameBundle, "pacedGaps">,
  afterActionId: string,
  durationMs?: number,
): boolean {
  return (bundle.pacedGaps ?? []).some(
    (g) =>
      g.afterActionId === afterActionId &&
      (durationMs === undefined || g.durationMs === durationMs),
  );
}
export type KeyframeEntry = z.infer<typeof KeyframeSchema>;
export type MotionSpanEntry = z.infer<typeof MotionSpanSchema>;
export type CursorSample = z.infer<typeof CursorSampleSchema>;
export type CursorGap = z.infer<typeof CursorGapSchema>;
export type AnchorRectEntry = z.infer<typeof AnchorRectSchema>;
export type MarkerEntry = z.infer<typeof MarkerSchema>;
export type Degradation = z.infer<typeof DegradationSchema>;

/**
 * How far a frame's two axes may disagree about their scale before the frame
 * is treated as not covering the viewport.
 *
 * The two populations are nowhere near each other. A healthy frame is a
 * uniform scale of the viewport and disagrees only by H.264's even-dimension
 * rounding: a 1710x840 viewport at DPR 3 gives a 5130x2520 keyframe and a
 * 5130x2520 span, and the worst rounding available (an odd height rounded
 * down by one) is 0.04%. A frame captured from the window surface instead
 * disagreed by 20% on the take that produced this constant. Two per cent
 * sits an order of magnitude above the rounding and an order of magnitude
 * below the defect.
 */
export const COVERAGE_TOLERANCE = 0.02;

/**
 * Whether a harvested frame shows the whole viewport, rather than a corner
 * of it.
 *
 * Everything that draws a source frame — `renderFrame` above all — maps the
 * frame's full extent onto the full viewport rect. That is only correct if
 * the frame *is* the viewport at some scale, and until this existed nothing
 * checked that it was.
 *
 * It is not always. `Page.captureScreenshot` follows
 * `Emulation.setDeviceMetricsOverride`; `Page.screencastFrame` follows the
 * window's compositor surface, and the two part company whenever the surface
 * changes under a live override — a window resize does it, and so does the
 * debugger infobar. Measured against real Chrome on 2026-08-30: a 1710x840
 * emulated viewport in a 900x640 window screencast at 3420x1680 (a clean 2x)
 * until the window was resized, and at 1400x826 from then on — 0.819x wide by
 * 0.983x tall, which is not a scale of anything. Those frames are a **crop**
 * of the page's top-left corner, not a squashed copy of it: drawn to fill the
 * frame rect they magnify 1.90x horizontally and 1.52x vertically, so the
 * video is zoomed in and a quarter wider than it is tall for exactly as long
 * as the page is moving. Keyframes are untouched, which is why the stills of
 * such a take look right and only the scrolls and page loads look wrong.
 *
 * Tested per axis rather than against an expected scale, because the scale
 * itself is legitimately anything: replay keyframes arrive at `REPLAY_DPR`,
 * replay spans at the display's own DPR, and a capture bundle's keyframes at
 * CSS resolution alongside spans at 2x. What every honest frame shares is
 * that its two axes agree.
 */
export function coversViewport(
  frame: { width: number; height: number },
  viewport: { width: number; height: number },
): boolean {
  if (frame.width <= 0 || frame.height <= 0) return false;
  if (viewport.width <= 0 || viewport.height <= 0) return false;
  const scaleX = frame.width / viewport.width;
  const scaleY = frame.height / viewport.height;
  return Math.abs(scaleX / scaleY - 1) <= COVERAGE_TOLERANCE;
}

/**
 * The motion span a frame source should serve at this source time, or `null`
 * when a keyframe wins.
 *
 * Spans are closed at both ends, so a keyframe sitting exactly on a span's
 * boundary is *also* covered by it — and served naively, the span wins and
 * hands back a surface-capped frame for an instant the bundle already holds
 * at full resolution. That is not hypothetical: the harvested fixture's
 * `act-3` keyframe sits exactly on its span's closing boundary, and the
 * still rendered from a 1280x800 JPEG while a 3840x2400 frame of the same
 * moment went unused.
 *
 * So: an exact keyframe hit beats a covering span. The rule is coincidence,
 * not "past the end" — at a span's closing edge with no keyframe on it, the
 * span's own last frame is still the only current one, and falling back to
 * the keyframe *before* the span would snap the picture back to the
 * pre-motion state at the instant motion finished.
 *
 * This is the design's standing principle applied at the seam where it is
 * actually decided: keyframes carry the deliverable's resolution, motion
 * spans are the upscaled transients between them — on the replay path, by
 * construction. A capture bundle sends no metrics override, so its
 * keyframes come back in CSS pixels while its screencast is capped at the
 * physical compositor surface — the larger of the two on any Retina
 * display. So an exact keyframe hit beats a covering span UNLESS the span
 * actually carries more pixels at that instant: comparing what the frames
 * carry, rather than assuming the keyframe always wins, spans both regimes
 * and lands identically to the old rule on every replay bundle, so it
 * cannot regress the fix above.
 *
 * Task 12 (2026-08-29, against real Chromium — see
 * `packages/replay-engine/test/integration/capture-viewport.test.ts`) measured the
 * premise above and it did not hold on that platform: with the harvester's
 * exact `Page.startScreencast` parameters and a 2x device pixel ratio, the
 * screencast came back at 1280x800 CSS pixels, the same resolution as the
 * coincident keyframe, not the 2560x1600 physical surface size a Retina
 * display's DPR would imply. So `span.width > coincident.width` was false
 * on every coincident pair measured there and this function returned the
 * keyframe every time — this branch is correct but has not been observed to
 * fire. It is not dead code: a screencast that does arrive above CSS-pixel
 * resolution (a different Chrome version, platform, or compositor path)
 * would need it, and deleting it would silently reintroduce the
 * `act-3`-shaped bug above under exactly that condition.
 */
/**
 * Whether the pointer's position was unknown at any point between two
 * instants.
 *
 * The test for "these two samples are not the two ends of one continuous
 * stretch of observation", which is a different question from how far apart
 * they are in time. Several stages of the cursor pipeline must not join
 * across a gap — the smoothing kernel, the rest holds, the re-timer's
 * routes — and they ask it here so they all mean the same thing by it. A
 * gap can be shorter than any of their own time boundaries: `pointerleave`
 * opens one and the next `pointermove` closes it, so a pointer that clips
 * the edge of the document and comes back produces a hole of a few
 * milliseconds with a teleport inside it.
 */
export function overlapsGap(
  gaps: readonly CursorGap[],
  fromMs: number,
  toMs: number,
): boolean {
  return gaps.some((gap) => gap.startMs < toMs && gap.endMs > fromMs);
}

export function servingMotionSpan(
  bundle: FrameBundle,
  sourceTimeMs: number,
): MotionSpanEntry | null {
  const span = bundle.motionSpans.find(
    (s) => sourceTimeMs >= s.startMs && sourceTimeMs <= s.endMs,
  );
  if (!span) return null;
  // A span that does not cover the viewport cannot be drawn, whatever else
  // is true of it. `renderFrame` maps a frame's full extent onto the full
  // viewport rect, so a surface-cropped span is not merely lower-resolution
  // than the keyframe — it is a magnified corner of the page, stretched
  // unevenly. The keyframe is worse footage and a true picture, and this
  // takes the true picture. See `coversViewport`.
  //
  // Checked here rather than only where the frames are harvested, because
  // this is the seam where the damage is actually done: it covers the replay
  // path and the capture path with one rule, and it covers the bundles
  // already on disk, which no fix upstream can reach.
  //
  // `bundle.viewport` and not the plan's: this is a claim about the pixels,
  // and `buildCaptureBundle` recovers that field from the pixels themselves.
  if (!coversViewport(span, bundle.viewport)) return null;
  const coincident = bundle.keyframes.find(
    (k) => k.sourceTimeMs === sourceTimeMs,
  );
  if (coincident === undefined) return span;
  return span.width > coincident.width ? span : null;
}

/**
 * The keyframe standing at `sourceTimeMs`: the nearest at or before it, or
 * the first one when the instant is earlier than any keyframe. `null` only
 * when the bundle has no keyframes at all.
 *
 * One body for the three readers that used to carry their own copy — both
 * frame sources and the detail clamp — so "which still is on screen at this
 * instant" is one answer. Walks backwards rather than reversing a copy:
 * this runs once per camera key and once per output frame.
 */
export function keyframeAt(
  bundle: FrameBundle,
  sourceTimeMs: number,
): KeyframeEntry | null {
  for (let i = bundle.keyframes.length - 1; i >= 0; i--) {
    const keyframe = bundle.keyframes[i];
    if (keyframe && keyframe.sourceTimeMs <= sourceTimeMs) return keyframe;
  }
  return bundle.keyframes[0] ?? null;
}

export function validateBundle(input: unknown): FrameBundle {
  return FrameBundleSchema.parse(input);
}

/**
 * The record `FrameBundle.madeFrom` carries, from the scene a producer is
 * about to make frames from.
 *
 * Here rather than in either producer because both of them write it —
 * `buildCaptureBundle` for a take, the engine for a rebuild — and a second
 * copy is a second thing to drift.
 */
export function madeFromOf(scene: SceneDocument): MadeFromStep[] {
  return scene.actions.map((action) => ({
    actionId: action.id,
    kind: action.kind,
    anchorId: action.anchorId ?? null,
    text: action.kind === "type" ? action.text : null,
  }));
}
