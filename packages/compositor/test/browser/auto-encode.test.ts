import { describe, expect, it } from "vitest";
import { createMp4Sink } from "../../src/ports/sink-mp4";
import { autoTarget, LANDSCAPE_4K } from "../../src/render/target";

/** H.264 level 5.2's largest frame, in 16x16 macroblocks. */
const LEVEL_52_MAX_MACROBLOCKS = 36_864;
const macroblocks = (w: number, h: number) =>
  Math.ceil(w / 16) * Math.ceil(h / 16);

describe("the Auto frame at the 4K tier, encoded", () => {
  // Final review, Critical (2026-10-06): a replay at REPLAY_DPR 3 of a
  // 1280x800 window has 3840-wide keyframes, so Auto takes the 4K tier, and
  // at the default padding the frame came out 3840x2554 — over level 5.2's
  // frame size, which this environment's encoder refuses ("not supported in
  // this environment"). Red if autoTarget lets an MP4 frame outgrow it.
  it.each([
    [
      "a 16:10 window at the default padding",
      { width: 1280, height: 800 },
      0.08,
    ],
    ["a square window at padding 0", { width: 1000, height: 1000 }, 0],
    ["a narrow window", { width: 1000, height: 1200 }, 0.08],
  ])(
    "encodes %s",
    async (_name, viewport, padding) => {
      const target = autoTarget(LANDSCAPE_4K, viewport, padding);
      expect(
        macroblocks(target.width, target.height),
        `${target.width}x${target.height}`,
      ).toBeLessThanOrEqual(LEVEL_52_MAX_MACROBLOCKS);
      const sink = createMp4Sink(target);
      const canvas = new OffscreenCanvas(target.width, target.height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.fillStyle = "#3b5bdb";
      ctx.fillRect(0, 0, target.width, target.height);
      await sink.addFrame(canvas, 0, 1 / 30);
      const bytes = await sink.finish();
      expect(bytes.byteLength).toBeGreaterThan(100);
    },
    60_000,
  );

  // Premise: the encoder in this lane really does refuse the size the
  // unguarded formula produced, or the cases above prove nothing about it.
  it("premise: this environment refuses a 3840x2554 frame", async () => {
    const sink = createMp4Sink({
      ...LANDSCAPE_4K,
      width: 3840,
      height: 2554,
    });
    const canvas = new OffscreenCanvas(3840, 2554);
    // Painted, as the cases above are: an untouched canvas fails earlier,
    // constructing the VideoFrame, which is not the refusal this is about.
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.fillRect(0, 0, 3840, 2554);
    const attempt = (async () => {
      await sink.addFrame(canvas, 0, 1 / 30);
      return sink.finish();
    })();
    await expect(attempt).rejects.toThrow(/not supported/i);
  }, 60_000);
});
