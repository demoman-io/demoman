import { BRANDING_DEFAULTS } from "@demoman/scene-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FrameBundle,
  type MarkerEntry,
  type MotionSpanEntry,
  servingMotionSpan,
} from "../../src/bundle";
import { CAMERA_DEFAULTS } from "../../src/plan/camera";
import { planScene } from "../../src/plan/plan";
import { toSourceMs } from "../../src/plan/timeline";
import {
  createCollectingImageSink,
  createRecordingVideoSink,
} from "../../src/ports/fakes";
import type { FrameImage, FrameSource } from "../../src/ports/types";
import { renderFrame } from "../../src/render/compose";
import { sourceWidthAt } from "../../src/render/detail";
import {
  contentScale,
  derivePresentation,
} from "../../src/render/presentation";
import { renderScene, renderStills } from "../../src/render/render";
import {
  LANDSCAPE_1080P,
  STILL_1440,
  VERTICAL_1080,
} from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import {
  readonlyScene,
  removedFor,
  sceneWithZoomOnClick,
} from "../fixtures/scene";

// The node lane has no canvas, so the loop is exercised with a surface that
// hands back a stub and a renderFrame that is stubbed out. What is under test
// here is the *schedule*: how many frames, at what timestamps, in what order,
// and how many source frames are alive at once.
vi.mock("../../src/render/compose", () => ({
  renderFrame: vi.fn(async () => undefined),
  cssToOutput: vi.fn(),
  cssRectToOutput: vi.fn(),
}));
// `derivePresentation` is deliberately NOT mocked. It is pure geometry with
// no canvas in it, and the detail clamp now measures against the frame rect
// it computes — a stub frame width here would measure the clamp against a
// fiction. The draw functions it sits beside are only ever called from
// `renderFrame`, which is mocked out wholesale above.
// The node lane has no canvas, and detectKeyframeMotion uses OffscreenCanvas
// to diff pixels — that is exactly what the browser lane's
// motion-detect.test.ts exercises for real. Here the schedule is under test,
// not motion detection, so it is stubbed to find nothing.
vi.mock("../../src/render/motion-detect", () => ({
  detectKeyframeMotion: vi.fn(async () => []),
}));

function countingFrameSource(): FrameSource & { live: number; peak: number } {
  const bundle = proceduralBundle();
  const source = {
    live: 0,
    peak: 0,
    async at(): Promise<FrameImage> {
      source.live++;
      source.peak = Math.max(source.peak, source.live);
      await Promise.resolve();
      source.live--;
      // One stub image answers every request regardless of what was asked,
      // same as `render.ts`'s single-image source — 0 is the true value,
      // not filler, because there is only ever one frame to have served.
      return { image: {} as never, width: 1280, height: 800, sourceTimeMs: 0 };
    },
    describe: () => ({
      keyframes: bundle.keyframes,
      motionSpans: bundle.motionSpans,
    }),
  };
  return source;
}

// { create: () => ({}) as never } would make canvas.getContext("2d") blow up
// inside renderScene — a plain object has no such method. The stub needs one.
const stubSurface = { create: () => ({ getContext: () => ({}) }) as never };

