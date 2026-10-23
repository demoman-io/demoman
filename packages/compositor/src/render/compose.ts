import { CURSOR_POLISH_DEFAULTS } from "@demoman/scene-schema";
import type { Rect, Vec } from "../geometry.js";
import { frameCamera } from "../plan/camera.js";
import { sampleTrack } from "../plan/camera-follow.js";
import type { ResolvedPlan } from "../plan/resolve.js";
import { cursorIdleAlpha, sampleCursor } from "../plan/resolve.js";
import { toSourceMs } from "../plan/timeline.js";
import type { FrameSource } from "../ports/types.js";
import { cameraBlurTransforms, paintCameraBlur } from "./camera-blur.js";
import { cursorPressScale, cursorTiltRad } from "./cursor-pose.js";
import { drawCosmetics } from "./draw-cosmetics.js";
import {
  CURSOR_EXPOSURE_MS,
  CURSOR_TRAIL_MIN_TRAVEL_PX,
  cursorTrailStamps,
  drawClickPulse,
  drawCursor,
  drawCursorTrail,
  PRESS_DURATION_MS,
  PULSE_DURATION_MS,
} from "./draw-cursor.js";
import {
  clipToFrame,
  contentScale,
  drawBackground,
  drawFrameChrome,
  drawLogo,
  type Presentation,
} from "./presentation.js";
import type { RenderTarget } from "./target.js";

interface Camera {
  center: Vec;
  scale: number;
}

/**
 * CSS viewport coordinates → output pixels.
 *
 * `camera.center` is the CSS point drawn at the output's centre, after
 * `frameCamera` has placed both the app's pan inside its window and the
 * zoom over the whole composition. Both moves are linear, so composing them
 * leaves exactly this one mapping for anything drawn over the page.
 *
 * No `fit`: a `cover` frame does not share the capture's aspect, and
 * `contentScale` takes the larger factor, which covers it as it fits a
 * `contain` one.
 */
export function cssToOutput(
  point: Vec,
  camera: Camera,
  frameRect: Rect,
  viewport: { width: number; height: number },
): Vec {
  const k = contentScale(frameRect, viewport) * camera.scale;
  return {
    x: frameRect.x + frameRect.width / 2 + (point.x - camera.center.x) * k,
    y: frameRect.y + frameRect.height / 2 + (point.y - camera.center.y) * k,
  };
}

export function cssRectToOutput(
  rect: Rect,
  camera: Camera,
  frameRect: Rect,
  viewport: { width: number; height: number },
): Rect {
  const origin = cssToOutput(
    { x: rect.x, y: rect.y },
    camera,
    frameRect,
    viewport,
  );
  const k = contentScale(frameRect, viewport) * camera.scale;
  return {
    x: origin.x,
    y: origin.y,
    width: rect.width * k,
    height: rect.height * k,
  };
}

/**
 * Where the pointer was across one frame's exposure, oldest first, in CSS
 * viewport coordinates. Empty is the ordinary answer: a blur of zero and a
 * frame earlier than the take's first sample both produce it.
 *
 * Each stamp's OUTPUT instant is mapped back through the timeline before the
 * position is sampled — see CURSOR_EXPOSURE_MS for why the window is on that
 * axis rather than the source one.
 *
 * A stamp earlier than the take's first sample is dropped HERE, against
 * `first.sourceTimeMs`, and not by reading a refusal out of `sampleCursor`:
 * that function CLAMPS an out-of-range time onto the end sample rather than
 * declining it, and returns null only for an empty list. Left to it, every
 * too-early stamp resolved to the same point, and `drawCursorTrail` stacked
 * ten ghosts there — their alphas compounding into a blob at the pointer's
 * first recorded position, for the ~32ms after the take's time crossed it.
 * Dropping them shortens the trail into that position instead, which is what
 * the ghosts mean: the pointer has no history before its first sample.
 *
 * Exported and pure so the node lane can assert on the geometry it returns;
 * the pixels it becomes are the browser lane's `compose.test.ts`.
 */
