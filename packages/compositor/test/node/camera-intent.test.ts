import { BRANDING_DEFAULTS, CURSOR_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import type { Rect, Vec } from "../../src/geometry";
import {
  CAMERA_DEFAULTS,
  type CameraKey,
  clampCameraCenter,
  frameCamera,
  planCameraIntents,
  sampleCamera,
  solveCameraKeys,
} from "../../src/plan/camera";
import type { Timeline } from "../../src/plan/timeline";
import {
  contentScale,
  derivePresentation,
} from "../../src/render/presentation";
import {
  LANDSCAPE_1080P,
  type RenderTarget,
  VERTICAL_1080,
} from "../../src/render/target";
import {
  readonlyScene,
  sceneWithCamera,
  sceneWithNavigationWait,
} from "../fixtures/scene";

/**
 * These cases are about camera planning, not about cuts: no step is cut, so
 * nothing is filtered and nothing is collected. `plan-cuts.test.ts` owns
 * what a cut does to a zoom, and passing the two arguments explicitly here
 * — rather than giving `planCameraIntents` defaults — is what keeps a
 * future caller from silently getting "no cuts" by forgetting them.
 */
const intentsOf = (scene: Parameters<typeof planCameraIntents>[0]) =>
  planCameraIntents(scene, new Set<string>(), []);

describe("planCameraIntents", () => {
  // Zoom is authored or it does not exist. Auto-zoom-on-click was a default
  // that could not be seen or deleted: `clearCamera` had to write `scale: 1`
  // rather than remove the event, because removing it let auto put the zoom
  // straight back. Nothing generates a zoom now, so an empty `camera` array
  // means an empty camera track.
  it("emits no zoom for a click the author never marked", () => {
    expect(intentsOf(readonlyScene())).toEqual([]);
  });

  it("carries authored camera events through", () => {
    const intents = intentsOf(sceneWithCamera());
    expect(intents.map((i) => i.id)).toEqual(["cam-1", "cam-2"]);
    expect(intents.map((i) => i.actionId)).toEqual(["act-2", "act-3"]);
  });

  // Every scene edited before this change carries `scale: 1` events written
  // by the old "Hold at 1:1" button, which meant "no zoom here". Honouring
  // them literally would spend two transitions travelling to 1.0 and back
  // from 1.0 — a camera move that shows nothing.
  it("drops an authored event that says 1:1, which is how a scene said no zoom", () => {
    const scene = sceneWithCamera();
    const intents = intentsOf({
      ...scene,
      camera: scene.camera.map((c) =>
        c.id === "cam-2" ? { ...c, scale: 1 } : c,
      ),
    });
    expect(intents.map((i) => i.id)).toEqual(["cam-1"]);
  });

  // `scale` is optional in the schema and defaults to 1, which is the same
  // "no zoom" statement made by omission.
  it("drops an authored event with no scale at all", () => {
    const scene = sceneWithCamera();
    const [first] = scene.camera;
    if (!first) throw new Error("fixture carries no camera events");
    const { scale: _omitted, ...noScale } = first;
    expect(intentsOf({ ...scene, camera: [noScale] })).toEqual([]);
  });

  it("clamps an over-eager authored zoom to the maximum", () => {
    const scene = sceneWithCamera();
    const intents = intentsOf({
      ...scene,
      camera: scene.camera.map((c) =>
        c.id === "cam-1" ? { ...c, scale: 9 } : c,
      ),
    });
    expect(intents.find((i) => i.id === "cam-1")?.scale).toBe(
      CAMERA_DEFAULTS.maxScale,
    );
  });

  it("returns intents sorted by action order then offset", () => {
    // Build a scene where lexical sort and array-position sort diverge:
    // actions in array are "act-c", "act-b", "act-a" — so lexical sort
    // gives reverse of array order. The test fails against a lexical
    // comparator because the returned order would be "act-a", "act-b", "act-c".
    const divergentScene = {
      // v5, matching the schema this package is built against. This fixture
      // sat at schemaVersion 2 and drifted through two migrations unnoticed,
      // because nothing typechecked this directory — `planCameraIntents` only
      // reads `actions` and `camera`, so the test kept passing against a
      // document shape that no longer exists.
      schemaVersion: 12 as const,
      meta: {
        id: "scene-sort-diverge",
        name: "Sort order test",
        createdAt: "2026-08-25T05:00:00.000Z",
        toolchain: {
          resolverVersion: "1.0.0",
          compositorVersion: null,
          captureVersion: null,
        },
        capture: {
          originUrl: "https://app.example.com",
          originClass: "published" as const,
          buildSha: "abc1234",
          buildShaSource: null,
          viewport: { width: 1280, height: 800 },
          dpr: 3,
          mode: "record" as const,
        },
      },
      anchors: [
        {
          id: "anc-c",
          fingerprint: {
            stableId: "elem-c",
            role: "button",
            accessibleName: "anc-c",
            textContent: "anc-c",
            treePath: "body:1/main:1/*:1",
            boundingRect: { x: 100, y: 100, width: 50, height: 50 },
            imagePatchRef: null,
            dataKey: null,
          },
          resolution: {
            url: "https://app.example.com",
            actionIndex: 0,
            entryState: true,
            strategy: "stableId" as const,
            failureReason: null,
            candidates: 1,
          },
        },
        {
          id: "anc-b",
          fingerprint: {
            stableId: "elem-b",
            role: "button",
            accessibleName: "anc-b",
            textContent: "anc-b",
            treePath: "body:1/main:1/*:2",
            boundingRect: { x: 200, y: 200, width: 50, height: 50 },
            imagePatchRef: null,
            dataKey: null,
          },
          resolution: {
            url: "https://app.example.com",
            actionIndex: 1,
            entryState: false,
            strategy: "stableId" as const,
            failureReason: null,
            candidates: 1,
          },
        },
        {
          id: "anc-a",
          fingerprint: {
            stableId: "elem-a",
            role: "button",
            accessibleName: "anc-a",
            textContent: "anc-a",
            treePath: "body:1/main:1/*:3",
            boundingRect: { x: 300, y: 300, width: 50, height: 50 },
            imagePatchRef: null,
            dataKey: null,
          },
          resolution: {
            url: "https://app.example.com",
            actionIndex: 2,
            entryState: false,
            strategy: "stableId" as const,
            failureReason: null,
            candidates: 1,
          },
        },
      ],
      actions: [
        {
          id: "act-c",
          anchorId: "anc-c",
          timestamp: 100,
          marker: "click:anc-c",
          kind: "click" as const,
          button: "left" as const,
        },
        {
          id: "act-b",
          anchorId: "anc-b",
          timestamp: 200,
          marker: "click:anc-b",
          kind: "click" as const,
          button: "left" as const,
        },
        {
          id: "act-a",
          anchorId: "anc-a",
          timestamp: 300,
          marker: "click:anc-a",
          kind: "click" as const,
          button: "left" as const,
        },
      ],
      camera: [
        {
          id: "cam-c",
          kind: "zoom" as const,
          anchorId: "anc-c",
          marker: { actionId: "act-c", offsetMs: -200 },
          scale: 2,
        },
        {
          id: "cam-b",
          kind: "zoom" as const,
          anchorId: "anc-b",
          marker: { actionId: "act-b", offsetMs: 0 },
          scale: 2,
        },
        {
          id: "cam-a-early",
          kind: "zoom" as const,
          anchorId: "anc-a",
          marker: { actionId: "act-a", offsetMs: -100 },
          scale: 1.5,
        },
        {
          id: "cam-a-late",
          kind: "zoom" as const,
          anchorId: "anc-a",
          marker: { actionId: "act-a", offsetMs: 100 },
          scale: 2,
        },
      ],
      edits: { masks: [], holds: [], gaps: [], splits: [], removed: [] },
      sideChannels: {
        network: [],
        consoleExcerpt: [],
        urlTrace: [],
        uncoveredOrigins: [],
      },
      flags: { mutating: false, hoverSensitive: false },
      branding: {
        background: {
          kind: "gradient" as const,
          from: "#daebff",
          to: "#a8c2ff",
          angle: 150,
        },
        logo: null,
        padding: 0.08,
      },
      cursor: CURSOR_DEFAULTS,
      canvas: { aspect: "16:9" as const },
      // No outer `as const`: it made every array readonly, which SceneDocument
      // is not. The literal `kind`/`mode` narrowing that matters is asserted
      // per-field above.
    };

    const intents = intentsOf(divergentScene);

    // Action order: act-c, act-b, act-a (array order)
    // Lexical order: act-a, act-b, act-c (reverse)
    // Test that we get array order, not lexical.
    expect(intents.map((i) => i.actionId)).toEqual([
      "act-c",
      "act-b",
      "act-a",
      "act-a",
    ]);

    // Verify "then offset" part: intents on same action sorted by offsetMs ascending.
    const actAIntents = intents.filter((i) => i.actionId === "act-a");
    expect(actAIntents).toHaveLength(2);
    expect(actAIntents[0]?.offsetMs).toBe(-100);
    expect(actAIntents[1]?.offsetMs).toBe(100);
  });

  // v3: a navigation waitFor carries anchorId: null — it names no element, so
  // it has no on-screen position to aim at. The schema cannot express a zoom
  // on one (CameraEvent.anchorId is required and must name a real anchor), so
  // this pins that the planner agrees rather than inventing a centre.
  it("emits no camera intent for a null-anchor waitFor", () => {
    const intents = intentsOf(sceneWithNavigationWait());
    expect(intents.some((i) => i.actionId === "act-nav")).toBe(false);
  });

  it("carries a point target and an authored end through, with anchorId null", () => {
    const scene = readonlyScene();
    const intents = intentsOf({
      ...scene,
      camera: [
        {
          id: "cam-p",
          kind: "zoom",
          point: { x: 1060, y: 642 },
          marker: { actionId: "act-2", offsetMs: 0 },
          end: { actionId: "act-3", offsetMs: -200 },
          scale: 2,
        },
      ],
    });
    expect(intents).toEqual([
      {
        id: "cam-p",
        kind: "zoom",
        anchorId: null,
        point: { x: 1060, y: 642 },
        actionId: "act-2",
        offsetMs: 0,
        scale: 2,
        end: { actionId: "act-3", offsetMs: -200 },
      },
    ]);
  });

  it("gives an anchor-targeted event point: null and end: null", () => {
    const intent = intentsOf(sceneWithCamera())[0];
    expect(intent?.point).toBeNull();
    expect(intent?.end).toBeNull();
    expect(intent?.anchorId).toBe("a-row");
  });
});

describe("clampCameraCenter", () => {
  const viewport = { width: 1280, height: 800 };
  // Real frames rather than invented ones: the clamp has to agree with what
  // `derivePresentation` actually produces for each fit mode.
  const frameOf = (target: RenderTarget) =>
    derivePresentation(BRANDING_DEFAULTS, target, viewport).frameRect;
  const kOf = (target: RenderTarget, scale: number) =>
    contentScale(frameOf(target), viewport) * scale;

  describe("under contain", () => {
    const frame = frameOf(LANDSCAPE_1080P);

    // At 1:1 a contain frame is covered exactly on both axes, so there is
    // nothing off-frame to pan to and the legal range is a single point.
    it("pins the centre to the viewport middle at scale 1", () => {
      const k = kOf(LANDSCAPE_1080P, 1);
      expect(
        clampCameraCenter({ x: 1220, y: 760 }, k, frame, viewport),
      ).toEqual({ x: 640, y: 400 });
      expect(clampCameraCenter({ x: 0, y: 0 }, k, frame, viewport)).toEqual({
        x: 640,
        y: 400,
      });
    });

    it("allows exactly a half-window of pan at scale 2", () => {
      // The window is the viewport halved, so x is legal in [320, 960].
      const k = kOf(LANDSCAPE_1080P, 2);
      expect(
        clampCameraCenter({ x: 1220, y: 760 }, k, frame, viewport),
      ).toEqual({ x: 960, y: 600 });
      expect(clampCameraCenter({ x: 100, y: 50 }, k, frame, viewport)).toEqual({
        x: 320,
        y: 200,
      });
    });

    it("leaves a centre that is already legal untouched", () => {
      const k = kOf(LANDSCAPE_1080P, 2);
      expect(clampCameraCenter({ x: 700, y: 420 }, k, frame, viewport)).toEqual(
        {
          x: 700,
          y: 420,
        },
      );
    });
  });

  describe("under cover", () => {
    const frame = frameOf(VERTICAL_1080);
    const k = kOf(VERTICAL_1080, 1);

    // The follow crop lives here. A 9:16 window over a 16:10 page is filled
    // on height and overflows on width, so even at scale 1 the camera must be
    // free to slide that window across the page. Clamping this axis to a
    // point — which a scale-derived half-window would do — would freeze the
    // crop over the middle of the page and there would be nothing to follow.
    it("leaves real room to pan on the overflowing axis at scale 1", () => {
      const half = frame.width / k / 2;
      expect(half).toBeLessThan(viewport.width / 2);
      expect(clampCameraCenter({ x: 1060, y: 400 }, k, frame, viewport).x).toBe(
        1060,
      );
      expect(clampCameraCenter({ x: 0, y: 400 }, k, frame, viewport).x).toBe(
        half,
      );
      expect(clampCameraCenter({ x: 9999, y: 400 }, k, frame, viewport).x).toBe(
        viewport.width - half,
      );
    });

    // Height is filled exactly, so that axis has no room and pins — the same
    // rule, just landing on the other answer.
    it("pins the filled axis", () => {
      expect(clampCameraCenter({ x: 640, y: 780 }, k, frame, viewport).y).toBe(
        400,
      );
      expect(clampCameraCenter({ x: 640, y: 10 }, k, frame, viewport).y).toBe(
        400,
      );
    });
  });

  // A window wider than the viewport would put the low bound above the high
  // one, and `clamp` is min(hi, max(lo, v)) — it would answer `hi` and shove
  // the camera into a corner instead of centring it.
  it("pins rather than inverting when the window exceeds the viewport", () => {
    const frame = { width: 1920, height: 1200 };
    expect(clampCameraCenter({ x: 0, y: 0 }, 0.5, frame, viewport)).toEqual({
      x: 640,
      y: 400,
    });
  });
});

/**
 * The camera zooms the whole composition — background, the rounded window
 * and the app inside it. So the window the
 * viewer sees is the CANVAS shrunk by the scale, and it is the canvas, not
 * the app frame, that it has to stay inside.
 */
describe("frameCamera", () => {
  const viewport = { width: 1280, height: 800 };
  const target = LANDSCAPE_1080P;
  const canvas = { width: target.width, height: target.height };
  // A 15% padding, not the default: these cases need a wide margin on every
  // side (asserted below), and the "x=355" figures are read off it.
  const frame = derivePresentation(
    { ...BRANDING_DEFAULTS, padding: 0.15 },
    target,
    viewport,
  ).frameRect;
  const base = contentScale(frame, viewport);
  const canvasCentre = { x: canvas.width / 2, y: canvas.height / 2 };

  /** Where a point of the unzoomed composition lands in the output. */
  const toOutput = (
    camera: ReturnType<typeof frameCamera>,
    scenePoint: Vec,
  ): Vec => ({
    x: canvasCentre.x + (scenePoint.x - camera.focus.x) * camera.scale,
    y: canvasCentre.y + (scenePoint.y - camera.focus.y) * camera.scale,
  });

  // The geometry every case below reads off: a contain frame centred on the
  // canvas, inset on every side. If the presets stop producing it, the
  // numbers below stop meaning what their comments say.
  it("works on a frame centred in the canvas with a margin on every side", () => {
    expect(frame.x + frame.width / 2).toBeCloseTo(canvasCentre.x, 6);
    expect(frame.y + frame.height / 2).toBeCloseTo(canvasCentre.y, 6);
    expect(frame.x).toBeGreaterThan(100);
    expect(frame.y).toBeGreaterThan(100);
  });

  it("looks at the whole canvas at scale 1, wherever the key points", () => {
    for (const center of [
      { x: 0, y: 0 },
      { x: 1220, y: 760 },
    ]) {
      const camera = frameCamera(
        { center, scale: 1 },
        base,
        frame,
        viewport,
        canvas,
      );
      expect(camera.focus).toEqual(canvasCentre);
      expect(camera.center).toEqual({ x: 640, y: 400 });
    }
  });

  it("puts the zoomed point at the centre of the output when there is room", () => {
    const camera = frameCamera(
      { center: { x: 700, y: 420 }, scale: 1.8 },
      base,
      frame,
      viewport,
      canvas,
    );
    expect(camera.center.x).toBeCloseTo(700, 6);
    expect(camera.center.y).toBeCloseTo(420, 6);
    // The page point is drawn where the composition's own geometry puts it.
    const scenePoint = {
      x: frame.x + frame.width / 2 + (700 - camera.pan.x) * base,
      y: frame.y + frame.height / 2 + (420 - camera.pan.y) * base,
    };
    const out = toOutput(camera, scenePoint);
    expect(out.x).toBeCloseTo(canvasCentre.x, 6);
    expect(out.y).toBeCloseTo(canvasCentre.y, 6);
  });

  // Toward a corner the camera goes as far as the canvas allows and no
  // further: the canvas's own corner lands on the output's corner, and the
  // margin between it and the window is in shot.
  it("stops at the canvas edge, not at the window's", () => {
    const camera = frameCamera(
      { center: { x: 0, y: 0 }, scale: 1.8 },
      base,
      frame,
      viewport,
      canvas,
    );
    const origin = toOutput(camera, { x: 0, y: 0 });
    expect(origin.x).toBeCloseTo(0, 6);
    expect(origin.y).toBeCloseTo(0, 6);
    const windowCorner = toOutput(camera, { x: frame.x, y: frame.y });
    expect(windowCorner.x).toBeCloseTo(frame.x * 1.8, 6);
    expect(windowCorner.y).toBeCloseTo(frame.y * 1.8, 6);
  });

  // The old clamp kept a frame-sized window inside the viewport, so a point
  // 100 CSS px from the page edge could only be framed from x=355. Over the
  // whole canvas the camera reaches further toward it.
  it("reaches closer to a point near the page edge than a frame-bound camera could", () => {
    const camera = frameCamera(
      { center: { x: 100, y: 400 }, scale: 1.8 },
      base,
      frame,
      viewport,
      canvas,
    );
    const frameBound = clampCameraCenter(
      { x: 100, y: 400 },
      base * 1.8,
      frame,
      viewport,
    );
    expect(frameBound.x).toBeGreaterThan(350);
    expect(camera.center.x).toBeLessThan(frameBound.x - 100);
    expect(camera.center.x).toBeGreaterThan(100);
  });

  // The follow crop is a pan of the app inside its window, not a camera
  // move: it still slides at scale 1 under cover, as `clampCameraCenter`
  // rules, and the scene camera has nothing to do there.
  it("keeps the cover follow crop as a pan inside the window", () => {
    const vertical = VERTICAL_1080;
    const vFrame = derivePresentation(
      BRANDING_DEFAULTS,
      vertical,
      viewport,
    ).frameRect;
    const vBase = contentScale(vFrame, viewport);
    const camera = frameCamera(
      { center: { x: 1060, y: 400 }, scale: 1 },
      vBase,
      vFrame,
      viewport,
      { width: vertical.width, height: vertical.height },
    );
    expect(camera.pan.x).toBe(1060);
    expect(camera.center.x).toBeCloseTo(1060, 6);
    expect(camera.focus).toEqual({
      x: vertical.width / 2,
      y: vertical.height / 2,
    });
  });
});

/**
 * A zoom is a segment, not a camera position.
 *
 * It used to be a position: `solveCameraKeys` pushed one key per zoom and
 * `sampleCamera` holds the last key forever, so the camera pushed in at the
 * first beat and never came back out — every scroll after it was watched
 * through a 711-CSS-px window, and the video ended zoomed on whatever the
 * last beat happened to be. Return-to-neutral existed but was gated on the
 * next beat being 2.6s away or 40% of the diagonal across the page, so most
 * beats never triggered it and the final one could not.
 *
 * Now every zoom pushes in, holds through its beat, and pulls back out. Full
 * frame is the resting state; a zoom is a departure from it that ends.
 */
describe("solveCameraKeys zoom segments", () => {
  const viewport = { width: 1280, height: 800 };
  const ZOOM = 1.8;
  // Output time is source time here: retiming is not what is under test, and
  // an identity map keeps every number in this file readable as milliseconds.
  const timeline: Timeline = {
    segments: [
      {
        outStartMs: 0,
        outEndMs: 20_000,
        srcStartMs: 0,
        srcEndMs: 20_000,
        kind: "motion",
      },
    ],
    outputDurationMs: 20_000,
    sourceDurationMs: 20_000,
    unplacedPaces: 0,
    nonMonotonicPaces: 0,
    // Hand-built timelines: these cases are about the camera, the
    // cursor's idle fade and its trail, none of which a cut touches.
    cuts: [],
    unplacedCuts: [],
    interruptions: [],
  };

  const rect = (x: number, y: number): Rect => ({
    x: x - 80,
    y: y - 22,
    width: 160,
    height: 44,
  });

  function keysFor(
    beats: { anchorId: string; markerMs: number; at: Vec }[],
    overrides: { timeline?: Timeline } = {},
  ): CameraKey[] {
    const rects = new Map(beats.map((b) => [b.anchorId, rect(b.at.x, b.at.y)]));
    return solveCameraKeys(
      beats.map((b, i) => ({
        id: `cam-${i}`,
        kind: "zoom" as const,
        anchorId: b.anchorId,
        point: null,
        end: null,
        actionId: `act-${i}`,
        offsetMs: CAMERA_DEFAULTS.leadInMs,
        scale: ZOOM,
      })),
      (id) => rects.get(id) ?? null,
      overrides.timeline ?? timeline,
      new Map(beats.map((b, i) => [`act-${i}`, b.markerMs])),
      viewport,
    );
  }

  /** Arrival is `leadInMs` before the marker, so the beat has landed by then. */
  const arrivalOf = (markerMs: number) => markerMs + CAMERA_DEFAULTS.leadInMs;

  const ONE = [{ anchorId: "a", markerMs: 2755, at: { x: 600, y: 400 } }];
  /** What a return to 1:1 between two zooms costs: the pull-out, the next
   *  push-in, and a plateau at each end (`insertNeutralKeys`). */
  const ROOM_MS =
    CAMERA_DEFAULTS.zoomOutMs +
    CAMERA_DEFAULTS.zoomInMs +
    2 * CAMERA_DEFAULTS.neutral.minPlateauMs;
  // Adjacent controls, 3s apart: not "in another region" (< 40% of the
  // diagonal) under the rule this replaces, so the old gate skipped the
  // pull-out and the camera stayed in.
  //
  // They were 2.5s apart until the spring zooms (2026-10-09), which also
  // put them under the old rule's other clause ("distant" was 2.6s). The
  // longer moves made a return cost ROOM_MS — 2.725s at the default
  // smoothness — so no gap under 2.6s can return any more on physics alone,
  // and that clause can no longer be told apart from it. The region clause
  // still can, and it is what this pair now exercises.
  const NEAR = [
    { anchorId: "a", markerMs: 2755, at: { x: 600, y: 400 } },
    { anchorId: "b", markerMs: 5755, at: { x: 700, y: 420 } },
  ];

  it("ends the video at 1:1 after the last zoom", () => {
    const keys = keysFor(ONE);
    const last = keys[keys.length - 1] as CameraKey;
    expect(last.scale).toBe(1);
    expect(last.outputTimeMs).toBeGreaterThan(arrivalOf(2755));
    expect(sampleCamera(keys, timeline.outputDurationMs).scale).toBe(1);
  });

  it("returns to 1:1 between two nearby beats in the same region", () => {
    const [from, to] = NEAR as [(typeof NEAR)[0], (typeof NEAR)[1]];
    // The premise: the old rule's region clause says "stay in", so a pass
    // here cannot be the old rule agreeing by accident — and the gap pays
    // for a return, so a pass is not physics refusing one either.
    expect(Math.hypot(to.at.x - from.at.x, to.at.y - from.at.y)).toBeLessThan(
      0.4 * Math.hypot(viewport.width, viewport.height),
    );
    expect(to.markerMs - from.markerMs).toBeGreaterThanOrEqual(ROOM_MS);

    const keys = keysFor(NEAR);
    const between = keys.filter(
      (k) =>
        k.scale === 1 &&
        k.outputTimeMs > arrivalOf(from.markerMs) &&
        k.outputTimeMs < arrivalOf(to.markerMs),
    );
    expect(between).toHaveLength(1);
  });

  // The lead-in exists so the push-in has finished before the action fires;
  // the hold exists so what the action did is still on screen when the camera
  // leaves. A pull-out that starts at the marker shows the approach and hides
  // the payoff.
  it("holds the zoom through the beat and half a second past it", () => {
    const keys = keysFor(ONE);
    expect(sampleCamera(keys, 2755).scale).toBeCloseTo(ZOOM, 6);
    expect(sampleCamera(keys, 3255).scale).toBeCloseTo(ZOOM, 6);
  });

  it("holds 1:1 long enough to read as a beat rather than a bounce", () => {
    const keys = keysFor(NEAR);
    const key = keys.find(
      (k) => k.scale === 1 && k.outputTimeMs > arrivalOf(2755),
    );
    expect(key).toBeDefined();
    if (!key) throw new Error("unreachable");
    const { minPlateauMs } = CAMERA_DEFAULTS.neutral;
    for (const t of [key.outputTimeMs, key.outputTimeMs + minPlateauMs]) {
      expect(sampleCamera(keys, t).scale).toBeCloseTo(1, 6);
    }
  });

  // Room is the one thing that can still keep the camera in. The pull-out
  // and the next push-in eat zoomOutMs + zoomInMs of the gap outright and
  // each end needs a plateau to hold; below that there is nothing to hold
  // and the pull-out reads as a wobble, so the camera pans from one beat to
  // the next instead.
  it("pans between two zooms with no room to pull out and back in", () => {
    const beats = [
      ONE[0] as (typeof ONE)[0],
      { anchorId: "b", markerMs: 3755, at: { x: 700, y: 420 } },
    ];
    const gapMs = 1000;
    expect(gapMs).toBeLessThan(ROOM_MS);
    const inner = keysFor(beats).filter(
      (k) =>
        k.scale === 1 &&
        k.outputTimeMs > arrivalOf(2755) &&
        k.outputTimeMs < arrivalOf(3755),
    );
    expect(inner).toHaveLength(0);
  });

  // Ruling 3 (polish-parity plan): the camera is settled before every click,
  // and that includes the clicks of two zooms it pans between. The pan used
  // to keep the push-in's 1300ms, so it left the instant the first zoom
  // arrived (1650) and was 69% of the way to the second at the first click
  // (2000), with the clicked point off-screen.
  it("holds the first zoom through its click before panning to a close second", () => {
    const first = { anchorId: "a", markerMs: 2000, at: { x: 300, y: 250 } };
    const second = { anchorId: "b", markerMs: 3000, at: { x: 1000, y: 600 } };
    const keys = keysFor([first, second]);
    const zoomAt = (markerMs: number) =>
      keys.find((k) => k.outputTimeMs === arrivalOf(markerMs));
    const one = zoomAt(first.markerMs);
    const two = zoomAt(second.markerMs);
    if (!one || !two)
      throw new Error(`no zoom key at an arrival: ${JSON.stringify(keys)}`);
    // Premise: this pair has no room to return, so it pans — the case under
    // test — and the arrivals are the 1650 and 2650 the comment names, with
    // the default push-in longer than the gap between them.
    expect(second.markerMs - first.markerMs).toBeLessThan(ROOM_MS);
    expect([one.outputTimeMs, two.outputTimeMs]).toEqual([1650, 2650]);
    expect(
      keys.filter(
        (k) =>
          k.scale === 1 &&
          k.outputTimeMs > one.outputTimeMs &&
          k.outputTimeMs < two.outputTimeMs,
      ),
    ).toEqual([]);
    expect(CAMERA_DEFAULTS.zoomInMs).toBeGreaterThan(
      two.outputTimeMs - one.outputTimeMs,
    );
    // Premise: the two zooms share a scale and sit far apart, so a camera
    // between them shows on its centre.
    expect(Math.abs(two.center.x - one.center.x)).toBeGreaterThan(300);

    const atClick = sampleCamera(keys, first.markerMs);
    expect(atClick.scale).toBeCloseTo(one.scale, 6);
    expect(atClick.center.x).toBeCloseTo(one.center.x, 6);
    expect(atClick.center.y).toBeCloseTo(one.center.y, 6);
    // And a plateau past it — the pan leaves after the action has landed.
    const settled = sampleCamera(
      keys,
      first.markerMs + CAMERA_DEFAULTS.neutral.minPlateauMs,
    );
    expect(settled.center.x).toBeCloseTo(one.center.x, 6);

    const arrived = sampleCamera(keys, two.outputTimeMs);
    expect(arrived.scale).toBeCloseTo(two.scale, 6);
    expect(arrived.center.x).toBeCloseTo(two.center.x, 6);
    expect(arrived.center.y).toBeCloseTo(two.center.y, 6);
    // The pan is still a move, not a cut: halfway through its window the
    // camera is between the two.
    const mid = sampleCamera(keys, (2250 + two.outputTimeMs) / 2);
    expect(mid.center.x).toBeGreaterThan(one.center.x + 1);
    expect(mid.center.x).toBeLessThan(two.center.x - 1);
  });

  // The pull-out is cut short rather than dropped: a zoom on the last beat of
  // a take with no tail footage still ends as close to full frame as the
  // footage allows, instead of holding the zoom past the end of the video.
  it("keeps the closing pull-out inside the video", () => {
    const short: Timeline = {
      segments: [
        {
          outStartMs: 0,
          outEndMs: 3200,
          srcStartMs: 0,
          srcEndMs: 3200,
          kind: "motion",
        },
      ],
      outputDurationMs: 3200,
      sourceDurationMs: 3200,
      unplacedPaces: 0,
      nonMonotonicPaces: 0,
      // Hand-built timelines: these cases are about the camera, the
      // cursor's idle fade and its trail, none of which a cut touches.
      cuts: [],
      unplacedCuts: [],
      interruptions: [],
    };
    const keys = keysFor(ONE, { timeline: short });
    const last = keys[keys.length - 1] as CameraKey;
    expect(last.scale).toBe(1);
    expect(last.outputTimeMs).toBeLessThanOrEqual(3200);
    expect(last.outputTimeMs).toBeGreaterThan(arrivalOf(2755));
  });

  // The boundary itself, from both sides: the room is the pull-out's length
  // plus the NEXT push-in's, not either one twice. Red on `2 x zoomInMs`
  // (3.1s: the first pair would pan) and on `2 x zoomOutMs` (2.35s: the
  // second would return).
  it("returns exactly when the gap pays for a pull-out, a push-in and two plateaus", () => {
    const innerAt = (gapMs: number) =>
      keysFor([
        ONE[0] as (typeof ONE)[0],
        { anchorId: "b", markerMs: 2755 + gapMs, at: { x: 700, y: 420 } },
      ]).filter(
        (k) =>
          k.scale === 1 &&
          k.outputTimeMs > arrivalOf(2755) &&
          k.outputTimeMs < arrivalOf(2755 + gapMs),
      );
    expect(innerAt(ROOM_MS + 10)).toHaveLength(1);
    expect(innerAt(ROOM_MS - 10)).toHaveLength(0);
    // Premise: the two wrong rooms really do fall either side of this pair.
    const plateaus = 2 * CAMERA_DEFAULTS.neutral.minPlateauMs;
    expect(2 * CAMERA_DEFAULTS.zoomInMs + plateaus).toBeGreaterThan(
      ROOM_MS + 10,
    );
    expect(2 * CAMERA_DEFAULTS.zoomOutMs + plateaus).toBeLessThan(ROOM_MS - 10);
  });

  it("leaves a scene with no zooms at 1:1 throughout", () => {
    const keys = solveCameraKeys([], () => null, timeline, new Map(), viewport);
    expect(keys).toEqual([
      {
        outputTimeMs: 0,
        center: { x: 640, y: 400 },
        scale: 1,
        transitionMs: 0,
        stiffness: CAMERA_DEFAULTS.stiffness,
      },
    ]);
  });
});