describe("renderScene", () => {
  // Carries an authored zoom: the detail clamp below has nothing to clamp
  // against a scene with an empty camera track, and would report no violation
  // whether or not the clamp existed.
  const scene = sceneWithZoomOnClick();
  // A stationary cursor, deliberately. Cursor travel is no longer dead air
  // (see `cursorMotionSpans`), so the procedural fixture's four sparse
  // samples now protect the whole source from retiming and every frame count
  // in this file would silently become a function of cursor geometry. What is
  // under test here is the *schedule*; holding the pointer still keeps the
  // retimed duration independently derivable as "idle gaps + the motion span".
  const bundle = proceduralBundle({
    cursorSamples: [{ sourceTimeMs: 0, x: 640, y: 400 }],
  });
  const plan = planScene(scene);

  it("emits frames on an exact fixed-fps timeline", async () => {
    const video = createRecordingVideoSink();
    await renderScene({
      plan,
      bundle,
      scene,
      target: LANDSCAPE_1080P,
      ports: { frames: countingFrameSource(), surface: stubSurface, video },
    });
    const step = 1 / LANDSCAPE_1080P.fps;
    video.calls.forEach((call, i) => {
      expect(call.timestampSec).toBeCloseTo(i * step, 9);
      expect(call.durationSec).toBeCloseTo(step, 9);
    });
  });

  it("emits frames in strictly increasing timestamp order", async () => {
    const video = createRecordingVideoSink();
    await renderScene({
      plan,
      bundle,
      scene,
      target: LANDSCAPE_1080P,
      ports: { frames: countingFrameSource(), surface: stubSurface, video },
    });
    for (let i = 1; i < video.calls.length; i++) {
      expect(video.calls[i]?.timestampSec).toBeGreaterThan(
        video.calls[i - 1]?.timestampSec as number,
      );
    }
  });

  it("covers the whole retimed timeline and no more", async () => {
    const video = createRecordingVideoSink();
    // Idle no longer compresses (P5, 2026-09-08): with no holds or authored
    // gaps in this plan, retimed output now equals the raw 9000ms source
    // duration exactly — this used to be 3 * maxIdleMs + 800 (idle gaps +
    // the motion span).
    const resolvedDuration = 9000;
    await renderScene({
      plan,
      bundle,
      scene,
      target: LANDSCAPE_1080P,
      ports: { frames: countingFrameSource(), surface: stubSurface, video },
    });
    const expected = Math.round(
      (resolvedDuration / 1000) * LANDSCAPE_1080P.fps,
    );
    expect(video.calls.length).toBeGreaterThan(expected - 3);
    expect(video.calls.length).toBeLessThan(expected + 3);
  });

  // MV3 memory is a named platform risk (v8 §9). A render that accumulates
  // the timeline is a render that OOMs on a long demo.
  it("never holds more than one source frame in flight", async () => {
    const frames = countingFrameSource();
    await renderScene({
      plan,
      bundle,
      scene,
      target: LANDSCAPE_1080P,
      ports: {
        frames,
        surface: stubSurface,
        video: createRecordingVideoSink(),
      },
    });
    expect(frames.peak).toBe(1);
  });

  it("finishes the sink and returns its bytes", async () => {
    const video = createRecordingVideoSink();
    const { bytes } = await renderScene({
      plan,
      bundle,
      scene,
      target: LANDSCAPE_1080P,
      ports: { frames: countingFrameSource(), surface: stubSurface, video },
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    await expect(video.addFrame({} as never, 0, 0)).rejects.toThrow(/finish/);
  });

  // The camera's second clamp — never zoom past the detail the source frames
  // actually carry — must be recorded, not silent.
  it("reports detail violations rather than upscaling in silence", async () => {
    const target = { ...LANDSCAPE_1080P, width: 3840, height: 2160 };
    const result = await renderScene({
      plan: {
        ...plan,
        cameraIntents: plan.cameraIntents.map((i) => ({ ...i, scale: 2.5 })),
      },
      bundle,
      scene,
      target,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        video: createRecordingVideoSink(),
      },
    });
    // A 4K target draws this 1280x800 capture ~3110px across after padding
    // and the aspect fit, so 3840-wide keyframes back ~1.23x — well below the
    // requested 2.5x. The zoom must clamp to that headroom, and the cut must
    // be on the record rather than merely an array of some shape.
    const headroom =
      3840 /
      1280 /
      contentScale(
        derivePresentation(BRANDING_DEFAULTS, target, plan.viewport).frameRect,
        plan.viewport,
      );
    expect(headroom).toBeGreaterThan(1);
    // One cut, the zoom's. Everything else on the record is a motion span
    // drawn under that zoom from fewer pixels than it needs (reported since
    // 2026-10-11) — an upscale, never a second cut.
    const cuts = result.detailViolations.filter(
      (v) => v.grantedScale < v.requestedScale,
    );
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({
      requestedScale: 2.5,
      sourceWidth: 3840,
    });
    expect(cuts[0]?.grantedScale).toBeCloseTo(headroom, 6);
    for (const v of result.detailViolations.filter((x) => !cuts.includes(x))) {
      expect(v.grantedScale).toBe(v.requestedScale);
      expect(v.sourceWidth).toBeLessThan(v.neededWidth);
    }
  });

  // A span the frame source could not decode is served from the keyframe
  // before it — the picture freezes for the span's whole window — and until
  // 2026-09-06 the render reported that as a success with no violations.
  it("carries the frame source's unavailable spans out in the result", async () => {
    const frames = countingFrameSource();
    const unavailable = [{ ref: "m-0", reason: "cannot decode avc1.64001f" }];
    const result = await renderScene({
      plan,
      bundle,
      scene,
      target: LANDSCAPE_1080P,
      ports: {
        frames: { ...frames, unavailable: () => unavailable },
        surface: stubSurface,
        video: createRecordingVideoSink(),
      },
    });
    expect(result.unavailableSpans).toEqual(unavailable);
  });

  it("reports no violations when the source can back the requested zoom", async () => {
    const result = await renderScene({
      plan,
      bundle,
      scene,
      target: LANDSCAPE_1080P,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        video: createRecordingVideoSink(),
      },
    });
    expect(result.detailViolations).toEqual([]);
  });

  // The "dead Download button" shape: a 0-byte file saved as a successful
  // output. A png render whose sink hands back no file must say so.
  it("refuses to return empty bytes when the image sink produced no file", async () => {
    const images = createCollectingImageSink();
    images.finish = async () => [];
    await expect(
      renderScene({
        plan,
        bundle,
        scene,
        target: { ...STILL_1440, format: "png" },
        ports: { frames: countingFrameSource(), surface: stubSurface, images },
      }),
    ).rejects.toThrow(/no file/i);
  });

  it("refuses an mp4 target with no video sink rather than silently doing nothing", async () => {
    await expect(
      renderScene({
        plan,
        bundle,
        scene,
        target: LANDSCAPE_1080P,
        ports: { frames: countingFrameSource(), surface: stubSurface },
      }),
    ).rejects.toThrow(/video sink/i);
  });

  // A prior task fixed a silent no-op here: frames were never added to the
  // image sink and finish()'s bytes were discarded. That branch had zero
  // coverage. This closes it at the schedule level (the browser lane's
  // outputs.test.ts covers the same branch with a real encoder end to end).
  // STILL_1440.fps is 0 (it drives renderStills's own loop, not this one),
  // so a real fps is substituted to get more than a single scheduled frame.
  describe("png target", () => {
    const target = { ...STILL_1440, fps: 10 };

    it("adds one image per scheduled frame, matching the mp4 loop's own schedule math", async () => {
      const images = createCollectingImageSink();
      await renderScene({
        plan,
        bundle,
        scene,
        target,
        ports: { frames: countingFrameSource(), surface: stubSurface, images },
      });
      // See the mp4-loop test above: idle no longer compresses, so the
      // retimed output is the raw 9000ms source duration.
      const resolvedDuration = 9000;
      const step = 1000 / target.fps;
      const expected = Math.round(resolvedDuration / step);
      expect(images.files.length).toBeGreaterThan(expected - 3);
      expect(images.files.length).toBeLessThan(expected + 3);
    });

    it("returns the sink's own bytes rather than an empty buffer", async () => {
      const images = createCollectingImageSink();
      const { bytes } = await renderScene({
        plan,
        bundle,
        scene,
        target,
        ports: { frames: countingFrameSource(), surface: stubSurface, images },
      });
      const files = await images.finish();
      expect(files.length).toBeGreaterThan(0);
      expect(bytes).toEqual(files[0]?.bytes);
    });

    it("refuses a png target with no image sink rather than silently doing nothing", async () => {
      await expect(
        renderScene({
          plan,
          bundle,
          scene,
          target,
          ports: { frames: countingFrameSource(), surface: stubSurface },
        }),
      ).rejects.toThrow(/png sink/i);
    });
  });
});

