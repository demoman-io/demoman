import {
  CURSOR_DEFAULTS,
  type SceneCursor,
  type SceneDocument,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import { frameCamera, sampleCamera } from "../../src/plan/camera";
import { planScene } from "../../src/plan/plan";
import {
  holdAcrossGaps,
  holdThroughRests,
  type ResolvedPlan,
  resolvePlan,
  sampleCursor,
} from "../../src/plan/resolve";
import {
  CURSOR_REST_MS,
  CURSOR_SMOOTHING_MS,
  smoothCursor,
} from "../../src/plan/smooth";
import { toOutputMs, toSourceMs } from "../../src/plan/timeline";
import {
  cssRectToOutput,
  cssToOutput,
  renderFrame,
} from "../../src/render/compose";
import { TILT_SETTLE_MS } from "../../src/render/cursor-pose";
import {
  PRESS_DURATION_MS,
  PULSE_DURATION_MS,
} from "../../src/render/draw-cursor";
import {
  contentScale,
  derivePresentation,
  type Presentation,
} from "../../src/render/presentation";
import {
  LANDSCAPE_1080P,
  type RenderTarget,
  VERTICAL_1080,
} from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { cameraKey } from "../fixtures/camera-key";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene, sceneWithCosmetics } from "../fixtures/scene";

const VIEWPORT = { width: 1280, height: 800 };

/**
 * What `renderFrame` actually draws with. It clamps the sampled camera so the
 * zoomed view stays inside the canvas, so a test predicting where the cursor
 * lands has to clamp too or it will predict a position the renderer
 * deliberately refused to use.
 */
function cameraAt(
  keys: Parameters<typeof sampleCamera>[0],
  outputTimeMs: number,
  presentation: Presentation,
  target: RenderTarget,
) {
  return frameCamera(
    sampleCamera(keys, outputTimeMs),
    contentScale(presentation.frameRect, VIEWPORT),
    presentation.frameRect,
    VIEWPORT,
    target,
  );
}
const FRAME = { x: 100, y: 100, width: 1280, height: 800 };

