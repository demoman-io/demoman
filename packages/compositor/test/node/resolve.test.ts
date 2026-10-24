import { MOTION_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import { springEase } from "../../src/easing";
import type { Vec } from "../../src/geometry";
import {
  CAMERA_DEFAULTS,
  motionTimings,
  sampleCamera,
} from "../../src/plan/camera";
import { sampleSegment } from "../../src/plan/cursor";
import {
  CURSOR_SPRING_TAU_MS,
  springLeadMs,
  springSettleMs,
} from "../../src/plan/cursor-spring";
import { planScene } from "../../src/plan/plan";
import {
  cursorMotionSpans,
  resolvePlan,
  sampleCursor,
} from "../../src/plan/resolve";
import { toOutputMs } from "../../src/plan/timeline";
import { proceduralBundle } from "../fixtures/bundle";
import { cameraKey } from "../fixtures/camera-key";
import {
  mutatingScene,
  readonlyScene,
  sceneWithCosmetics,
  sceneWithZoomOnClick,
} from "../fixtures/scene";

function bundle(overrides: Partial<FrameBundle> = {}): FrameBundle {
  return {
    bundleVersion: 1,
    sceneId: "scene-readonly-001",
    source: "replay",
    dpr: 3,
    viewport: { width: 1280, height: 800 },
    keyframes: [
      {
        byteLength: 0,
        sourceTimeMs: 0,
        ref: "k0",
        width: 3840,
        height: 2400,
        actionId: null,
      },
      {
        byteLength: 0,
        sourceTimeMs: 9000,
        ref: "k1",
        width: 3840,
        height: 2400,
        actionId: "act-3",
      },
    ],
    motionSpans: [],
    cursorSamples: [
      { sourceTimeMs: 0, x: 0, y: 0 },
      { sourceTimeMs: 1000, x: 100, y: 200 },
    ],
    cursorGaps: [],
    // Replay resolved the checkout button somewhere different from where
    // capture saw it — the page had scrolled. The camera must follow replay.
    anchorRects: [
      {
        actionId: "act-3",
        anchorId: "a-checkout",
        rect: { x: 500, y: 100, width: 160, height: 44 },
      },
    ],
    markers: [
      { actionId: "act-1", sourceTimeMs: 400 },
      { actionId: "act-2", sourceTimeMs: 3200 },
      { actionId: "act-3", sourceTimeMs: 9000 },
    ],
    degradations: [],
    ...overrides,
  };
}

describe("sampleCursor", () => {
  const samples = [
    { sourceTimeMs: 0, x: 0, y: 0 },
    { sourceTimeMs: 100, x: 100, y: 0 },
  ];

  it("interpolates between samples", () => {
    expect(sampleCursor(samples, 50)).toEqual({ x: 50, y: 0 });
  });

  it("clamps outside the sampled range", () => {
    expect(sampleCursor(samples, -10)).toEqual({ x: 0, y: 0 });
    expect(sampleCursor(samples, 999)).toEqual({ x: 100, y: 0 });
  });

  it("returns null when there is nothing to sample", () => {
    expect(sampleCursor([], 0)).toBeNull();
  });
});

describe("resolvePlan", () => {
  const plan = planScene(sceneWithZoomOnClick());

  // The whole reason resolvePlan exists: replay knows where things actually
  // were, and capture-time rects are only a fallback.
  it("prefers the bundle's anchor rect over the capture-time rect", () => {
    const resolved = resolvePlan(plan, bundle(), sceneWithZoomOnClick());
    const key = resolved.cameraKeys.find((k) => k.scale > 1);
    expect(key?.center).toEqual({ x: 580, y: 122 });
  });

  it("falls back to the capture-time rect when replay recorded none", () => {
    const resolved = resolvePlan(
      plan,
      bundle({ anchorRects: [] }),
      sceneWithZoomOnClick(),
    );
    const key = resolved.cameraKeys.find((k) => k.scale > 1);
    expect(key?.center).toEqual({ x: 1060, y: 642 });
  });

  it("solves the camera with the scene's own motion block, and reports it", () => {
    const keysWith = (smoothness: number | null) => {
      const scene = sceneWithZoomOnClick();
      const withMotion =
        smoothness === null
          ? scene
          : { ...scene, motion: { ...MOTION_DEFAULTS, smoothness } };
      return resolvePlan(planScene(withMotion), bundle(), withMotion);
    };
    // Absent: the documented defaults, by reference.
    const plain = keysWith(null);
    expect(plain.motion).toBe(MOTION_DEFAULTS);
    expect(plain.cameraKeys.find((k) => k.scale > 1)).toMatchObject({
      transitionMs: CAMERA_DEFAULTS.zoomInMs,
      stiffness: CAMERA_DEFAULTS.stiffness,
    });
    // Present: its own timings reach the keys a render samples.
    const languid = keysWith(1);
    expect(languid.motion.smoothness).toBe(1);
    const timings = motionTimings(1);
    // Premise: smoothness 1 is not the default, so the match is not free.
    expect(timings.zoomInMs).not.toBe(CAMERA_DEFAULTS.zoomInMs);
    expect(languid.cameraKeys.find((k) => k.scale > 1)).toMatchObject({
      transitionMs: timings.zoomInMs,
      stiffness: timings.stiffness,
    });
  });

  it("uses the cursor samples replay dispatched", () => {
    const resolved = resolvePlan(plan, bundle(), sceneWithZoomOnClick());
    expect(resolved.cursor).toEqual(bundle().cursorSamples);
  });

  // `plan/types.ts` makes a replayed cursor's identity with its recorded
  // input the point; smoothing must never touch it. A capture-sourced
  // cursor is a real hand, and this is where that split is wired.
  describe("cursor smoothing", () => {
    const jitteryCapture = Array.from({ length: 10 }, (_, i) => ({
      sourceTimeMs: i * 8,
      x: i * 10,
      y: i % 2 === 0 ? 100 : 101,
    }));

    it("smooths a capture-sourced cursor's jitter, starting where it starts", () => {
      const resolved = resolvePlan(
        plan,
        bundle({ source: "capture", cursorSamples: jitteryCapture }),
        sceneWithZoomOnClick(),
      );
      expect(resolved.cursor[0]).toEqual(jitteryCapture[0]);
      // No claim about the far end. It used to assert the last sample was
      // exact; `followWithSpring` ends this fixture 56px short, and that is
      // arithmetic rather than a regression — a critically damped follower
      // chasing a target from rest has covered `1 - (1 + t/tau)e^(-t/tau)`
      // of the distance, which over a 72ms take at tau 55 is 37%. This
      // fixture is 72ms of unbroken fast movement with no tail, which no
      // real take is.
      //
      // Rather than weaken that assertion to whatever number this fixture
      // happens to produce, it is gone: the two properties it was standing
      // in for are tested where they belong. `smoothCursor` still holds its
      // own endpoints exactly (`cursor-smoothing.test.ts`), and the spring
      // arrives and stays arrived (`cursor-spring.test.ts`). What has to be
      // true HERE is only that capture is smoothed and replay is not.
      // At least one interior sample moved off its raw jittery y — this is
      // not a vacuous "smoothing ran but did nothing" check.
      const movedOffRaw = resolved.cursor.some(
        (s, i) =>
          i > 0 &&
          i < jitteryCapture.length - 1 &&
          s.y !== jitteryCapture[i]?.y,
      );
      expect(movedOffRaw).toBe(true);
    });

    it("draws a replay-sourced cursor exactly as recorded, jitter and all", () => {
      const resolved = resolvePlan(
        plan,
        bundle({ source: "replay", cursorSamples: jitteryCapture }),
        sceneWithZoomOnClick(),
      );
      // Same raw samples as the capture case above, but source: "replay" —
      // the drawn cursor must be byte-for-byte what replay dispatched,
      // jitter included, because those samples ARE the input that drove
      // the app.
      expect(resolved.cursor).toEqual(jitteryCapture);
    });
  });

  // A mutating scene never replayed, so there is nothing to hand back. The
  // compositor synthesizes from its own segments instead — v9's second
  // cursor rule, for frozen frames.
  it("synthesizes a cursor when the bundle came from capture", () => {
    const frozen = bundle({
      source: "capture",
      cursorSamples: [],
      anchorRects: [],
    });
    const resolved = resolvePlan(
      planScene(mutatingScene()),
      frozen,
      mutatingScene(),
    );
    expect(resolved.cursor.length).toBeGreaterThan(1);
    const last = resolved.cursor[resolved.cursor.length - 1];
    expect(last).toMatchObject({ x: 1060, y: 642 });
  });

  it("synthesizes each move as a bell of speed, not a spike through its middle", () => {
    const scene = readonlyScene();
    // The premise: a hover-sensitive scene takes the gentler sine on purpose,
    // so this has to be a scene that does not.
    expect(scene.flags.hoverSensitive).toBe(false);
    const plan = planScene(scene);
    const resolved = resolvePlan(
      plan,
      bundle({ source: "capture", cursorSamples: [], anchorRects: [] }),
      scene,
    );
    // The move into the click at 9000ms, which has the whole gap since the
    // marker at 3200ms to depart in, so neither clamp shortens it.
    const segment = plan.cursorSegments.find((s) => s.toActionId === "act-3");
    if (!segment) throw new Error("expected a segment to the click");
    const arriveMs = 9000 - segment.dwellMs;
    const departMs = arriveMs - segment.durationMs;
    expect(departMs).toBeGreaterThan(3200);
    const travel = resolved.cursor.filter(
      (s) => s.sourceTimeMs >= departMs && s.sourceTimeMs <= arriveMs,
    );
    const speeds = travel
      .slice(1)
      .map(
        (s, i) =>
          Math.hypot(s.x - (travel[i] as Vec).x, s.y - (travel[i] as Vec).y) /
          (s.sourceTimeMs -
            (travel[i] as { sourceTimeMs: number }).sourceTimeMs),
      );
    const distance = Math.hypot(
      segment.to.x - segment.from.x,
      segment.to.y - segment.from.y,
    );
    expect(distance).toBeGreaterThan(100);
    expect(speeds.length).toBeGreaterThan(20);
    const average = (speeds.reduce((a, b) => a + b, 0) /
      speeds.length) as number;
    // easeInOutCubic measured 3.0 here; minimum jerk's bell is 1.875 plus
    // what the bow adds.
    expect(Math.max(...speeds) / average).toBeLessThan(2.2);
  });

  /**
   * The synthesized path must never run backwards.
   *
   * A segment departs `dwell + duration` before its marker — 750ms on a
   * hover-sensitive scene, 540ms otherwise. Two markers closer together than
   * that used to interleave after the sort: segment k+1 was already
   * travelling when segment k's trailing hold sample landed at `arrive_k`,
   * so `sampleCursor` interpolated back to the anchor the pointer had
   * already left and then forward again. Frozen-frame scenes only — a
   * replayed bundle brings its own samples.
   *
   * Measured as arc length, because that is what doubling back actually
   * costs: a path that visits an anchor, leaves, returns and leaves again
   * travels that leg three times. The planned segments are the floor.
   */
  it("never doubles back when two markers are closer than a segment wants", () => {
    const frozen = bundle({
      source: "capture",
      cursorSamples: [],
      anchorRects: [],
      // 300ms and 700ms apart, both inside the 750ms a hover-sensitive
      // segment asks for, and late enough that the old code's departures
      // reached back past the previous marker rather than past zero.
      markers: [
        { actionId: "act-1", sourceTimeMs: 2000 },
        { actionId: "act-2", sourceTimeMs: 2300 },
        { actionId: "act-3", sourceTimeMs: 3000 },
      ],
    });
    const scene = mutatingScene();
    const plan = planScene(scene);
    const resolved = resolvePlan(plan, frozen, scene);

    // Samples are in order: the precondition the interpolation relies on.
    for (let i = 1; i < resolved.cursor.length; i++) {
      expect(resolved.cursor[i]?.sourceTimeMs).toBeGreaterThanOrEqual(
        resolved.cursor[i - 1]?.sourceTimeMs as number,
      );
    }

    const arcOf = (points: Vec[]) =>
      points.reduce(
        (total, point, i) =>
          i === 0
            ? 0
            : total +
              Math.hypot(
                point.x - (points[i - 1] as Vec).x,
                point.y - (points[i - 1] as Vec).y,
              ),
        0,
      );

    const planned = plan.cursorSegments.reduce(
      (total, segment) =>
        total +
        arcOf(
          Array.from({ length: 129 }, (_, i) =>
            sampleSegment(segment, i / 128),
          ),
        ),
      0,
    );

    const drawn: Vec[] = [];
    for (let t = 0; t <= 3200; t += 4) {
      const at = sampleCursor(resolved.cursor, t);
      expect(at).not.toBeNull();
      if (at) drawn.push(at);
    }

    // 5% for the polyline's own sampling error. Measured with the defect
    // reintroduced, this ratio is 1.98 — the pointer walks almost the whole
    // path twice.
    expect(arcOf(drawn) / planned).toBeLessThan(1.05);
  });

  // In OUTPUT time, not source. The pulse and the press are viewer-time
  // animations, so the composer has to window them against the same clock it
  // is drawing on; handing them a source time lets the retimer set their
  // duration. Here the click's source time is the very end of the source
  // timeline, which retiming maps to the very end of the output one.
  //
  // Idle no longer compresses (P5, 2026-09-08), so a plain plan's output and
  // source clocks now coincide by construction — asserting against that
  // plan would pass whether or not `resolvePlan` used the right clock. A
  // hold on the click itself is what keeps the two disagreeing: it adds
  // 800ms of output time with no source-time counterpart at all.
  it("records each click as an output time, not a source time", () => {
    const scene = sceneWithZoomOnClick();
    const held = planScene({
      ...scene,
      edits: {
        ...scene.edits,
        holds: [
          {
            id: "hold-1",
            marker: { actionId: "act-3", offsetMs: 0 },
            durationMs: 800,
          },
        ],
      },
    });
    const resolved = resolvePlan(held, bundle(), scene);
    // The type's own click first (act-1, before the hold), then act-3's.
    expect(resolved.clickOutputMs).toEqual([
      400,
      resolved.timeline.outputDurationMs,
    ]);
    // And the two clocks really do disagree here, so this is not a
    // coincidence of an identity map: 9000ms of source plus the 800ms hold.
    expect(resolved.timeline.outputDurationMs).toBe(9800);
  });

  // Replay clicks a type's field to focus it before it types (`walk.ts`,
  // `performVerb`), at the step's marker as it does for a click. That click
  // is real and was drawn as nothing: the cursor arrived, and text appeared.
  it("draws the click a replayed type makes to focus its field", () => {
    const scene = readonlyScene();
    // The premise: the scene opens on a type and has one click besides.
    expect(scene.actions.map((a) => a.kind)).toEqual([
      "type",
      "scrollTo",
      "click",
    ]);
    const resolved = resolvePlan(planScene(scene), bundle(), scene);
    expect(resolved.clickOutputMs).toEqual([400, 9000]);
  });

  // A drag presses at its marker and lets go later: one pulse, at the press,
  // and the held interval in output time for the cursor to stay down through.
  it("maps a held press to output time and pulses at its press only", () => {
    const scene = readonlyScene();
    const scroll = scene.actions[1];
    if (scroll === undefined) throw new Error("fixture has no second action");
    // The premise: act-2 is the scroll this case turns into a drag.
    expect(scroll.kind).toBe("scrollTo");
    const dragged = {
      ...scene,
      actions: scene.actions.map((a) =>
        a.id === scroll.id
          ? ({
              ...a,
              kind: "drag" as const,
              toAnchorId: null,
              to: { by: { x: 200, y: 0 } },
            } as ReturnType<typeof readonlyScene>["actions"][number])
          : a,
      ),
    };
    const resolved = resolvePlan(
      planScene(dragged),
      bundle({
        heldPresses: [{ actionId: scroll.id, pressMs: 3200, releaseMs: 4000 }],
      }),
      dragged,
    );
    expect(resolved.clickOutputMs).toEqual([400, 3200, 9000]);
    expect(resolved.holdOutputMs).toEqual([{ startMs: 3200, endMs: 4000 }]);
  });

  // A take the author recorded has no such click: they may have tabbed into
  // the field, and a click they did make is its own step.
  it("draws no click for a type in a take the author recorded", () => {
    const scene = readonlyScene();
    const resolved = resolvePlan(
      planScene(scene),
      bundle({ source: "capture" }),
      scene,
    );
    expect(resolved.clickOutputMs).toEqual([9000]);
  });

  it("keeps a mask's own rect", () => {
    const scene = sceneWithCosmetics();
    const resolved = resolvePlan(planScene(scene), bundle(), scene);
    expect(resolved.cosmetics.find((c) => c.id === "mask-1")?.rect).toEqual({
      x: 60,
      y: 380,
      width: 400,
      height: 24,
    });
  });

  // Pins solveCameraKeys' use of toOutputMs through the resolvePlan
  // integration, not just toOutputMs in isolation (see timeline.test.ts).
  it("places a solved camera key on the output timeline via toOutputMs", () => {
    const resolved = resolvePlan(plan, bundle(), sceneWithZoomOnClick());
    const key = resolved.cameraKeys.find((k) => k.scale > 1);
    // act-3's marker sits at sourceMs 9000 — this bundle's last source time —
    // so toOutputMs clamps it straight to outputDurationMs. The zoom
    // intent's leadInMs (a negative offset) then pulls the key earlier;
    // solveCameraKeys clamps the result to >= 0, which this stays above.
    const expected =
      resolved.timeline.outputDurationMs + CAMERA_DEFAULTS.leadInMs;
    expect(expected).toBeGreaterThanOrEqual(0);
    expect(key?.outputTimeMs).toBeCloseTo(expected, 6);
  });

  it("builds a timeline", () => {
    expect(
      resolvePlan(plan, bundle(), sceneWithZoomOnClick()).timeline
        .outputDurationMs,
    ).toBeGreaterThan(0);
  });
});

describe("sampleCamera", () => {
  const keys = [
    cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1 }),
    cameraKey({
      outputTimeMs: 500,
      center: { x: 200, y: 100 },
      scale: 2,
      transitionMs: 500,
    }),
  ];

  it("holds the first key before the timeline starts", () => {
    expect(sampleCamera(keys, -100)).toEqual({
      center: { x: 640, y: 400 },
      scale: 1,
    });
  });

  it("holds the last key after the timeline ends", () => {
    expect(sampleCamera(keys, 9999)).toEqual({
      center: { x: 200, y: 100 },
      scale: 2,
    });
  });

  it("eases rather than cuts between keys", () => {
    const mid = sampleCamera(keys, 250);
    expect(mid.scale).toBeGreaterThan(1);
    expect(mid.scale).toBeLessThan(2);
    // Half way in time is `springEase(0.5)` of the way, in log scale (see
    // camera-sample.test.ts). The spring front-loads the move, so that is
    // well past sqrt(2), the symmetric curve's midpoint this used to pin.
    expect(mid.scale).toBeCloseTo(
      2 ** springEase(0.5, CAMERA_DEFAULTS.stiffness),
      6,
    );
  });

  it("defaults to a neutral camera with no keys at all", () => {
    expect(sampleCamera([], 0)).toEqual({ center: { x: 0, y: 0 }, scale: 1 });
  });

  // The keys above sit exactly their transitionMs apart, so they cannot tell
  // the two anchorings apart. These can. The transition belongs to its
  // DESTINATION: hold the departing state until transitionMs before the key,
  // then arrive exactly ON it. Anchored to the departing key instead — which
  // is what this did — the move completed transitionMs after the PREVIOUS
  // key and then parked, so a lone auto-zoom fired at the top of the video
  // and CAMERA_DEFAULTS.leadInMs meant nothing at all: a lead-in can only
  // have a meaning if the key marks an arrival.
  describe("with a destination well past the transition window", () => {
    const distant = [
      cameraKey({ outputTimeMs: 0, center: { x: 640, y: 400 }, scale: 1 }),
      cameraKey({ outputTimeMs: 2000, center: { x: 200, y: 100 }, scale: 2 }),
    ];
    const opensAt = 2000 - CAMERA_DEFAULTS.zoomInMs;

    it("holds the departing state until the transition window opens", () => {
      // Premise: the window opens well after the first key, so the early
      // instants below are really before it.
      expect(opensAt).toBeGreaterThan(400);
      for (const t of [1, 100, 400, opensAt - 1, opensAt]) {
        expect(sampleCamera(distant, t), `at ${t}ms`).toEqual({
          center: { x: 640, y: 400 },
          scale: 1,
        });
      }
    });

    it("is still mid-move a moment before the destination key", () => {
      const nearly = sampleCamera(distant, 2000 - 1);
      expect(nearly.scale).toBeGreaterThan(1);
      expect(nearly.scale).toBeLessThan(2);
    });

    it("arrives exactly at the destination key", () => {
      expect(
        sampleCamera(distant, opensAt + CAMERA_DEFAULTS.zoomInMs / 2).scale,
      ).toBeCloseTo(2 ** springEase(0.5, CAMERA_DEFAULTS.stiffness), 6);
      expect(sampleCamera(distant, 2000)).toEqual({
        center: { x: 200, y: 100 },
        scale: 2,
      });
    });
  });
});

