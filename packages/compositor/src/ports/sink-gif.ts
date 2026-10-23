import type { Palette, RGB } from "gifenc";
import * as gifencModule from "gifenc";
import type { RenderTarget } from "../render/target.js";
import type { GifSink } from "./types.js";

/**
 * gifenc's two doors disagree about shape, and both are in use here.
 *
 * It ships CJS on `main` and ESM only on the unofficial `module` field, with
 * no `exports` map to arbitrate. Node ESM therefore reads the CJS, and its
 * lexer cannot see these three as named exports — `import { GIFEncoder } from
 * "gifenc"` throws `Named export 'GIFEncoder' not found` under node while
 * resolving fine through vite, esbuild and wxt. Nothing noticed until
 * `apps/runner` became the first consumer to load `dist/` in node.
 *
 * Neither a plain default import nor a plain namespace import fixes it alone:
 * the ESM build has a `default` of its own that is NOT the bag of names, so
 * preferring `default` breaks the bundler path (measured 2026-09-08 — two gif
 * tests went red with `GIFEncoder is not a function`). Pick whichever object
 * actually carries the names.
 */
const ns = gifencModule as unknown as Record<string, unknown> & {
  default?: Record<string, unknown>;
};
const gifenc = (typeof ns.GIFEncoder === "function"
  ? ns
  : (ns.default ?? ns)) as unknown as typeof gifencModule;
const { applyPalette, GIFEncoder, quantize } = gifenc;

/**
 * How far, in levels on any channel, what the GIF shows at a pixel may sit
 * from what the compositor drew there before the pixel is written again.
 *
 * It is also what a moving edge may leave behind. Measured 2026-10-18 on an
 * 11 s take with a slide-in drawer and a toast: a slide's motion blur ends
 * a few levels off the white it settles to, and that residue stays as a
 * copy of what slid past. At 6 it reads plainly on a white panel; at 4 it
 * is a 3-level trace you find only by looking, for 22% more bytes than 6
 * (6.2 MB to 7.6 MB at 1600 px). Not below 3: gifenc bins colours by
 * rgb565, 8 levels wide on red and blue, and a still picture whose bins
 * cannot get within the tolerance is rewritten frame after frame (at 2,
 * 1,560 pixels on every still frame of that take). Writing a pixel again
 * once its colour holds exactly still did not clear the trace and cost 28%
 * more, tried only on frames decoded from the take's MP4, whose codec noise
 * may hide a still pixel.
 */
const KEEP_LEVELS = 4;

/**
 * GIF is the embed-anywhere format, so it is quantized hard and kept small.
 * No dithering: gifenc has none, and on flat product UI the banding it would
 * hide barely appears.
 *
 * A demo holds still for most of its length, and the sink is built around
 * that. Measured 2026-10-16 on a 28.5 s take: of 427 frames, 135 were
 * identical to the one before and 224 more changed under a tenth of the
 * picture, and writing every one whole came to 13.9 MB. So:
 *
 * - After the first frame, a pixel where the GIF already SHOWS a colour
 *   within `KEEP_LEVELS` of what the compositor drew is written as the
 *   transparent index, over a frame left in place (disposal 1), so a still
 *   page costs a run of one code. A camera creeping a fraction of a pixel
 *   changes nearly every byte by a level or two, and that is what the
 *   tolerance absorbs. The reference is the palette colour the pixel was
 *   last written as, so it moves only when the pixel is written: against
 *   the frame drawn just before, steps of a level each could add up, unseen,
 *   to any error at all.
 *
 *   It is not what the compositor drew at that write. That was the
 *   reference until 2026-10-18, and it froze each write's quantization
 *   error in place: a frame where much of the picture changes (a fade, a
 *   slide, a camera move) spreads its 255 colours thin and lands near-whites
 *   10 to 20 levels off, with a tint. Once the picture settled, every pixel
 *   kept the error of whichever frame last wrote it, so neighbours written
 *   in different frames showed different palettes' errors, a mosaic in the
 *   shape of what had changed together. The export showed it as ghosts of
 *   earlier pages from about 3.6 s on; the MP4 of the same take was clean.
 *   A pixel quantized badly is now written again, and the palette for that
 *   frame goes to the pixels still off, so a still picture settles within a
 *   few frames rather than holding its errors.
 * - A frame with no such pixel is no frame: its time goes on the delay of
 *   the frame already showing.
 * - The palette is quantized from the changed pixels alone, so a small
 *   change gets all 255 colours for itself.
 *
 * gifenc writes every frame at (0, 0) and full size, so a changed rectangle
 * is not available; the transparent runs get nearly all of that saving.
 */
/**
 * Why a GIF sink stopped: the stream passed the byte budget it was given.
 * A class of its own so a caller trying widths in turn can tell "too big at
 * this width" from every other failure, which it must not swallow.
 */
export class GifOverBudgetError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly bytesSoFar: number,
  ) {
    super(
      `the GIF passed its ${maxBytes}-byte budget (${bytesSoFar} bytes written so far)`,
    );
    this.name = "GifOverBudgetError";
  }
}