describe("coordinate transforms", () => {
  const camera = { center: { x: 640, y: 400 }, scale: 1 };

  it("maps the viewport centre to the frame centre at scale 1", () => {
    expect(cssToOutput({ x: 640, y: 400 }, camera, FRAME, VIEWPORT)).toEqual({
      x: 740,
      y: 500,
    });
  });

  it("maps the viewport origin to the frame origin at scale 1", () => {
    expect(cssToOutput({ x: 0, y: 0 }, camera, FRAME, VIEWPORT)).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("keeps the camera centre pinned to the frame centre when zoomed", () => {
    const zoomed = { center: { x: 200, y: 150 }, scale: 2 };
    expect(cssToOutput({ x: 200, y: 150 }, zoomed, FRAME, VIEWPORT)).toEqual({
      x: 740,
      y: 500,
    });
  });

  it("magnifies distances by the camera scale", () => {
    const zoomed = { center: { x: 640, y: 400 }, scale: 2 };
    const a = cssToOutput({ x: 640, y: 400 }, zoomed, FRAME, VIEWPORT);
    const b = cssToOutput({ x: 740, y: 400 }, zoomed, FRAME, VIEWPORT);
    expect(b.x - a.x).toBeCloseTo(200, 6);
  });

  it("transforms rects consistently with points", () => {
    const zoomed = { center: { x: 640, y: 400 }, scale: 1.5 };
    const rect = cssRectToOutput(
      { x: 100, y: 100, width: 200, height: 50 },
      zoomed,
      FRAME,
      VIEWPORT,
    );
    const origin = cssToOutput({ x: 100, y: 100 }, zoomed, FRAME, VIEWPORT);
    expect(rect.x).toBeCloseTo(origin.x, 6);
    expect(rect.width).toBeCloseTo(300, 6);
  });
});

describe("renderFrame", () => {
  const bundle = proceduralBundle();
  const scene = readonlyScene();
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const target = LANDSCAPE_1080P;

  function compose(outputTimeMs: number, withScene = scene) {
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const presentation = derivePresentation(
      withScene.branding,
      target,
      VIEWPORT,
    );
    return renderFrame({
      resolved:
        withScene === scene
          ? resolved
          : resolvePlan(planScene(withScene), bundle, withScene),
      target,
      presentation,
      frames: createProceduralFrameSource(bundle),
      ctx,
      outputTimeMs,
    }).then(() => ({ ctx, presentation }));
  }

  function at(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number) {
    const [r, g, b, a] = ctx.getImageData(
      Math.round(x),
      Math.round(y),
      1,
      1,
    ).data;
    return { r: r as number, g: g as number, b: b as number, a: a as number };
  }

  it("fills the whole output — no transparent gaps anywhere", async () => {
    const { ctx } = await compose(0);
    for (const [x, y] of [
      [2, 2],
      [target.width - 2, 2],
      [2, target.height - 2],
      [target.width - 2, target.height - 2],
      [target.width / 2, target.height / 2],
    ]) {
      expect(at(ctx, x as number, y as number).a, `alpha at ${x},${y}`).toBe(
        255,
      );
    }
  });

  // Found by the harvested fixture, invisible to every other test here: the
  // camera centre was never constrained, so at scale 1 — where the source
  // covers the app frame exactly — any pan slid the image off and left the
  // pure-black fill `drawFrameChrome` lays down for its shadow passes showing
  // through as a hard-edged wedge. About a third of the 4K deliverable was
  // black. A procedural fixture cannot catch this by accident, because it
  // only shows up when a camera key asks to pan somewhere illegal.
  it("never exposes bare frame inside the app frame when the camera is off-centre at scale 1", async () => {
    const offCentre: ResolvedPlan = {
      ...resolved,
      // The only legal centre at scale 1 is the viewport's own (640, 400).
      // This asks for the bottom-right corner instead.
      cameraKeys: [
        cameraKey({ outputTimeMs: 0, center: { x: 1220, y: 760 }, scale: 1 }),
      ],
    };
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const presentation = derivePresentation(scene.branding, target, VIEWPORT);
    await renderFrame({
      resolved: offCentre,
      target,
      presentation,
      frames: createProceduralFrameSource(bundle),
      ctx,
      outputTimeMs: 0,
    });

    const { frameRect } = presentation;
    // Inset past the rounded corners, which are legitimately background.
    const inset = presentation.cornerRadius + 2;
    const bare: string[] = [];
    for (
      let y = frameRect.y + inset;
      y < frameRect.y + frameRect.height - inset;
      y += 16
    ) {
      for (
        let x = frameRect.x + inset;
        x < frameRect.x + frameRect.width - inset;
        x += 16
      ) {
        const px = at(ctx, x, y);
        // The shadow fill is exactly #000000; the fixture app's darkest pixel
        // is #111827. Pure black, or any transparency at all, means the
        // source image failed to cover that part of the frame.
        if (px.a !== 255 || (px.r === 0 && px.g === 0 && px.b === 0)) {
          bare.push(`${Math.round(x)},${Math.round(y)}`);
        }
      }
    }
    expect(bare.length, `bare frame at ${bare.slice(0, 6).join(" ")}`).toBe(0);
  });

  // The assertion that would have caught the letterbox, at the pixel level:
  // under `cover` the app has to reach every edge of its frame. The two
  // renders differ only in their solid background colour, and the *only* thing that
  // reads that colour is `drawBackground` — so any pixel that differs between
  // them is background showing through. Pure black is checked alongside it,
  // because content that is merely short rather than absent exposes the
  // shadow fill instead of the gradient.
  it("fills a cover frame edge to edge, with no background and no bare frame", async () => {
    const vertical = VERTICAL_1080;
    async function paint(color: string) {
      const canvas = new OffscreenCanvas(vertical.width, vertical.height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      const presentation = derivePresentation(
        { background: { kind: "solid", color }, logo: null, padding: 0.08 },
        vertical,
        VIEWPORT,
      );
      await renderFrame({
        resolved,
        target: vertical,
        presentation,
        frames: createProceduralFrameSource(bundle),
        ctx,
        outputTimeMs: 0,
      });
      return { ctx, presentation };
    }

    const warm = await paint("#db3b3b");
    const cool = await paint("#3b5bdb");
    const { frameRect } = warm.presentation;
    const inset = warm.presentation.cornerRadius + 2;
    const leaks: string[] = [];
    for (
      let y = frameRect.y + inset;
      y < frameRect.y + frameRect.height - inset;
      y += 16
    ) {
      for (
        let x = frameRect.x + inset;
        x < frameRect.x + frameRect.width - inset;
        x += 16
      ) {
        const a = at(warm.ctx, x, y);
        const b = at(cool.ctx, x, y);
        const showsBackground =
          Math.abs(a.r - b.r) > 4 ||
          Math.abs(a.g - b.g) > 4 ||
          Math.abs(a.b - b.b) > 4;
        const bare = a.a !== 255 || (a.r === 0 && a.g === 0 && a.b === 0);
        if (showsBackground || bare) {
          leaks.push(`${Math.round(x)},${Math.round(y)}`);
        }
      }
    }
    expect(leaks.length, `leaks at ${leaks.slice(0, 6).join(" ")}`).toBe(0);
  });

  // A crop that does not move is a letterbox with extra steps. Under `cover`
  // the overflowing axis has real room at scale 1, and the camera has to
  // spend it on the anchor the beat is about.
  it("centres a cover crop on the active anchor rather than sitting fixed", () => {
    const presentation = derivePresentation(
      readonlyScene().branding,
      VERTICAL_1080,
      VIEWPORT,
    );
    const { frameRect } = presentation;
    const anchors = readonlyScene().anchors;
    const rectOf = (id: string) =>
      anchors.find((a) => a.id === id)?.fingerprint.boundingRect;

    const centreOf = (id: string) => {
      const rect = rectOf(id);
      expect(rect).toBeDefined();
      if (!rect) throw new Error("unreachable");
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    };

    const framed = (id: string) => {
      const anchor = centreOf(id);
      const camera = cameraAt(
        [cameraKey({ outputTimeMs: 0, center: anchor, scale: 1 })],
        0,
        presentation,
        VERTICAL_1080,
      );
      return cssToOutput(anchor, camera, frameRect, VIEWPORT).x;
    };

    // a-checkout sits at x=1060, comfortably inside the reachable range, so
    // the crop centres on it exactly.
    const centreX = frameRect.x + frameRect.width / 2;
    expect(framed("a-checkout")).toBeCloseTo(centreX, 6);

    // a-search sits at x=200, closer to the page edge than half a crop
    // window, so the crop slides as far left as it can and the anchor lands
    // left of centre — still framed, never off-frame, and never at the cost
    // of exposing page that does not exist.
    expect(framed("a-search")).toBeLessThan(centreX);
    expect(framed("a-search")).toBeGreaterThan(frameRect.x);

    // And the two are genuinely different windows over the page, which is
    // the whole difference between a follow crop and a fixed one.
    const windowFor = (id: string) =>
      cameraAt(
        [cameraKey({ outputTimeMs: 0, center: centreOf(id), scale: 1 })],
        0,
        presentation,
        VERTICAL_1080,
      ).center.x;
    expect(windowFor("a-checkout")).toBeGreaterThan(
      windowFor("a-search") + 400,
    );
  });

  it("draws app content inside the frame and background outside it", async () => {
    const { ctx, presentation } = await compose(0);
    const { frameRect } = presentation;
    const inside = at(ctx, frameRect.x + frameRect.width / 2, frameRect.y + 20);
    const outside = at(ctx, 4, target.height / 2);
    expect([inside.r, inside.g, inside.b]).not.toEqual([
      outside.r,
      outside.g,
      outside.b,
    ]);
  });

  it("renders the app header dark, proving the frame is drawn right way up", async () => {
    const { ctx, presentation } = await compose(0);
    const { frameRect } = presentation;
    // The fixture app's header bar is #1f2937 across the top of the viewport.
    const header = at(ctx, frameRect.x + frameRect.width / 2, frameRect.y + 8);
    expect(header.r).toBeLessThan(80);
    expect(header.g).toBeLessThan(80);
  });

  // SP1's platform fact: the motion stream is capped at the compositor
  // surface and ignores emulated DPR, so a motion frame is smaller than a
  // keyframe and has to be upscaled into the same composite.
  it("composes a motion-span frame at the same size as a keyframe frame", async () => {
    const keyframeMoment = await compose(0);
    const motionMoment = await compose(
      resolved.timeline.segments.find((s) => s.kind === "motion")?.outStartMs ??
        0,
    );
    const rect = keyframeMoment.presentation.frameRect;
    // Same geometry, different pixels: the upscale landed in the same box.
    expect(at(motionMoment.ctx, rect.x + 4, rect.y + rect.height / 2).a).toBe(
      255,
    );
    expect(
      at(motionMoment.ctx, rect.x + rect.width - 4, rect.y + rect.height / 2).a,
    ).toBe(255);
  });

  // Corrected from the brief: as written this scanned the ENTIRE frame for a
  // near-white pixel, which would also pass against a render that drew no
  // cursor at all — the fixture app is full of white (a white search field,
  // white table rows). Restrict the scan to a window around the cursor's
  // actual transformed position instead, so this genuinely tests cursor
  // presence rather than "does the frame contain white anywhere".
  // Spec 2026-10-10 §5. A phone take shows a fingertip at each tap and
  // nothing between taps: no arrow, no trail, no glide. Measured as the
  // difference from the same frame with the pointer hidden, so whatever
  // the page underneath looks like, only what the pointer drew is counted.
  it("draws a tap marker at the tap, and no pointer at all between taps, for a touch take", async () => {
    const touchScene = {
      ...scene,
      meta: {
        ...scene.meta,
        capture: {
          ...scene.meta.capture,
          device: {
            preset: "phone" as const,
            width: 393,
            height: 852,
            mobile: true,
            touch: true,
            userAgent: "x",
          },
        },
      },
    };
    const touch = resolvePlan(planScene(touchScene), bundle, touchScene);
    const hidden = (r: typeof touch) => ({
      ...r,
      cursorLook: { ...r.cursorLook, hidden: true },
    });
    const drawWith = async (r: typeof touch, outputTimeMs: number) => {
      const canvas = new OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      const presentation = derivePresentation(
        touchScene.branding,
        target,
        VIEWPORT,
      );
      await renderFrame({
        resolved: r,
        target,
        presentation,
        frames: createProceduralFrameSource(bundle),
        ctx,
        outputTimeMs,
      });
      return { ctx, presentation };
    };
    /** Pixels that differ from the same frame with the pointer hidden, in a
     *  box around `where` (or the whole frame). */
    const drawn = async (
      r: typeof touch,
      outputTimeMs: number,
      where: { x: number; y: number } | null,
    ): Promise<number> => {
      const shown = (await drawWith(r, outputTimeMs)).ctx;
      const bare = (await drawWith(hidden(r), outputTimeMs)).ctx;
      const box =
        where === null
          ? { x: 0, y: 0, w: target.width, h: target.height }
          : {
              x: Math.max(0, Math.round(where.x - 60)),
              y: Math.max(0, Math.round(where.y - 60)),
              w: 120,
              h: 120,
            };
      const a = shown.getImageData(box.x, box.y, box.w, box.h).data;
      const b = bare.getImageData(box.x, box.y, box.w, box.h).data;
      let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d =
          Math.abs((a[i] ?? 0) - (b[i] ?? 0)) +
          Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) +
          Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
        if (d > 24) n++;
      }
      return n;
    };

    // The premise: there is a tap, and an instant well before it. The last
    // one: the first is the opening type's, too near the start for that.
    const tap = touch.taps.at(-1);
    expect(tap, "the fixture's touch take has no tap").toBeDefined();
    if (tap === undefined) throw new Error("unreachable");
    const before = tap.outputMs - 1500;
    expect(before).toBeGreaterThan(0);

    const { presentation } = await drawWith(touch, tap.outputMs);
    const camera = cameraAt(
      touch.cameraKeys,
      tap.outputMs,
      presentation,
      target,
    );
    const where = cssToOutput(tap.at, camera, presentation.frameRect, VIEWPORT);

    expect(await drawn(touch, tap.outputMs, where)).toBeGreaterThan(200);
    expect(await drawn(touch, before, null)).toBe(0);
    // The positive control: the desktop take at that instant draws its arrow,
    // so "nothing drawn" above is about the touch take, not the instant.
    expect(await drawn(resolved, before, null)).toBeGreaterThan(50);
  });

  it("draws the cursor near its transformed position", async () => {
    const { ctx, presentation } = await compose(0);
    const firstSample = resolved.cursor[0];
    expect(firstSample).toBeDefined();
    if (!firstSample) throw new Error("unreachable");
    // At output time 0 the cursor sits at the first cursor sample's CSS
    // coordinates; the camera at t=0 is the plan's first (neutral) key.
    const camera = cameraAt(resolved.cameraKeys, 0, presentation, target);
    const cursorAt = cssToOutput(
      { x: firstSample.x, y: firstSample.y },
      camera,
      presentation.frameRect,
      VIEWPORT,
    );

    let sawCursorWhite = false;
    for (let y = cursorAt.y - 12; y < cursorAt.y + 40; y += 2) {
      for (let x = cursorAt.x - 12; x < cursorAt.x + 40; x += 2) {
        const px = at(ctx, x, y);
        if (px.r > 250 && px.g > 250 && px.b > 250) sawCursorWhite = true;
      }
    }
    expect(sawCursorWhite).toBe(true);
  });

  // The cursor is part of the scene the camera zooms:
  // two ResolvedPlans differing only in camera zoom must draw a cursor that
  // much bigger. (It was the opposite invariant until 2026-10-05, when the
  // camera zoomed the app inside a fixed window and the pointer was UI.)
  it("grows the cursor with the camera zoom", async () => {
    // Anchored near the cursor's own CSS position so the transformed point
    // stays inside the frame at every scale under test — the point is to
    // isolate the size invariant, not to also exercise frame clipping.
    const cameraCenter = { x: 300, y: 640 };

    function variant(scale: number, withCursor: boolean): ResolvedPlan {
      return {
        ...resolved,
        cameraKeys: [
          cameraKey({ outputTimeMs: 0, center: cameraCenter, scale }),
        ],
        cursor: withCursor ? resolved.cursor : [],
        // Isolate the arrow from the click pulse, which also scales with the
        // zoom and would otherwise add ink that has nothing to do with the
        // arrow under test.
        clickOutputMs: [],
      };
    }

    async function cursorInkCount(scale: number): Promise<number> {
      const presentation = derivePresentation(scene.branding, target, VIEWPORT);
      const frames = createProceduralFrameSource(bundle);

      const withCursor = variant(scale, true);
      const withoutCursor = variant(scale, false);

      const canvasA = new OffscreenCanvas(target.width, target.height);
      const ctxA = canvasA.getContext(
        "2d",
      ) as OffscreenCanvasRenderingContext2D;
      await renderFrame({
        resolved: withCursor,
        target,
        presentation,
        frames,
        ctx: ctxA,
        outputTimeMs: 0,
      });

      const canvasB = new OffscreenCanvas(target.width, target.height);
      const ctxB = canvasB.getContext(
        "2d",
      ) as OffscreenCanvasRenderingContext2D;
      await renderFrame({
        resolved: withoutCursor,
        target,
        presentation,
        frames,
        ctx: ctxB,
        outputTimeMs: 0,
      });

      const camera = cameraAt(withCursor.cameraKeys, 0, presentation, target);
      const cursorCss = sampleCursor(withCursor.cursor, 0);
      expect(cursorCss).not.toBeNull();
      if (!cursorCss) throw new Error("unreachable");
      const cursorAt = cssToOutput(
        cursorCss,
        camera,
        presentation.frameRect,
        VIEWPORT,
      );

      // The window grows with the zoom, or it would clip the larger arrow
      // and cap the count it is measuring.
      let n = 0;
      for (
        let y = Math.round(cursorAt.y - 12 * scale);
        y < Math.round(cursorAt.y + 40 * scale);
        y++
      ) {
        for (
          let x = Math.round(cursorAt.x - 12 * scale);
          x < Math.round(cursorAt.x + 40 * scale);
          x++
        ) {
          const a = at(ctxA, x, y);
          const b = at(ctxB, x, y);
          if (
            Math.abs(a.r - b.r) > 10 ||
            Math.abs(a.g - b.g) > 10 ||
            Math.abs(a.b - b.b) > 10
          ) {
            n++;
          }
        }
      }
      return n;
    }

    const countAtScale1 = await cursorInkCount(1.0);
    const countAtScale2_5 = await cursorInkCount(2.5);

    // The premise: there is an arrow to measure at all.
    expect(countAtScale1).toBeGreaterThan(100);
    // 2.5x linear is 6.25x the ink. A pointer that kept its size would read
    // ~1x; the band is wide only for anti-aliasing along a longer outline.
    const ratio = countAtScale2_5 / countAtScale1;
    expect(ratio, `ink ${countAtScale1} -> ${countAtScale2_5}`).toBeGreaterThan(
      5,
    );
    expect(ratio, `ink ${countAtScale1} -> ${countAtScale2_5}`).toBeLessThan(
      7.5,
    );
  });

  // A drag holds the button down: the arrow is drawn pressed for the whole
  // hold, on the picture, not just in `cursorPressScale`'s number.
  it("draws the cursor pressed through a hold", async () => {
    const presentation = derivePresentation(scene.branding, target, VIEWPORT);
    const frames = createProceduralFrameSource(bundle);
    const draw = async (
      cursor: boolean,
      holds: { startMs: number; endMs: number }[],
    ) => {
      const canvas = new OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      await renderFrame({
        resolved: {
          ...resolved,
          cursor: cursor ? resolved.cursor : [],
          clickOutputMs: [],
          holdOutputMs: holds,
        },
        target,
        presentation,
        frames,
        ctx,
        outputTimeMs: 0,
      });
      return ctx;
    };
    const ink = async (holds: { startMs: number; endMs: number }[]) => {
      const a = await draw(true, holds);
      const b = await draw(false, holds);
      const camera = cameraAt(resolved.cameraKeys, 0, presentation, target);
      const css = sampleCursor(resolved.cursor, 0);
      if (!css) throw new Error("no cursor at 0");
      const c = cssToOutput(css, camera, presentation.frameRect, VIEWPORT);
      let n = 0;
      for (let y = Math.round(c.y - 12); y < Math.round(c.y + 40); y++) {
        for (let x = Math.round(c.x - 12); x < Math.round(c.x + 40); x++) {
          const p = at(a, x, y);
          const q = at(b, x, y);
          if (
            Math.abs(p.r - q.r) > 10 ||
            Math.abs(p.g - q.g) > 10 ||
            Math.abs(p.b - q.b) > 10
          )
            n++;
        }
      }
      return n;
    };
    const free = await ink([]);
    const held = await ink([{ startMs: -100, endMs: 1000 }]);
    // The premise: an arrow is drawn either way.
    expect(free).toBeGreaterThan(100);
    expect(held).toBeGreaterThan(50);
    // Pressed is 0.86 linear, about 0.74 of the ink.
    const ratio = held / free;
    expect(ratio, `ink ${free} -> ${held}`).toBeGreaterThan(0.6);
    expect(ratio, `ink ${free} -> ${held}`).toBeLessThan(0.85);
  });

  it("applies cosmetics", async () => {
    const scene = sceneWithCosmetics();
    const { ctx, presentation } = await compose(0, scene);
    const { frameRect } = presentation;
    // The mask sits at CSS 60,380 400x24 — flat, opaque redaction grey.
    const px = at(
      ctx,
      frameRect.x + (100 / 1280) * frameRect.width,
      frameRect.y + (392 / 800) * frameRect.height,
    );
    expect(px.a).toBe(255);
    expect(Math.abs(px.r - px.g)).toBeLessThan(20);
  });

  it("is deterministic — the same output time composes the same pixels", async () => {
    const a = await compose(120);
    const b = await compose(120);
    const sample = (ctx: OffscreenCanvasRenderingContext2D) =>
      [...ctx.getImageData(0, 0, 64, 64).data].join(",");
    expect(sample(a.ctx)).toBe(sample(b.ctx));
  });
});

/**
 * The click pulse against a real retimed timeline, at the frame rate the
 * deliverable is assembled on.
 *
 * Every other test of `drawClickPulse` hands it a literal `t`, which is
 * exactly why this shipped: the drawing was always correct, and the *window*
 * was wrong. `PULSE_DURATION_MS` and `PRESS_DURATION_MS` are viewer-time
 * constants, but the composer measured them against `toSourceMs(...)` — so on
 * a compressed idle span the retimer set the pulse's duration, and a 400ms
 * ring played in whatever fraction of screen time that span had been cut to.
 *
 * This is the normal case, not an edge one. A click is preceded by the
 * pointer arriving and dwelling, and a dwell produces no cursor-motion span,
 * so nothing marks the stretch around a click as motion. The last click of
 * any demo is followed by dead air by definition.
 */
/**
 * The camera zooms the whole composition — background, rounded window, app,
 * cursor and logo as one picture. Until
 * 2026-10-05 it zoomed the app inside a window that stayed put, and every
 * case here reads a pixel that the old camera painted differently.
 */
describe("the camera zooms the whole scene", () => {
  const bundle = proceduralBundle();
  const scene = readonlyScene();
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const target = LANDSCAPE_1080P;
  const WARM = "#db3b3b";
  const COOL = "#3b5bdb";

  function held(center: { x: number; y: number }, scale: number): ResolvedPlan {
    return {
      ...resolved,
      cameraKeys: [cameraKey({ outputTimeMs: 0, center, scale })],
      // Nothing but the scene itself: no pointer, no pulse, no overlays, so
      // a probe reads background, window or page and nothing else.
      cursorLook: { ...resolved.cursorLook, hidden: true },
      clickOutputMs: [],
    };
  }

  async function paint(
    plan: ResolvedPlan,
    branding: SceneDocument["branding"],
    logo: Awaited<ReturnType<typeof solidLogo>> | null = null,
  ) {
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const presentation = derivePresentation(branding, target, VIEWPORT, logo);
    await renderFrame({
      resolved: plan,
      target,
      presentation,
      frames: createProceduralFrameSource(bundle),
      ctx,
      outputTimeMs: 0,
    });
    return { ctx, presentation };
  }

  const solid = (color: string): SceneDocument["branding"] => ({
    background: { kind: "solid", color },
    logo: null,
    padding: 0.08,
  });

  function px(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number) {
    const [r, g, b, a] = ctx.getImageData(
      Math.round(x),
      Math.round(y),
      1,
      1,
    ).data;
    return [r, g, b, a] as number[];
  }

  /** The only thing that reads the background colour is the background, so
   *  a pixel that differs between a warm and a cool render is background. */
  async function backgroundAt(
    plan: ResolvedPlan,
    points: Array<[number, number]>,
  ): Promise<boolean[]> {
    const warm = await paint(plan, solid(WARM));
    const cool = await paint(plan, solid(COOL));
    return points.map(([x, y]) => {
      const a = px(warm.ctx, x, y);
      const b = px(cool.ctx, x, y);
      return a.some((v, i) => Math.abs(v - (b[i] as number)) > 4);
    });
  }

  async function solidLogo(width: number, height: number) {
    const c = new OffscreenCanvas(width, height);
    const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
    g.fillStyle = "#e03131";
    g.fillRect(0, 0, width, height);
    const image = await createImageBitmap(c);
    return { image, width, height, sourceTimeMs: 0 };
  }

  it("carries the window's margin into the zoom along with the page", async () => {
    const { frameRect } = derivePresentation(solid(WARM), target, VIEWPORT);
    // Halfway across the left margin, on the window's own centre line.
    const margin: [number, number] = [frameRect.x / 2, target.height / 2];
    const [atRest] = await backgroundAt(held({ x: 640, y: 400 }, 1), [margin]);
    // The premise: at 1:1 this point is background.
    expect(atRest, "the margin probe is background at 1:1").toBe(true);
    // Zoomed 1.8x on the page's centre the window grows past the output's
    // edges, so the same output pixel is page. A camera that zoomed only
    // inside a fixed window would still be showing background here.
    const [zoomed] = await backgroundAt(held({ x: 640, y: 400 }, 1.8), [
      margin,
    ]);
    expect(zoomed, "the margin probe is page at 1.8x").toBe(false);
  });

  it("stops at the canvas edge, with the margin in shot, toward a corner", async () => {
    const { frameRect } = derivePresentation(solid(WARM), target, VIEWPORT);
    const scale = 1.8;
    // Zoomed on the page's own top-left corner the canvas's corner lands on
    // the output's, so the window's left edge is at frameRect.x * 1.8.
    const edge = frameRect.x * scale;
    expect(edge, "the zoomed window edge is inside the output").toBeLessThan(
      target.width / 2,
    );
    const plan = held({ x: 0, y: 0 }, scale);
    const [corner, marginBand, page] = await backgroundAt(plan, [
      [2, 2],
      // Between the window's resting edge and its zoomed one: page under a
      // fixed window, margin under a zoomed scene.
      [(frameRect.x + edge) / 2, target.height / 2],
      [edge + 40, target.height / 2],
    ]);
    expect(corner, "the canvas corner is background").toBe(true);
    expect(marginBand, "the band left of the zoomed window is margin").toBe(
      true,
    );
    expect(page, "right of the zoomed window edge is page").toBe(false);
    // And nothing outside the canvas is ever in shot: every corner opaque.
    const { ctx } = await paint(plan, solid(WARM));
    for (const [x, y] of [
      [1, 1],
      [target.width - 1, 1],
      [1, target.height - 1],
      [target.width - 1, target.height - 1],
    ] as const) {
      expect(px(ctx, x, y)[3], `alpha at ${x},${y}`).toBe(255);
    }
  });

  it("zooms the logo with the background it is painted on", async () => {
    const logo = await solidLogo(200, 100);
    const branding: SceneDocument["branding"] = {
      background: { kind: "solid", color: "#ffffff" },
      logo: { ref: "logo:a", corner: "top-left", size: 0.06, opacity: 1 },
      padding: 0.08,
    };
    const scale = 1.8;
    const atRest = await paint(held({ x: 0, y: 0 }, 1), branding, logo);
    const rect = atRest.presentation.logo?.rect;
    expect(rect, "the logo was placed").toBeDefined();
    const r = rect as NonNullable<typeof rect>;
    const centre = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    // The premise: at 1:1 the logo is where its placement says.
    expect(px(atRest.ctx, centre.x, centre.y)).toEqual([0xe0, 0x31, 0x31, 255]);
    // Zoomed on the top-left corner the canvas origin stays at the output's
    // origin, so the logo's centre moves out to 1.8x its distance from it.
    const zoomed = await paint(held({ x: 0, y: 0 }, scale), branding, logo);
    expect(px(zoomed.ctx, centre.x * scale, centre.y * scale)).toEqual([
      0xe0, 0x31, 0x31, 255,
    ]);
    // ...and a point just past its resting right edge, inside its zoomed
    // one, is logo too: it grew, it did not merely move.
    expect(px(zoomed.ctx, r.x + r.width + 4, centre.y * scale)).toEqual([
      0xe0, 0x31, 0x31, 255,
    ]);
  });

  // Canvas shadows are drawn in device pixels and ignore the transform, so
  // a shadow left alone would stay the size it is at 1:1 while the window
  // it seats grew 1.8x — a hard, thin edge under a big window.
  it("grows the window's shadow with the zoom", async () => {
    const pale = "#eceff2";
    const bg = [0xec, 0xef, 0xf2];
    async function shadowDepth(scale: number): Promise<number> {
      // Zoomed on the page's bottom-left corner, the canvas's bottom-left
      // lands on the output's, so the window's bottom edge is in shot.
      const { ctx, presentation } = await paint(
        held({ x: 0, y: 800 }, scale),
        solid(pale),
      );
      const { frameRect } = presentation;
      const bottom =
        target.height -
        (target.height - (frameRect.y + frameRect.height)) * scale;
      const x = (frameRect.x + frameRect.width / 2) * scale;
      expect(x, "the probe column is inside the output").toBeLessThan(
        target.width,
      );
      for (let y = Math.ceil(bottom) + 1; y < target.height; y++) {
        const p = px(ctx, x, y);
        if (bg.every((v, i) => Math.abs(v - (p[i] as number)) <= 2)) {
          return y - bottom;
        }
      }
      return target.height - bottom;
    }
    const atRest = await shadowDepth(1);
    const zoomed = await shadowDepth(1.8);
    // The premise: a shadow measurably darkens the margin under the window,
    // and it fades out before the canvas ends at both scales.
    expect(atRest).toBeGreaterThan(30);
    expect(zoomed).toBeLessThan(target.height - 800);
    const ratio = zoomed / atRest;
    expect(ratio, `shadow ${atRest}px -> ${zoomed}px`).toBeGreaterThan(1.55);
    expect(ratio, `shadow ${atRest}px -> ${zoomed}px`).toBeLessThan(2.05);
  });
});

describe("click pulse on a retimed timeline", () => {
  const target = LANDSCAPE_1080P;
  const scene = readonlyScene();
  const CLICK_SOURCE_MS = 2000;
  const CURSOR_AT = { x: 1060, y: 642 };

  /**
   * A capture bundle whose click lands inside a 15x-compressed idle span:
   * the pointer travels for the first second, then holds on the checkout
   * button (a hold is not motion), clicks at 2000, and the page sits still
   * until 8000.
   *
   * The compression is production's, through `planScene` -> `resolvePlan`
   * -> `buildTimeline`: an authored 400ms gap after the click, against
   * 6000ms of dead air. Between 2026-09-08 and this commit the block
   * hand-built `resolved.timeline` to the deleted `[120, 400]` idle clamp's
   * numbers instead, which kept the pulse assertions meaningful but left the
   * branch's retiming change with no decoded-pixel evidence running through
   * production code at all — CLAUDE.md's "assert on the picture" bar,
   * unmet by the one file that could meet it.
   *
   * `act-nav` exists so the gap has a pair to sit between: `planScene`
   * emits no pace for a terminal action, and the click was the take's last
   * step. A navigation `waitFor` names no element, so it adds a marker and
   * nothing else.
   */
  const ACT_NAV_SOURCE_MS = 8000;
  const pacedScene = (gapMs: number | null): SceneDocument => {
    const base = readonlyScene();
    const [, , click] = base.actions;
    if (!click) throw new Error("unreachable");
    return {
      ...base,
      actions: [
        { ...click, timestamp: CLICK_SOURCE_MS },
        {
          id: "act-nav",
          anchorId: null,
          timestamp: ACT_NAV_SOURCE_MS,
          marker: "waitFor:navigation",
          kind: "waitFor",
          condition: "loaded",
        },
      ],
      edits: {
        ...base.edits,
        gaps:
          gapMs === null
            ? []
            : [{ id: "g-click", afterActionId: click.id, durationMs: gapMs }],
      },
    };
  };

  const bundle = proceduralBundle({
    source: "capture",
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
        sourceTimeMs: 9000,
        ref: "k-3",
        width: 3840,
        height: 2400,
        actionId: "act-3",
      },
    ],
    motionSpans: [],
    cursorSamples: [
      { sourceTimeMs: 0, x: 120, y: 640 },
      { sourceTimeMs: 1000, ...CURSOR_AT },
      // The dwell, then the click, then more dwell — no movement, so no
      // cursor-motion span protects any of it from the authored gap.
      { sourceTimeMs: CLICK_SOURCE_MS, ...CURSOR_AT },
      { sourceTimeMs: ACT_NAV_SOURCE_MS, ...CURSOR_AT },
      { sourceTimeMs: 9000, x: 900, y: 300 },
    ],
    markers: [
      { actionId: "act-3", sourceTimeMs: CLICK_SOURCE_MS },
      { actionId: "act-nav", sourceTimeMs: ACT_NAV_SOURCE_MS },
    ],
  });

  // 400ms of dead air where the take had 6000: the same 15x the deleted
  // clamp used to impose on everything, now asked for by an author.
  const AUTHORED_GAP_MS = 400;
  const paced = pacedScene(AUTHORED_GAP_MS);
  const resolved = resolvePlan(planScene(paced), bundle, paced);

  it("compresses the span the click sits in — the premise of everything below", () => {
    // Fixture guards. The gap has to reach the plan as an AUTHORED pace and
    // the bundle has to be a capture one, or `idleOutputFor` never fires and
    // the compression below would have to have come from somewhere else.
    expect(bundle.source).toBe("capture");
    expect(resolved.plan.paces).toEqual([
      {
        afterActionId: "act-3",
        beforeActionId: "act-nav",
        origin: "authored",
        idleTargetMs: AUTHORED_GAP_MS,
      },
    ]);

    const span = resolved.timeline.segments.find(
      (s) => s.srcStartMs === CLICK_SOURCE_MS,
    );
    expect(span).toBeDefined();
    if (!span) throw new Error("unreachable");
    expect(span.kind).toBe("idle");
    expect(span.outEndMs - span.outStartMs).toBeCloseTo(AUTHORED_GAP_MS, 0);
    const rate =
      (span.srcEndMs - span.srcStartMs) / (span.outEndMs - span.outStartMs);
    expect(rate).toBeGreaterThan(10);
  });

  /**
   * Counts frames, at the target's real fps, on which the ring puts ink
   * outside the pointer's own footprint.
   *
   * The comparison render differs only in `clickOutputMs`, so every pixel that
   * moves is pulse or press. The exclusion box covers the arrow and its drop
   * shadow, which both extend down-right from the hotspot and never up-left,
   * so the press animation cannot be mistaken for the ring.
   */
  const WINDOW = 140;

  async function framesShowingPulse(plan: ResolvedPlan): Promise<number> {
    const presentation = derivePresentation(scene.branding, target, VIEWPORT);
    const noPulse: ResolvedPlan = { ...plan, clickOutputMs: [] };
    const step = 1000 / target.fps;
    const clickOutMs = plan.clickOutputMs[0];
    expect(clickOutMs).toBeDefined();
    if (clickOutMs === undefined) throw new Error("unreachable");

    // One source for all 50 paints, so its keyframe cache actually applies.
    const frames = createProceduralFrameSource(bundle);
    let seen = 0;
    for (let i = 0; i * step <= PULSE_DURATION_MS; i++) {
      const outputTimeMs = clickOutMs + i * step;
      if (outputTimeMs > plan.timeline.outputDurationMs) break;

      const paint = async (source: ResolvedPlan) => {
        const canvas = new OffscreenCanvas(target.width, target.height);
        const ctx = canvas.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        await renderFrame({
          resolved: source,
          target,
          presentation,
          frames,
          ctx,
          outputTimeMs,
        });
        return ctx;
      };
      const withPulse = await paint(plan);
      const without = await paint(noPulse);

      const camera = cameraAt(
        plan.cameraKeys,
        outputTimeMs,
        presentation,
        target,
      );
      const cursorCss = sampleCursor(
        plan.cursor,
        toSourceMs(plan.timeline, outputTimeMs),
      );
      expect(cursorCss).not.toBeNull();
      if (!cursorCss) throw new Error("unreachable");
      const hot = cssToOutput(
        cursorCss,
        camera,
        presentation.frameRect,
        VIEWPORT,
      );

      // One readback per canvas, not one per pixel. `getImageData` is a
      // synchronous GPU-to-CPU copy, and this window is 19,600 pixels on 25
      // frames of two renders: read per pixel, the two tests below took
      // 14–16s on a GitHub runner against a 15s budget (2026-09-05) and
      // ~3s here. Read once, the pixels compared are the same.
      const x0 = Math.round(hot.x) - 70;
      const y0 = Math.round(hot.y) - 70;
      const a = withPulse.getImageData(x0, y0, WINDOW, WINDOW).data;
      const b = without.getImageData(x0, y0, WINDOW, WINDOW).data;
      let ink = 0;
      for (let y = y0; y < y0 + WINDOW; y++) {
        for (let x = x0; x < x0 + WINDOW; x++) {
          const isPointer =
            x > hot.x - 3 && x < hot.x + 22 && y > hot.y - 3 && y < hot.y + 34;
          if (isPointer) continue;
          const i = ((y - y0) * WINDOW + (x - x0)) * 4;
          if (
            Math.abs((a[i] as number) - (b[i] as number)) > 8 ||
            Math.abs((a[i + 1] as number) - (b[i + 1] as number)) > 8 ||
            Math.abs((a[i + 2] as number) - (b[i + 2] as number)) > 8
          ) {
            ink++;
          }
        }
      }
      if (ink > 20) seen++;
    }
    return seen;
  }

  // 400ms at 60fps is 24 frames. Allow the last couple, where alpha has faded
  // toward zero by design, to fall under the ink threshold. Windowed in
  // source time this same scene renders the pulse on 2 frames — 33ms of
  // screen time — which is the defect stated as a number.
  //
  // Both tests below are render-bound, like outputs.test.ts and mp4.test.ts,
  // and carry the same budget those do. Each composes 50 full 1080p frames,
  // and a compose is ~38ms here regardless of source size — the frame
  // chrome's shadow passes, not the image draw. A GitHub runner is ~5x
  // slower, which put the first one at 16.3s against vitest's 15s default
  // on 2026-09-05 while its twin passed at 14.1s.
  const RENDER_BOUND_MS = 120_000;

  it(
    "stays on screen for its whole 400ms even on a heavily compressed span",
    async () => {
      expect(await framesShowingPulse(resolved)).toBeGreaterThanOrEqual(20);
    },
    RENDER_BOUND_MS,
  );

  // The control: on an uncompressed span the answer must be the same. If it
  // is not, the fix has traded one clock for another rather than using the
  // right one.
  it(
    "shows the same pulse length where the timeline is not compressed",
    async () => {
      // The same scene with no gap authored: production leaves the 6000ms
      // of dead air alone (the idle clamp is gone), so source and output
      // agree end to end.
      const plain = pacedScene(null);
      const uncompressed = resolvePlan(planScene(plain), bundle, plain);
      const span = uncompressed.timeline.segments.find(
        (s) => s.srcStartMs === CLICK_SOURCE_MS,
      );
      expect(span?.outEndMs).toBeCloseTo(span?.srcEndMs ?? 0, 0);
      expect(await framesShowingPulse(uncompressed)).toBeGreaterThanOrEqual(20);
    },
    RENDER_BOUND_MS,
  );
});

