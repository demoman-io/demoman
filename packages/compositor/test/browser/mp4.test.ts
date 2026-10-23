import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { createMp4Sink } from "../../src/ports/sink-mp4";
import { createOffscreenSurface } from "../../src/ports/surface";
import { renderScene } from "../../src/render/render";
import { LANDSCAPE_1080P } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene } from "../fixtures/scene";

describe("mp4 render", () => {
  it("produces a demuxable MP4 at the target resolution and duration", async () => {
    const scene = readonlyScene();
    const bundle = proceduralBundle();
    // A short target keeps the browser-lane run quick; the encode path is
    // identical at 4K, and that is what the harvested review render covers.
    const target = {
      ...LANDSCAPE_1080P,
      width: 640,
      height: 360,
      bitrate: 2_000_000,
    };

    const { bytes } = await renderScene({
      plan: planScene(scene),
      bundle,
      scene,
      target,
      ports: {
        frames: createProceduralFrameSource(bundle),
        surface: createOffscreenSurface(),
        video: createMp4Sink(target),
      },
    });

    expect(bytes.byteLength).toBeGreaterThan(1000);

    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(bytes),
    });
    const track = await input.getPrimaryVideoTrack();
    expect(track).not.toBeNull();
    expect(track?.displayWidth).toBe(640);
    expect(track?.displayHeight).toBe(360);
    expect(await track?.canDecode()).toBe(true);

    const duration = await track?.computeDuration();
    expect(duration).toBeGreaterThan(1);
  }, 120_000);
});