describe("cursorMotionSpans", () => {
  it("reports a span for every pair of samples that moved", () => {
    expect(
      cursorMotionSpans([
        { sourceTimeMs: 0, x: 0, y: 0 },
        { sourceTimeMs: 100, x: 50, y: 0 },
        { sourceTimeMs: 200, x: 50, y: 90 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 100, endMs: 200 },
    ]);
  });

  it("reports nothing while the cursor holds still", () => {
    expect(
      cursorMotionSpans([
        { sourceTimeMs: 0, x: 640, y: 400 },
        { sourceTimeMs: 900, x: 640, y: 400 },
        { sourceTimeMs: 1800, x: 640, y: 400 },
      ]),
    ).toEqual([]);
  });

  // A dwell that jitters by a fraction of a pixel is a hold, not travel.
  it("ignores sub-pixel movement", () => {
    expect(
      cursorMotionSpans([
        { sourceTimeMs: 0, x: 640, y: 400 },
        { sourceTimeMs: 900, x: 640.2, y: 400.1 },
      ]),
    ).toEqual([]);
  });
});

// The design doc used to claim dead air contains no cursor motion "by
// construction". It plainly does: the pointer crosses the screen between one
// action and the next while the page underneath it sits perfectly still. The
// retimer saw a static page, called it dead air, and squeezed two ~1270ms
// travels into 400ms each — the pointer whipped across the harvested render
// at 3.2x, which is the one speed-up in the frame a viewer can actually
// recognise as wrong.
describe("retiming does not compress cursor travel", () => {
  const scene = readonlyScene();
  const plan = planScene(scene);
  const staticPage = {
    keyframes: [
      {
        byteLength: 0,
        sourceTimeMs: 0,
        ref: "k0",
        width: 3840,
        height: 2400,
        actionId: null,
      },
      {
        sourceTimeMs: 4000,
        ref: "k1",
        width: 3840,
        height: 2400,
        actionId: "act-1",
        byteLength: 0,
      },
    ],
    motionSpans: [],
    markers: [{ actionId: "act-1", sourceTimeMs: 4000 }],
    degradations: [],
  };

  it("passes a travelling cursor over a static page through at rate 1.0", () => {
    const resolved = resolvePlan(
      plan,
      bundle({
        ...staticPage,
        cursorSamples: [
          { sourceTimeMs: 0, x: 100, y: 700 },
          { sourceTimeMs: 4000, x: 1180, y: 120 },
        ],
      }),
      scene,
    );
    expect(resolved.timeline.sourceDurationMs).toBe(4000);
    expect(resolved.timeline.outputDurationMs).toBe(4000);
    expect(
      resolved.timeline.segments.every((seg) => seg.kind === "motion"),
    ).toBe(true);
  });

  it("no longer compresses the same span now that the cursor is holding still", () => {
    // Before 2026-09-08 this diverged from the test above (400ms, the old
    // maxIdleMs) precisely because "idle" got clamped and "motion" did not.
    // Idle no longer clamps, so a static page now passes through at rate 1.0
    // exactly like cursor travel does — the classification below still runs
    // and still differs (idle vs motion), but the two spans' output durations
    // no longer do.
    const resolved = resolvePlan(
      plan,
      bundle({
        ...staticPage,
        cursorSamples: [
          { sourceTimeMs: 0, x: 640, y: 400 },
          { sourceTimeMs: 4000, x: 640, y: 400 },
        ],
      }),
      scene,
    );
    expect(resolved.timeline.sourceDurationMs).toBe(4000);
    expect(resolved.timeline.outputDurationMs).toBe(4000);
    expect(resolved.timeline.segments.every((seg) => seg.kind === "idle")).toBe(
      true,
    );
  });
});

/**
 * The drawn cursor moves for longer than the hand did, at BOTH ends, and the
 * retimer has to be told about both or it compresses whichever one it was
 * not told about. A hint is what tells it: a stretch a hint covers is
 * classified `motion` and passes at rate 1.0, and everything else is idle
 * and is the retimer's to compress.
 */
describe("the overhang the spring adds to a gesture", () => {
  const gestureFrom = 4000;
  const gestureTo = 4496;

  const resolved = () => {
    const scene = readonlyScene();
    const samples = [{ sourceTimeMs: 0, x: 100, y: 100 }];
    for (let t = gestureFrom; t <= gestureTo; t += 16) {
      samples.push({ sourceTimeMs: t, x: 100 + (t - gestureFrom), y: 100 });
    }
    samples.push({ sourceTimeMs: 9000, x: 600, y: 100 });
    return resolvePlan(
      planScene(scene),
      bundle({
        source: "capture",
        cursorSamples: samples,
        markers: [],
        motionSpans: [],
      }),
      scene,
    );
  };

  const firstMotion = () => {
    const segment = resolved().timeline.segments.find(
      (s) => s.kind === "motion",
    );
    if (!segment) throw new Error("no motion segment in the timeline");
    return segment;
  };

  it("protects the anticipation before the hand set off", () => {
    // The spring reads its target `springLeadMs` ahead, so the drawn cursor
    // is already gathering itself that long before the first recorded
    // sample. Unprotected, that lands in the dead air the gesture is
    // approached through — the stretch an authored gap compresses hardest —
    // and the departure is snapped through.
    expect(firstMotion().srcStartMs).toBeLessThanOrEqual(
      gestureFrom - springLeadMs(CURSOR_SPRING_TAU_MS),
    );
  });

  it("is measuring a departure the drawn cursor really does anticipate", () => {
    // Fixture guard: if nothing moved before `gestureFrom` there would be
    // nothing to protect, and the assertion above would hold for a hint that
    // was merely generous.
    const cursor = resolved().cursor;
    const early = sampleCursor(cursor, gestureFrom - 100) as Vec;
    const late = sampleCursor(cursor, gestureFrom - 5) as Vec;
    expect(Math.abs(late.x - early.x)).toBeGreaterThan(1);
  });

  it("protects the settle after the hand stopped", () => {
    expect(firstMotion().srcEndMs).toBeGreaterThanOrEqual(
      gestureTo + springSettleMs(CURSOR_SPRING_TAU_MS),
    );
  });

  it("is measuring a stop the drawn cursor really does glide through", () => {
    const cursor = resolved().cursor;
    const stopped = sampleCursor(cursor, gestureTo) as Vec;
    const settled = sampleCursor(
      cursor,
      gestureTo + springSettleMs(CURSOR_SPRING_TAU_MS),
    ) as Vec;
    expect(Math.abs(settled.x - stopped.x)).toBeGreaterThan(1);
  });
});

describe("resolvePlan mask ranges", () => {
  it("resolves a mask's markers to output ms and leaves a whole-take mask unbounded", () => {
    const scene = sceneWithCosmetics();
    const bundle = proceduralBundle();
    const ranged = {
      ...scene,
      edits: {
        ...scene.edits,
        masks: [
          ...scene.edits.masks,
          {
            id: "mask-2",
            rect: { x: 0, y: 0, width: 10, height: 10 },
            start: { actionId: "act-1", sourceOffsetMs: 0 },
            end: { actionId: "act-2", sourceOffsetMs: -100 },
          },
        ],
      },
    };
    const r = resolvePlan(planScene(ranged), bundle, ranged);
    const src = (id: string) =>
      bundle.markers.find((m) => m.actionId === id)?.sourceTimeMs ?? 0;
    // Premise: nothing stands still here, so a frame plays at one instant.
    expect(
      r.timeline.segments.filter((g) => g.srcStartMs === g.srcEndMs),
    ).toEqual([]);
    expect(r.cosmetics.find((c) => c.id === "mask-1")?.range).toBeNull();
    expect(r.cosmetics.find((c) => c.id === "mask-2")?.range).toEqual({
      startMs: toOutputMs(r.timeline, src("act-1")),
      endMs: toOutputMs(r.timeline, src("act-2") - 100),
    });
  });

  it("reports a mask side the bundle carries no marker for, rather than silently widening it", () => {
    // F4: `resolveRange`'s `unplaced` was destructured away for masks while
    // the trim's and the zoom's were kept and surfaced. A mask whose end step
    // lost its marker in the last render then silently ran to the end of the
    // take, painting over stretches the author never asked to redact, with
    // nothing anywhere saying the range is not the authored one.
    const scene = sceneWithCosmetics();
    const bundle = proceduralBundle();
    const ghosted = {
      ...scene,
      edits: {
        ...scene.edits,
        masks: [
          {
            id: "mask-ghost",
            rect: { x: 0, y: 0, width: 10, height: 10 },
            start: { actionId: "act-1", sourceOffsetMs: 0 },
            end: { actionId: "act-ghost", sourceOffsetMs: 0 },
          },
        ],
      },
    };
    const r = resolvePlan(planScene(ghosted), bundle, ghosted);
    const mask = r.cosmetics.find((c) => c.id === "mask-ghost");
    expect(mask?.unplaced).toEqual(["end"]);
    // It still paints, and it still runs to the take's end — the fix is that
    // it now says so, not that it draws differently.
    expect(mask?.range?.endMs).toBe(r.timeline.outputDurationMs);

    // Fixture guard: a mask both of whose steps the bundle DOES carry reports
    // nothing, so the assertion above cannot pass by every mask saying "end".
    const placed = {
      ...ghosted,
      edits: {
        ...ghosted.edits,
        masks: [
          {
            id: "mask-ghost",
            rect: { x: 0, y: 0, width: 10, height: 10 },
            start: { actionId: "act-1", sourceOffsetMs: 0 },
            end: { actionId: "act-2", sourceOffsetMs: 0 },
          },
        ],
      },
    };
    const q = resolvePlan(planScene(placed), bundle, placed);
    expect(q.cosmetics.find((c) => c.id === "mask-ghost")?.unplaced).toEqual(
      [],
    );
  });

  it("reports a mask cut to nothing", () => {
    const scene = sceneWithCosmetics();
    const inverted = {
      ...scene,
      edits: {
        ...scene.edits,
        masks: [
          {
            id: "mask-x",
            rect: { x: 0, y: 0, width: 10, height: 10 },
            start: { actionId: "act-3", sourceOffsetMs: 0 },
            end: { actionId: "act-1", sourceOffsetMs: 0 },
          },
        ],
      },
    };
    const r = resolvePlan(planScene(inverted), proceduralBundle(), inverted);
    expect(r.clampedRanges.map((c) => [c.kind, c.id])).toEqual([
      ["mask", "mask-x"],
    ]);
  });
});
