import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { type CameraKey, sampleCamera } from "../../src/plan/camera";
import { sampleTrack } from "../../src/plan/camera-follow";
import { planScene } from "../../src/plan/plan";
import type { ResolvedPlan } from "../../src/plan/resolve";
import { toOutputMs } from "../../src/plan/timeline";
import { createOffscreenSurface } from "../../src/ports/surface";
import type { ImageSink } from "../../src/ports/types";
import { renderFrame } from "../../src/render/compose";
import { composeForTarget } from "../../src/render/compose-for-target";
import { renderStills } from "../../src/render/render";
import { STILL_1440 } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene, sceneWithZoomOnClick } from "../fixtures/scene";

/**
 * How a still is framed. A still of a step is taken at the step's own
 * instant, and the video's camera there is not the step's zoom: the zoom on
 * a click lands just before it and, on the last step, has pulled back out
 * by the instant itself. So a still is framed one of two ways: `none`, the
 * whole window, which is what a page of docs wants; or `step`, the zoom the
 * video lands on for that step, all the way in.
 *
 * Two fixtures, each asserted to supply what its case needs:
 * - `lateZoom`: the zoom on the last step's click (`act-3`). The take ends
 *   on it, so at that step's instant the video is back at full frame — a
 *   still has to look for the zoom to frame it.
 * - `heldZoom`: a zoom on `act-2`, mid-take, so the video holds it at that
 *   step's instant — a still has to drop it to show the whole window.
 *
 * Each case paints the frame it expects directly, with a camera held still,
 * and asks the still to equal it.
 */
const bundle = proceduralBundle();
const target = { ...STILL_1440, width: 960, height: 540 };

function setup(scene: SceneDocument) {
  const plan = planScene(scene);
  const { resolved, presentation } = composeForTarget({
    plan,
    bundle,
    scene,
    target,
  });
  return { scene, plan, resolved, presentation };
}
type Setup = ReturnType<typeof setup>;

const lateZoom = setup(sceneWithZoomOnClick());
const heldZoom = setup({
  ...readonlyScene(),
  camera: [
    {
      id: "cam-row",
      kind: "zoom",
      anchorId: "a-row",
      marker: { actionId: "act-2", offsetMs: -300 },
      scale: 1.6,
    },
  ],
});

/** The step's own instant, as `renderStills` places it: its keyframe. */
function stepMs(at: Setup, actionId: string): number {
  const keyframe = bundle.keyframes.find((k) => k.actionId === actionId);
  const marker = bundle.markers.find((m) => m.actionId === actionId);
  const sourceMs = keyframe?.sourceTimeMs ?? marker?.sourceTimeMs;
  if (sourceMs === undefined) throw new Error(`no marker for ${actionId}`);
  return toOutputMs(at.resolved.timeline, sourceMs);
}

/** A camera that holds `at` for the whole take. */
function heldAt(
  on: Setup,
  at: { center: { x: number; y: number }; scale: number },
): CameraKey[] {
  return [
    {
      outputTimeMs: 0,
      center: at.center,
      scale: at.scale,
      transitionMs: 0,
      stiffness: on.resolved.cameraKeys[0]?.stiffness ?? 0,
    },
  ];
}

async function paint(
  on: Setup,
  keys: CameraKey[],
  t: number,
): Promise<Uint8ClampedArray> {
  const r: ResolvedPlan = {
    ...on.resolved,
    cameraKeys: keys,
    // The held camera alone: the take's own follow spring would draw its
    // pointer's camera over it.
    cameraFollow: [],
    motion: { ...on.resolved.motion, blur: 0 },
    cursorLook: { ...on.resolved.cursorLook, motionBlur: 0 },
  };
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  await renderFrame({
    resolved: r,
    target,
    presentation: on.presentation,
    frames: createProceduralFrameSource(bundle),
    ctx,
    outputTimeMs: t,
  });
  return ctx.getImageData(0, 0, target.width, target.height).data;
}