/**
 * The vertical cap, applied by the render path rather than by the caller.
 *
 * `verticalCameraIntents` was only ever called from `scripts/render-entry.ts`
 * and one unit test, so the obvious call — `renderScene({ plan, target:
 * VERTICAL_1080 })`, which SP7's editor will certainly write — shipped the
 * 1.8x landscape zoom on top of the ~2.29x `cover` crop: a ~241 CSS px
 * window with the detail panel reduced to a featureless slab. A cap that
 * depends on the caller remembering is not a cap.
 *
 * `renderFrame` is mocked at the top of this file, so the camera curve it was
 * handed is readable straight off the spy — which is the fact under test.
 */
describe("target-driven camera cap", () => {
  // The cap can only be observed over a zoom that exceeds it. Against a scene
  // with no zooms every scale drawn is 1.0, and "at most 1.15" would pass
  // with the cap deleted.
  const scene = sceneWithZoomOnClick();
  const bundle = proceduralBundle({
    cursorSamples: [{ sourceTimeMs: 0, x: 640, y: 400 }],
  });
  const plan = planScene(scene);

  beforeEach(() => {
    vi.mocked(renderFrame).mockClear();
  });

  const scalesDrawn = () =>
    vi
      .mocked(renderFrame)
      .mock.calls.flatMap(([call]) => call.resolved.cameraKeys)
      .map((key) => key.scale);

  it("caps a cover target's zoom without the caller asking", async () => {
    await renderScene({
      plan,
      bundle,
      scene,
      target: VERTICAL_1080,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        video: createRecordingVideoSink(),
      },
    });
    expect(scalesDrawn().length).toBeGreaterThan(0);
    // The premise: the plan really does ask for more than the cap.
    expect(Math.max(...plan.cameraIntents.map((i) => i.scale))).toBeGreaterThan(
      CAMERA_DEFAULTS.verticalMaxScale,
    );
    expect(Math.max(...scalesDrawn())).toBeLessThanOrEqual(
      CAMERA_DEFAULTS.verticalMaxScale,
    );
  });

  it("leaves a contain target's zoom alone — the premise of the test above", async () => {
    await renderScene({
      plan,
      bundle,
      scene,
      target: LANDSCAPE_1080P,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        video: createRecordingVideoSink(),
      },
    });
    expect(Math.max(...scalesDrawn())).toBeGreaterThan(
      CAMERA_DEFAULTS.verticalMaxScale,
    );
  });

  // Stills take the same road, and a vertical still is a legitimate ask.
  it("caps a cover target in renderStills too", async () => {
    await renderStills({
      plan,
      bundle,
      scene,
      target: { ...VERTICAL_1080, format: "png" },
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        images: createCollectingImageSink(),
      },
    });
    expect(scalesDrawn().length).toBeGreaterThan(0);
    expect(Math.max(...scalesDrawn())).toBeLessThanOrEqual(
      CAMERA_DEFAULTS.verticalMaxScale,
    );
  });

  // Red if renderStills stops returning the composition's facts: the CLI's
  // stills export reads them for zoomWarnings.
  it("reports the same lowered zooms and clamps as renderScene", async () => {
    const target = { ...VERTICAL_1080, format: "png" as const };
    const editedPlan = planScene(scene);
    const stills = await renderStills({
      plan: editedPlan,
      bundle,
      scene,
      target,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        images: createCollectingImageSink(),
      },
    });
    const video = await renderScene({
      plan: editedPlan,
      bundle,
      scene,
      target: VERTICAL_1080,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        video: createRecordingVideoSink(),
      },
    });
    // The premise: this cover target lowers a zoom, so the comparison below
    // compares something: a lowered zoom. No clamp is
    // provoked here (clamps need a detail-limited source), so clampedRanges
    // parity may be [] === [] and is covered by the detail tests instead.
    expect(video.loweredZooms.length).toBeGreaterThan(0);
    expect(stills.loweredZooms).toEqual(video.loweredZooms);
    expect(stills.clampedRanges).toEqual(video.clampedRanges);
  });
});

