import { describe, expect, it } from "vitest";
import { solveFollow } from "../../src/plan/camera-follow";
import { planScene } from "../../src/plan/plan";
import { type ResolvedPlan, resolvePlan } from "../../src/plan/resolve";
import type { FrameSource } from "../../src/ports/types";
import { renderFrame } from "../../src/render/compose";
import { derivePresentation } from "../../src/render/presentation";
import { LANDSCAPE_1080P } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { cameraKey } from "../fixtures/camera-key";
import { createProceduralFrameSource } from "../fixtures/procedural";
import {
  B,
  CLICKS,
  pointer,
  pointerThrough,
  runKeys,
} from "../fixtures/run-follow";
import { readonlyScene } from "../fixtures/scene";

/**
 * The trailing camera on decoded pixels (spec 2026-10-22): through a run of
 * clicks the picture keeps moving while the pointer travels, and a frame
 * drawn on its own equals the same frame drawn in sequence.
 *
 * One resolved plan with the pointer hidden, camera blur off and the page
 * held still, its camera swapped for the run fixture's, so the only thing
 * that moves the picture is the camera.
 */
const VIEWPORT = { width: 1280, height: 800 };
const target = LANDSCAPE_1080P;
const bundle = proceduralBundle();
const scene = readonlyScene();
const resolved = resolvePlan(planScene(scene), bundle, scene);
const presentation = derivePresentation(scene.branding, target, VIEWPORT);
const procedural = createProceduralFrameSource(bundle);
/** The page held at one instant: the procedural source animates in its
 *  motion spans, and only the camera may move the picture here. */
const frozenPage: FrameSource = {
  ...procedural,
  at: () => procedural.at(1000),
};

function withTrack(extra: Partial<ResolvedPlan>): ResolvedPlan {
  return {
    ...resolved,
    motion: { ...resolved.motion, blur: 0 },
    cursorLook: { ...resolved.cursorLook, hidden: true },
    ...extra,
  };
}

const keys = runKeys();
const trailing = withTrack({
  cameraKeys: keys,
  cameraFollow: solveFollow({
    keys,
    cursorAt: pointer,
    holds: [],
    outputDurationMs: resolved.timeline.outputDurationMs,
    rate: 10,
  }),
});
const still = withTrack({
  cameraKeys: [
    cameraKey({ outputTimeMs: 0, center: B, scale: 2, transitionMs: 0 }),
  ],
  cameraFollow: [],
});

async function paint(
  plan: ResolvedPlan,
  outputTimeMs: number,
): Promise<Uint8ClampedArray> {
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  await renderFrame({
    resolved: plan,
    target,
    presentation,
    frames: frozenPage,
    ctx,
    outputTimeMs,
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

const FRAME_MS = 1000 / 30;
/** The output instants of the run's frames, first click to last. */
const RUN_FRAMES: number[] = [];
for (let t = CLICKS[0]; t <= CLICKS[2]; t += FRAME_MS) RUN_FRAMES.push(t);

const handSpeed = (t: number) => {
  const a = pointer(t - FRAME_MS);
  const b = pointer(t);
  return Math.hypot(b.x - a.x, b.y - a.y) / (FRAME_MS / 1000);
};

// ~73 1080p composites per case, each well under 100ms here; a GitHub
// runner composes ~5x slower (CLAUDE.md, `fff4505`), so the bound is the
// one camera-blur-pixels.test.ts carries.
const RENDER_BOUND_MS = 120_000;

describe("the trailing camera on pixels", () => {
  it(
    "has the fixture it claims: a still camera paints identical frames",
    async () => {
      expect(resolved.timeline.outputDurationMs).toBeGreaterThan(CLICKS[2]);
      let previous = await paint(still, RUN_FRAMES[0] as number);
      for (const t of RUN_FRAMES.slice(1)) {
        const now = await paint(still, t);
        expect(differing(previous, now), `frame at ${Math.round(t)}ms`).toBe(0);
        previous = now;
      }
    },
    RENDER_BOUND_MS,
  );

  it(
    "moves the picture on every frame the pointer travels",
    async () => {
      const total = target.width * target.height;
      let previous = await paint(trailing, RUN_FRAMES[0] as number);
      let checked = 0;
      for (const t of RUN_FRAMES.slice(1)) {
        const now = await paint(trailing, t);
        // The spring sets off from rest a moment after the hand does (see
        // camera-follow.test.ts, "never stops"): skip a journey's first 150ms.
        const onset = [2150, 3350].some((s) => t > s && t - s < 150);
        if (handSpeed(t) > 50 && !onset) {
          checked++;
          expect(
            differing(previous, now) / total,
            `share changed at ${Math.round(t)}ms`,
          ).toBeGreaterThan(0.005);
        }
        previous = now;
      }
      // Premise: most of the run is the hand travelling.
      expect(checked).toBeGreaterThan(20);
    },
    RENDER_BOUND_MS,
  );

  // The author's choice 2: the camera follows every movement, not only the
  // journeys between zooms. One zoom held on B while the hand wanders round
  // it: the keys do not move at all, so only the spring can move the picture.
  it(
    "moves the picture while the hand wanders inside one held zoom",
    async () => {
      // In at once and held: a 1ms push-in landing at 1ms.
      const held = [
        cameraKey({
          outputTimeMs: 0,
          center: B,
          scale: 1,
          transitionMs: 0,
        }),
        cameraKey({ outputTimeMs: 1, center: B, scale: 2, transitionMs: 1 }),
      ];
      const wander = pointerThrough([
        [0, B],
        [2000, B],
        [2600, { x: B.x + 150, y: B.y + 60 }],
        [3200, { x: B.x - 120, y: B.y + 90 }],
        [3800, B],
      ]);
      const plan = withTrack({
        cameraKeys: held,
        cameraFollow: solveFollow({
          keys: held,
          cursorAt: wander,
          holds: [],
          outputDurationMs: resolved.timeline.outputDurationMs,
          rate: 10,
        }),
      });
      const total = target.width * target.height;
      let previous = await paint(plan, 2300);
      for (let t = 2300 + FRAME_MS; t <= 3500; t += FRAME_MS) {
        const now = await paint(plan, t);
        expect(
          differing(previous, now) / total,
          `share changed at ${Math.round(t)}ms`,
        ).toBeGreaterThan(0.005);
        previous = now;
      }
    },
    RENDER_BOUND_MS,
  );

  it(
    "draws a scrubbed frame exactly as the export does",
    async () => {
      const direct = await paint(trailing, 3000);
      for (const t of RUN_FRAMES.filter((t) => t < 3000)) {
        await paint(trailing, t);
      }
      const inSequence = await paint(trailing, 3000);
      expect(differing(direct, inSequence)).toBe(0);
    },
    RENDER_BOUND_MS,
  );
});