export function cursorTrailPoints(
  resolved: Pick<ResolvedPlan, "cursor" | "timeline">,
  outputTimeMs: number,
  motionBlur: number,
): TrailStamp[] {
  const stamps = cursorTrailStamps(motionBlur);
  const first = resolved.cursor[0];
  if (stamps === 0 || !first) return [];
  const exposureMs = CURSOR_EXPOSURE_MS * motionBlur;
  const points: TrailStamp[] = [];
  for (let i = stamps; i >= 1; i--) {
    const ghostOutputMs = outputTimeMs - (exposureMs * i) / stamps;
    if (ghostOutputMs < 0) continue;
    const ghostSourceMs = toSourceMs(resolved.timeline, ghostOutputMs);
    if (ghostSourceMs < first.sourceTimeMs) continue;
    const at = sampleCursor(resolved.cursor, ghostSourceMs);
    // Type narrowing, not a failure path: `first` above is the only thing
    // that makes this null, and it is already in hand. Nothing is swallowed
    // here, so nothing is owed a reason.
    if (!at) continue;
    points.push({ x: at.x, y: at.y, outputMs: ghostOutputMs });
  }
  return points;
}

/** One trail stamp: where the pointer was, in CSS px, and the output
 *  instant it was there. */
export interface TrailStamp extends Vec {
  outputMs: number;
}

/**
 * The trail's ghosts, each leaning the way the pointer leaned at its own
 * instant (`cursorTiltRad`). A ghost is the pointer some milliseconds ago,
 * so the frame's own lean on it draws, at a turn, a lean the pointer never
 * had there. `tilt` is the look's, 0 for a style that does not lean.
 */
export function cursorTrailGhosts(
  resolved: Pick<ResolvedPlan, "cursor" | "timeline"> & {
    plan: Pick<ResolvedPlan["plan"], "viewport">;
  },
  outputTimeMs: number,
  motionBlur: number,
  tilt: number,
): (Vec & { angleRad: number })[] {
  return cursorTrailPoints(resolved, outputTimeMs, motionBlur).map((s) => ({
    x: s.x,
    y: s.y,
    angleRad: cursorTiltRad(resolved, s.outputMs, tilt),
  }));
}

/**
 * One output frame, composed from scratch. Frame-accurate and offline: every
 * value derives from `outputTimeMs`, never from wall clock, which is the
 * difference SP1 measured between a smooth deliverable and a janky one.
 */