describe("renderStills naming", () => {
  const scene = readonlyScene();
  const bundle = proceduralBundle({
    cursorSamples: [{ sourceTimeMs: 0, x: 640, y: 400 }],
  });
  const target = STILL_1440;

  // Planned per scene rather than once: the cut case below hands in a
  // different one, and a shared plan would have described the uncut take
  // while the render used the cut scene.
  const namesFor = async (
    outputTimesMs?: number[],
    forScene: typeof scene = scene,
  ) => {
    const images = createCollectingImageSink();
    const { files } = await renderStills({
      plan: planScene(forScene),
      bundle,
      scene: forScene,
      target,
      outputTimesMs,
      ports: { frames: countingFrameSource(), surface: stubSurface, images },
    });
    return files.map((f) => f.name);
  };

  it("names each still for its action when the times are the markers", async () => {
    expect(await namesFor()).toEqual(["act-1.png", "act-2.png", "act-3.png"]);
  });

  // The defect: the name was read from `bundle.markers[i]` unconditionally,
  // so an arbitrary time inherited the filename of whatever action happened
  // to sit at the same index — a still of the middle of a transition
  // delivered as `act-2.png` — and anything past the marker count fell
  // through to `still-N`. A caller supplying its own times is asking for
  // frames, not for beats, so every one of them is numbered.
  it("numbers caller-supplied times instead of borrowing action names", async () => {
    expect(await namesFor([0, 120, 240, 360, 480])).toEqual([
      "still-0.png",
      "still-1.png",
      "still-2.png",
      "still-3.png",
      "still-4.png",
    ]);
  });

  // A step with no frames left in the video gets no still.
  //
  // Two ways to lose them, and this fixture has both. `act-2` is CUT, so its
  // own stretch is gone. `act-3` is the step the cut runs UP TO — it
  // survives in the take — but this bundle's last frame sits exactly on its
  // marker, so the removal reaches the end and the video contains no frame
  // of it either. Without the filter this set shipped `act-2.png` and
  // `act-3.png` as one picture; without the placement check in `stillBeats`
  // it shipped `act-3.png` holding the frame from the moment the author cut.
  //
  // The pixel proof for the SURVIVING-step case is `cut-pixels.test.ts`,
  // which uses a bundle with frames past the last marker. This lane asserts
  // the names.
  it("renders no still for a step the cut leaves no frames of", async () => {
    // Premise: the uncut take really does produce one still per marker, so
    // the shorter list below is the cut's doing and not the fixture's.
    expect(bundle.markers.map((m) => m.actionId)).toEqual([
      "act-1",
      "act-2",
      "act-3",
    ]);
    expect(await namesFor()).toEqual(["act-1.png", "act-2.png", "act-3.png"]);
    // Premise: act-3's marker really is the last frame this bundle holds,
    // which is what leaves it with nothing once the cut reaches the end.
    expect(Math.max(...bundle.keyframes.map((k) => k.sourceTimeMs))).toBe(
      bundle.markers[bundle.markers.length - 1]?.sourceTimeMs,
    );

    const cut = {
      ...scene,
      edits: {
        ...scene.edits,
        removed: removedFor(scene, [{ id: "cut-1", actionId: "act-2" }]),
      },
    };
    expect(await namesFor(undefined, cut)).toEqual(["act-1.png"]);
  });

  // The drop above is correct and it was also SILENT, which is the half
  // this covers. A caller handed `files` one short with nothing to say
  // which step went missing or why — and the two reasons are not the same
  // fact: "this step is cut" is the author's own edit, "the video holds no
  // frame of it" is the take falling short of the step.
  it("says which steps got no still, and which of the two reasons it was", async () => {
    const cut = {
      ...scene,
      edits: {
        ...scene.edits,
        removed: removedFor(scene, [{ id: "cut-1", actionId: "act-2" }]),
      },
    };
    const { files, unplacedStills } = await renderStills({
      plan: planScene(cut),
      bundle,
      scene: cut,
      target,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        images: createCollectingImageSink(),
      },
    });
    // Premise: this is the fixture that loses TWO steps for two different
    // reasons — one cut, one with nothing left in the video. A fixture that
    // stopped losing them would satisfy a bare length check trivially.
    expect(files.map((f) => f.name)).toEqual(["act-1.png"]);
    expect(unplacedStills).toHaveLength(2);

    const said = new Map(unplacedStills.map((u) => [u.actionId, u.reason]));
    expect(said.get("act-2")).toMatch(/removed piece/i);
    // act-3 is NOT removed — it is the step the piece runs up to — so it
    // must not be reported as though the author had removed it.
    expect(said.get("act-3")).not.toMatch(/removed/i);
    expect(said.get("act-3")).toMatch(/no frame/i);
  });

  it("refuses a stills export with no still in it, rather than finishing empty", async () => {
    // `renderScene` throws a named error for this state. `renderStills`
    // returned `{files: []}`, and the offscreen renderer walked zero files
    // and reported the job finished — a successful export with no downloads
    // and no reason given.
    const allCut = {
      ...scene,
      edits: {
        ...scene.edits,
        removed: [{ id: "cut-1", start: null, end: null }],
      },
    };
    // Premise: the one piece is the whole take, which is what leaves
    // nothing to draw.
    expect(allCut.edits.removed).toEqual([
      { id: "cut-1", start: null, end: null },
    ]);

    await expect(
      renderStills({
        plan: planScene(allCut),
        bundle,
        scene: allCut,
        target,
        ports: {
          frames: countingFrameSource(),
          surface: stubSurface,
          images: createCollectingImageSink(),
        },
      }),
    ).rejects.toThrow(/nothing left to render/i);
  });

  it("says the removed pieces are why, so it is actionable", async () => {
    const allCut = {
      ...scene,
      edits: {
        ...scene.edits,
        removed: [{ id: "cut-1", start: null, end: null }],
      },
    };
    const why = await renderStills({
      plan: planScene(allCut),
      bundle,
      scene: allCut,
      target,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        images: createCollectingImageSink(),
      },
    }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(why).toMatch(/removed piece/);
    // And the way out, the way `renderScene`'s own sentence does.
    expect(why).toMatch(/restore/i);
  });

  // An empty take is the same silent-empty shape arrived at from the other
  // side, and it must not borrow the cut sentence — there is nothing to
  // restore.
  it("refuses a take with no steps at all, in its own words", async () => {
    const empty = { ...scene, actions: [], camera: [] };
    const bare = proceduralBundle({ markers: [] });
    expect(bare.markers).toHaveLength(0); // fixture premise
    const why = await renderStills({
      plan: planScene(empty as typeof scene),
      bundle: bare,
      scene: empty as typeof scene,
      target,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        images: createCollectingImageSink(),
      },
    }).then(
      () => "",
      (error: unknown) => (error as Error).message,
    );
    expect(why).toMatch(/nothing left to render/i);
    expect(why).toMatch(/no steps/i);
    expect(why).not.toMatch(/restore/i);
  });
});

