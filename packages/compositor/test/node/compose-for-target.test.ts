import { describe, expect, it, vi } from "vitest";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { createRecordingVideoSink } from "../../src/ports/fakes";
import type { FrameImage, FrameSource } from "../../src/ports/types";
import { renderFrame } from "../../src/render/compose";
import { composeForTarget } from "../../src/render/compose-for-target";
import { renderScene } from "../../src/render/render";
import { LANDSCAPE_1080P } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { sceneWithZoomOnClick } from "../fixtures/scene";

// The node lane has no canvas. `renderFrame` is stubbed so the test can read
// the resolved plan the loop actually draws with; motion detection needs
// pixels and is stubbed to find nothing, same as render-loop.test.ts.
vi.mock("../../src/render/compose", () => ({
  renderFrame: vi.fn(async () => undefined),
  cssToOutput: vi.fn(),
  cssRectToOutput: vi.fn(),
}));
vi.mock("../../src/render/motion-detect", () => ({
  detectKeyframeMotion: vi.fn(async () => []),
}));

const stubSurface = { create: () => ({ getContext: () => ({}) }) as never };

function stubFrames(): FrameSource {
  const bundle = proceduralBundle();
  return {
    at: async (): Promise<FrameImage> => ({
      image: {} as never,
      width: 1280,
      height: 800,
      sourceTimeMs: 0,
    }),
    describe: () => ({
      keyframes: bundle.keyframes,
      motionSpans: bundle.motionSpans,
    }),
  };
}

describe("composeForTarget", () => {
  const scene = sceneWithZoomOnClick();
  const bundle = proceduralBundle({
    cursorSamples: [{ sourceTimeMs: 0, x: 640, y: 400 }],
  });
  // A zoom the 3840-wide keyframes cannot back at 4K: the detail clamp has
  // to cut it, and the cut is what the preview used to miss.
  const requested = 2.5;
  const plan = (() => {
    const base = planScene(scene);
    return {
      ...base,
      cameraIntents: base.cameraIntents.map((i) => ({
        ...i,
        scale: requested,
      })),
    };
  })();
  const target = { ...LANDSCAPE_1080P, width: 3840, height: 2160 };

  it("gives the preview the same camera the render draws — clamp included", async () => {
    const composed = composeForTarget({ plan, bundle, scene, target });

    await renderScene({
      plan,
      bundle,
      scene,
      target,
      ports: {
        frames: stubFrames(),
        surface: stubSurface,
        video: createRecordingVideoSink(),
      },
    });
    const drawn = vi.mocked(renderFrame).mock.calls[0]?.[0].resolved;
    expect(drawn).toBeDefined();
    expect(composed.resolved.cameraKeys).toEqual(drawn?.cameraKeys);

    // Not vacuously: the clamp fired, and the keys differ from what the
    // preview's old front half — `resolvePlan` alone — would have scrubbed.
    expect(composed.violations.length).toBeGreaterThan(0);
    expect(
      Math.max(...composed.resolved.cameraKeys.map((k) => k.scale)),
    ).toBeLessThan(requested);
    expect(composed.resolved.cameraKeys).not.toEqual(
      resolvePlan(plan, bundle, scene).cameraKeys,
    );
  });

  it("clamps a preview-sized target against the deliverable, not its own bitmap", () => {
    const deliverable = composeForTarget({ plan, bundle, scene, target });
    // Two preview bitmaps of the same deliverable, the sizes the editor
    // flips between on play and pause.
    const small = { ...target, width: 1280, height: 720 };
    const large = { ...target, width: 2560, height: 1440 };

    // The premise: measured against their own size, these two disagree about
    // the zoom — which is the framing jump on every Space press.
    const own = (t: typeof target) =>
      composeForTarget({ plan, bundle, scene, target: t }).resolved.cameraKeys;
    expect(own(small)).not.toEqual(own(large));

    for (const preview of [small, large]) {
      const composed = composeForTarget({
        plan,
        bundle,
        scene,
        target: preview,
        detailTarget: target,
      });
      expect(composed.resolved.cameraKeys).toEqual(
        deliverable.resolved.cameraKeys,
      );
      expect(composed.violations).toEqual(deliverable.violations);
      // Drawn at the preview's size, not the deliverable's.
      expect(composed.presentation.frameRect.width).toBeLessThan(
        deliverable.presentation.frameRect.width,
      );
    }
  });

  // /code-review 2026-10-22: the camera's trail is planned from the keys the
  // target draws. A source that backs no zoom at 4K cuts every key to 1x,
  // and a trail planned from the uncut keys would steer a camera at 1x.
  it("plans the trail from the keys the clamp leaves", () => {
    const low = proceduralBundle({
      cursorSamples: [{ sourceTimeMs: 0, x: 640, y: 400 }],
      keyframes: bundle.keyframes.map((k) => ({
        ...k,
        width: 1280,
        height: 800,
      })),
      motionSpans: [],
    });
    const composed = composeForTarget({ plan, bundle: low, scene, target });
    // Premise: unclamped there is a trail; the clamp cut every zoom to 1x.
    expect(resolvePlan(plan, low, scene).cameraFollow.length).toBeGreaterThan(
      0,
    );
    expect(Math.max(...composed.resolved.cameraKeys.map((k) => k.scale))).toBe(
      1,
    );
    expect(composed.resolved.cameraFollow).toEqual([]);
  });

  it("reports nothing when the source backs the zoom", () => {
    const composed = composeForTarget({
      plan: planScene(scene),
      bundle,
      scene,
      target: LANDSCAPE_1080P,
    });
    expect(composed.violations).toEqual([]);
  });
});