/**
 * A rebuild's reconstructed pause, asserted on decoded pixels.
 *
 * `"pace"` segments and `RenderPlan.paces` had no picture-level evidence
 * anywhere in either browser lane until this test: the whole of rebuild-mode
 * pacing was proved by segment counts and durations, which is exactly the
 * proxy CLAUDE.md says the rendered video keeps diverging from. A freeze is
 * a claim about frames — "the picture stops here and nothing moves" — and
 * that is what this reads back.
 *
 * The cursor is what moves. The procedural app is still between keyframes,
 * so the pointer travelling across the viewport is the only thing that
 * changes from frame to frame, which makes "frozen" and "playing" tell each
 * other apart in ink.
 */
describe("a reconstructed pause is a frozen picture", () => {
  const target = LANDSCAPE_1080P;
  const REPLAY_SPAN_MS = 1000;
  const RECORDED_SPAN_MS = 3000;

  // Two steps, 3000ms apart in the take. The rebuild covered the same
  // ground in 1000ms and every one of those was the cursor moving, so there
  // is no dead air to shorten and the whole shortfall is inserted.
  const scene: SceneDocument = (() => {
    const base = readonlyScene();
    const [type, , click] = base.actions;
    if (!type || !click) throw new Error("unreachable");
    return {
      ...base,
      actions: [
        { ...type, timestamp: 0 },
        { ...click, timestamp: RECORDED_SPAN_MS },
      ],
    };
  })();

  const bundle = proceduralBundle({
    source: "replay",
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
        sourceTimeMs: 2000,
        ref: "k-3",
        width: 3840,
        height: 2400,
        actionId: "act-3",
      },
    ],
    motionSpans: [],
    cursorSamples: [
      { sourceTimeMs: 0, x: 120, y: 200 },
      { sourceTimeMs: 500, x: 400, y: 320 },
      { sourceTimeMs: 1000, x: 700, y: 440 },
      { sourceTimeMs: 1500, x: 900, y: 540 },
      { sourceTimeMs: 2000, x: 1060, y: 642 },
    ],
    markers: [
      { actionId: "act-1", sourceTimeMs: 0 },
      { actionId: "act-3", sourceTimeMs: REPLAY_SPAN_MS },
    ],
  });

  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const freeze = resolved.timeline.segments.find((s) => s.kind === "pace");

  it("carries the fixture the pixels are read against", () => {
    // Without these, "the frames are identical" would go green over a render
    // containing no freeze and a cursor that never moved.
    expect(bundle.source).toBe("replay");
    expect(freeze).toBeDefined();
    if (!freeze) throw new Error("unreachable");
    expect(freeze.srcStartMs).toBe(freeze.srcEndMs);
    expect(freeze.outEndMs - freeze.outStartMs).toBeCloseTo(
      RECORDED_SPAN_MS - REPLAY_SPAN_MS,
      0,
    );
    // Source time really does stand still across it, and really does move
    // over the control window below.
    expect(toSourceMs(resolved.timeline, freeze.outStartMs + 100)).toBeCloseTo(
      freeze.srcStartMs,
      6,
    );
    expect(toSourceMs(resolved.timeline, freeze.outEndMs - 100)).toBeCloseTo(
      freeze.srcStartMs,
      6,
    );
    const early = sampleCursor(
      resolved.cursor,
      toSourceMs(resolved.timeline, 100),
    );
    const late = sampleCursor(
      resolved.cursor,
      toSourceMs(resolved.timeline, 900),
    );
    expect(early).not.toBeNull();
    expect(late).not.toBeNull();
    expect(early?.x).not.toBeCloseTo(late?.x ?? 0, 0);
  });

  async function paintAt(outputTimeMs: number): Promise<Uint8ClampedArray> {
    const presentation = derivePresentation(scene.branding, target, VIEWPORT);
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    await renderFrame({
      resolved,
      target,
      presentation,
      frames: createProceduralFrameSource(bundle),
      ctx,
      outputTimeMs,
    });
    return ctx.getImageData(0, 0, target.width, target.height).data;
  }

  /** Pixels whose red channel differs by more than a rounding wobble. */
  const differing = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs((a[i] as number) - (b[i] as number)) > 8) n++;
    }
    return n;
  };

  // Five 1080p composites. ~38ms each here (the frame chrome's shadow
  // passes, not the image draw) and a GitHub runner is ~5x slower, so the
  // explicit budget is the one outputs.test.ts and the pulse tests carry.
  const RENDER_BOUND_MS = 120_000;

  it(
    "paints the same frame across the freeze, and a different one either side",
    async () => {
      if (!freeze) throw new Error("unreachable");
      // The pace is the wait BEFORE act-3, so act-3's click lands where the
      // freeze ENDS — and the press, which animates in viewer time for
      // `PRESS_DURATION_MS` either side of the click, legitimately moves the
      // freeze's closing frames. Until 2026-09-22 the click landed on the
      // freeze's FIRST frame instead, and this read the frozen picture after
      // the pulse there: the click pulsed, the picture held, and the page's
      // response played after the wait. So the premise is asserted, and the
      // frozen picture is read clear of the press at the far end.
      //
      // The opening end has its own legitimate motion since 2026-10-09: the
      // pointer arrives at the freeze moving, and its lean settles upright
      // over the `TILT_SETTLE_MS` after it stops. So the frozen picture is
      // read clear of that at the near end too.
      expect(resolved.clickOutputMs).toContainEqual(
        expect.closeTo(freeze.outEndMs, 6),
      );
      const settledStartMs = freeze.outStartMs + TILT_SETTLE_MS + 100;
      const settledEndMs = freeze.outEndMs - PRESS_DURATION_MS - 100;
      expect(settledStartMs).toBeLessThan(settledEndMs);
      const insideA = await paintAt(settledStartMs);
      const insideB = await paintAt((settledStartMs + settledEndMs) / 2);
      const insideC = await paintAt(settledEndMs);
      expect(differing(insideA, insideB)).toBe(0);
      expect(differing(insideA, insideC)).toBe(0);

      // The control, over a window of the same 800ms: while the timeline is
      // playing, the same two offsets apart paint a moving cursor. Without
      // it "identical" would be satisfied by a render that never draws
      // anything at all.
      const playingA = await paintAt(100);
      const playingB = await paintAt(900);
      expect(differing(playingA, playingB)).toBeGreaterThan(500);
    },
    RENDER_BOUND_MS,
  );
});