function differing(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
}

async function stills(
  on: Setup,
  camera: "none" | "step",
): Promise<Map<string, Uint8ClampedArray>> {
  const byName = new Map<string, Uint8ClampedArray>();
  const images: ImageSink = {
    async add(canvas, name) {
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      byName.set(
        name,
        ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      );
    },
    async finish() {
      return [];
    },
  };
  await renderStills({
    plan: on.plan,
    bundle,
    scene: on.scene,
    target,
    camera,
    ports: {
      frames: createProceduralFrameSource(bundle),
      surface: createOffscreenSurface(),
      images,
    },
  });
  return byName;
}

const fullFrame = (on: Setup) => ({
  center: { x: on.plan.viewport.width / 2, y: on.plan.viewport.height / 2 },
  scale: 1,
});

// A handful of small composites; a GitHub runner composes ~5x slower
// (CLAUDE.md, `fff4505`).
const BOUND_MS = 60_000;

describe("how a still is framed", () => {
  it(
    "the premises: one zoom the video has left by its step, one it holds",
    () => {
      const late = lateZoom.resolved.cameraSegments[0];
      if (!late) throw new Error("lateZoom made no segment");
      const atStep = sampleCamera(
        lateZoom.resolved.cameraKeys,
        stepMs(lateZoom, "act-3"),
      ).scale;
      const landed = sampleCamera(
        lateZoom.resolved.cameraKeys,
        late.startMs,
      ).scale;
      expect(landed).toBeGreaterThan(1.3);
      expect(atStep, JSON.stringify({ atStep, landed })).toBeLessThan(1.01);

      const held = sampleCamera(
        heldZoom.resolved.cameraKeys,
        stepMs(heldZoom, "act-2"),
      ).scale;
      expect(held).toBeGreaterThan(1.3);
    },
    BOUND_MS,
  );

  // Red if `none` keeps the video's camera.
  it(
    "none: the whole window, even at a step the video holds a zoom on",
    async () => {
      const got = await stills(heldZoom, "none");
      for (const actionId of ["act-1", "act-2", "act-3"]) {
        const still = got.get(`${actionId}.png`);
        if (!still) throw new Error(`no still for ${actionId}`);
        const want = await paint(
          heldZoom,
          heldAt(heldZoom, fullFrame(heldZoom)),
          stepMs(heldZoom, actionId),
        );
        const diff = differing(still, want);
        expect(
          diff,
          `${actionId} differs from the whole window by ${diff} px`,
        ).toBe(0);
      }
    },
    BOUND_MS,
  );

  // Red if `step` takes the video's camera at the step, or no zoom at all.
  it(
    "step: the zoomed step all the way in, though the video has left it",
    async () => {
      const late = lateZoom.resolved.cameraSegments[0];
      if (!late) throw new Error("lateZoom made no segment");
      const got = await stills(lateZoom, "step");
      const landed = sampleCamera(lateZoom.resolved.cameraKeys, late.startMs);
      const still = got.get("act-3.png");
      if (!still) throw new Error("no still for act-3");
      const t = stepMs(lateZoom, "act-3");
      const diff = differing(
        still,
        await paint(lateZoom, heldAt(lateZoom, landed), t),
      );
      expect(diff, `act-3 differs from the landed zoom by ${diff} px`).toBe(0);
      // And that is a different picture from the whole window.
      const whole = await paint(
        lateZoom,
        heldAt(lateZoom, fullFrame(lateZoom)),
        t,
      );
      expect(differing(still, whole)).toBeGreaterThan(10_000);

      // A step outside every zoom is the whole window.
      const first = got.get("act-1.png");
      if (!first) throw new Error("no still for act-1");
      expect(
        differing(
          first,
          await paint(
            lateZoom,
            heldAt(lateZoom, fullFrame(lateZoom)),
            stepMs(lateZoom, "act-1"),
          ),
        ),
      ).toBe(0);
    },
    BOUND_MS,
  );

  // Spec 2026-10-22: the video's camera trails the pointer while zoomed. A
  // step still is drawn at its zoom's own aim, so it must not keep the
  // video's spring. Red if `held` spreads the video's `cameraFollow` through.
  it(
    "step: a held zoom's still is its aim, not where the video's camera drifted",
    async () => {
      const zoom = heldZoom.resolved.cameraSegments[0];
      if (!zoom) throw new Error("heldZoom made no segment");
      const t = stepMs(heldZoom, "act-2");
      const aim = sampleCamera(heldZoom.resolved.cameraKeys, zoom.startMs);
      // Premise: by the step the video's camera has trailed off the aim.
      const video = sampleTrack(heldZoom.resolved, t);
      expect(
        Math.hypot(
          video.center.x - aim.center.x,
          video.center.y - aim.center.y,
        ),
        JSON.stringify({ video, aim }),
      ).toBeGreaterThan(5);
      const got = await stills(heldZoom, "step");
      const still = got.get("act-2.png");
      if (!still) throw new Error("no still for act-2");
      const diff = differing(
        still,
        await paint(heldZoom, heldAt(heldZoom, aim), t),
      );
      expect(diff, `act-2 differs from its zoom's aim by ${diff} px`).toBe(0);
    },
    BOUND_MS,
  );
});