// The human quality gate found `act-3.png` visibly soft, "like it was cropped
// to zoom in". Its marker sat exactly on a motion span's inclusive opening
// boundary, so the still was composed from a screencast JPEG the harvest
// captured at 1280x800 — CSS resolution, not the emulated DPR — and upscaled
// into a ~2073px frame, while a 3840x2400 keyframe tagged with that very
// actionId sat unused 800ms later. The detail clamp could not save it: it
// never cuts below 1.0, so it has no way to say "this source is too small".
//
// 189 unit tests missed this because every one of them asked what the stills
// were NAMED and none asked what they were made OF.
describe("renderStills source frame", () => {
  const scene = readonlyScene();
  // The defect, reduced: act-2's marker sits on the span's opening boundary
  // (3200) while the only keyframe tagged `act-2` — the sole full-resolution
  // frame of that beat — is 800ms later at the span's closing boundary.
  const bundle = proceduralBundle({
    cursorSamples: [{ sourceTimeMs: 0, x: 640, y: 400 }],
    keyframes: [
      {
        byteLength: 0,
        sourceTimeMs: 0,
        ref: "k-0",
        width: 3840,
        height: 2400,
        actionId: null,
      },
      {
        byteLength: 0,
        sourceTimeMs: 400,
        ref: "k-1",
        width: 3840,
        height: 2400,
        actionId: "act-1",
      },
      {
        byteLength: 0,
        sourceTimeMs: 4000,
        ref: "k-2",
        width: 3840,
        height: 2400,
        actionId: "act-2",
      },
      {
        byteLength: 0,
        sourceTimeMs: 9000,
        ref: "k-3",
        width: 3840,
        height: 2400,
        actionId: "act-3",
      },
    ],
  });
  const plan = planScene(scene);
  const span = bundle.motionSpans[0] as MotionSpanEntry;

  beforeEach(() => {
    vi.mocked(renderFrame).mockClear();
  });

  /** The source time each still was actually composed at. */
  const sourceTimesDrawn = async (outputTimesMs?: number[]) => {
    await renderStills({
      plan,
      bundle,
      scene,
      target: STILL_1440,
      outputTimesMs,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        images: createCollectingImageSink(),
      },
    });
    return vi
      .mocked(renderFrame)
      .mock.calls.map(([call]) =>
        toSourceMs(call.resolved.timeline, call.outputTimeMs),
      );
  };

  // The premise: without the fix act-2's still is taken at 3200, mid-span.
  it("has a marker sitting inside a motion span", () => {
    const marker = bundle.markers[1] as MarkerEntry;
    expect(marker.actionId).toBe("act-2");
    expect(marker.sourceTimeMs).toBeGreaterThanOrEqual(span.startMs);
    expect(marker.sourceTimeMs).toBeLessThan(span.endMs);
  });

  it("renders each still from its action's keyframe, not its marker", async () => {
    expect(await sourceTimesDrawn()).toEqual([400, 4000, 9000]);
  });

  // The point of moving it: at the marker the bundle serves a surface-capped
  // 2560px span frame; at the keyframe it serves the full 3840px one. This is
  // the assertion that would have caught the blurry still.
  it("lands on a full-resolution source instead of a surface-capped one", async () => {
    const [, actTwo] = await sourceTimesDrawn();
    expect(sourceWidthAt(bundle, 3200)).toBe(span.width); // 2560 — what it had
    expect(servingMotionSpan(bundle, actTwo as number)).toBeNull();
    expect(sourceWidthAt(bundle, actTwo as number)).toBe(3840);
  });

  // Caller-supplied times are moments the caller chose. Relocating one to a
  // keyframe would be the naming defect all over again in the time dimension.
  it("honours caller-supplied times exactly", async () => {
    expect(await sourceTimesDrawn([0, 120, 240])).toEqual([0, 120, 240]);
  });
});

