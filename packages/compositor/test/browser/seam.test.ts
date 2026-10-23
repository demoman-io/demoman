import { describe, expect, it } from "vitest";
import type { FrameImage, FrameSource } from "../../src/ports/types";
import { greyscaleProbe, meanAbsDiff } from "../../src/render/frame-diff";
import { seamAt } from "../../src/render/seam";
import { proceduralBundle } from "../fixtures/bundle";

const THRESHOLD = 0.02;

/** A flat grey frame, tagged with the instant it was served for. */
function flat(level: number, sourceTimeMs: number): FrameImage {
  const canvas = new OffscreenCanvas(64, 64);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = `rgb(${level}, ${level}, ${level})`;
  ctx.fillRect(0, 0, 64, 64);
  return { image: canvas, width: 64, height: 64, sourceTimeMs };
}

function sourceOf(
  at: (sourceTimeMs: number) => Promise<FrameImage>,
): FrameSource {
  return { at, describe: () => ({ keyframes: [], motionSpans: [] }) };
}

describe("seamAt", () => {
  it("calls two different pictures a jump, and says how different", async () => {
    const frames = sourceOf(async (ms) => flat(ms < 5000 ? 20 : 230, ms));
    // Premise: the two frames this fixture serves really do differ by more
    // than the threshold. Without it a `jump` verdict could come from a
    // threshold of zero rather than from the pictures.
    const a = greyscaleProbe((await frames.at(3200)).image);
    const b = greyscaleProbe((await frames.at(9000)).image);
    expect(meanAbsDiff(a, b)).toBeGreaterThan(THRESHOLD);

    const seam = await seamAt({
      frames,
      bundle: proceduralBundle(),
      range: { srcStartMs: 3200, srcEndMs: 9000 },
      threshold: THRESHOLD,
    });
    expect(seam.kind).toBe("jump");
    expect(seam).toMatchObject({ diff: expect.any(Number) });
  });

  it("calls two matching pictures clean", async () => {
    const frames = sourceOf(async (ms) => flat(128, ms));
    const a = greyscaleProbe((await frames.at(3200)).image);
    const b = greyscaleProbe((await frames.at(9000)).image);
    // Premise: they really are the same picture.
    expect(meanAbsDiff(a, b)).toBeLessThan(THRESHOLD);

    expect(
      await seamAt({
        frames,
        bundle: proceduralBundle(),
        range: { srcStartMs: 3200, srcEndMs: 9000 },
        threshold: THRESHOLD,
      }),
    ).toEqual({ kind: "clean" });
  });

  it("is unknown, never clean, when a frame cannot be read", async () => {
    const frames = sourceOf(async (ms) => {
      if (ms >= 9000) throw new Error("blob 'k-3' is not in the store");
      return flat(20, ms);
    });
    const seam = await seamAt({
      frames,
      bundle: proceduralBundle(),
      range: { srcStartMs: 3200, srcEndMs: 9000 },
      threshold: THRESHOLD,
    });
    expect(seam.kind).toBe("unknown");
    expect(seam).toMatchObject({ reason: expect.stringContaining("k-3") });
  });

  it("is unknown, never clean, when both ends resolve to one frame", async () => {
    // A keyframe-only stretch: `FrameSource.at` serves the nearest preceding
    // keyframe however far away it is, so two instants 5.8s apart come back
    // as ONE image — which diffs to exactly zero. Reporting that as `clean`
    // is a stillness verdict from a comparison that never happened, the
    // hazard `FrameImage.sourceTimeMs`'s own docblock exists to name.
    const frames = sourceOf(async () => flat(128, 400));
    // Premise: the source really does serve one instant for both ends.
    expect((await frames.at(3200)).sourceTimeMs).toBe(
      (await frames.at(9000)).sourceTimeMs,
    );

    const seam = await seamAt({
      frames,
      bundle: proceduralBundle(),
      range: { srcStartMs: 3200, srcEndMs: 9000 },
      threshold: THRESHOLD,
    });
    expect(seam.kind).toBe("unknown");
    expect(seam).toMatchObject({ reason: expect.stringContaining("400") });
  });

  it("is unknown when the stretch lies outside the bundle", async () => {
    const frames = sourceOf(async (ms) => flat(128, ms));
    const bundle = proceduralBundle();
    // Premise: 40000ms really is past the bundle's last frame.
    expect(
      Math.max(...bundle.keyframes.map((k) => k.sourceTimeMs)),
    ).toBeLessThan(40_000);

    const seam = await seamAt({
      frames,
      bundle,
      range: { srcStartMs: 3200, srcEndMs: 40_000 },
      threshold: THRESHOLD,
    });
    expect(seam.kind).toBe("unknown");
    expect(seam).toMatchObject({ reason: expect.stringContaining("40000") });
  });
});
