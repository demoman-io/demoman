import { describe, expect, it } from "vitest";
import {
  type CameraKey,
  frameCamera,
  sampleCamera,
} from "../../src/plan/camera";
import { planScene } from "../../src/plan/plan";
import { type ResolvedPlan, resolvePlan } from "../../src/plan/resolve";
import type { FrameSource } from "../../src/ports/types";
import {
  CAMERA_BLUR_MAX_SMEAR,
  CAMERA_EXPOSURE_MS,
  cameraBlurTransforms,
} from "../../src/render/camera-blur";
import { cssToOutput, renderFrame } from "../../src/render/compose";
import {
  contentScale,
  derivePresentation,
} from "../../src/render/presentation";
import { LANDSCAPE_1080P } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { cameraKey } from "../fixtures/camera-key";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene } from "../fixtures/scene";

/**
 * Camera motion blur on decoded pixels: it smears a moving camera, leaves a
 * still one byte-for-byte alone, and cannot carry a masked region back out
 * from under its mask.
 *
 * Every case swaps the camera keys and `motion.blur` on one resolved plan,
 * so the only thing that differs between two renders compared here is the
 * thing named. The pointer is hidden: it is drawn after the blur, is not
 * part of what it smears, and would only add its own lean and trail to
 * every difference counted.
 */
const VIEWPORT = { width: 1280, height: 800 };
const target = LANDSCAPE_1080P;
const bundle = proceduralBundle();
const scene = readonlyScene();
const resolved = resolvePlan(planScene(scene), bundle, scene);
const presentation = derivePresentation(scene.branding, target, VIEWPORT);
const procedural = createProceduralFrameSource(bundle);

/** Full frame until 1200ms, then a push-in to 2x on (400, 300) over 800ms. */
const pushIn: CameraKey[] = [
  cameraKey({
    outputTimeMs: 0,
    center: { x: 640, y: 400 },
    scale: 1,
    transitionMs: 0,
  }),
  cameraKey({
    outputTimeMs: 2000,
    center: { x: 400, y: 300 },
    scale: 2,
    transitionMs: 800,
  }),
];

/** A pan across the page at a held 1.6x, 600 CSS px over 600ms. */
const pan: CameraKey[] = [
  cameraKey({
    outputTimeMs: 0,
    center: { x: 340, y: 400 },
    scale: 1.6,
    transitionMs: 0,
  }),
  cameraKey({
    outputTimeMs: 1000,
    center: { x: 940, y: 400 },
    scale: 1.6,
    transitionMs: 600,
  }),
];

function withCamera(
  keys: CameraKey[],
  blur: number,
  extra: Partial<ResolvedPlan> = {},
): ResolvedPlan {
  return {
    ...resolved,
    cameraKeys: keys,
    // The keys alone: the resolved take's own follow spring would draw its
    // pointer's camera over these.
    cameraFollow: [],
    motion: { ...resolved.motion, blur },
    cursorLook: { ...resolved.cursorLook, hidden: true },
    ...extra,
  };
}

const cameraAt = (keys: CameraKey[], t: number) =>
  frameCamera(
    sampleCamera(keys, t),
    contentScale(presentation.frameRect, VIEWPORT),
    presentation.frameRect,
    VIEWPORT,
    target,
  );

async function paint(
  plan: ResolvedPlan,
  outputTimeMs: number,
  frames: FrameSource = procedural,
): Promise<Uint8ClampedArray> {
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  await renderFrame({
    resolved: plan,
    target,
    presentation,
    frames,
    ctx,
    outputTimeMs,
  });
  return ctx.getImageData(0, 0, target.width, target.height).data;
}

/** Pixels where any channel differs at all. */
function differing(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
}

// A handful of 1080p composites per case, each well under 100ms here; a
// GitHub runner composes ~5x slower (CLAUDE.md, `fff4505`), so the budget
// is the one compose.test.ts's frozen-picture cases carry.
const RENDER_BOUND_MS = 120_000;

