import type { CursorStyle } from "@demoman/scene-schema";
import { clamp, type Vec } from "../geometry.js";

export const PULSE_DURATION_MS = 400;

/**
 * How long the press takes to go down, before the click instant.
 *
 * Until 2026-10-09 the press was a triangle this long either side of the
 * click; the release is now a spring that runs for `RELEASE_MS` after it
 * (`cursorPressScale`, in `cursor-pose.ts`), and this is only the way down.
 *
 * 60ms until 2026-09-12, which is under four frames at 60fps — the shrink
 * was in the file and effectively not on the screen. A click is the moment
 * the whole take is about, so it gets long enough to register.
 */
export const PRESS_DURATION_MS = 110;

/**
 * How the pointer is held at one instant: its size multiplier (`press`, 1 is
 * its own size — `cursorPressScale`) and its lean (`angleRad`, positive is
 * clockwise on the canvas — `cursorTiltRad`).
 *
 * An object rather than two more positional numbers on purpose. Until
 * 2026-10-09 the fourth argument was `pressT`, where 0 meant "not pressed";
 * it is now a multiplier, where 0 would mean "drawn at size zero". A caller
 * still passing the old `0` would have typechecked and painted nothing —
 * the editor's style buttons did exactly that — so the shape changed with
 * the meaning, and every stale call site is a type error instead.
 */
export interface CursorPose {
  press: number;
  angleRad: number;
}

/** Unpressed and upright: what a still pointer, and a style preview, draw. */
export const CURSOR_UPRIGHT: Readonly<CursorPose> = Object.freeze({
  press: 1,
  angleRad: 0,
});

// The macOS-style arrow, in a 0..1 box anchored at its tip. Drawn as a path
// rather than an image so it is resolution-independent — crisp at 4K, which
// a bitmap cursor never is.
const ARROW: Vec[] = [
  { x: 0, y: 0 },
  { x: 0, y: 0.75 },
  { x: 0.19, y: 0.58 },
  { x: 0.31, y: 0.87 },
  { x: 0.45, y: 0.81 },
  { x: 0.33, y: 0.53 },
  { x: 0.56, y: 0.52 },
];

/** The touch circle's radius, as a fraction of the art box. */
const TOUCH_RADIUS = 0.42;

/**
 * Each style's art box and hotspot, in the 0..1 space the shapes are drawn
 * in.
 *
 * `height` is the base height in output pixels at scale 1, and it is
 * deliberately larger than life. The frame is a 1280x800 page scaled up to
 * fill a 1080p output, so a pointer at true system size arrives at roughly
 * 32px — and at exactly life size it is the one thing in a demo nobody can
 * find, because it is competing with the app's own UI while being the
 * viewer's eye-line through the entire video. Screen recordings that read
 * well all draw it bigger than the machine did. It was 28 until 2026-09-12,
 * which was *smaller* than life once the upscale is counted; raising it is
 * the cheapest available change to how the cursor reads, and it is guarded
 * by a decoded-pixel assertion on the arrow's own ink in `compose.test.ts`
 * rather than by this number agreeing with itself.
 *
 * The hotspots differ because the shapes mean different things. An arrow
 * points, so it hangs off its tip. A touch circle is what a finger covers,
 * so it is centred: drawn down-and-right like the arrow it would sit beside
 * every control it taps rather than on it.
 *
 * `ink` is the box the shape actually paints, in the same 0..1 space — the
 * arrow fills only the top-left of its box, so centring the box leaves the
 * arrow visibly off to the left (the editor's style buttons did exactly
 * that until 2026-09-22). Derived from the path, never restated, so a
 * reshaped arrow moves it too. Stroke and shadow fall outside it.
 */
export const CURSOR_ART: Record<
  CursorStyle,
  { height: number; hotspot: Vec; ink: { min: Vec; max: Vec } }
> = {
  light: { height: 40, hotspot: { x: 0, y: 0 }, ink: bounds(ARROW) },
  dark: { height: 40, hotspot: { x: 0, y: 0 }, ink: bounds(ARROW) },
  touch: {
    height: 40,
    hotspot: { x: 0.5, y: 0.5 },
    ink: {
      min: { x: 0.5 - TOUCH_RADIUS, y: 0.5 - TOUCH_RADIUS },
      max: { x: 0.5 + TOUCH_RADIUS, y: 0.5 + TOUCH_RADIUS },
    },
  },
};

