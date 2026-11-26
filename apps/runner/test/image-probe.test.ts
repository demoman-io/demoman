import * as gifencModule from "gifenc";
import { describe, expect, it } from "vitest";
import { readMp4Crops, sampleImage, sampleMp4 } from "./mp4-probe.js";

// gifenc's CJS/ESM shapes disagree under node; pick whichever object carries
// the names (see the comment above `sink-gif.ts`'s import).
const ns = gifencModule as unknown as Record<string, unknown> & {
  default?: Record<string, unknown>;
};
const { applyPalette, GIFEncoder, quantize } = (typeof ns.GIFEncoder ===
"function"
  ? ns
  : (ns.default ?? ns)) as unknown as typeof gifencModule;

// Red if sampleImage reads only the first frame, or reads a frame's colours
// wrong: the GIF and stills tests in executor-export-filetypes.slow.test.ts rest
// on it.
describe("sampleImage", () => {
  it("reads every frame of a gif, each with its own colour", async () => {
    const w = 64;
    const h = 32;
    const frame = (rgb: [number, number, number]) => {
      const data = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
      return data;
    };
    const gif = GIFEncoder();
    for (const rgb of [
      [255, 0, 0],
      [0, 0, 255],
    ] as const) {
      const pixels = frame([...rgb]);
      const palette = quantize(pixels, 256);
      gif.writeFrame(applyPalette(pixels, palette), w, h, {
        palette,
        delay: 100,
      });
    }
    gif.finish();
    const read = await sampleImage(gif.bytes(), "image/gif", {
      colors: [
        [255, 0, 0],
        [0, 0, 255],
      ],
    });
    expect([read.width, read.height, read.frameCount]).toEqual([w, h, 2]);
    expect(read.readings.map((r) => r.colorCounts)).toEqual([
      [expect.any(Number), 0],
      [0, expect.any(Number)],
    ]);
    expect(read.readings[0]?.colorCounts[0]).toBeGreaterThan(0);
    expect(read.readings[1]?.colorCounts[1]).toBeGreaterThan(0);
  }, 60_000);
});

// An empty `atSecs` reads no frame, and a check over no frames passes: the
// probe refuses it before decoding anything, so these bytes need not be a
// video at all. Red if the guard goes.
describe("an empty atSecs", () => {
  const bytes = new Uint8Array([0, 0, 0, 0]);
  it("is refused by sampleMp4", async () => {
    await expect(sampleMp4(bytes, { colors: [], atSecs: [] })).rejects.toThrow(
      "atSecs is empty",
    );
  }, 60_000);
  it("is refused by readMp4Crops", async () => {
    await expect(
      readMp4Crops(bytes, [], [0, 0, 1, 1], { width: 8, height: 8 }),
    ).rejects.toThrow("atSecs is empty");
  }, 60_000);
});
