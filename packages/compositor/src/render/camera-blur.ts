import { clamp, type Rect, type Vec } from "../geometry.js";
import { type CameraTrack, frameTrack } from "../plan/camera-follow.js";

/**
 * The camera's exposure window at full blur, in OUTPUT milliseconds — about
 * two frames at 60fps, the cursor trail's own window (`CURSOR_EXPOSURE_MS`)
 * and for the same reason: a viewer-time constant, so a camera move smears
 * by how fast it plays, wherever it falls on the timeline.
 */
export const CAMERA_EXPOSURE_MS = 32;

/**
 * Below this much travel at every canvas corner across the exposure, the
 * camera counts as still and no pass is drawn at all. Under a pixel is
 * under what a pass could show — and the gate is what makes a still camera
 * paint byte-identically to a render with blur off, for the long plateaus
 * that are most of a take.
 */
export const CAMERA_BLUR_MIN_TRAVEL_PX = 0.75;

/**
 * The longest smear, as a share of the output's diagonal: about 26px at
 * 1080p, 11px in an 800x450 GIF. A faster move shortens the exposure until
 * its farthest corner travels no more than this, so it reads as a soft
 * streak rather than as the page printed twice.
 *
 * Found by looking, 2026-10-09: a pull-out squeezed into 350ms at the end of
 * a take moved the corners ~50px of an 800x450 frame in one 16ms exposure,
 * and the uncapped smear wiped the page's text out entirely.
 */
export const CAMERA_BLUR_MAX_SMEAR = 0.012;

/**
 * The widest gap between neighbouring passes, at the corner that travels
 * furthest. Copies further apart than about a pixel and a half stop
 * blending into a smear and read as separate ghosts — the stair-stepping
 * a fixed pass count drew on every fast move.
 */
export const CAMERA_BLUR_PASS_SPACING_PX = 1.5;

/** The fewest and the most passes a moving frame draws. */
const MIN_PASSES = 2;
const MAX_PASSES = 24;

/**
 * One blur pass, as the uniform-scale affine `q' = scale·q + (x, y)` in
 * output pixels — `ctx.setTransform(scale, 0, 0, scale, x, y)` — and the
 * output instant whose camera it shows.
 */
export interface CameraBlurPass {
  scale: number;
  x: number;
  y: number;
  outputTimeMs: number;
}

/**
 * Where the composition sat at earlier instants of this frame's exposure,
 * relative to where it sits now, oldest last. Empty when there is nothing
 * to smear: blur 0, the take's first instant, or a camera that is still
 * across the window.
 *
 * The derivation, from `renderFrame`'s `toScene()` — translate to the frame
 * centre F, scale by s, translate by −focus — which draws a scene point p at
 * `q = F + s·(p − focus)`. The pixel at q now is therefore the scene point
 * `p = focus + (q − F)/s`, and at instant i, with camera `(s_i, focus_i)`,
 * that same point was drawn at
 *
 *     q_i = F + s_i·(p − focus_i)
 *         = F + (s_i/s)·(q − F) + s_i·(focus − focus_i)
 *
 * — a scale `r = s_i/s` about F, then a translation `s_i·(focus − focus_i)`.
 * The node lane maps a page point through both cameras and checks this
 * against it, rather than trusting the algebra above.
 *
 * How long and how many, in that order:
 *
 * - The exposure is `CAMERA_EXPOSURE_MS · blur`, never reaching back past
 *   output 0, and shortened — by bisection, since a camera's travel grows
 *   with the window — until no corner moves more than
 *   `CAMERA_BLUR_MAX_SMEAR` of the diagonal across it.
 * - The pass count follows the distance, not the blur setting: enough that
 *   neighbouring passes sit at most `CAMERA_BLUR_PASS_SPACING_PX` apart at
 *   the corner that moves most, within 2..24. It used to be
 *   `ceil(2 + 6·blur)` whatever the move, which spread five copies of the
 *   page tens of pixels apart on a fast one.
 *
 * Image space, not a re-render: each pass resamples the composition that
 * was already painted, so a mask drawn over the page is part of every pass
 * and nothing it hides can be smeared back out from under it. Re-drawing
 * the page at each earlier camera would have been sharper and would have
 * had to repeat the cosmetics in exactly the right order to stay safe.
 *
 * Only the camera's scale and focus are seen. The `cover` follow crop
 * (`frameCamera`'s `pan`) slides the page INSIDE its window while the window
 * stays put, which no single transform of the whole composition can
 * describe, so a frame whose only motion is the crop is still to this.
 */