/**
 * The drawn cursor through a pause in a capture take, asserted on decoded
 * pixels rather than on the sample array.
 *
 * A resting hand records nothing — Chrome fires no `pointermove` while the
 * mouse is untouched — so a pause is a hole between two real samples, and
 * `sampleCursor` interpolated straight across it: the arrow glided the whole
 * way to the next target while the hand sat still, in every take. The sample
 * arithmetic for that lives in `plan/resolve.ts`'s tests; this is the claim
 * that matters, which is about the picture.
 */
/**
 * Where the cursor's own ink is, in output pixels.
 *
 * Differenced against the same frame rendered with no cursor, so this
 * locates the arrow itself rather than any white the app happens to contain
 * — the fixture app is full of white, and a plain brightness scan would pass
 * against a render that drew no cursor at all. The click pulse is switched
 * off in both so only the arrow contributes.
 */
async function cursorInkCentroid(args: {
  plan: ResolvedPlan;
  bundle: FrameBundle;
  scene: SceneDocument;
  target: RenderTarget;
  outputTimeMs: number;
}): Promise<{ x: number; y: number; n: number }> {
  const { plan, bundle, scene, target, outputTimeMs } = args;
  const presentation = derivePresentation(scene.branding, target, VIEWPORT);
  const render = async (cursor: ResolvedPlan["cursor"]) => {
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    await renderFrame({
      resolved: { ...plan, cursor, clickOutputMs: [] },
      target,
      presentation,
      frames: createProceduralFrameSource(bundle),
      ctx,
      outputTimeMs,
    });
    return ctx;
  };
  const withCursor = await render(plan.cursor);
  const without = await render([]);

  const a = withCursor.getImageData(0, 0, target.width, target.height).data;
  const b = without.getImageData(0, 0, target.width, target.height).data;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs((a[i] as number) - (b[i] as number)) > 10 ||
      Math.abs((a[i + 1] as number) - (b[i + 1] as number)) > 10 ||
      Math.abs((a[i + 2] as number) - (b[i + 2] as number)) > 10
    ) {
      const px = (i / 4) % target.width;
      const py = Math.floor(i / 4 / target.width);
      sx += px;
      sy += py;
      n++;
    }
  }
  return { x: n === 0 ? -1 : sx / n, y: n === 0 ? -1 : sy / n, n };
}

