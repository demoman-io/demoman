import { describe, expect, it } from "vitest";
import { createGifSink, isGifOverBudget } from "../../src/ports/sink-gif";
import { GIF_800 } from "../../src/render/target";

// gifenc quantises to whole pixels and whole centiseconds, neither of which
// needs a canvas: a stub that hands back a 4x4 image is enough for the sink
// to write real frames. Each one is a different grey, because the sink
// writes a frame identical to the one before as a longer delay instead.
function flatCanvas(grey: number): OffscreenCanvas {
  const data = new Uint8ClampedArray(4 * 4 * 4).fill(255);
  for (let i = 0; i < data.length; i += 4) data.fill(grey, i, i + 3);
  return {
    width: 4,
    height: 4,
    getContext: () => ({
      getImageData: () => ({
        data: new Uint8ClampedArray(data),
        width: 4,
        height: 4,
      }),
    }),
  } as unknown as OffscreenCanvas;
}

/** Every Graphic Control Extension's delay, in ms, in stream order. */
function frameDelaysMs(bytes: Uint8Array): number[] {
  const delays: number[] = [];
  for (let i = 0; i + 5 < bytes.length; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
      delays.push(
        ((bytes[i + 4] as number) | ((bytes[i + 5] as number) << 8)) * 10,
      );
      i += 7;
    }
  }
  return delays;
}

describe("createGifSink", () => {
  // GIF delays are whole centiseconds. At 15 fps a frame is 66.67 ms, which
  // rounds to 70 on its own, so a 10 s timeline played back at 10.5 s. The
  // rounding remainder has to carry from frame to frame.
  it("keeps the encoded duration within one frame of the timeline", async () => {
    const fps = 15;
    const step = 1000 / fps;
    const frames = 150; // 10 s
    const sink = createGifSink(GIF_800);
    // The premise: every frame differs from the one before, so none merges.
    // Twenty levels apart, well past the sink's tolerance for "unchanged".
    const greys = Array.from({ length: frames }, (_, i) => (i % 2) * 20 + 100);
    for (const [i, g] of greys.entries()) {
      if (i > 0) expect(g).not.toBe(greys[i - 1]);
      await sink.addFrame(flatCanvas(g), step);
    }
    const delays = frameDelaysMs(await sink.finish());

    expect(delays).toHaveLength(frames);
    const total = delays.reduce((sum, d) => sum + d, 0);
    expect(Math.abs(total - frames * step)).toBeLessThan(step);
    // Not by starving one frame: every delay is one of the two neighbours.
    for (const d of delays) expect([60, 70]).toContain(d);
  });
});

// A frame of noise: every pixel changes, so every frame costs its whole size
// and the stream grows by roughly the same amount each time.
function noiseCanvas(seed: number): OffscreenCanvas {
  const data = new Uint8ClampedArray(32 * 32 * 4);
  let x = seed * 2654435761;
  for (let i = 0; i < data.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    data[i] = i % 4 === 3 ? 255 : x >>> 24;
  }
  return {
    width: 32,
    height: 32,
    getContext: () => ({
      getImageData: () => ({
        data: new Uint8ClampedArray(data),
        width: 32,
        height: 32,
      }),
    }),
  } as unknown as OffscreenCanvas;
}

describe("createGifSink's byte budget", () => {
  // What a GIF wider than it can afford answers with: a refusal the ladder
  // can tell apart from any other failure, raised as soon as the stream
  // passes the budget, not after the whole take has been encoded.
  it("refuses, by name, once the stream passes its budget", async () => {
    const sink = createGifSink(GIF_800, { maxBytes: 4000 });
    let added = 0;
    let refused: unknown;
    try {
      for (; added < 50; added++) await sink.addFrame(noiseCanvas(added), 70);
    } catch (error) {
      refused = error;
    }
    expect(isGifOverBudget(refused), String(refused)).toBe(true);
    // Early: a frame of noise is about 1.5 KB, so the budget is gone within
    // a handful of frames, far short of the 50 offered.
    expect(added).toBeLessThan(10);
  });

  it("encodes the same frames whole with no budget", async () => {
    const sink = createGifSink(GIF_800);
    for (let i = 0; i < 50; i++) await sink.addFrame(noiseCanvas(i), 70);
    const bytes = await sink.finish();
    // The premise: these frames together are far over the budget above.
    expect(bytes.byteLength).toBeGreaterThan(20_000);
  });
});