function bounds(points: Vec[]): { min: Vec; max: Vec } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    min: { x: Math.min(...xs), y: Math.min(...ys) },
    max: { x: Math.max(...xs), y: Math.max(...ys) },
  };
}

/** Fill and stroke per style. Every one carries its own contrast pair, so
 *  it survives a brand-coloured button and a white table row alike. */
const INK: Record<CursorStyle, { fill: string; stroke: string }> = {
  light: { fill: "#ffffff", stroke: "#111827" },
  dark: { fill: "#111827", stroke: "#ffffff" },
  touch: { fill: "rgba(255, 255, 255, 0.45)", stroke: "#111827" },
};

/**
 * Draws the pointer at `at`, in output-space coordinates.
 *
 * `scale` folds in the output resolution, the author's multiplier and the
 * camera scale: the cursor is part of the scene the camera zooms.
 * `pose.press` multiplies its size; `pose.angleRad` turns it about its
 * hotspot — the point `at` names — so a leaning arrow still points at
 * exactly the pixel it was pointing at. The touch circle does not turn: it
 * is a contact point, and a rotated circle is the same circle.
 */
export function drawCursor(
  ctx: OffscreenCanvasRenderingContext2D,
  at: Vec,
  scale: number,
  pose: Readonly<CursorPose>,
  style: CursorStyle = "light",
): void {
  const size = CURSOR_ART[style].height * scale * pose.press;
  const ink = INK[style];

  ctx.save();
  ctx.translate(at.x, at.y);
  // After the translate, so the turn is about the hotspot. The arrow's path
  // below is drawn with its tip — its hotspot — at the origin.
  if (style !== "touch" && pose.angleRad !== 0) ctx.rotate(pose.angleRad);

  ctx.beginPath();
  if (style === "touch") {
    // Centred on the hotspot: the circle IS the contact point.
    ctx.arc(0, 0, size * TOUCH_RADIUS, 0, Math.PI * 2);
  } else {
    const first = ARROW[0];
    if (first) {
      ctx.moveTo(first.x * size, first.y * size);
      for (const point of ARROW.slice(1))
        ctx.lineTo(point.x * size, point.y * size);
    }
  }
  ctx.closePath();

  // A soft drop shadow keeps the pointer readable over light UI without
  // needing a heavy outline.
  ctx.shadowColor = "rgba(15, 23, 42, 0.35)";
  ctx.shadowBlur = 3 * scale;
  ctx.shadowOffsetY = 1.5 * scale;

  ctx.fillStyle = ink.fill;
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.lineWidth = Math.max(1, 1.4 * scale);
  ctx.lineJoin = "round";
  ctx.strokeStyle = ink.stroke;
  ctx.stroke();

  ctx.restore();
}

/**
 * The exposure window at full blur, in OUTPUT milliseconds — about two
 * frames at 60fps.
 *
 * Output, not source, and `compose.ts` maps each stamp back through the
 * timeline before it samples a position. This is the same argument this
 * file already makes for `PULSE_DURATION_MS`: a viewer-time constant
 * measured on a source clock is handed to the retimer, and 32ms of
 * recording inside a 6x-compressed span is 5ms of screen time.
 *
 * Measuring on the output axis also has the right side effect. A stretch
 * the retimer speeds up smears more, which is exactly the medicine for the
 * thing a sped-up pointer suffers from: it is the one element of a frame
 * whose true speed a viewer already knows.
 */
export const CURSOR_EXPOSURE_MS = 32;

/** Under this much travel across the window, no trail is drawn at all. */
export const CURSOR_TRAIL_MIN_TRAVEL_PX = 1;

/** How much of the trail the faintest ghost keeps. */
const TRAIL_PEAK_ALPHA = 0.55;

/**
 * How many ghosts a blur setting asks for. Zero at zero — the slider's low
 * end is a genuinely crisp pointer, not a cheap one.
 */
export function cursorTrailStamps(motionBlur: number): number {
  if (motionBlur <= 0) return 0;
  return Math.ceil(2 + 8 * clamp(motionBlur, 0, 1));
}