describe("the drawn cursor through a pause in a capture take", () => {
  const target = LANDSCAPE_1080P;
  const scene = readonlyScene();
  const paused = proceduralBundle({
    source: "capture",
    cursorSamples: [
      { sourceTimeMs: 0, x: 120, y: 300 },
      { sourceTimeMs: 16, x: 130, y: 305 },
      { sourceTimeMs: 32, x: 140, y: 310 },
      // Two seconds of stillness, then the hand moves across the page.
      { sourceTimeMs: 2032, x: 1100, y: 700 },
      { sourceTimeMs: 2048, x: 1110, y: 705 },
    ],
  });
  const resolved = resolvePlan(planScene(scene), paused, scene);

  const inkCentroid = (plan: ResolvedPlan, outputTimeMs: number) =>
    cursorInkCentroid({ plan, bundle: paused, scene, target, outputTimeMs });

  /** Two instants a second apart, both inside the pause. */
  const early = toOutputMs(resolved.timeline, 600);
  const late = toOutputMs(resolved.timeline, 1600);

  it("paints the arrow in the same place at both ends of the pause", async () => {
    const first = await inkCentroid(resolved, early);
    const second = await inkCentroid(resolved, late);
    // Ink present at all — without this the two centroids could agree at
    // (-1, -1) and the test would pass having drawn no cursor.
    expect(first.n).toBeGreaterThan(100);
    expect(second.n).toBeGreaterThan(100);
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeLessThan(2);
  });

  it("is composing a pause the raw samples really do glide across", async () => {
    // Fixture guard, and the gate on `holdThroughRests`: the same frames
    // drawn from the raw recorded samples move the arrow across the frame
    // while the hand is still.
    const raw: ResolvedPlan = { ...resolved, cursor: paused.cursorSamples };
    const first = await inkCentroid(raw, early);
    const second = await inkCentroid(raw, late);
    expect(first.n).toBeGreaterThan(100);
    expect(second.n).toBeGreaterThan(100);
    // Derived, not a tuned constant. This guard measures a journey in OUTPUT
    // pixels, and output pixels per CSS pixel move with the branding's padding —
    // the drawn content narrows as the inset grows, so the very same journey
    // covers fewer of them. The threshold was a bare 200, calibrated at the
    // 0.05 landscape inset; raising it to 0.15 on 2026-09-21 shrank the
    // travel to 168.9px and turned this red with the cursor behaving exactly
    // as before. 144 CSS px is that 200 divided by the scale it was written
    // at, so the claim is now about the pointer rather than about the frame
    // it happens to be drawn in.
    const { frameRect } = derivePresentation(
      scene.branding,
      target,
      scene.meta.capture.viewport,
    );
    const outputPxPerCssPx = contentScale(
      frameRect,
      scene.meta.capture.viewport,
    );
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThan(
      144 * outputPxPerCssPx,
    );
  });

  it("separates the two instants, so the two frames are not the same frame", async () => {
    // If the retimer collapsed the pause to a single output instant, both
    // assertions above would be comparing a frame with itself.
    expect(late - early).toBeGreaterThan(20);
  });
});