// A keyframe on a span's boundary is covered by the span too, and a naive
// containment test hands back the span's surface-capped frame for an instant
// the bundle holds at full resolution. That is what defeated the fix above
// until the boundary was settled: renderStills asked for source time 4000 and
// the frame source answered with the JPEG stream anyway.
describe("servingMotionSpan", () => {
  const bundle = proceduralBundle();
  const span = bundle.motionSpans[0] as MotionSpanEntry;

  it("serves the span mid-motion", () => {
    expect(servingMotionSpan(bundle, 3600)).toBe(span);
  });

  it("lets a keyframe sitting exactly on a boundary outrank the span", () => {
    // proceduralBundle's act-2 keyframe is at 3200, the span's own start.
    expect(servingMotionSpan(bundle, span.startMs)).toBeNull();
  });

  // Not "past the start wins": at a boundary with no keyframe on it the
  // span's last frame is the only current one, and falling back to the
  // keyframe BEFORE the span would snap the picture to the pre-motion state
  // at the instant motion finished.
  it("keeps serving the span at a boundary no keyframe sits on", () => {
    expect(bundle.keyframes.some((k) => k.sourceTimeMs === span.endMs)).toBe(
      false,
    );
    expect(servingMotionSpan(bundle, span.endMs)).toBe(span);
  });

  it("serves no span outside one", () => {
    expect(servingMotionSpan(bundle, span.endMs + 1)).toBeNull();
  });

  // A capture bundle takes no metrics override, so its keyframes are CSS
  // pixels while its screencast is capped at the physical surface — which on
  // a Retina display is the larger of the two. The standing rule (keyframe
  // wins a coincidence) would serve the smaller frame.
  it("serves a coincident span that out-resolves the keyframe", () => {
    const captured: FrameBundle = {
      ...proceduralBundle(),
      source: "capture",
      cursorSamples: [],
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 1000,
          ref: "k-0",
          width: 1280,
          height: 800,
          actionId: null,
        },
      ],
      motionSpans: [
        {
          byteLength: 0,
          startMs: 1000,
          endMs: 2000,
          ref: "span:s:capture:000000",
          width: 2560,
          height: 1600,
          fps: 30,
        },
      ],
    };
    expect(servingMotionSpan(captured, 1000)).toBe(captured.motionSpans[0]);
  });

  it("still lets an equal-or-higher-resolution keyframe win a coincidence", () => {
    const captured: FrameBundle = {
      ...proceduralBundle(),
      source: "capture",
      cursorSamples: [],
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 1000,
          ref: "k-0",
          width: 2560,
          height: 1600,
          actionId: null,
        },
      ],
      motionSpans: [
        {
          byteLength: 0,
          startMs: 1000,
          endMs: 2000,
          ref: "span:s:capture:000000",
          width: 2560,
          height: 1600,
          fps: 30,
        },
      ],
    };
    expect(servingMotionSpan(captured, 1000)).toBeNull();
  });
});

