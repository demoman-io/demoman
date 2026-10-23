import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { toOutputMs } from "../../src/plan/timeline";
import { createOffscreenSurface } from "../../src/ports/surface";
import type { VideoSink } from "../../src/ports/types";
import { cssToOutput } from "../../src/render/compose";
import { derivePresentation } from "../../src/render/presentation";
import { renderScene } from "../../src/render/render";
import { LANDSCAPE_1080P } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene } from "../fixtures/scene";

/** Inside the panel that slides open across the bundle's motion span. */
const PANEL_CSS = { x: 1100, y: 400 };
const target = { ...LANDSCAPE_1080P, width: 640, height: 360, fps: 10 };

const isDark = ([r, g, b]: number[]) =>
  (r ?? 255) < 60 && (g ?? 255) < 60 && (b ?? 255) < 80;

/**
 * A sink that keeps the FIRST frame's probe pixel and counts the rest.
 * `createRecordingVideoSink` (src/ports/fakes.ts) records timestamps only,
 * so it cannot answer the question this test asks — which picture came first.
 */
function pixelSink(probe: { x: number; y: number }): VideoSink & {
  first: number[] | null;
  frames: number;
} {
  const sink = {
    first: null as number[] | null,
    frames: 0,
    addFrame: async (canvas: OffscreenCanvas) => {
      if (sink.first === null) {
        const ctx = canvas.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        sink.first = Array.from(ctx.getImageData(probe.x, probe.y, 1, 1).data);
      }
      sink.frames += 1;
    },
    finish: async () => new Uint8Array([1]),
  };
  return sink;
}

async function firstFrame(scene = readonlyScene()) {
  const bundle = proceduralBundle();
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
  const video = pixelSink({ x: Math.round(at.x), y: Math.round(at.y) });
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
  if (video.first === null) throw new Error("no frame recorded");
  return { pixel: video.first, frames: video.frames, bundle };
}

describe("a trimmed render", () => {
  it("starts on the frame at the head marker, not on frame zero", async () => {
    // Fixture guard first: untrimmed, frame zero shows the page with the
    // panel closed. If this stops being true the assertion below is not
    // sampling what it claims to.
    const untrimmed = await firstFrame();
    expect(isDark(untrimmed.pixel)).toBe(false);

    const scene = readonlyScene();
    // act-2's marker is source 3200; +600ms output on this replay bundle is
    // source 3800 (the motion span passes at rate 1.0), 75% through the
    // panel's slide-open. `createProceduralFrameSource` derives the probe's
    // coverage from the panel's width, not from a boolean "open" state — the
    // panel's leading edge is at x = 1280 - 360*t, so it has already passed
    // the probe (x=1100) once t >= 0.5 (source >= 3600). 3800 sits with 90px
    // of margin on the pixel test and 200ms of margin before the span ends
    // at 4000, where a *keyframe-only* fallback would misreport the panel as
    // still closed — that fallback derives "open" from the nearest
    // *keyframe's* timestamp, and the bundle carries no keyframe between the
    // span's end (4000) and act-3 (9000), so any offset landing past 4000
    // reads as closed here despite the panel having finished opening.
    const OFFSET_MS = 600;
    const trimmed = {
      ...scene,
      edits: {
        ...scene.edits,
        trim: { head: { actionId: "act-2", offsetMs: OFFSET_MS } },
      },
    };
    const cut = await firstFrame(trimmed);
    expect(isDark(cut.pixel)).toBe(true);

    const r = resolvePlan(planScene(trimmed), cut.bundle, trimmed);
    const step = 1000 / target.fps;
    expect(cut.frames).toBe(
      Math.max(1, Math.round((r.range.endMs - r.range.startMs) / step)),
    );
    expect(cut.frames).toBeLessThan(untrimmed.frames);
    // And the head really is past act-2: guards the offset arithmetic.
    const act2 = toOutputMs(r.timeline, 3200);
    expect(r.range.startMs).toBeCloseTo(act2 + OFFSET_MS, 6);
    // measured 0.67s locally; CI is ~5x slower (CLAUDE.md) — 120_000ms
    // leaves headroom well beyond that, for a slow cold Chromium launch.
  }, 120_000);
});