/**
 * The ghosts behind the pointer: the same shape, stamped along the path it
 * covered during the frame's exposure, oldest and faintest first.
 *
 * Alpha rises quadratically rather than linearly because a linear ramp
 * leaves a visibly hard end to the tail. The crisp cursor is NOT drawn
 * here — `compose.ts` draws it afterwards with `drawCursor`, so the sharp
 * copy always lands on top.
 *
 * An empty `positions` draws nothing and is the ordinary case: it is what a
 * still pointer, and a blur of zero, both produce.
 */
export function drawCursorTrail(
  ctx: OffscreenCanvasRenderingContext2D,
  /** Each ghost's place, and its own lean (absent is upright): a ghost is
   *  the pointer at an earlier instant, so it leans as the pointer leaned
   *  then (`cursorTrailGhosts`), not as it leans now. */
  positions: (Vec & { angleRad?: number })[],
  scale: number,
  style: CursorStyle,
): void {
  if (positions.length === 0) return;
  const priorAlpha = ctx.globalAlpha;
  positions.forEach((position, i) => {
    const t = (i + 1) / (positions.length + 1);
    ctx.globalAlpha = priorAlpha * t * t * TRAIL_PEAK_ALPHA;
    // Unpressed: the press is a moment, and the smear is of the motion.
    const pose = { press: 1, angleRad: position.angleRad ?? 0 };
    drawCursor(ctx, position, scale, pose, style);
  });
  ctx.globalAlpha = priorAlpha;
}

/**
 * The click ring: expands and fades over PULSE_DURATION_MS. `t` runs 0..1;
 * outside that range nothing is drawn, so the composer can call it blindly
 * for every recorded click on every frame.
 *
 * It is drawn the way the pointer is: a light core between two dark edges,
 * so it carries its own contrast and reads on whatever the author happened
 * to click — a brand-coloured button, a white table row, a dark header.
 * The previous ring was a single `rgba(59, 91, 219, ...)` fill-and-stroke,
 * i.e. a hardcoded #3b5bdb, and source-over with the destination's own RGB
 * cannot change a pixel at any alpha: on a #3b5bdb button the pulse was not
 * faint, it was provably absent. A tinted ring only moves that collision to
 * whichever app shares the tint, so the colour is not a brand value here.
 *
 * The three strokes sit at different radii rather than being layered on one,
 * because a translucent light stroke composited over a translucent dark one
 * blends into neither, and the whole point is that one of the two always
 * differs from the background.
 *
 * Stroke-only, and never filled: the ring must not veil the control that was
 * just clicked. That also lets the alpha peak near 1 — a fill at that opacity
 * would be a flashbulb, a 2.5px ring is feedback.
 *
 * Radius and alpha ride different curves on purpose. The expansion is
 * ease-out cubic, because a ring that leaps out and settles reads as
 * feedback, and it carries the ring past the edge of a normal control (a
 * 160x44 CSS px button) about a fifth of the way through its life, so most
 * of the pulse is legible against the page rather than the target. The fade
 * is linear, because sharing that cubic put alpha at (1 - t)^3 — under a
 * single 8-bit level well before t reached 1, so the last ~180ms of a 400ms
 * pulse drew nothing. Linear keeps a visible ring across the whole life and
 * still reaches exactly zero at t = 1, so there is no pop at the end.
 */
export function drawClickPulse(
  ctx: OffscreenCanvasRenderingContext2D,
  at: Vec,
  scale: number,
  t: number,
): void {
  if (t < 0 || t > 1) return;
  const eased = 1 - (1 - t) ** 3;
  const radius = 16 * scale * (1 + 2.2 * eased);
  const alpha = 1 - t;

  const core = Math.max(1, 2.5 * scale);
  const edge = Math.max(0.75, 1.25 * scale);
  const offset = (core + edge) / 2;

  ctx.save();
  ring(ctx, at, radius - offset, edge, `rgba(15, 23, 42, ${0.75 * alpha})`);
  ring(ctx, at, radius + offset, edge, `rgba(15, 23, 42, ${0.75 * alpha})`);
  ring(ctx, at, radius, core, `rgba(255, 255, 255, ${0.95 * alpha})`);
  ctx.restore();
}

function ring(
  ctx: OffscreenCanvasRenderingContext2D,
  at: Vec,
  radius: number,
  width: number,
  style: string,
): void {
  if (radius <= 0) return;
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  ctx.lineWidth = width;
  ctx.strokeStyle = style;
  ctx.stroke();
}