/**
 * What a still reports about detail is what that still draws. Found
 * 2026-10-16: whole-window stills of a real take said "5 zooms were held
 * below their scale" and "some frames are drawn from fewer pixels" — both
 * true of the video's camera, neither of any still.
 *
 * `narrow` is `lateZoom` filmed at 1280 px: its 1.8x zoom needs about 1306
 * source px across a 960 px still's 726 px window, so the video's camera
 * falls short there, while the whole window at 1x needs only 726.
 */
describe("what a still says about detail", () => {
  const narrowBundle = proceduralBundle({
    keyframes: proceduralBundle().keyframes.map((k) => ({
      ...k,
      width: 1280,
      height: 800,
    })),
    motionSpans: proceduralBundle().motionSpans.map((s) => ({
      ...s,
      width: 1280,
      height: 800,
    })),
  });
  const narrowScene = sceneWithZoomOnClick();
  const narrowPlan = planScene(narrowScene);
  const composed = composeForTarget({
    plan: narrowPlan,
    bundle: narrowBundle,
    scene: narrowScene,
    target,
  });
  const report = async (camera: "video" | "none" | "step") => {
    const result = await renderStills({
      plan: narrowPlan,
      bundle: narrowBundle,
      scene: narrowScene,
      target,
      camera,
      ports: {
        frames: createProceduralFrameSource(narrowBundle),
        surface: createOffscreenSurface(),
        images: {
          async add() {},
          async finish() {
            return [];
          },
        },
      },
    });
    return result.detailViolations;
  };

  it(
    "the premise: the video's camera falls short of the recording here",
    () => {
      expect(composed.violations.length).toBeGreaterThan(0);
      expect(composed.presentation.frameRect.width).toBeLessThan(1280);
    },
    BOUND_MS,
  );

  it(
    "video: the video's own report, as before",
    async () => {
      expect(await report("video")).toEqual(composed.violations);
    },
    BOUND_MS,
  );

  // Red if whole-window stills carry the video's zoom report.
  it(
    "none: nothing, when every whole window fits the recording",
    async () => {
      expect(await report("none")).toEqual([]);
    },
    BOUND_MS,
  );

  // Red if a zoomed still that falls short says nothing.
  it(
    "step: the zoom the zoomed still draws",
    async () => {
      const said = await report("step");
      expect(said.length).toBeGreaterThan(0);
      const segment = composed.resolved.cameraSegments[0];
      if (!segment) throw new Error("no zoom segment");
      for (const v of said) {
        expect(v.outputTimeMs).toBeLessThanOrEqual(segment.endMs);
      }
    },
    BOUND_MS,
  );
});