export function cameraBlurTransforms(args: {
  /** The camera every frame reads (`ResolvedPlan` is one). */
  camera: CameraTrack;
  outputTimeMs: number;
  /** `ResolvedPlan.motion.blur`, 0..1. */
  blur: number;
  /** The camera this frame was drawn with: `frameTrack(...)` at now. */
  current: { scale: number; focus: Vec };
  /** Output pixels per CSS pixel at camera scale 1 — `contentScale(...)`. */
  base: number;
  frameRect: Rect;
  viewport: { width: number; height: number };
  canvas: { width: number; height: number };
}): CameraBlurPass[] {
  const blur = clamp(args.blur, 0, 1);
  if (!(blur > 0) || !(args.current.scale > 0)) return [];
  const { current, frameRect, canvas, outputTimeMs } = args;
  const centre = {
    x: frameRect.x + frameRect.width / 2,
    y: frameRect.y + frameRect.height / 2,
  };
  const corners = [
    { x: 0, y: 0 },
    { x: canvas.width, y: 0 },
    { x: 0, y: canvas.height },
    { x: canvas.width, y: canvas.height },
  ];

  const passAt = (at: number): CameraBlurPass => {
    const then = frameTrack(
      args.camera,
      at,
      args.base,
      frameRect,
      args.viewport,
      canvas,
    );
    const r = then.scale / current.scale;
    return {
      scale: r,
      x: (1 - r) * centre.x + then.scale * (current.focus.x - then.focus.x),
      y: (1 - r) * centre.y + then.scale * (current.focus.y - then.focus.y),
      outputTimeMs: at,
    };
  };
  /** How far apart two passes put the corner that differs most. */
  const apart = (a: CameraBlurPass, b: CameraBlurPass): number => {
    let most = 0;
    for (const c of corners) {
      most = Math.max(
        most,
        Math.hypot(
          a.scale * c.x + a.x - (b.scale * c.x + b.x),
          a.scale * c.y + a.y - (b.scale * c.y + b.y),
        ),
      );
    }
    return most;
  };
  const now: CameraBlurPass = { scale: 1, x: 0, y: 0, outputTimeMs };

  // Before the take's first frame there is no earlier camera to show, so
  // the window ends at 0 rather than sampling the opening key repeatedly.
  let exposureMs = Math.min(CAMERA_EXPOSURE_MS * blur, outputTimeMs);
  if (!(exposureMs > 0)) return [];
  let travel = apart(passAt(outputTimeMs - exposureMs), now);

  const maxSmear =
    CAMERA_BLUR_MAX_SMEAR * Math.hypot(canvas.width, canvas.height);
  if (travel > maxSmear) {
    // The longest window whose farthest corner stays within the cap. Twenty
    // halvings take a 32ms window to a few nanoseconds of precision; each is
    // one camera sample, so this costs nothing next to one pass's draw.
    let fits = 0;
    let fails = exposureMs;
    for (let i = 0; i < 20; i++) {
      const mid = (fits + fails) / 2;
      if (apart(passAt(outputTimeMs - mid), now) <= maxSmear) fits = mid;
      else fails = mid;
    }
    exposureMs = fits;
    travel = apart(passAt(outputTimeMs - exposureMs), now);
  }
  if (travel < CAMERA_BLUR_MIN_TRAVEL_PX) return [];

  let count = clamp(
    Math.ceil(travel / CAMERA_BLUR_PASS_SPACING_PX),
    MIN_PASSES,
    MAX_PASSES,
  );
  // Evenly spread in TIME, which is evenly spread in distance only while the
  // camera's speed is steady across the window. An eased camera is not
  // quite, so the widest neighbouring gap is measured and the count raised
  // until it fits — at most twice, and never past the ceiling.
  let passes: CameraBlurPass[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    passes = [];
    for (let i = 1; i <= count; i++) {
      passes.push(passAt(outputTimeMs - (exposureMs * i) / count));
    }
    let widest = 0;
    let prior = now;
    for (const pass of passes) {
      widest = Math.max(widest, apart(pass, prior));
      prior = pass;
    }
    if (widest <= CAMERA_BLUR_PASS_SPACING_PX || count >= MAX_PASSES) break;
    count = Math.min(
      MAX_PASSES,
      Math.ceil((count * widest) / CAMERA_BLUR_PASS_SPACING_PX),
    );
  }
  return passes;
}

