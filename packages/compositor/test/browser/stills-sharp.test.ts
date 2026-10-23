import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import type { ResolvedPlan } from "../../src/plan/resolve";
import { createOffscreenSurface } from "../../src/ports/surface";
import type { ImageSink } from "../../src/ports/types";
import { renderFrame } from "../../src/render/compose";
import { composeForTarget } from "../../src/render/compose-for-target";
import { renderStills } from "../../src/render/render";
import { STILL_1440 } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { sceneWithZoomOnClick } from "../fixtures/scene";

/**
 * A still has no exposure, so it carries neither smear the video paints for
 * motion: the camera blur (everything under the pointer, dragged back along
 * the camera's path) or the cursor trail. Found on 2026-10-16 in a CLI
 * stills export: a step's still was taken mid-zoom, and the page was
 * smeared under a crisp pointer.
 *
 * Each case picks an instant where the fixture really moves — the camera,
 * then the pointer — and proves it by painting that instant with the smear
 * on and off and finding them different. Then the still at that instant has
 * to equal the smear-off frame.
 */
// A zoom on the checkout click, so the camera moves; full blur, so both
// smears are as large as the product paints them.
const scene = {
  ...sceneWithZoomOnClick(),
  motion: { smoothness: 0.5, blur: 1, follow: true },
};
const bundle = proceduralBundle();
const target = { ...STILL_1440, width: 960, height: 540 };
const plan = planScene(scene);
const { resolved, presentation } = composeForTarget({
  plan,
  bundle,
  scene,
  target,
});

function unsmeared(r: ResolvedPlan): ResolvedPlan {
  return {
    ...r,
    motion: { ...r.motion, blur: 0 },
    cursorLook: { ...r.cursorLook, motionBlur: 0 },
  };
}
function cameraBlurOnly(r: ResolvedPlan): ResolvedPlan {
  return { ...r, cursorLook: { ...r.cursorLook, motionBlur: 0 } };
}
function trailOnly(r: ResolvedPlan): ResolvedPlan {
  return { ...r, motion: { ...r.motion, blur: 0 } };
}

async function paint(r: ResolvedPlan, t: number): Promise<Uint8ClampedArray> {
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  await renderFrame({
    resolved: r,
    target,
    presentation,
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

/** The first instant, 50 ms apart, where `smeared` paints differently from
 *  the unsmeared frame — so the fixture really moves there. */
async function movingInstant(
  smeared: (r: ResolvedPlan) => ResolvedPlan,
): Promise<{ t: number; changed: number }> {
  const end = resolved.timeline.outputDurationMs;
  for (let t = 50; t < end; t += 50) {
    const changed = differing(
      await paint(smeared(resolved), t),
      await paint(unsmeared(resolved), t),
    );
    if (changed > 0) return { t, changed };
  }
  return { t: -1, changed: 0 };
}

/** What renderStills hands its sink, as pixels rather than PNG bytes. */
function pixelSink(): ImageSink & { pixels: Uint8ClampedArray[] } {
  const pixels: Uint8ClampedArray[] = [];
  return {
    pixels,
    async add(canvas) {
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      pixels.push(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
    },
    async finish() {
      return [];
    },
  };
}

async function stillAt(t: number): Promise<Uint8ClampedArray> {
  const images = pixelSink();
  await renderStills({
    plan,
    bundle,
    scene,
    target,
    outputTimesMs: [t],
    ports: {
      frames: createProceduralFrameSource(bundle),
      surface: createOffscreenSurface(),
      images,
    },
  });
  const [only] = images.pixels;
  if (!only) throw new Error("renderStills handed its sink no still");
  return only;
}

// Dozens of small composites while searching for a moving instant; a GitHub
// runner composes ~5x slower (CLAUDE.md, `fff4505`).
const BOUND_MS = 120_000;

describe("stills carry no motion smear", () => {
  it(
    "draws a still taken mid-camera-move without the camera blur",
    async () => {
      const { t, changed } = await movingInstant(cameraBlurOnly);
      // The premise: the camera moves somewhere in this take, and the blur
      // paints a real difference there.
      expect(
        t,
        "no instant where the camera blur changes the frame",
      ).toBeGreaterThan(0);
      // A zoom moves every pixel off the frame's centre: a broad smear.
      expect(changed).toBeGreaterThan(5_000);

      const still = await stillAt(t);
      const diff = differing(still, await paint(unsmeared(resolved), t));
      expect(
        diff,
        `still at ${t} ms differs from the unblurred frame by ${diff} px`,
      ).toBe(0);
    },
    BOUND_MS,
  );

  it(
    "draws a still taken while the pointer moves without its trail",
    async () => {
      const { t, changed } = await movingInstant(trailOnly);
      expect(
        t,
        "no instant where the cursor trail changes the frame",
      ).toBeGreaterThan(0);
      // A pointer at this size is small; its trail is a few dozen pixels.
      expect(changed).toBeGreaterThan(20);

      const still = await stillAt(t);
      const diff = differing(still, await paint(unsmeared(resolved), t));
      expect(
        diff,
        `still at ${t} ms differs from the trail-less frame by ${diff} px`,
      ).toBe(0);
    },
    BOUND_MS,
  );
});