describe("the drawn cursor through a gap in a capture take", () => {
  const target = LANDSCAPE_1080P;
  const scene = readonlyScene();
  /** The same shape as the pause above, except the pointer LEFT: its
   *  position through the hole was not observed, it was unknown. */
  const samples = [
    { sourceTimeMs: 0, x: 120, y: 300 },
    { sourceTimeMs: 16, x: 130, y: 305 },
    { sourceTimeMs: 32, x: 140, y: 310 },
    { sourceTimeMs: 2032, x: 1100, y: 700 },
    { sourceTimeMs: 2048, x: 1110, y: 705 },
  ];
  const lost = proceduralBundle({
    source: "capture",
    cursorSamples: samples,
    cursorGaps: [{ startMs: 32, endMs: 2032 }],
  });
  const resolved = resolvePlan(planScene(scene), lost, scene);

  const inkCentroid = (plan: ResolvedPlan, outputTimeMs: number) =>
    cursorInkCentroid({ plan, bundle: lost, scene, target, outputTimeMs });

  /** Two instants inside the hole, the second close enough to its end that
   *  the spring's lead had already set the drawn cursor moving toward the
   *  position the pointer reappeared at. */
  const early = toOutputMs(resolved.timeline, 600);
  const late = toOutputMs(resolved.timeline, 1980);

  it("paints the arrow in the same place at both ends of the gap", async () => {
    const first = await inkCentroid(resolved, early);
    const second = await inkCentroid(resolved, late);
    expect(first.n).toBeGreaterThan(100);
    expect(second.n).toBeGreaterThan(100);
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeLessThan(2);
  });

  it("is composing a hole something really would be drawn across", async () => {
    // Fixture guard: the same samples with nothing recorded about the
    // pointer having left are a journey, and the arrow crosses the frame.
    const journey = proceduralBundle({
      source: "capture",
      cursorSamples: samples,
      cursorGaps: [],
    });
    const plan = resolvePlan(planScene(scene), journey, scene);
    const first = await cursorInkCentroid({
      plan,
      bundle: journey,
      scene,
      target,
      outputTimeMs: toOutputMs(plan.timeline, 600),
    });
    const second = await cursorInkCentroid({
      plan,
      bundle: journey,
      scene,
      target,
      outputTimeMs: toOutputMs(plan.timeline, 1980),
    });
    expect(first.n).toBeGreaterThan(100);
    expect(second.n).toBeGreaterThan(100);
    // Derived, not a tuned constant. This guard measures a journey in OUTPUT
    // pixels, and output pixels per CSS pixel move with the branding's padding —
    // the drawn content narrows as the inset grows, so the very same journey
    // covers fewer of them. The threshold was a bare 200, calibrated at the
    // 0.05 landscape inset; raising it to 0.15 on 2026-09-21 shrank the
    // travel to 168.9px and turned this red with the cursor behaving exactly
    // as before. 144 CSS px is that 200 divided by the scale it was written
    // at, so the claim is now about the pointer rather than about the frame
    // it happens to be drawn in.
    const { frameRect } = derivePresentation(
      scene.branding,
      target,
      scene.meta.capture.viewport,
    );
    const outputPxPerCssPx = contentScale(
      frameRect,
      scene.meta.capture.viewport,
    );
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThan(
      144 * outputPxPerCssPx,
    );
  });

  it("separates the two instants, so the two frames are not the same frame", () => {
    expect(late - early).toBeGreaterThan(20);
  });
});

/**
 * A pointer that leaves the page through its edge is drawn leaving it — cut
 * off by the window's edge as it goes, and gone while it is out — rather
 * than parked just inside the edge for the whole time it was away. Asserted
 * on the picture, because "off the page" in the sample array is only a
 * coordinate until the frame clip has had its say.
 */
describe("the drawn cursor leaving through the page's edge", () => {
  const target = LANDSCAPE_1080P;
  const scene = readonlyScene();
  /** Moving left at 1px/ms, out through the left-hand edge at 1000ms, and
   *  not seen again for two seconds. Left, not right, because the arrow
   *  hangs right of and below its hotspot: leaving to the left is the exit
   *  where part of it is still in frame after the hotspot has gone. */
  const samples: { sourceTimeMs: number; x: number; y: number }[] = [];
  for (let t = 0; t <= 1000; t += 16) {
    samples.push({ sourceTimeMs: t, x: 1016 - t, y: 400 });
  }
  samples.push({ sourceTimeMs: 3000, x: 640, y: 400 });
  const gaps = [{ startMs: 1000, endMs: 3000 }];
  const left = proceduralBundle({
    source: "capture",
    cursorSamples: samples,
    cursorGaps: gaps,
    markers: [],
  });
  const resolved = resolvePlan(planScene(scene), left, scene);
  const { frameRect } = derivePresentation(
    scene.branding,
    target,
    scene.meta.capture.viewport,
  );

  /** The first source instant at which the drawn hotspot is past the edge. */
  const hotspotGoneMs = (() => {
    for (let ms = 1000; ms < 2000; ms++) {
      if ((sampleCursor(resolved.cursor, ms)?.x ?? 0) < -4) return ms;
    }
    return -1;
  })();

  it("is drawing a hotspot that really does cross the edge", () => {
    // Fixture guard for the partial frame below: without this the search
    // returns -1 and the frame it composes is from before the take began.
    expect(hotspotGoneMs).toBeGreaterThan(1000);
    expect(hotspotGoneMs).toBeLessThan(1100);
  });

  it("cuts the arrow off at the window's edge on its way out", async () => {
    const ink = await cursorInkCentroid({
      plan: resolved,
      bundle: left,
      scene,
      target,
      outputTimeMs: toOutputMs(resolved.timeline, hotspotGoneMs),
    });
    // Some of the arrow is still in frame, all of it right of the edge.
    expect(ink.n).toBeGreaterThan(20);
    expect(ink.x).toBeGreaterThan(frameRect.x);
  });

  it("draws no cursor at all while the pointer is off the page", async () => {
    const ink = await cursorInkCentroid({
      plan: resolved,
      bundle: left,
      scene,
      target,
      outputTimeMs: toOutputMs(resolved.timeline, 2000),
    });
    expect(ink.n).toBe(0);
  });

  it("is composing an instant the old hold drew an arrow at", async () => {
    // Fixture guard for the case above: the same take resolved without the
    // off-page reading — the hold at the last sighting, as it was — paints
    // the arrow at the edge at that same instant, so a blank frame there is
    // the glide's doing and not a frame that never had a cursor in it.
    const held = {
      ...resolved,
      cursor: holdAcrossGaps(resolved.cursor, gaps),
    };
    const ink = await cursorInkCentroid({
      plan: held,
      bundle: left,
      scene,
      target,
      outputTimeMs: toOutputMs(resolved.timeline, 2000),
    });
    expect(ink.n).toBeGreaterThan(100);
  });
});

