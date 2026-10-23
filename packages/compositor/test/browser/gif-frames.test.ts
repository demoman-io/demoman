import { describe, expect, it } from "vitest";
import { createGifSink } from "../../src/ports/sink-gif";
import { GIF_800 } from "../../src/render/target";

/**
 * What the GIF sink writes, read back through Chromium's own decoder, which
 * composes each frame onto the ones before it the way a viewer does.
 *
 * A demo holds still for most of its length: on 2026-10-16 a 28.5 s take
 * exported 427 frames, 135 identical to the one before and 224 more that
 * changed under a tenth of the picture, and the sink wrote every one of
 * them whole, 13.9 MB in all. These cases pin the two savings: a repeated
 * frame is no frame, only a longer delay, and a frame that changes a little
 * costs a little.
 */
const W = 320;
const H = 180;
const STEP_MS = 1000 / 15;

/** A busy picture: a gradient with far more than 256 colours. */
function base(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = (x * 255) / W;
      data[i + 1] = (y * 255) / H;
      data[i + 2] = ((x + y) * 255) / (W + H);
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * A picture the first frame can show as drawn: 256 colours in 4 px tiles,
 * each in an rgb565 bin of its own, so each gets a palette entry. Product UI
 * is mostly flat colour like this; `base()`'s gradient is the hard case, and
 * a frame of it is shown faithfully only once it has settled.
 */
function tiles(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = ((x >> 2) % 16) * 16;
      data[i + 1] = ((y >> 2) % 16) * 16;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  return data;
}

/** `data` with a 20 x 20 square painted solid at (x, y). */
function withSquare(
  data: Uint8ClampedArray,
  x: number,
  y: number,
  rgb: [number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data);
  for (let row = y; row < y + 20; row++) {
    for (let col = x; col < x + 20; col++) {
      const i = (row * W + col) * 4;
      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
    }
  }
  return out;
}

function canvasOf(data: Uint8ClampedArray): OffscreenCanvas {
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), W, H), 0, 0);
  return canvas;
}

async function encode(frames: Uint8ClampedArray[]): Promise<Uint8Array> {
  const sink = createGifSink({ ...GIF_800, width: W, height: H });
  for (const f of frames) await sink.addFrame(canvasOf(f), STEP_MS);
  return sink.finish();
}

interface Decoded {
  pixels: Uint8ClampedArray[];
  durationsMs: number[];
}

async function decode(bytes: Uint8Array): Promise<Decoded> {
  const decoder = new ImageDecoder({ data: bytes, type: "image/gif" });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  if (!track) throw new Error("the GIF has no image track");
  await decoder.completed;
  const pixels: Uint8ClampedArray[] = [];
  const durationsMs: number[] = [];
  for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
    const { image } = await decoder.decode({ frameIndex });
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(image, 0, 0);
    pixels.push(ctx.getImageData(0, 0, W, H).data);
    durationsMs.push((image.duration ?? 0) / 1000);
    image.close();
  }
  decoder.close();
  return { pixels, durationsMs };
}

/** Pixels where any channel differs at all. */
function differing(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
}

/** The largest per-channel error anywhere in the picture. */
function worstError(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let worst = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      worst = Math.max(worst, Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0)));
    }
  }
  return worst;
}