// The harvest fix (2026-08-25): an animating click's own keyframe must sit
// at the marker instant — exactly a motion span's OPENING boundary — not on
// the settled frame 800ms downstream. Before the fix that keyframe was the
// only one tagged with the action, so the still (and the camera key it
// drives) rode the settled, post-transition, camera-returning-to-neutral
// state instead of the beat itself: correct resolution, wrong moment.
//
// The compositor-side invariant this depends on — a keyframe exactly
// coincident with a span outranks it regardless of which edge it sits on —
// already has generic coverage above, incidentally, via proceduralBundle's
// own act-2 keyframe placement. This pins the actual shape the fixed harvest
// now produces: an action-tagged keyframe on the OPENING edge plus a
// null-tagged "stable state" keyframe on the CLOSING edge, and asserts the
// full renderStills path — not just the predicate — resolves it correctly.
describe("renderStills at an action-tagged keyframe on a span's opening boundary", () => {
  const scene = readonlyScene();
  const bundle = proceduralBundle({
    cursorSamples: [{ sourceTimeMs: 0, x: 640, y: 400 }],
    keyframes: [
      {
        byteLength: 0,
        sourceTimeMs: 0,
        ref: "k-0",
        width: 3840,
        height: 2400,
        actionId: null,
      },
      {
        byteLength: 0,
        sourceTimeMs: 400,
        ref: "k-1",
        width: 3840,
        height: 2400,
        actionId: "act-1",
      },
      // The marker instant, coincident with the motion span's startMs (3200).
      {
        byteLength: 0,
        sourceTimeMs: 3200,
        ref: "k-2",
        width: 3840,
        height: 2400,
        actionId: "act-2",
      },
      // The settled, post-transition frame — a stable state, not a marker.
      {
        byteLength: 0,
        sourceTimeMs: 4000,
        ref: "k-3",
        width: 3840,
        height: 2400,
        actionId: null,
      },
      {
        byteLength: 0,
        sourceTimeMs: 9000,
        ref: "k-4",
        width: 3840,
        height: 2400,
        actionId: "act-3",
      },
    ],
  });
  const plan = planScene(scene);
  const span = bundle.motionSpans[0] as MotionSpanEntry;

  beforeEach(() => {
    vi.mocked(renderFrame).mockClear();
  });

  const sourceTimesDrawn = async () => {
    await renderStills({
      plan,
      bundle,
      scene,
      target: STILL_1440,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        images: createCollectingImageSink(),
      },
    });
    return vi
      .mocked(renderFrame)
      .mock.calls.map(([call]) =>
        toSourceMs(call.resolved.timeline, call.outputTimeMs),
      );
  };

  it("takes act-2's still from the marker-coincident keyframe, not the settled one 800ms later", async () => {
    expect(await sourceTimesDrawn()).toEqual([400, span.startMs, 9000]);
  });

  it("resolves that instant to the full-resolution keyframe, not the surface-capped span", async () => {
    const [, actTwo] = await sourceTimesDrawn();
    expect(servingMotionSpan(bundle, actTwo as number)).toBeNull();
    expect(sourceWidthAt(bundle, actTwo as number)).toBe(3840);
  });
});

