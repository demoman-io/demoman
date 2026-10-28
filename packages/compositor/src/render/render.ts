import type { SceneDocument } from "@demoman/scene-schema";
import type { FrameBundle, MarkerEntry } from "../bundle.js";
import { type CameraKey, sampleCamera } from "../plan/camera.js";
import { type Screens, screenMoments } from "../plan/moments.js";
import type { ClampedRange } from "../plan/ranges.js";
import type { LoweredZoom } from "../plan/resolve.js";
import { type Timeline, toOutputMs, toSourceMs } from "../plan/timeline.js";
import type { RenderPlan } from "../plan/types.js";
import type {
  CompositorPorts,
  FrameImage,
  FrameSource,
  UnavailableSpan,
} from "../ports/types.js";
import { renderFrame } from "./compose.js";
import { composeForTarget } from "./compose-for-target.js";
import { type DetailViolation, sourceWidthAt } from "./detail.js";
import { detectKeyframeMotion } from "./motion-detect.js";
import { contentScale } from "./presentation.js";
import { cameraIntentsForTarget, type RenderTarget } from "./target.js";

/**
 * `renderScene`'s bytes plus everything the render had to give up on the
 * way: camera zoom cut back because the source frames could not back it
 * (`src/render/detail.ts`), and motion spans served from a still because
 * their bytes would not decode (`ports/frame-source-video.ts`). Reporting
 * these is the point: silently upscaling to hit a resolution number, or
 * freezing on a keyframe through a span and calling it a render, is
 * exactly the shortcut a side-by-side comparison punishes.
 */
export interface RenderResult {
  bytes: Uint8Array;
  detailViolations: DetailViolation[];
  unavailableSpans: UnavailableSpan[];
  /** Zooms a `cover` target capped or narrowed (`ResolvedPlan.loweredZooms`).
   *  Empty under `contain`. */
  loweredZooms: LoweredZoom[];
  /** What the plan clamped (`ResolvedPlan.clampedRanges`), from the
   *  composition this render walked, so the report and the picture agree. */
  clampedRanges: ClampedRange[];
  /** The still screens this render stops on (`screenMoments`), decided
   *  from the composition it walked. No scene, no steps: none. */
  screens: Screens;
}

/**
 * The streaming render loop.
 *
 * One canvas, reused. This loop — not `renderFrame` — owns fetching: it
 * pulls exactly one source frame from `ports.frames`, hands `renderFrame` a
 * one-shot source that just returns the frame already in hand, then lets
 * that frame go before the next iteration starts. So a raw `FrameSource`
 * backed by decode or network I/O is only ever asked for one frame at a
 * time, and `renderFrame` never has to know that. Encoded chunks leave
 * immediately. Nothing accumulates, because MV3 memory limits are a named
 * platform risk (v8 §9) and a crashed render is a broken promise where a
 * slower one is only slower.
 */