describe("camera motion blur", () => {
  it(
    "smears a frame taken mid-move",
    async () => {
      const t = 1600;
      // The premise: the camera really moves across this frame's exposure
      // at blur 0.5 (16ms), by more than the stillness gate could ignore.
      const now = cameraAt(pushIn, t);
      const then = cameraAt(pushIn, t - CAMERA_EXPOSURE_MS * 0.5);
      expect(now.scale - then.scale).toBeGreaterThan(0.01);

      const sharp = await paint(withCamera(pushIn, 0), t);
      const blurred = await paint(withCamera(pushIn, 0.5), t);
      const changed = differing(sharp, blurred);
      // A real fraction of the 2M-pixel frame, not an edge or two: a zoom
      // moves every pixel off the frame's centre, so the smear is broad.
      expect(changed, `${changed} pixels differ`).toBeGreaterThan(50_000);
    },
    RENDER_BOUND_MS,
  );

  it(
    "paints a still camera byte-identically to blur 0",
    async () => {
      // On the plateau after the push-in lands: zoomed in, and still.
      const t = 2600;
      expect(cameraAt(pushIn, t).scale).toBe(2);
      expect(cameraAt(pushIn, t - CAMERA_EXPOSURE_MS).scale).toBe(2);
      const sharp = await paint(withCamera(pushIn, 0), t);
      const still = await paint(withCamera(pushIn, 1), t);
      expect(differing(sharp, still)).toBe(0);
    },
    RENDER_BOUND_MS,
  );

  it(
    "leaves a camera creeping under the travel gate byte-identical too",
    async () => {
      // 12 CSS px over 10s at 1.6x: the camera does move across the
      // exposure, by about a tenth of an output pixel. Without the gate,
      // eight passes each resample the frame by that sub-pixel offset and
      // the picture changes everywhere there is an edge — on a frame that
      // looks perfectly still.
      const creep: CameraKey[] = [
        cameraKey({
          outputTimeMs: 0,
          center: { x: 600, y: 400 },
          scale: 1.6,
          transitionMs: 0,
        }),
        cameraKey({
          outputTimeMs: 10_000,
          center: { x: 612, y: 400 },
          scale: 1.6,
          transitionMs: 10_000,
        }),
      ];
      const t = 5000;
      const moved =
        cameraAt(creep, t).focus.x -
        cameraAt(creep, t - CAMERA_EXPOSURE_MS).focus.x;
      expect(Math.abs(moved)).toBeGreaterThan(0.01);
      const sharp = await paint(withCamera(creep, 0), t);
      const crept = await paint(withCamera(creep, 1), t);
      expect(differing(sharp, crept)).toBe(0);
    },
    RENDER_BOUND_MS,
  );

  it(
    "cannot smear a masked region back out from under its mask",
    async () => {
      // A page that is flat grey but for one pure-green patch, and a mask
      // over the patch with a margin. Green is the one colour nothing else
      // in this composition carries, so any pixel leaning green came from
      // the patch.
      const PATCH = { x: 560, y: 340, width: 160, height: 120 };
      const MASK = { x: 556, y: 336, width: 168, height: 128 };
      const page = new OffscreenCanvas(VIEWPORT.width, VIEWPORT.height);
      const pageCtx = page.getContext(
        "2d",
      ) as OffscreenCanvasRenderingContext2D;
      pageCtx.fillStyle = "#808080";
      pageCtx.fillRect(0, 0, VIEWPORT.width, VIEWPORT.height);
      pageCtx.fillStyle = "#00ff00";
      pageCtx.fillRect(PATCH.x, PATCH.y, PATCH.width, PATCH.height);
      const frames: FrameSource = {
        at: async (sourceTimeMs) => ({
          image: page,
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          sourceTimeMs,
        }),
        describe: () => ({ keyframes: [], motionSpans: [] }),
      };
      const mask = {
        id: "m-1",
        kind: "mask" as const,
        rect: MASK,
        range: null,
        unplaced: [],
      };

      const t = 700;
      // The premise, twice over. The smear this frame actually draws — the
      // farthest pass, after the cap has shortened the exposure — reaches
      // further than the mask's 4 CSS px margin, so a smear of the UNmasked
      // page would carry green outside the mask...
      const k = contentScale(presentation.frameRect, VIEWPORT) * 1.6;
      const passes = cameraBlurTransforms({
        camera: { cameraKeys: pan, cameraFollow: [] },
        outputTimeMs: t,
        blur: 1,
        current: cameraAt(pan, t),
        base: contentScale(presentation.frameRect, VIEWPORT),
        frameRect: presentation.frameRect,
        viewport: VIEWPORT,
        canvas: target,
      });
      const smear = Math.abs(passes.at(-1)?.x ?? 0);
      const marginOut = (PATCH.x - MASK.x) * k;
      expect(smear, `smear ${smear}px, margin ${marginOut}px`).toBeGreaterThan(
        marginOut + 8,
      );
      const greenish = (data: Uint8ClampedArray): number => {
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const [r, g, b] = [
            data[i] as number,
            data[i + 1] as number,
            data[i + 2] as number,
          ];
          if (g - Math.max(r, b) > 40) n++;
        }
        return n;
      };
      // ...and the patch is in shot: without the mask, it paints green.
      const bare = await paint(withCamera(pan, 1), t, frames);
      expect(greenish(bare)).toBeGreaterThan(10_000);

      const masked = await paint(
        withCamera(pan, 1, { cosmetics: [mask] }),
        t,
        frames,
      );
      expect(greenish(masked)).toBe(0);
      // And the blur did run on the masked frame — this is not a pass that
      // was skipped and so trivially leaked nothing.
      const maskedSharp = await paint(
        withCamera(pan, 0, { cosmetics: [mask] }),
        t,
        frames,
      );
      expect(differing(masked, maskedSharp)).toBeGreaterThan(10_000);
    },
    RENDER_BOUND_MS,
  );
  it(
    "smears a thin line into one soft streak, not a row of ghosts",
    async () => {
      // A flat page with one dark vertical line, 1 CSS px wide — 2 output
      // px at this zoom — panned across fast. Across a scan line, a real
      // smear of it is ONE dip: darkest somewhere, lighter on either side
      // of that all the way out. Copies of the page laid down several px
      // apart show as a comb instead — dip, back up toward the paper, dip
      // again — which is what a fixed five or eight passes drew on any fast
      // move (2026-10-09, seen in the editor as stair-stepped text).
      const LINE_X = 640;
      const page = new OffscreenCanvas(VIEWPORT.width, VIEWPORT.height);
      const pageCtx = page.getContext(
        "2d",
      ) as OffscreenCanvasRenderingContext2D;
      pageCtx.fillStyle = "#e0e0e0";
      pageCtx.fillRect(0, 0, VIEWPORT.width, VIEWPORT.height);
      pageCtx.fillStyle = "#202020";
      pageCtx.fillRect(LINE_X, 0, 1, VIEWPORT.height);
      const frames: FrameSource = {
        at: async (sourceTimeMs) => ({
          image: page,
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          sourceTimeMs,
        }),
        describe: () => ({ keyframes: [], motionSpans: [] }),
      };
      const t = 700;
      const lineNow = cssToOutput(
        { x: LINE_X + 0.5, y: 400 },
        cameraAt(pan, t),
        presentation.frameRect,
        VIEWPORT,
      );
      const row = Math.round(lineNow.y);
      const from = Math.round(lineNow.x) - 90;
      const profile = (data: Uint8ClampedArray): number[] =>
        Array.from({ length: 181 }, (_, i) => {
          const o = (row * target.width + from + i) * 4;
          return (
            ((data[o] as number) +
              (data[o + 1] as number) +
              (data[o + 2] as number)) /
            3
          );
        });
      /** The largest rise back toward the paper on the way in to the
       *  darkest point, from either side: 0 for one clean dip. */
      const comb = (p: number[]): number => {
        let darkest = 0;
        p.forEach((v, i) => {
          if (v < (p[darkest] as number)) darkest = i;
        });
        let worst = 0;
        let low = Number.POSITIVE_INFINITY;
        for (let i = 0; i <= darkest; i++) {
          low = Math.min(low, p[i] as number);
          worst = Math.max(worst, (p[i] as number) - low);
        }
        low = Number.POSITIVE_INFINITY;
        for (let i = p.length - 1; i >= darkest; i--) {
          low = Math.min(low, p[i] as number);
          worst = Math.max(worst, (p[i] as number) - low);
        }
        return worst;
      };
      /** How many columns the line darkens, against the paper. */
      const width = (p: number[]): number =>
        p.filter((v) => v < 224 - 6).length;

      const sharp = profile(await paint(withCamera(pan, 0), t, frames));
      // The premise: the sharp line is in the scan window, a few px wide,
      // and the camera sweeps it much further than that across the window
      // at both settings below.
      expect(width(sharp)).toBeGreaterThan(0);
      expect(width(sharp)).toBeLessThan(6);
      const k = contentScale(presentation.frameRect, VIEWPORT) * 1.6;
      const sweep =
        (cameraAt(pan, t).center.x -
          cameraAt(pan, t - CAMERA_EXPOSURE_MS * 0.5).center.x) *
        k;
      expect(sweep).toBeGreaterThan(20);

      const cap =
        CAMERA_BLUR_MAX_SMEAR * Math.hypot(target.width, target.height);
      for (const blur of [0.5, 1]) {
        const smeared = profile(await paint(withCamera(pan, blur), t, frames));
        const shown = smeared.map((v) => Math.round(v)).join(" ");
        // It did smear: the line covers many more columns than it does sharp...
        expect(width(smeared), shown).toBeGreaterThan(width(sharp) + 8);
        // ...no more than the cap allows, plus the line's own width...
        expect(width(smeared), shown).toBeLessThanOrEqual(
          Math.ceil(cap) + width(sharp) + 2,
        );
        // ...and as one dip. Discrete passes still leave a ripple — copies
        // 1.5px apart of a 2px line cover a column once or twice by turns —
        // measured at 3 levels (2026-10-09). The ghosts it replaced rose 26
        // levels back toward the paper between copies, so the line is drawn
        // well clear of both.
        expect(comb(smeared), `blur ${blur}: ${shown}`).toBeLessThanOrEqual(6);
      }
    },
    RENDER_BOUND_MS,
  );
});
