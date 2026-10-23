import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { buildTimeline, toOutputMs, toSourceMs } from "../../src/plan/timeline";
import { createOffscreenSurface } from "../../src/ports/surface";
import type { VideoSink } from "../../src/ports/types";
import { cssToOutput } from "../../src/render/compose";
import { derivePresentation } from "../../src/render/presentation";
import { renderScene, renderStills } from "../../src/render/render";
import { LANDSCAPE_1080P, STILL_1440 } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene, removedFor } from "../fixtures/scene";

/** Inside the panel that slides open across the bundle's motion span: dark
 *  once the panel is open, light before it. Same probe `trim-pixels` uses. */
const PANEL_CSS = { x: 1100, y: 400 };
const target = { ...LANDSCAPE_1080P, width: 640, height: 360, fps: 10 };

const isDark = ([r, g, b]: number[]) =>
  (r ?? 255) < 60 && (g ?? 255) < 60 && (b ?? 255) < 80;

/**
 * A sink that keeps EVERY frame's probe pixel.
 *
 * `trim-pixels.test.ts`'s sink keeps only the first, which answers "which
 * picture came first"; this file asks "which pictures survived", so it needs
 * the whole sequence.
 */
function probeSink(probe: { x: number; y: number }): VideoSink & {
  pixels: number[][];
} {
  const sink = {
    pixels: [] as number[][],
    addFrame: async (canvas: OffscreenCanvas) => {
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      sink.pixels.push(
        Array.from(ctx.getImageData(probe.x, probe.y, 1, 1).data),
      );
    },
    finish: async () => new Uint8Array([1]),
  };
  return sink;
}

type Removed = SceneDocument["edits"]["removed"];

async function render(
  cuts: { id: string; actionId: string }[] | { removed: Removed },
  bundle = proceduralBundle(),
) {
  const base = readonlyScene();
  const removed = Array.isArray(cuts) ? removedFor(base, cuts) : cuts.removed;
  const scene = { ...base, edits: { ...base.edits, removed } };
  const presentation = derivePresentation(
    scene.branding,
    target,
    bundle.viewport,
    null,
  );
  const at = cssToOutput(
    PANEL_CSS,
    { center: { x: 640, y: 400 }, scale: 1 },
    presentation.frameRect,
    bundle.viewport,
  );
  const video = probeSink({ x: Math.round(at.x), y: Math.round(at.y) });
  await renderScene({
    plan: planScene(scene),
    bundle,
    scene,
    target,
    ports: {
      frames: createProceduralFrameSource(bundle),
      surface: createOffscreenSurface(),
      video,
    },
  });
  return video.pixels;
}

// Measured on this machine: 627ms for the whole file, 329ms for its slowest
// case (two 90-frame renders). CI is about 5x slower at composing frames
// (CLAUDE.md), so the real budget is ~1.7s — nowhere near vitest's 15s
// default. The explicit timeout is here because these ARE compositor renders
// and the file will grow; it is headroom, not a measured need.
const TIMEOUT_MS = 40_000;