/** Across module copies too: a bundle may carry its own copy of this file. */
export function isGifOverBudget(error: unknown): error is GifOverBudgetError {
  return error instanceof Error && error.name === "GifOverBudgetError";
}

export function createGifSink(
  _target: RenderTarget,
  options: {
    /** Stop with `GifOverBudgetError` once the stream passes this many
     *  bytes, rather than encoding the rest of a file that will not fit. */
    maxBytes?: number;
  } = {},
): GifSink {
  const gif = GIFEncoder();
  let finished = false;
  // GIF delays are whole centiseconds, and gifenc rounds each frame's on
  // its own. At 15 fps a frame is 66.67 ms, which rounds to 70 every time,
  // so a 10 s timeline played back at 10.5 s. The remainder carries from
  // frame to frame instead: each frame gets the nearest centisecond to what
  // the timeline is owed so far, and the total stays within one frame.
  let owedMs = 0;
  // What the GIF shows at each pixel, as RGB: the palette colour it was
  // last written as. And the latest frame, held until its delay is known.
  let written: Uint8ClampedArray | null = null;
  let changed: Uint32Array | null = null;
  let pending: {
    index: Uint8Array;
    width: number;
    height: number;
    palette: Palette;
    transparentIndex: number | null;
    delayMs: number;
  } | null = null;

  const writePending = () => {
    if (pending === null) return;
    owedMs += pending.delayMs;
    const grantedMs = Math.round(owedMs / 10) * 10;
    owedMs -= grantedMs;
    gif.writeFrame(pending.index, pending.width, pending.height, {
      palette: pending.palette,
      delay: grantedMs,
      // Leave each frame in place for the next to draw over.
      dispose: 1,
      ...(pending.transparentIndex === null
        ? {}
        : { transparent: true, transparentIndex: pending.transparentIndex }),
    });
    pending = null;
    const written = gif.bytesView().byteLength;
    if (options.maxBytes !== undefined && written > options.maxBytes) {
      throw new GifOverBudgetError(options.maxBytes, written);
    }
  };

  return {
    async addFrame(canvas, delayMs) {
      if (finished)
        throw new Error("sink already finish()ed; cannot accept more frames");
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      const { data, width, height } = ctx.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      );
      if (written === null || pending === null) {
        // quantize's default format is rgb565: RGB entries, no alpha.
        const palette = quantize(data, 256) as RGB[];
        const index = applyPalette(data, palette);
        written = new Uint8ClampedArray(width * height * 3);
        changed = new Uint32Array(width * height);
        for (let p = 0, j = 0; p < index.length; p++, j += 3) {
          const shown = palette[index[p] as number] as RGB;
          written[j] = shown[0];
          written[j + 1] = shown[1];
          written[j + 2] = shown[2];
        }
        pending = {
          index,
          width,
          height,
          palette,
          transparentIndex: null,
          delayMs,
        };
        return;
      }

      // Which pixels show a colour further than KEEP_LEVELS from what was
      // drawn, by pixel number, into a buffer kept across frames:
      // a camera move changes every pixel, and a growable list of a million
      // numbers a frame was the sink's own cost (review, 2026-10-16).
      if (changed === null || changed.length !== width * height) {
        changed = new Uint32Array(width * height);
      }
      let count = 0;
      for (let p = 0, i = 0, j = 0; p < width * height; p++, i += 4, j += 3) {
        if (
          Math.abs((data[i] as number) - (written[j] as number)) >
            KEEP_LEVELS ||
          Math.abs((data[i + 1] as number) - (written[j + 1] as number)) >
            KEEP_LEVELS ||
          Math.abs((data[i + 2] as number) - (written[j + 2] as number)) >
            KEEP_LEVELS
        ) {
          changed[count++] = p;
        }
      }
      if (count === 0) {
        pending.delayMs += delayMs;
        return;
      }

      writePending();
      const picked = new Uint8ClampedArray(count * 4);
      for (let n = 0; n < count; n++) {
        const i = (changed[n] as number) * 4;
        const o = n * 4;
        picked[o] = data[i] as number;
        picked[o + 1] = data[i + 1] as number;
        picked[o + 2] = data[i + 2] as number;
        picked[o + 3] = data[i + 3] as number;
      }
      // 255 colours for the change, and the last index for "as before".
      const palette = quantize(picked, 255) as RGB[];
      const transparentIndex = palette.length;
      const pickedIndex = applyPalette(picked, palette);
      const index = new Uint8Array(width * height).fill(transparentIndex);
      for (let n = 0; n < count; n++) {
        const p = changed[n] as number;
        const k = pickedIndex[n] as number;
        const shown = palette[k] as RGB;
        index[p] = k;
        written[p * 3] = shown[0];
        written[p * 3 + 1] = shown[1];
        written[p * 3 + 2] = shown[2];
      }
      pending = {
        index,
        width,
        height,
        palette: [...palette, [0, 0, 0]],
        transparentIndex,
        delayMs,
      };
    },
    async finish() {
      if (!finished) writePending();
      finished = true;
      gif.finish();
      return gif.bytes();
    },
  };
}