/**
 * One scratch canvas per destination canvas, reused frame after frame: an
 * export at 1080p would otherwise allocate 8 MB per moving frame. Weakly
 * held, so a closed editor or a finished render takes its scratch with it.
 * Purely a buffer — it is overwritten whole before every use, so nothing in
 * it outlives the frame that wrote it, and the picture stays a function of
 * `outputTimeMs` alone.
 */
const scratches = new WeakMap<object, OffscreenCanvas>();

function scratchFor(width: number, height: number, key: object) {
  let scratch = scratches.get(key);
  if (!scratch || scratch.width !== width || scratch.height !== height) {
    scratch = new OffscreenCanvas(width, height);
    scratches.set(key, scratch);
  }
  const ctx = scratch.getContext("2d") as OffscreenCanvasRenderingContext2D;
  // A fresh 2D canvas always yields a context; this fires only if something
  // else claimed the scratch for another context type. Thrown rather than
  // skipped, because skipping would export a sharp camera move and report
  // the render as the one the author asked for.
  if (!ctx)
    throw new Error("the camera blur's scratch canvas has no 2D context");
  return { scratch, ctx };
}

/**
 * Smears what is on `ctx` along `passes`: a running average of the sharp
 * composition and each pass, the k-th drawn at alpha `1/(k+1)` so every
 * layer ends with an equal share. Draws nothing for an empty list.
 *
 * Paints in device pixels whatever transform the caller left set, and
 * expects no clip: the whole composition moves under the camera, background
 * and window alike, and `renderFrame` calls this between its clipped
 * blocks. Leaves the context's transform and alpha as it found them.
 */
export function paintCameraBlur(
  ctx: OffscreenCanvasRenderingContext2D,
  passes: readonly CameraBlurPass[],
): void {
  if (passes.length === 0) return;
  const { width, height } = ctx.canvas;
  const { scratch, ctx: scratchCtx } = scratchFor(width, height, ctx.canvas);
  scratchCtx.globalCompositeOperation = "copy";
  scratchCtx.drawImage(ctx.canvas, 0, 0);

  ctx.save();
  // "medium", and not "low", for the passes. Measured 2026-10-09 in Chrome
  // for Testing: with software rasterization (headless, and any machine
  // without a GPU canvas) "low" blends in 8 bits and rounds the same way
  // every pass, so 18–24 translucent passes over a flat #e0e0e0 page lifted
  // it to 227, and a #282828 one sank to 35 — a moving frame a shade
  // brighter or darker than the still one beside it. "medium" and "high"
  // hold both exactly. On a GPU canvas (headed) none of the three drift,
  // and a moving 1080p frame costs ~12–14ms against ~7ms still at either
  // "low" or "medium"; headless puts "medium" at ~230ms against ~100ms, a
  // software-only cost.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  passes.forEach((pass, i) => {
    ctx.setTransform(pass.scale, 0, 0, pass.scale, pass.x, pass.y);
    ctx.globalAlpha = 1 / (i + 2);
    ctx.drawImage(scratch, 0, 0);
  });
  ctx.restore();
}