/**
 * The drawn cursor through a hesitation, asserted on decoded pixels.
 *
 * A hand crossing the screen does not do it at a steady rate: it sets off,
 * stalls partway, then finishes. Filtering the positions leaves that intact,
 * because it is a faithful record rather than noise — and a viewer reads a
 * stalled cursor over a still page as the recording stuttering.
 * `retimeAlongRoute` walks the same recorded route at an eased, even pace.
 *
 * The stall is 300ms deliberately. An earlier version used 80ms and passed
 * with re-timing disabled: a stall shorter than the smoothing kernel's own
 * 90ms reach is carried by the filter alone, so the test proved nothing
 * about re-timing. Measured across the stall in CSS px — recorded 1.6,
 * smoothed 21.2, re-timed 72.7 at 80ms; 6.0 / 25.6 / 189.9 at 300ms. Both
 * guards below hold the two lower mechanisms down so the assertion can only
 * pass on the third.
 */
describe("the drawn cursor through a hesitation in a capture take", () => {
  const target = LANDSCAPE_1080P;
  const scene = readonlyScene();
  const STALL_FROM = 1060;
  const STALL_MS = 300;
  const STALL_TO = STALL_FROM + STALL_MS;
  const stalling = (() => {
    const samples = [{ sourceTimeMs: 0, x: 120, y: 200 }];
    let x = 120;
    for (let t = 1000; t <= 1300 + STALL_MS; t += 10) {
      const moving = t < STALL_FROM || t > STALL_TO;
      x += moving ? 10 : 0.2;
      samples.push({ sourceTimeMs: t, x, y: 200 });
    }
    samples.push({ sourceTimeMs: 3000 + STALL_MS, x, y: 200 });
    return proceduralBundle({ source: "capture", cursorSamples: samples });
  })();
  const resolved = resolvePlan(planScene(scene), stalling, scene);

  const travelledPx = async (plan: ResolvedPlan): Promise<number> => {
    const at = (sourceMs: number) =>
      cursorInkCentroid({
        plan,
        bundle: stalling,
        scene,
        target,
        outputTimeMs: toOutputMs(resolved.timeline, sourceMs),
      });
    const before = await at(STALL_FROM);
    const after = await at(STALL_TO);
    expect(before.n).toBeGreaterThan(100);
    expect(after.n).toBeGreaterThan(100);
    return after.x - before.x;
  };

  it("keeps the arrow moving while the hand is stalled", async () => {
    expect(await travelledPx(resolved)).toBeGreaterThan(120);
  });

  it("is composing a stall the recorded hand really does make", async () => {
    // Guard one: the recorded samples barely move across those 300ms.
    expect(
      await travelledPx({ ...resolved, cursor: stalling.cursorSamples }),
    ).toBeLessThan(20);
  });

  it("is measuring something the smoothing kernel cannot do on its own", async () => {
    // Guard two, and the one that matters: the smoothed-but-not-re-timed
    // path is what this feature is being compared against. Without it an
    // 80ms stall passed the assertion above on the filter alone.
    const smoothed = smoothCursor(
      holdThroughRests(stalling.cursorSamples, CURSOR_REST_MS),
      CURSOR_SMOOTHING_MS,
      [],
    );
    expect(await travelledPx({ ...resolved, cursor: smoothed })).toBeLessThan(
      60,
    );
  });
});

/**
 * How big the arrow actually lands, in output pixels.
 *
 * A demo cursor is not a system cursor. The frame is a 1280x800 page scaled
 * up to fill 1080p, so a life-size pointer would arrive at roughly 32px —
 * and a pointer at exactly life size is the one thing in a demo nobody can
 * find. It is the viewer's eye-line through the whole video and it is
 * competing with the app's own UI, so it is drawn deliberately larger.
 */
describe("the drawn cursor's size", () => {
  const target = LANDSCAPE_1080P;
  const scene = readonlyScene();
  const bundle = proceduralBundle();
  const resolved = resolvePlan(planScene(scene), bundle, scene);

  it("draws an arrow big enough to follow", async () => {
    const presentation = derivePresentation(scene.branding, target, VIEWPORT);
    const render = async (cursor: ResolvedPlan["cursor"]) => {
      const canvas = new OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      await renderFrame({
        resolved: { ...resolved, cursor, clickOutputMs: [] },
        target,
        presentation,
        frames: createProceduralFrameSource(bundle),
        ctx,
        outputTimeMs: 0,
      });
      return ctx.getImageData(0, 0, target.width, target.height).data;
    };
    const a = await render(resolved.cursor);
    const b = await render([]);

    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < a.length; i += 4) {
      if (
        Math.abs((a[i] as number) - (b[i] as number)) > 10 ||
        Math.abs((a[i + 1] as number) - (b[i + 1] as number)) > 10 ||
        Math.abs((a[i + 2] as number) - (b[i + 2] as number)) > 10
      ) {
        const py = Math.floor(i / 4 / target.width);
        top = Math.min(top, py);
        bottom = Math.max(bottom, py);
      }
    }
    expect(bottom).toBeGreaterThan(top);
    expect(bottom - top).toBeGreaterThan(30);
  });
});

/**
 * The authored cursor look, on decoded pixels.
 *
 * Each case differences a rendered frame against the same frame rendered
 * with no cursor samples and no clicks, which isolates everything the
 * cursor block draws: the pointer, its trail, the click ring and the press.
 * Counting ink rather than probing a coordinate keeps these honest against
 * a camera that moves the pointer around the frame.
 */