describe("a cut render", () => {
  it(
    "removes a piece from the middle of a step and joins the frames either side of it",
    async () => {
      const bundle = proceduralBundle();
      const whole = await render([]);
      const axis = buildTimeline(planScene(readonlyScene()), bundle);
      const srcOf = (i: number) => toSourceMs(axis, i * 100);
      const dark = whole.flatMap((p, i) => (isDark(p) ? [i] : []));
      // Premise: the panel is open (dark) for a few frames, and nowhere
      // else, so removing exactly those frames is visible.
      expect(dark.length).toBeGreaterThanOrEqual(3);
      const first = dark[0] as number;
      const last = dark[dark.length - 1] as number;
      const startMs = srcOf(first) - 50;
      const endMs = srcOf(last) + 50;
      // Premise: the piece lies strictly inside act-2's stretch (3200 to
      // act-3's 9000), so it is no step boundary a step cut could make.
      expect(startMs).toBeGreaterThan(3200);
      expect(endMs).toBeLessThan(9000);

      const cut = await render({
        removed: [
          {
            id: "piece",
            start: { actionId: "act-2", sourceOffsetMs: startMs - 3200 },
            end: { actionId: "act-2", sourceOffsetMs: endMs - 3200 },
          },
        ],
      });
      expect(cut.some(isDark)).toBe(false);
      const removedFrames = whole.length - cut.length;
      expect(removedFrames).toBeGreaterThanOrEqual(dark.length);
      // The frames either side of the join are the uncut take's own: the
      // last one before the piece, then the first one after it.
      const k = Math.floor(toOutputMs(axis, startMs) / 100);
      expect(cut.slice(0, k)).toEqual(whole.slice(0, k));
      expect(cut[k + 1]).toEqual(whole[k + 1 + removedFrames]);
    },
    TIMEOUT_MS,
  );

  it(
    "is shorter by the removed stretch and never shows a removed frame",
    async () => {
      const whole = await render([]);
      const cut = await render([{ id: "cut-1", actionId: "act-2" }]);

      // Premise: the fixture's removed stretch (3200–9000ms) really does
      // contain frames that differ from both of its ends — the panel slides
      // open across it. Without this, "no removed frame survived" would be
      // satisfied by a stretch that looked like its neighbours all along.
      // Measured: 5 of the uncut render's 90 frames are dark, all of them
      // inside that stretch.
      expect(whole).toHaveLength(90);
      expect(whole.filter(isDark).length).toBeGreaterThanOrEqual(3);
      expect(whole.some((p) => !isDark(p))).toBe(true);

      // 5800ms at 10fps.
      expect(whole.length - cut.length).toBe(58);
      // The panel opens inside the removed stretch, so every frame left is
      // a closed-panel frame.
      expect(cut.some(isDark)).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    "merges an adjacent pair into one removal, not two",
    async () => {
      const whole = await render([]);
      const pair = await render([
        { id: "cut-1", actionId: "act-1" },
        { id: "cut-2", actionId: "act-2" },
      ]);
      // act-1's marker is at 400ms and act-3's at 9000ms: ONE stretch of
      // 8600ms, 86 frames at 10fps. Two independent runs would each close
      // on the next surviving step and remove 8600 + 5800.
      expect(whole.length - pair.length).toBe(86);
    },
    TIMEOUT_MS,
  );

  it(
    "leaves the lead-in before the first step when every step is cut",
    async () => {
      // A cut removes a STEP's stretch — its action and the page's reaction
      // to it. The frames before the first action belong to no step, so
      // cutting everything leaves them, and the video is the lead-in alone.
      // Not a refusal: there is a picture, and it is the one the take
      // opened on.
      const all = await render([
        { id: "cut-1", actionId: "act-1" },
        { id: "cut-2", actionId: "act-2" },
        { id: "cut-3", actionId: "act-3" },
      ]);
      // Premise: the first marker really is at 400ms, which is what leaves
      // a lead-in to survive at all.
      expect(proceduralBundle().markers[0]?.sourceTimeMs).toBe(400);
      expect(all).toHaveLength(4);
      expect(all.every((p) => !isDark(p))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "refuses an export when the removed pieces really do empty the video, saying so",
    async () => {
      // The reachable empty case: a bundle whose first marker is at source
      // zero — which is what a rebuild produces, since replay fires act-1
      // immediately. There is no lead-in, so cutting every step leaves
      // nothing at all, and the author must read why rather than get a
      // keyframe error from the frame walk.
      const fromZero = proceduralBundle({
        markers: [
          { actionId: "act-1", sourceTimeMs: 0 },
          { actionId: "act-2", sourceTimeMs: 3200 },
          { actionId: "act-3", sourceTimeMs: 9000 },
        ],
      });
      // Premise: there really is no lead-in in this bundle.
      expect(fromZero.markers[0]?.sourceTimeMs).toBe(0);

      await expect(
        render(
          [
            { id: "cut-1", actionId: "act-1" },
            { id: "cut-2", actionId: "act-2" },
            { id: "cut-3", actionId: "act-3" },
          ],
          fromZero,
        ),
      ).rejects.toThrow(/the removed pieces leave no frames\. Restore one/);
    },
    TIMEOUT_MS,
  );
});

/**
 * `proceduralBundle` with a keyframe PAST act-3's marker, so the closing
 * step of a cut on act-2 genuinely has frames of its own in the video.
 * Without it the take ends on act-3's marker and the honest answer is that
 * the step has no still at all — both cases are exercised below.
 */
function bundleWithTail() {
  const base = proceduralBundle();
  return proceduralBundle({
    keyframes: [
      ...base.keyframes,
      {
        sourceTimeMs: 12_000,
        ref: "k-tail",
        width: 3840,
        height: 2400,
        actionId: null,
        byteLength: 0,
      },
    ],
  });
}

/** Each still's name and the probe pixel at the panel's position. */
async function stills(
  cuts: { id: string; actionId: string }[],
  bundle = proceduralBundle(),
) {
  const base = readonlyScene();
  const scene = {
    ...base,
    edits: { ...base.edits, removed: removedFor(base, cuts) },
  };
  const stillTarget = { ...STILL_1440, width: 640, height: 360 };
  const presentation = derivePresentation(
    scene.branding,
    stillTarget,
    bundle.viewport,
    null,
  );
  const at = cssToOutput(
    PANEL_CSS,
    { center: { x: 640, y: 400 }, scale: 1 },
    presentation.frameRect,
    bundle.viewport,
  );
  const probe = { x: Math.round(at.x), y: Math.round(at.y) };
  const seen: { name: string; pixel: number[] }[] = [];
  const images = {
    add: async (canvas: OffscreenCanvas, name: string) => {
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      seen.push({
        name,
        pixel: Array.from(ctx.getImageData(probe.x, probe.y, 1, 1).data),
      });
    },
    finish: async () =>
      seen.map((s) => ({ name: s.name, bytes: new Uint8Array([1]) })),
  };
  await renderStills({
    plan: planScene(scene),
    bundle,
    scene,
    target: stillTarget,
    ports: {
      frames: createProceduralFrameSource(bundle),
      surface: createOffscreenSurface(),
      images,
    },
  });
  return seen;
}

describe("a stills export of a cut take", () => {
  it(
    "draws the surviving closing step from its OWN frame, not the one before the cut",
    async () => {
      const bundle = bundleWithTail();
      // Premise: the fixture's act-3 keyframe and the last frame before the
      // cut really do look different — the panel is open at one and closed
      // at the other. Without this the pixel assertion below would be
      // satisfied by two identical pictures.
      const whole = await stills([], bundle);
      const beforeCut = whole.find((s) => s.name === "act-2.png");
      const atActThree = whole.find((s) => s.name === "act-3.png");
      expect(beforeCut && !isDark(beforeCut.pixel)).toBe(true);
      expect(atActThree && isDark(atActThree.pixel)).toBe(true);

      const cut = await stills([{ id: "cut-1", actionId: "act-2" }], bundle);
      expect(cut.map((s) => s.name)).toEqual(["act-1.png", "act-3.png"]);
      // THE defect: act-3's still is named for the step that survived and
      // must show that step's own frame. `toOutputMs` and `toSourceMs` are
      // not inverses at a seam, so a naive round trip drew the moment the
      // author cut under the kept step's name.
      const kept = cut.find((s) => s.name === "act-3.png");
      expect(kept && isDark(kept.pixel)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "renders no still for a closing step the cut leaves no frames of",
    async () => {
      // The default fixture ends ON act-3's marker, so cutting act-2 removes
      // everything from 3200ms to the end: act-3 has no frame in the video
      // at all. A still there could only be the frame before the cut, under
      // act-3's name — so there is no still.
      const bundle = proceduralBundle();
      expect(Math.max(...bundle.keyframes.map((k) => k.sourceTimeMs))).toBe(
        9000,
      );
      const cut = await stills([{ id: "cut-1", actionId: "act-2" }], bundle);
      expect(cut.map((s) => s.name)).toEqual(["act-1.png"]);
    },
    TIMEOUT_MS,
  );

  it(
    "is unchanged on a take with no cuts",
    async () => {
      const whole = await stills([]);
      expect(whole.map((s) => s.name)).toEqual([
        "act-1.png",
        "act-2.png",
        "act-3.png",
      ]);
    },
    TIMEOUT_MS,
  );
});