export async function renderFrame(args: {
  resolved: ResolvedPlan;
  target: RenderTarget;
  presentation: Presentation;
  frames: FrameSource;
  ctx: OffscreenCanvasRenderingContext2D;
  outputTimeMs: number;
  /**
   * Where the per-frame time went, stage by stage. Optional and off by
   * default: the editor turns it on to answer "why is preview playback
   * dropping frames", and nothing else passes it.
   *
   * Measured with `performance.now()` around each stage's draw calls, so it
   * is the time this thread spends submitting work — not GPU time. That is
   * the right measure here, because the thread it is spent on is the one
   * that has to come back for the next frame.
   */
  onStage?: (stage: string, ms: number) => void;
}): Promise<void> {
  const { resolved, target, presentation, frames, ctx, outputTimeMs } = args;
  // Zero overhead when nobody is asking: no timestamps are read at all.
  const stage = args.onStage
    ? (name: string, run: () => void): void => {
        const startedAt = performance.now();
        run();
        args.onStage?.(name, performance.now() - startedAt);
      }
    : (_name: string, run: () => void): void => run();
  const viewport = resolved.plan.viewport;
  const { frameRect } = presentation;

  const sourceMs = toSourceMs(resolved.timeline, outputTimeMs);
  const base = contentScale(frameRect, viewport);
  // Clamp once, here, so the *same* camera value drives the scene, the image
  // draw, the cosmetic rects and the cursor. Clamping inside any one of them
  // would put the overlays somewhere the pixels underneath them are not.
  const camera = frameCamera(
    sampleTrack(resolved, outputTimeMs),
    base,
    frameRect,
    viewport,
    target,
  );
  const fetchStartedAt = args.onStage ? performance.now() : 0;
  const frame = await frames.at(sourceMs);
  args.onStage?.("fetch", performance.now() - fetchStartedAt);

  // The scene transform: the unzoomed composition — background, window,
  // logo — scaled about `camera.focus`, which lands on the window's centre
  // (the output's own). The page and everything over it is drawn below in
  // output pixels through `cssToOutput`, which agrees with this by
  // construction; see `frameCamera`.
  const toScene = (): void => {
    ctx.translate(
      frameRect.x + frameRect.width / 2,
      frameRect.y + frameRect.height / 2,
    );
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-camera.focus.x, -camera.focus.y);
  };

  ctx.save();
  toScene();
  stage("background", () => drawBackground(ctx, target, presentation));
  stage("chrome", () => drawFrameChrome(ctx, presentation, camera.scale));
  ctx.restore();

  ctx.save();
  // The clip is fixed in device pixels when it is made, so it is cut through
  // the scene transform and survives the reset that follows.
  toScene();
  clipToFrame(ctx, presentation);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Draw the whole frame image through the camera transform. The source may
  // be a DPR-3 keyframe or a surface-capped motion frame; scaling from the
  // frame's own pixel dimensions makes the upscale automatic and invisible.
  const topLeft = cssToOutput({ x: 0, y: 0 }, camera, frameRect, viewport);
  const k = base * camera.scale;
  stage("frame", () => {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      frame.image,
      topLeft.x,
      topLeft.y,
      viewport.width * k,
      viewport.height * k,
    );
  });

  stage("cosmetics", () =>
    drawCosmetics(
      ctx,
      // A ranged cosmetic paints inside its range only: `[startMs, endMs)`
      // on the untrimmed output axis, the same clock `outputTimeMs` is on.
      resolved.cosmetics.filter(
        (c) =>
          c.range === null ||
          (outputTimeMs >= c.range.startMs && outputTimeMs < c.range.endMs),
      ),
      (rect) => cssRectToOutput(rect, camera, frameRect, viewport),
    ),
  );

  ctx.restore();

  // The logo is painted on the background margin, so it rides the zoom with
  // it — and usually leaves the shot while the camera is in.
  //
  // Z-order changed on 2026-10-09: the logo used to be the last thing
  // painted, over the cursor. It is now painted BEFORE the camera blur and
  // the cursor, so it smears with the rest of the composition it belongs
  // to, and a pointer crossing it is drawn over it rather than under it.
  ctx.save();
  toScene();
  stage("logo", () => drawLogo(ctx, target, presentation));
  ctx.restore();

  // Camera motion blur: everything painted so far, smeared back along the
  // camera's path across this frame's exposure. No clip is active here, by
  // construction of the blocks above. A still camera gets no passes and
  // paints byte-identically to blur 0; see `cameraBlurTransforms`.
  stage("blur", () =>
    paintCameraBlur(
      ctx,
      cameraBlurTransforms({
        camera: resolved,
        outputTimeMs,
        blur: resolved.motion.blur,
        current: camera,
        base,
        frameRect,
        viewport,
        canvas: target,
      }),
    ),
  );

  // The cursor, after the blur, so it stays crisp — it has its own smear,
  // the trail, which follows the pointer's path rather than the camera's.
  // Inside the frame clip as before: the same cut, made the same way.
  ctx.save();
  toScene();
  clipToFrame(ctx, presentation);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const cursorStartedAt = args.onStage ? performance.now() : 0;
  const look = resolved.cursorLook;
  // A touch take has no pointer between taps (spec 2026-10-10 §5): its
  // fingertips are drawn below, and only at the taps.
  const cursorCss =
    look.hidden || resolved.touch
      ? null
      : sampleCursor(resolved.cursor, sourceMs);
  if (cursorCss) {
    const at = cssToOutput(cursorCss, camera, frameRect, viewport);
    // Cursor and pulse are part of the scene the camera zooms: they scale
    // with output resolution and with the camera, so the pointer grows with
    // the page under it. The author's own multiplier
    // folds in here too, so `drawCursor` knows nothing about any of them.
    const uiScale = (target.height / 1080) * look.scale * camera.scale;

    // The idle fade covers trail, pulse and pointer together, so they dim
    // as one object rather than crossing each other's translucency.
    const priorAlpha = ctx.globalAlpha;
    ctx.globalAlpha = look.hideWhenIdle
      ? cursorIdleAlpha(resolved.cursorRestOutputMs, outputTimeMs)
      : 1;

    // The lean, read off the recorded path at this instant; an absent
    // `tilt` is the default lean, never none (see CURSOR_POLISH_DEFAULTS).
    const tilt =
      look.style === "touch" ? 0 : (look.tilt ?? CURSOR_POLISH_DEFAULTS.tilt);
    const angleRad = cursorTiltRad(resolved, outputTimeMs, tilt);

    // The trail: where the pointer was across this frame's exposure, in
    // output pixels, each ghost at the lean it had then. `cursorTrailPoints`
    // owns which instants are sampled at all; this maps them through the
    // same camera as the pointer itself, so the ghosts ride the zoom with
    // the shape they trail.
    const trail = cursorTrailGhosts(
      resolved,
      outputTimeMs,
      look.motionBlur,
      tilt,
    ).map((g) => ({
      ...cssToOutput(g, camera, frameRect, viewport),
      angleRad: g.angleRad,
    }));
    const oldest = trail[0];
    // At rest, nothing. A still pointer gets no halo, and this is the
    // ordinary case for most of a take.
    if (
      oldest &&
      Math.hypot(at.x - oldest.x, at.y - oldest.y) >= CURSOR_TRAIL_MIN_TRAVEL_PX
    ) {
      drawCursorTrail(ctx, trail, uiScale, look.style);
    }

    // Windowed in OUTPUT time, deliberately. PULSE_DURATION_MS and
    // PRESS_DURATION_MS are viewer-time constants; measuring them against
    // `sourceMs` would hand their duration to the retimer, and a click almost
    // always lands in a compressed idle span — the pointer is dwelling on its
    // target, so nothing marks that stretch as motion. `resolved.clickOutputMs`
    // is pre-mapped through `toOutputMs` so this comparison is apples to
    // apples and 400ms of pulse is 400ms on screen wherever it falls.
    for (const clickMs of resolved.clickOutputMs) {
      const t = (outputTimeMs - clickMs) / PULSE_DURATION_MS;
      if (t >= 0 && t <= 1) drawClickPulse(ctx, at, uiScale, t);
    }

    drawCursor(
      ctx,
      at,
      uiScale,
      {
        press: cursorPressScale(
          outputTimeMs,
          resolved.clickOutputMs,
          look.clickBounce ?? CURSOR_POLISH_DEFAULTS.clickBounce,
          resolved.holdOutputMs,
        ),
        angleRad,
      },
      look.style,
    );
    ctx.globalAlpha = priorAlpha;
  }
  if (resolved.touch && !look.hidden) {
    // A fingertip at each tap and nothing else: it presses in over the press
    // window before the tap and ripples out over the pulse after it, fading
    // in and out with them. Output time, for the reason the pulse above is.
    const uiScale = (target.height / 1080) * look.scale * camera.scale;
    const priorAlpha = ctx.globalAlpha;
    for (const tap of resolved.taps) {
      const t = outputTimeMs - tap.outputMs;
      if (t < -PRESS_DURATION_MS || t > PULSE_DURATION_MS) continue;
      const at = cssToOutput(tap.at, camera, frameRect, viewport);
      ctx.globalAlpha =
        t < 0 ? 1 + t / PRESS_DURATION_MS : 1 - t / PULSE_DURATION_MS;
      if (t >= 0) drawClickPulse(ctx, at, uiScale, t / PULSE_DURATION_MS);
      drawCursor(
        ctx,
        at,
        uiScale,
        {
          press: cursorPressScale(outputTimeMs, [tap.outputMs], 1),
          angleRad: 0,
        },
        "touch",
      );
    }
    ctx.globalAlpha = priorAlpha;
  }
  args.onStage?.("cursor", performance.now() - cursorStartedAt);

  ctx.restore();
}