describe("the authored cursor look", () => {
  const target = LANDSCAPE_1080P;
  const base = readonlyScene();

  /** Moves, sits perfectly still for two seconds, then crosses the page. */
  const dwelling = proceduralBundle({
    source: "capture",
    cursorSamples: [
      { sourceTimeMs: 0, x: 120, y: 300 },
      { sourceTimeMs: 16, x: 200, y: 340 },
      { sourceTimeMs: 32, x: 280, y: 380 },
      { sourceTimeMs: 2032, x: 280, y: 380 },
      { sourceTimeMs: 2048, x: 1100, y: 700 },
    ],
  });

  const sceneWith = (cursor: Partial<SceneCursor>): SceneDocument => ({
    ...base,
    cursor: { ...CURSOR_DEFAULTS, ...cursor },
  });

  const presentation = derivePresentation(base.branding, target, VIEWPORT);

  async function paint(
    scene: SceneDocument,
    outputTimeMs: number,
    bare = false,
  ): Promise<Uint8ClampedArray> {
    const plan = resolvePlan(planScene(scene), dwelling, scene);
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    await renderFrame({
      // `bare` is the baseline: the same frame with nothing the cursor block
      // would draw. Differencing against it counts exactly that block's ink.
      resolved: bare ? { ...plan, cursor: [], clickOutputMs: [] } : plan,
      target,
      presentation,
      frames: createProceduralFrameSource(dwelling),
      ctx,
      outputTimeMs,
    });
    return ctx.getImageData(0, 0, target.width, target.height).data;
  }

  const differing = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs((a[i] as number) - (b[i] as number)) > 8) n++;
    }
    return n;
  };

  /** How much ink the cursor block puts on the frame at an instant. */
  async function cursorInk(
    cursor: Partial<SceneCursor>,
    outputTimeMs: number,
  ): Promise<number> {
    const scene = sceneWith(cursor);
    const [drawn, bare] = await Promise.all([
      paint(scene, outputTimeMs, false),
      paint(scene, outputTimeMs, true),
    ]);
    return differing(drawn, bare);
  }

  // Composites are ~38ms each here and a GitHub runner is ~5x slower, so
  // these carry the same explicit budget the pulse tests do.
  const RENDER_BOUND_MS = 120_000;

  const resolvedBase = resolvePlan(planScene(base), dwelling, base);
  const timeline = resolvedBase.timeline;
  /** Mid-gesture, while the pointer is genuinely travelling. */
  const movingMs = toOutputMs(timeline, 24);
  /** Deep inside the two-second dwell. */
  const dwellMs = toOutputMs(timeline, 1600);
  /** Just after it starts moving again. */
  const resumedMs = toOutputMs(timeline, 2044);

  // Derived, not hardcoded: if the fixture ever stops carrying a click, this
  // throws instead of silently composing somewhere the ring was never drawn.
  const clickMs = resolvedBase.clickOutputMs[0];
  if (clickMs === undefined) {
    throw new Error(
      "the fixture carries no click; the pulse assertions would be vacuous",
    );
  }

  it(
    "draws no cursor, no pulse and no press when hidden",
    async () => {
      const inkAtClick = await cursorInk({ motionBlur: 0 }, clickMs);
      const inkAfterPulse = await cursorInk(
        { motionBlur: 0 },
        clickMs + PULSE_DURATION_MS + 50,
      );
      // Fixture guard: the ring genuinely paints at the click instant.
      // Without this, "hidden draws nothing" would be satisfiable by an
      // instant where nothing was drawn in the first place.
      //
      // Two things differ between these instants, not one. The pointer is
      // parked on its last recorded sample long before this take's click at
      // source 9000ms, so it contributes the same ink at both — but the
      // press shrink is full on at the click (`cursorPressScale` is
      // `1 − PRESS_DEPTH` there) and its spring has died to under a
      // thousandth by the second instant (450ms on, the end of `RELEASE_MS`),
      // which means the click instant draws
      // the arrow SMALLER. The press therefore works against this inequality:
      // whatever margin is measured here, the ring's own contribution is
      // larger than it by the ink the shrink took away.
      expect(inkAtClick).toBeGreaterThan(inkAfterPulse + 100);
      // Hidden has to take the pointer, the ring AND the press, all at once.
      expect(await cursorInk({ hidden: true }, clickMs)).toBe(0);
    },
    RENDER_BOUND_MS,
  );

  it(
    "draws the style the scene authored",
    async () => {
      const bare = await paint(sceneWith({ motionBlur: 0 }), movingMs, true);
      const light = await paint(
        sceneWith({ motionBlur: 0, style: "light" }),
        movingMs,
      );
      const dark = await paint(
        sceneWith({ motionBlur: 0, style: "dark" }),
        movingMs,
      );
      const touch = await paint(
        sceneWith({ motionBlur: 0, style: "touch" }),
        movingMs,
      );
      // Positive controls: each style drew something at all. Without these
      // the difference assertions below are satisfiable by three blank
      // frames.
      expect(differing(light, bare)).toBeGreaterThan(100);
      expect(differing(dark, bare)).toBeGreaterThan(100);
      expect(differing(touch, bare)).toBeGreaterThan(100);
      // ...and they are three different pictures. Hardcoding "light" at the
      // pointer's call site turns this red. `motionBlur: 0` here never
      // reaches the trail's own call site — that is covered separately
      // below, where the trail's ink is isolated from the pointer's.
      expect(differing(light, dark)).toBeGreaterThan(100);
      expect(differing(light, touch)).toBeGreaterThan(100);
    },
    RENDER_BOUND_MS,
  );

  it(
    "draws the trail in the authored style too, not just the pointer",
    async () => {
      const crispLight = await paint(
        sceneWith({ motionBlur: 0, style: "light" }),
        movingMs,
      );
      const crispTouch = await paint(
        sceneWith({ motionBlur: 0, style: "touch" }),
        movingMs,
      );
      const blurLight = await paint(
        sceneWith({ motionBlur: 1, style: "light" }),
        movingMs,
      );
      const blurTouch = await paint(
        sceneWith({ motionBlur: 1, style: "touch" }),
        movingMs,
      );
      // How much the two styles differ with no trail: the pointers alone.
      const pointersDiffer = differing(crispTouch, crispLight);
      // ...and with trails. When the trail carries the style, this adds ten
      // circle-vs-arrow ghosts on top of that same pointer difference.
      const trailsDiffer = differing(blurTouch, blurLight);
      // Positive control: the two styles are distinguishable at all.
      expect(pointersDiffer).toBeGreaterThan(100);
      // Hardcode the style at drawCursorTrail's call site and both renders
      // get the SAME light ghosts at the same positions and alphas, so the
      // ghosts cancel in the difference and this collapses to roughly
      // `pointersDiffer`. That cancellation is exact, not approximate,
      // which is why this compares against a measured baseline rather than
      // a tuned constant.
      expect(trailsDiffer).toBeGreaterThan(pointersDiffer * 2);
    },
    RENDER_BOUND_MS,
  );

  it(
    "fades the cursor out through a dwell and brings it back on the next move",
    async () => {
      const look = { motionBlur: 0, hideWhenIdle: true };
      // Three instants on one timeline. Any one alone would pass against a
      // cursor that is simply never drawn.
      const entering = await cursorInk(look, toOutputMs(timeline, 40));
      const settled = await cursorInk(look, dwellMs);
      const resumed = await cursorInk(look, resumedMs);
      expect(entering).toBeGreaterThan(100);
      expect(settled).toBe(0);
      expect(resumed).toBeGreaterThan(100);
    },
    RENDER_BOUND_MS,
  );

  it(
    "leaves the cursor up through that same dwell when the toggle is off",
    async () => {
      // The control for the case above: the fade is the setting's doing and
      // not something else emptying the frame at that instant.
      expect(await cursorInk({ motionBlur: 0 }, dwellMs)).toBeGreaterThan(100);
    },
    RENDER_BOUND_MS,
  );

  it(
    "draws more ink at a bigger scale",
    async () => {
      const small = await cursorInk({ motionBlur: 0, scale: 1 }, movingMs);
      const big = await cursorInk({ motionBlur: 0, scale: 2 }, movingMs);
      expect(big).toBeGreaterThan(small * 2);
    },
    RENDER_BOUND_MS,
  );

  it(
    "smears a moving cursor at full blur and leaves it crisp at zero",
    async () => {
      const crisp = await cursorInk({ motionBlur: 0 }, movingMs);
      const blurred = await cursorInk({ motionBlur: 1 }, movingMs);
      expect(blurred).toBeGreaterThan(crisp);
    },
    RENDER_BOUND_MS,
  );

  it(
    "adds no smear to a cursor that is standing still",
    async () => {
      // The trail's travel floor. Without it, full blur stamps ten copies on
      // top of each other through every dwell in every take.
      const crisp = await cursorInk({ motionBlur: 0 }, dwellMs);
      const blurred = await cursorInk({ motionBlur: 1 }, dwellMs);
      expect(blurred).toBe(crisp);
    },
    RENDER_BOUND_MS,
  );

  it(
    "presses with the authored bounce, and springs past full size after",
    async () => {
      // At the click: the deeper the bounce, the smaller the arrow. The ring
      // is the same in both, so the difference is the press alone.
      const flatAtClick = await cursorInk(
        { motionBlur: 0, clickBounce: 0 },
        clickMs,
      );
      const deepAtClick = await cursorInk(
        { motionBlur: 0, clickBounce: 2 },
        clickMs,
      );
      expect(flatAtClick - deepAtClick).toBeGreaterThan(40);
      // 160ms on, the spring's crest: the bouncing arrow is now LARGER than
      // the one that never pressed. A release that eased back to 1 without
      // overshooting would leave it smaller or equal here.
      const flatAfter = await cursorInk(
        { motionBlur: 0, clickBounce: 0 },
        clickMs + 160,
      );
      const deepAfter = await cursorInk(
        { motionBlur: 0, clickBounce: 2 },
        clickMs + 160,
      );
      // Measured 2026-10-09: 1670 against 1636 — the crest is 1.038x at
      // bounce 2, on an arrow whose ink is a few hundred pixels.
      expect(
        deepAfter,
        `flat ${flatAfter}, bounced ${deepAfter}`,
      ).toBeGreaterThan(flatAfter + 10);
    },
    RENDER_BOUND_MS,
  );
});

/**
 * The lean, on the picture: a pointer moving steadily right leans clockwise,
 * which swings its tail to the LEFT of where an upright arrow's sits (see
 * `draw-cursor.test.ts`'s "leans about its tip" for the derivation on the
 * bare shape). This one proves `renderFrame` hands the lean through.
 */
describe("the pointer's lean in a composed frame", () => {
  const target = LANDSCAPE_1080P;
  const base = readonlyScene();
  /** Still, then 700 CSS px to the right in 600ms, then still again. */
  const sweeping = proceduralBundle({
    source: "capture",
    cursorSamples: [
      { sourceTimeMs: 0, x: 200, y: 400 },
      { sourceTimeMs: 1000, x: 200, y: 400 },
      { sourceTimeMs: 1600, x: 900, y: 400 },
      { sourceTimeMs: 4000, x: 900, y: 400 },
    ],
  });
  const presentation = derivePresentation(base.branding, target, VIEWPORT);
  const sceneWith = (cursor: Partial<SceneCursor>): SceneDocument => ({
    ...base,
    cursor: { ...CURSOR_DEFAULTS, motionBlur: 0, ...cursor },
  });

  async function paint(
    scene: SceneDocument,
    outputTimeMs: number,
    bare: boolean,
  ) {
    const plan = resolvePlan(planScene(scene), sweeping, scene);
    const canvas = new OffscreenCanvas(target.width, target.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    await renderFrame({
      resolved: bare ? { ...plan, cursor: [], clickOutputMs: [] } : plan,
      target,
      presentation,
      frames: createProceduralFrameSource(sweeping),
      ctx,
      outputTimeMs,
    });
    return ctx.getImageData(0, 0, target.width, target.height).data;
  }

  /** The centroid of what the cursor block painted, in output pixels. */
  async function inkCentroid(tilt: number, outputTimeMs: number) {
    const scene = sceneWith({ tilt });
    const drawn = await paint(scene, outputTimeMs, false);
    const bare = await paint(scene, outputTimeMs, true);
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < drawn.length; i += 4) {
      const d =
        Math.abs((drawn[i] as number) - (bare[i] as number)) +
        Math.abs((drawn[i + 1] as number) - (bare[i + 1] as number)) +
        Math.abs((drawn[i + 2] as number) - (bare[i + 2] as number));
      if (d > 24) {
        const p = i / 4;
        n++;
        sx += p % target.width;
        sy += Math.floor(p / target.width);
      }
    }
    return { n, x: sx / n, y: sy / n };
  }

  const resolvedBase = resolvePlan(
    planScene(sceneWith({})),
    sweeping,
    sceneWith({}),
  );
  // Not the middle of the recorded sweep: the resolved path leaves its rest
  // late and fast (the cursor timing's eased departure), and is moving
  // across this instant's whole lean window only from about here.
  const movingMs = toOutputMs(resolvedBase.timeline, 1650);

  // Four 1080p composites, ~40ms each here; a runner is ~5x slower.
  const RENDER_BOUND_MS = 120_000;

  it(
    "leans the arrow's tail left while it moves right",
    async () => {
      // The premise: across this instant's lean window the pointer has
      // moved a long way right and not at all vertically.
      const here = sampleCursor(
        resolvedBase.cursor,
        toSourceMs(resolvedBase.timeline, movingMs),
      );
      const before = sampleCursor(
        resolvedBase.cursor,
        toSourceMs(resolvedBase.timeline, movingMs - TILT_SETTLE_MS),
      );
      expect((here?.x ?? 0) - (before?.x ?? 0)).toBeGreaterThan(100);
      expect(here?.y).toBe(before?.y);

      const upright = await inkCentroid(0, movingMs);
      const leaning = await inkCentroid(1, movingMs);
      expect(upright.n).toBeGreaterThan(200);
      // A 40px arrow leaning near the full 15°: its centroid, ~8px right and
      // ~20px below the tip, swings ~5px left. Same frame otherwise, same tip.
      expect(
        leaning.x - upright.x,
        `upright ${JSON.stringify(upright)}, leaning ${JSON.stringify(leaning)}`,
      ).toBeLessThan(-2);
    },
    RENDER_BOUND_MS,
  );
});