describe("the GIF sink", () => {
  it("writes a repeated frame as a longer delay on the one before", async () => {
    const a = tiles();
    const b = withSquare(a, 40, 40, [250, 20, 20]);
    const bytes = await encode([a, a, a, b]);
    const { pixels, durationsMs } = await decode(bytes);

    // The premise: the first frame shows the tiles as drawn, so a repeat
    // of it has nothing left to correct.
    expect(worstError(pixels[0] as Uint8ClampedArray, a)).toBeLessThanOrEqual(
      1,
    );
    expect(pixels).toHaveLength(2);
    // Three frames' worth of time on the first, one on the second, each
    // within the centisecond GIF delays are written in.
    expect(durationsMs[0]).toBeCloseTo(3 * STEP_MS, -1);
    expect(durationsMs[1]).toBeCloseTo(STEP_MS, -1);
    const total = durationsMs.reduce((s, d) => s + d, 0);
    expect(Math.abs(total - 4 * STEP_MS)).toBeLessThan(10);
  }, 30_000);

  it("costs a small change a small frame, and still shows the whole picture", async () => {
    const a = tiles();
    const b = withSquare(a, 40, 40, [250, 20, 20]);
    // The premise: b differs from a in the square and nowhere else.
    expect(differing(a, b)).toBe(400);

    const one = await encode([a]);
    const two = await encode([a, b]);
    const added = two.byteLength - one.byteLength;
    // A whole-frame write costs about as much as the first frame; the
    // square is 0.7% of the picture.
    expect(
      added,
      `the second frame added ${added} bytes against ${one.byteLength} for the first`,
    ).toBeLessThan(one.byteLength / 10);

    const { pixels } = await decode(two);
    const [first, second] = pixels;
    if (!first || !second) throw new Error("expected two decoded frames");
    // Outside the square the picture is exactly the first frame's.
    const outside = differing(
      withSquare(first, 40, 40, [0, 0, 0]),
      withSquare(second, 40, 40, [0, 0, 0]),
    );
    expect(outside).toBe(0);
    // And the square arrived, in about its own colour.
    const i = (50 * W + 50) * 4;
    expect(second[i]).toBeGreaterThan(220);
    expect(second[i + 1]).toBeLessThan(50);
    // Every frame is still a faithful quantisation of what was drawn.
    expect(worstError(second, b)).toBeLessThan(40);
  }, 30_000);

  it("costs a picture that shifts a level or two everywhere a small frame", async () => {
    // A camera creeping a fraction of a pixel resamples the whole page and
    // changes almost every byte by a level or two; to the eye nothing moved.
    const a = tiles();
    const nudged = new Uint8ClampedArray(a);
    for (let i = 0; i < nudged.length; i += 4) {
      nudged[i] = Math.min(255, (nudged[i] ?? 0) + 2);
      nudged[i + 2] = Math.max(0, (nudged[i + 2] ?? 0) - 1);
    }
    // The premise: nearly every pixel differs in its bytes.
    expect(differing(a, nudged)).toBeGreaterThan(W * H * 0.9);

    const one = await encode([a]);
    const two = await encode([a, nudged]);
    const added = two.byteLength - one.byteLength;
    expect(
      added,
      `the nudged frame added ${added} bytes against ${one.byteLength} for the first`,
    ).toBeLessThan(one.byteLength / 10);
    // And what shows is still within quantisation of what was drawn — it
    // may be the first frame, held, when no pixel moved past the tolerance.
    const { pixels } = await decode(two);
    const last = pixels.at(-1);
    if (!last) throw new Error("expected a decoded frame");
    expect(worstError(last, nudged)).toBeLessThan(40);
  }, 30_000);

  it("does not let small steps add up to a large error", async () => {
    // Twenty frames each three levels redder than the last: every step is
    // under the tolerance, the sum (57) is far over this test's bound.
    const frames: Uint8ClampedArray[] = [];
    let f = base();
    for (let k = 0; k < 20; k++) {
      frames.push(f);
      f = new Uint8ClampedArray(f);
      for (let i = 0; i < f.length; i += 4)
        f[i] = Math.min(255, (f[i] ?? 0) + 3);
    }
    const { pixels } = await decode(await encode(frames));
    const last = pixels.at(-1);
    const drawn = frames.at(-1);
    if (!last || !drawn) throw new Error("expected decoded frames");
    expect(worstError(last, drawn)).toBeLessThan(40);
    // The premise: the last frame really is far from the first.
    expect(
      worstError(frames[0] as Uint8ClampedArray, drawn),
    ).toBeGreaterThanOrEqual(57);
  }, 30_000);

  it("rewrites a pixel that held still when what shows there is off", async () => {
    // The ghosting found on 2026-10-18: every pixel a GIF does not rewrite
    // keeps the colour its last write was quantized to, and that write's
    // palette was built for whatever else changed with it. A white strip
    // drawn beside a field of (248, 252, 248) shares its rgb565 bin, so
    // gifenc paints both the bin's mean. When the field turns black and the
    // strip holds still, the strip has to be written again: on its own,
    // white has a palette entry of its own.
    const strip = 40;
    const paint = (field: [number, number, number]) => {
      const out = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const rgb = x < strip ? [255, 255, 255] : field;
          out[i] = rgb[0] as number;
          out[i + 1] = rgb[1] as number;
          out[i + 2] = rgb[2] as number;
          out[i + 3] = 255;
        }
      }
      return out;
    };
    const first = paint([248, 252, 248]);
    const second = paint([0, 0, 0]);
    const at = (data: Uint8ClampedArray, x: number, y: number) => {
      const i = (y * W + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const { pixels } = await decode(await encode([first, second]));
    const [shownFirst, shownSecond] = pixels;
    if (!shownFirst || !shownSecond) {
      throw new Error(`expected two decoded frames, got ${pixels.length}`);
    }
    // The premise: the first frame really did paint the strip off white,
    // by more than the sink lets a pixel drift before it is rewritten.
    expect(
      worstError(shownFirst.slice(0, strip * 4), first.slice(0, strip * 4)),
      `the first frame showed the strip as ${at(shownFirst, 0, 0)}`,
    ).toBeGreaterThan(4);
    // The strip is exactly what was drawn, and so is the field.
    expect(
      worstError(shownSecond, second),
      `the strip shows ${at(shownSecond, 0, 0)}, the field ${at(shownSecond, strip, 0)}`,
    ).toBeLessThanOrEqual(1);
  }, 30_000);

  it("settles a busy picture held still, and then shows it as drawn", async () => {
    // A gradient of far more than 256 colours: the first frame lands much
    // of it well off, and each frame after writes those pixels again with a
    // palette of their own until they are within the tolerance. It has to
    // stop: a still picture that rewrote itself forever would cost every
    // frame of the hold.
    const a = base();
    const held = 20;
    const { pixels, durationsMs } = await decode(
      await encode(Array.from({ length: held }, () => a)),
    );
    const first = pixels[0];
    const last = pixels.at(-1);
    if (!first || !last) throw new Error("expected decoded frames");
    // The premise: the first frame really is off by more than the sink
    // lets stand, so there was something to settle.
    expect(worstError(first, a)).toBeGreaterThan(4);
    // Measured at 9 frames on 2026-10-18; the rest of the hold is one frame.
    expect(
      pixels.length,
      `the hold took ${pixels.length} frames`,
    ).toBeLessThanOrEqual(12);
    expect(worstError(last, a)).toBeLessThanOrEqual(4);
    const total = durationsMs.reduce((s, d) => s + d, 0);
    expect(Math.abs(total - held * STEP_MS)).toBeLessThan(10);
  }, 30_000);

  it("keeps a picture that changes everywhere whole", async () => {
    const a = base();
    const c = new Uint8ClampedArray(a.length);
    for (let i = 0; i < a.length; i += 4) {
      c[i] = 255 - (a[i] ?? 0);
      c[i + 1] = 255 - (a[i + 1] ?? 0);
      c[i + 2] = a[i + 2] ?? 0;
      c[i + 3] = 255;
    }
    const { pixels } = await decode(await encode([a, c]));
    const second = pixels[1];
    if (!second) throw new Error("expected two decoded frames");
    expect(worstError(second, c)).toBeLessThan(40);
  }, 30_000);
});