describe("renderScene, a trim collapsed to nothing", () => {
  // F2: `frameCount`'s `Math.max(1, ...)` floor is right for a range shorter
  // than one frame step and wrong for a range of zero — it turned a trim the
  // author had accidentally cut to nothing into a one-frame mp4 with
  // non-empty bytes, stored and listed beside every real render. The offscreen
  // renderer turns a throw here into `{kind:"failed", error}` per output, so
  // refusing is what puts the reason in front of the author.
  const scene = {
    ...readonlyScene(),
    edits: {
      ...readonlyScene().edits,
      trim: {
        head: { actionId: "act-2", offsetMs: 0 },
        tail: { actionId: "act-2", offsetMs: 0 },
      },
    },
  };
  const bundle = proceduralBundle({
    cursorSamples: [{ sourceTimeMs: 0, x: 640, y: 400 }],
  });

  it("refuses rather than returning a one-frame file", async () => {
    const video = createRecordingVideoSink();
    await expect(
      renderScene({
        plan: planScene(scene),
        bundle,
        scene,
        target: LANDSCAPE_1080P,
        ports: { frames: countingFrameSource(), surface: stubSurface, video },
      }),
    ).rejects.toThrow(/trim/i);
    expect(video.calls).toEqual([]);
  });
});

describe("progress", () => {
  it("reports every frame once, in order, against the frame count", async () => {
    const scene = readonlyScene();
    const bundle = proceduralBundle();
    const calls: [number, number][] = [];
    const sink = createRecordingVideoSink();
    await renderScene({
      plan: planScene(scene),
      bundle,
      scene,
      target: LANDSCAPE_1080P,
      ports: {
        frames: countingFrameSource(),
        surface: stubSurface,
        video: sink,
      },
      onFrame: (done, total) => calls.push([done, total]),
    });
    // Premise: a real multi-frame render, or "once per frame" is one call.
    expect(sink.calls.length).toBeGreaterThan(10);
    expect(calls).toHaveLength(sink.calls.length);
    expect(calls.map(([done]) => done)).toEqual(
      sink.calls.map((_, i) => i + 1),
    );
    expect(new Set(calls.map(([, total]) => total))).toEqual(
      new Set([sink.calls.length]),
    );
  });

  it("reports stills one per file", async () => {
    const scene = readonlyScene();
    const bundle = proceduralBundle();
    const calls: [number, number][] = [];
    const images = createCollectingImageSink();
    await renderStills({
      plan: planScene(scene),
      bundle,
      scene,
      target: STILL_1440,
      ports: { frames: countingFrameSource(), surface: stubSurface, images },
      onFrame: (done, total) => calls.push([done, total]),
    });
    // Premise: the procedural bundle has several markers.
    expect(bundle.markers.length).toBeGreaterThan(1);
    expect(calls).toEqual(
      bundle.markers.map((_, i) => [i + 1, bundle.markers.length]),
    );
  });
});
