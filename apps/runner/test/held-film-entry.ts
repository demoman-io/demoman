import { createMp4Sink, type RenderTarget } from "@demoman/compositor";

/**
 * In-page: films of one panel sliding in, encoded through the export's own
 * MP4 sink at 30 fps, for `same-picture.slow.test.ts`. 1280x720; the panel
 * rests off screen until `SLIDE_FROM`, slides in over 0.8 s (the fixture
 * app's own transition), then rests in place to the end.
 *
 * `captureEvery` films the slide as a slow screencast does: the picture
 * changes only at capture instants, `captureEvery` output frames apart and
 * half a frame off the output grid, and each capture is held until the
 * next. Without it the slide changes on every frame, as a fast capture's
 * does. `mark` draws a block once the panel is in: a change at rest.
 */
export interface HeldFilm {
  captureEvery?: number;
  mark?: boolean;
}

export const HELD_FILM_GLOBAL = "__demomanHeldFilm";
export const FPS = 30;
export const LENGTH_SEC = 3;
export const SLIDE_FROM = 1;
export const SLIDE_SEC = 0.8;
const W = 1280;
const H = 720;
const PANEL = 360;

/** The slide's own clock at output time `t`, as `film` captured it. */
export function capturedAt(t: number, film: HeldFilm): number {
  const every = film.captureEvery;
  if (every === undefined) return t;
  const first = SLIDE_FROM + 0.5 / FPS;
  const step = every / FPS;
  if (t < first) return t;
  const c = first + Math.floor((t - first) / step + 1e-9) * step;
  // The capture after the slide ends shows it ended.
  return c >= SLIDE_FROM + SLIDE_SEC ? t : c;
}

function draw(
  ctx: OffscreenCanvasRenderingContext2D,
  t: number,
  film: HeldFilm,
) {
  ctx.fillStyle = "#f3f4f6";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(0, 0, W, 72);
  ctx.fillStyle = "#374151";
  for (let i = 0; i < 8; i++) ctx.fillRect(40, 120 + i * 64, 700, 28);
  const u = Math.min(
    1,
    Math.max(0, (capturedAt(t, film) - SLIDE_FROM) / SLIDE_SEC),
  );
  const x = W - PANEL * (1 - (1 - u) ** 3);
  ctx.fillStyle = "#111827";
  ctx.fillRect(x, 72, PANEL, H - 72);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillRect(x + 24, 100, 200, 20);
  if (film.mark && t >= SLIDE_FROM + SLIDE_SEC) {
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(100, 640, 60, 30);
  }
}

async function film(spec: HeldFilm): Promise<string> {
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const sink = createMp4Sink({
    format: "mp4",
    width: W,
    height: H,
    fps: FPS,
    bitrate: 4_000_000,
    cornerRadius: 0,
  } as RenderTarget);
  for (let k = 0; k < LENGTH_SEC * FPS; k++) {
    draw(ctx, k / FPS, spec);
    await sink.addFrame(canvas, k / FPS, 1 / FPS);
  }
  const bytes = await sink.finish();
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

(globalThis as unknown as Record<string, unknown>)[HELD_FILM_GLOBAL] = film;