export async function renderScene(args: {
  plan: RenderPlan;
  bundle: FrameBundle;
  scene?: SceneDocument;
  target: RenderTarget;
  ports: CompositorPorts;
  logo?: FrameImage | null;
  /** Called after each frame is handed to the sink, with how many are done
   *  and how many there will be. The editor's "Exporting · 43%". */
  onFrame?: (done: number, total: number) => void;
}): Promise<RenderResult> {
  const { plan, bundle, scene, target, ports, logo = null, onFrame } = args;

  const sink =
    target.format === "mp4"
      ? ports.video
      : target.format === "gif"
        ? ports.gif
        : ports.images;
  if (!sink) {
    throw new Error(
      `render target "${target.format}" needs a matching ${
        target.format === "mp4" ? "video sink" : `${target.format} sink`
      }`,
    );
  }

  // Keyframe diffing needs pixels, which is why it lives out here rather
  // than in the pure planning stage. On a healthy render it finds nothing.
  const hints =
    target.format === "png"
      ? []
      : await detectKeyframeMotion(
          bundle,
          ports.frames,
          plan.retiming.motionDiffThreshold,
        );

  // The same composition the editor's preview scrubs — see `composeForTarget`.
  const {
    resolved: composed,
    presentation,
    violations,
  } = composeForTarget({ plan, bundle, scene, target, hints, logo });

  const canvas = ports.surface.create(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

  const step = 1000 / target.fps;
  // The trim: walk the resolved range, not the whole axis. Frame timestamps
  // handed to the sinks are RELATIVE to the range's start, so the
  // deliverable begins at zero; `outputTimeMs` handed to `renderFrame` stays
  // on the untrimmed axis, which is the axis every camera key, click pulse
  // and cosmetic range was resolved on.
  // Before the trim's guard below, and with its own sentence.
  //
  // That guard is gated on `outputDurationMs > 0` precisely so it does not
  // announce "the trim leaves nothing" over a take that was empty for some
  // other reason. Cuts are now one of those reasons — and the only one with
  // a cause we can name — so the naming happens here. Left to the frame
  // walk, the author would read a keyframe error over an edit they made on
  // purpose.
  //
  if (
    composed.timeline.outputDurationMs === 0 &&
    composed.timeline.cuts.length > 0
  ) {
    throw new Error(
      "nothing left to render: the removed pieces leave no frames. Restore one to export it.",
    );
  }
  const { startMs, endMs } = composed.range;
  // The `Math.max(1, ...)` floor below is right for a range SHORTER than one
  // frame step — that is a real range, and it is worth the one frame it
  // rounds to. A range of ZERO is not: it produced a one-frame file with
  // non-empty bytes, stored and listed beside every real render with nothing
  // to tell them apart. The resolver already worked out why (both trim sides
  // saturating at a Rebuild-shortened duration is the reachable case), so
  // hand its sentence on rather than inventing a second one. The offscreen
  // renderer turns this throw into `{kind:"failed", output, error}`, which
  // is what puts the reason in front of the author.
  //
  // Guarded on the take having a duration at all: a bundle whose own axis is
  // zero long makes every range zero long without anything having been cut,
  // and refusing there would announce "the trim leaves nothing" over
  // whatever real fault emptied the take — a keyframe ref the store never
  // received, say, whose own error is both truer and more actionable and
  // surfaces a few lines below.
  if (composed.timeline.outputDurationMs > 0 && endMs <= startMs) {
    const why =
      composed.clampedRanges.find((c) => c.kind === "trim")?.note ??
      `the trim's two ends both resolved to ${Math.round(startMs)}ms`;
    throw new Error(`nothing left to render: ${why}`);
  }
  const frameCount = Math.max(1, Math.round((endMs - startMs) / step));

  for (let i = 0; i < frameCount; i++) {
    const outputTimeMs = startMs + i * step;
    const sourceMs = toSourceMs(composed.timeline, outputTimeMs);

    // Fetch exactly one source frame, draw it, then let it go before the
    // next iteration starts — this is the "one frame in flight" invariant.
    const image = await ports.frames.at(sourceMs);
    const singleFrame: FrameSource = {
      at: async () => image,
      describe: () => ports.frames.describe(),
    };

    await renderFrame({
      resolved: composed,
      target,
      presentation,
      frames: singleFrame,
      ctx,
      outputTimeMs,
    });

    if (target.format === "mp4" && ports.video) {
      await ports.video.addFrame(canvas, (i * step) / 1000, step / 1000);
    } else if (target.format === "gif" && ports.gif) {
      await ports.gif.addFrame(canvas, step);
    } else if (target.format === "png" && ports.images) {
      await ports.images.add(canvas, `frame-${i}.png`);
    }
    onFrame?.(i + 1, frameCount);
  }

  // Bytes or a throw. An empty array here was the "dead Download button"
  // shape: a 0-byte output stored and listed as a success.
  const bytes = await (async () => {
    if (target.format === "mp4" && ports.video) return ports.video.finish();
    if (target.format === "gif" && ports.gif) return ports.gif.finish();
    if (target.format === "png" && ports.images) {
      const first = (await ports.images.finish())[0];
      if (!first) {
        throw new Error(
          `png render of ${frameCount} frame${frameCount === 1 ? "" : "s"} finished with no file`,
        );
      }
      return first.bytes;
    }
    // Unreachable: the sink check at the top already refused this target.
    throw new Error(`render target "${target.format}" has no sink to finish`);
  })();

  return {
    bytes,
    detailViolations: violations,
    unavailableSpans: ports.frames.unavailable?.() ?? [],
    loweredZooms: composed.loweredZooms,
    clampedRanges: composed.clampedRanges,
    screens: scene
      ? screenMoments(composed, scene, bundle)
      : { steps: 0, moments: [] },
  };
}

/**
 * The source time a still of this marker should be taken from.
 *
 * A still is the one output with no motion to preserve, so it should always
 * prefer its action's keyframe: the design's standing principle is that
 * keyframes carry the deliverable's resolution while motion spans are
 * upscaled transients. A marker that lands inside a span otherwise renders
 * from a screencast frame captured at the physical compositor surface rather
 * than at the emulated DPR, then upscaled into a 4K-adjacent frame it cannot
 * fill — visibly soft, as if cropped in. The harvested fixture's `act-3`
 * marker sits exactly on its span's inclusive opening boundary and did
 * exactly that, while a 3840x2400 keyframe tagged `act-3` went unused 800 ms
 * later. The detail clamp cannot rescue this: it never cuts below 1.0, so it
 * has no way to express "this source is below CSS resolution".
 *
 * Matched by `actionId`, not by nearness in time. The tag is the harvest
 * stating which frame *is* that action; nearest-keyframe would happily hand
 * a still the previous action's frame whenever a marker sits early in a long
 * beat, which is the "shows the wrong moment" defect rather than a blurry
 * one. The first match wins because keyframes are in ascending time order
 * and the earliest frame carrying the tag is the action's own.
 */
function stillSourceMs(bundle: FrameBundle, marker: MarkerEntry): number {
  const keyframe = bundle.keyframes.find((k) => k.actionId === marker.actionId);
  return keyframe ? keyframe.sourceTimeMs : marker.sourceTimeMs;
}

/**
 * How far past a seam a still is nudged to land on the kept side.
 *
 * A microsecond: far below any frame step at any fps this renders at, and
 * far above float noise at output magnitudes in the tens of thousands of
 * milliseconds. The same order as `plan/timeline.ts`'s `HOLD_EPSILON_MS`
 * and for the same reason.
 */
const STILL_SEAM_NUDGE_MS = 1e-3;

/**
 * How close the round trip has to land to count as landing.
 *
 * A whole millisecond, three orders above the nudge and well under any
 * frame at any fps — so a nudge that arrives a hair late still counts, and
 * a landing on the WRONG SIDE of a seam (the frame before the cut, seconds
 * away) never does. It has to exceed the nudge's own magnitude: a segment
 * maps the nudge onto `nudge * srcSpan / outSpan` of source time, which on
 * a rate-1.0 segment is the nudge itself — a tolerance equal to the nudge
 * sat exactly on that boundary and failed on float noise.
 */
const STILL_PLACEMENT_TOLERANCE_MS = 1;

/**
 * A step the take carries a marker for that got NO still, and which of the
 * two reasons it was.
 *
 * The two are not the same fact and must not collapse into one count: a
 * CUT step is the author's own edit doing exactly what they asked, while a
 * step the video holds no frame of is the take falling short of a step it
 * still contains. The first needs no action; the second is the one worth
 * going and looking at.
 */
export interface UnplacedStill {
  actionId: string;
  reason: string;
}

/**
 * The stills a take's own markers ask for: one per step still IN the video,
 * each at an output instant that really resolves back to its own frame.
 *
 * **`toOutputMs` and `toSourceMs` are not inverses at a seam, and that is
 * what this function exists for.** A cut's closing step — the surviving one
 * the removal runs up to — has its marker exactly on the cut's `srcEndMs`,
 * which shares an output instant with the last frame BEFORE the cut.
 * `toSourceMs` answers the earlier of those two segments (under a freeze
 * that is the right choice; here it is the removed side), and `renderFrame`
 * derives its whole picture from `toSourceMs`. Measured on the procedural
 * fixture: a naive round trip shipped `act-3.png` holding the frame from the
 * moment the author cut — the right name over the wrong picture, which is
 * the same defect the cut-step filter exists to remove, moved one file
 * along.
 *
 * So the round trip is CHECKED rather than assumed, which is also what makes
 * this safe: on any take without cuts it lands first time, so nothing about
 * holds, paces or the `toOutputMs` pace-stepping rule changes. A marker that
 * survives neither the placement nor the nudge has no frame in the video at
 * all — the closing step of a cut that runs to the take's end — and gets no
 * still rather than one borrowed from a neighbour.
 */
function stillBeats(
  bundle: FrameBundle,
  timeline: Timeline,
): {
  beats: { actionId: string; outputTimeMs: number }[];
  unplaced: UnplacedStill[];
} {
  const beats: { actionId: string; outputTimeMs: number }[] = [];
  const unplaced: UnplacedStill[] = [];
  for (const marker of bundle.markers) {
    // The step's own instant is in a removed piece: its frames are gone and
    // so is its still. Closed at the start, the way `stepsInsideRemoved`
    // counts a piece opening on a step's instant as taking that step.
    const ms = marker.sourceTimeMs;
    if (timeline.cuts.some((c) => ms >= c.srcStartMs && ms < c.srcEndMs)) {
      unplaced.push({
        actionId: marker.actionId,
        reason:
          "the step is in a removed piece, so the video holds none of its frames",
      });
      continue;
    }
    const sourceMs = stillSourceMs(bundle, marker);
    const placed = toOutputMs(timeline, sourceMs);
    let found = false;
    for (const outputTimeMs of [placed, placed + STILL_SEAM_NUDGE_MS]) {
      const lands = toSourceMs(timeline, outputTimeMs);
      if (Math.abs(lands - sourceMs) <= STILL_PLACEMENT_TOLERANCE_MS) {
        beats.push({ actionId: marker.actionId, outputTimeMs });
        found = true;
        break;
      }
    }
    if (found) continue;
    // Neither landed: the video contains no frame of this step. NOT the
    // same fact as the cut above, and reported as its own: that one is the
    // author's edit doing what they asked, this one is the take falling
    // short of a step it carries a marker for — typically the closing step
    // of a cut that runs to the end of the frames.
    unplaced.push({
      actionId: marker.actionId,
      reason: "the video holds no frame of this step",
    });
  }
  return { beats, unplaced };
}

/**
 * How a still is framed. A step's still is taken at the step's own instant,
 * and the video's camera there is not the step's zoom: the zoom on a click
 * lands just before it, and on the last step has pulled back out by then.
 *
 * - `video`: the video's camera at that instant (the extension's stills).
 * - `none`: the whole window. A `cover` (9:16) target, whose crop cannot
 *   show it, pans to the step at 1x.
 * - `step`: the step's own zoom, or the zoom the video holds over the step,
 *   all the way in; the whole window (as `none`) at a step with neither.
 */
export type StillCamera = "video" | "none" | "step";

/**
 * Stills at chosen output times. Defaults to one per action marker, which is
 * what a docs page or a changelog entry actually wants — the moment of each
 * beat, not an arbitrary frame.
 *
 * Deliberately ignores `plan.trim`: a still is addressed by its action
 * marker, not by a position on the trimmed output axis, and spec §2 names
 * only the timeline and frame walks (`renderScene`) as trim-aware. A stills
 * export that skips whatever the author trimmed away is a real want, but a
 * different one from this function.
 */
export async function renderStills(args: {
  plan: RenderPlan;
  bundle: FrameBundle;
  scene?: SceneDocument;
  target: RenderTarget;
  ports: CompositorPorts;
  outputTimesMs?: number[];
  logo?: FrameImage | null;
  /** How each still is framed (`StillCamera`). Defaults to `video`, the
   *  framing the extension's stills have always had. */
  camera?: StillCamera;
  /** Called after each still is handed to the sink — `renderScene`'s
   *  `onFrame`, one call per file. */
  onFrame?: (done: number, total: number) => void;
}): Promise<{
  files: { name: string; bytes: Uint8Array }[];
  detailViolations: DetailViolation[];
  unavailableSpans: UnavailableSpan[];
  /** Steps this take carries a marker for that got NO still, each with
   *  which of the two reasons it was. Empty on the caller-supplied path,
   *  which asks for frames rather than beats. See `stillBeats`. */
  unplacedStills: UnplacedStill[];
  /** As `RenderResult`'s: the composition this still set was taken from. */
  loweredZooms: LoweredZoom[];
  clampedRanges: ClampedRange[];
}> {
  const { plan, bundle, scene, target, ports, logo = null } = args;
  const images = ports.images;
  if (!images) throw new Error('render target "png" needs a matching png sink');

  const {
    resolved: composed,
    presentation,
    violations,
  } = composeForTarget({ plan, bundle, scene, target, logo });
  const canvas = ports.surface.create(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

  // Name from the marker only when the times ARE the markers. With
  // caller-supplied times the index is meaningless: an arbitrary time got the
  // filename of whatever action happened to sit at the same position in the
  // list, and a time past the marker count fell through to `still-N`, so a
  // set of five stills from a three-action scene came back as two named
  // actions and three numbered ones. A caller asking for its own times is
  // asking for frames, not for beats.
  //
  // The same distinction decides WHEN each still is taken. On the default
  // path a marker's still is pulled to its action's keyframe (see
  // `stillSourceMs`); caller-supplied times are honoured exactly, because a
  // caller asking for 2400 ms means 2400 ms and silently relocating it is a
  // different bug wearing the fix's clothes.
  //
  // Substituting the OUTPUT time — not the frame lookup — is what keeps the
  // still coherent. `renderFrame` derives its source time, camera, cursor and
  // cosmetics from the single `outputTimeMs` it is handed, so moving that one
  // number moves all four together. Reaching past it to swap only the image
  // would draw the cursor where it was 800 ms before the pixels underneath it.
  const supplied = args.outputTimesMs;
  const atMarkers = supplied === undefined;
  // A cut step is not a step in the video, and a step whose frames a cut
  // swallowed has no still either. Both are dropped by `stillBeats`, and
  // the beats that survive are placed by asking the timeline's segments
  // where their source instant actually plays — NOT by a `toOutputMs`
  // round trip, which is not exact at a seam. See `stillBeats`.
  //
  // Caller-supplied times are still honoured exactly, for the reason the
  // comment above gives: a caller asking for 2400ms means 2400ms.
  const { beats, unplaced } = atMarkers
    ? stillBeats(bundle, composed.timeline)
    : { beats: [], unplaced: [] };
  const times = supplied ?? beats.map((b) => b.outputTimeMs);

  // An export with no still in it is a FAILURE, and it used to look exactly
  // like a success: `files` came back empty, the offscreen renderer walked
  // zero of them and reported the job finished, and the author got no
  // downloads and no reason. `renderScene` already throws a named error for
  // the same state — every step cut — and the two doors must not disagree
  // about whether that is an error.
  //
  // The marker path only. Caller-supplied times are the caller's own list,
  // and an explicitly empty one is an explicit request rather than a state
  // to diagnose; nothing in this repo passes one.
  if (atMarkers && times.length === 0) {
    const why = unplaced.map((u) => `${u.actionId} (${u.reason})`).join(", ");
    throw new Error(
      unplaced.length === 0
        ? "nothing left to render: this take has no steps, so there is no still to take of it."
        : `nothing left to render: no step in this take has a still left — ${why}. Restore a removed piece to export stills.`,
    );
  }

  // A still has no exposure, so it carries neither smear the video paints
  // for motion: the camera blur and the cursor trail. Found 2026-10-16: a
  // step's still landed mid-zoom and the page came out smeared under a crisp
  // pointer. Only the paint changes; the camera and cursor sit where the
  // video has them at that instant.
  const unsmeared = {
    ...composed,
    motion: { ...composed.motion, blur: 0 },
    cursorLook: { ...composed.cursorLook, motionBlur: 0 },
  };
  const framing = args.camera ?? "video";
  // Which step each zoom belongs to, through the intents this target
  // draws: a 9:16 target follows every step with intents of its own.
  const stepOf = new Map(
    cameraIntentsForTarget(target, plan.cameraIntents).map(
      (intent) => [intent.id, intent.actionId] as const,
    ),
  );
  const held = (at: { center: { x: number; y: number }; scale: number }) => {
    const key: CameraKey = {
      outputTimeMs: 0,
      center: at.center,
      scale: at.scale,
      transitionMs: 0,
      stiffness: composed.cameraKeys[0]?.stiffness ?? 0,
    };
    // `cameraFollow: []`, or the spread keeps the video's spring and the
    // still is drawn off its own key.
    return { ...unsmeared, cameraKeys: [key], cameraFollow: [] };
  };
  // What the stills drawn fall short of, by output instant: under `video`
  // the video's report, which is what they draw; otherwise only what each
  // still's own camera asks of its frame (filled in by `framed`).
  const drawnShort = new Map<number, DetailViolation>();
  const framed = (actionId: string | undefined, outputTimeMs: number) => {
    if (framing === "video") return unsmeared;
    const segments = composed.cameraSegments;
    // The step's own zoom, or else the one the video holds over it.
    const zoom =
      (actionId === undefined
        ? undefined
        : segments.find((s) => stepOf.get(s.id) === actionId)) ??
      segments.find((s) => s.startMs <= outputTimeMs && outputTimeMs < s.endMs);
    if (framing === "step" && zoom !== undefined) {
      // The video's own report on this zoom: it is the zoom drawn here.
      for (const v of violations) {
        if (v.outputTimeMs === zoom.startMs) drawnShort.set(v.outputTimeMs, v);
      }
      // The zoom's own aim: inside a run the spring still trails it at the
      // landing, and a step's still frames what its zoom was aimed at.
      return held(sampleCamera(composed.cameraKeys, zoom.startMs));
    }
    // A whole window drawn wider than the frame it is drawn from.
    const sourceWidth = sourceWidthAt(
      bundle,
      toSourceMs(composed.timeline, outputTimeMs),
    );
    const neededWidth =
      contentScale(presentation.frameRect, plan.viewport) * plan.viewport.width;
    if (sourceWidth !== 0 && sourceWidth < neededWidth) {
      drawnShort.set(outputTimeMs, {
        outputTimeMs,
        requestedScale: 1,
        grantedScale: 1,
        sourceWidth,
        neededWidth,
      });
    }
    // The whole window. A `cover` target cannot show it — its crop is
    // narrower than the recording — so it pans to the step at 1x instead.
    if (target.fit !== "cover") {
      return held({
        center: { x: plan.viewport.width / 2, y: plan.viewport.height / 2 },
        scale: 1,
      });
    }
    const at = sampleCamera(composed.cameraKeys, zoom?.startMs ?? outputTimeMs);
    return held({ center: at.center, scale: 1 });
  };
  for (const [i, outputTimeMs] of times.entries()) {
    const beat = atMarkers ? beats[i] : undefined;
    await renderFrame({
      resolved: framed(beat?.actionId, outputTimeMs),
      target,
      presentation,
      frames: ports.frames,
      ctx,
      outputTimeMs,
    });
    await images.add(canvas, `${beat ? beat.actionId : `still-${i}`}.png`);
    args.onFrame?.(i + 1, times.length);
  }

  const files = await images.finish();
  return {
    files,
    detailViolations:
      framing === "video"
        ? violations
        : [...drawnShort.values()].sort(
            (a, b) => a.outputTimeMs - b.outputTimeMs,
          ),
    unavailableSpans: ports.frames.unavailable?.() ?? [],
    unplacedStills: unplaced,
    loweredZooms: composed.loweredZooms,
    clampedRanges: composed.clampedRanges,
  };
}
