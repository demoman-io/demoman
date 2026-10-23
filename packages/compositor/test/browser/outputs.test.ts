import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { createRecordingVideoSink } from "../../src/ports/fakes";
import { createGifSink } from "../../src/ports/sink-gif";
import { createMp4Sink } from "../../src/ports/sink-mp4";
import { createPngSink } from "../../src/ports/sink-png";
import { createOffscreenSurface } from "../../src/ports/surface";
import { renderScene, renderStills } from "../../src/render/render";
import {
  GIF_800,
  GIF_VERTICAL_450,
  LANDSCAPE_1080P,
  STILL_1440,
  STILL_VERTICAL_1080,
  VERTICAL_1080,
  verticalCameraIntents,
} from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";
import { readonlyScene } from "../fixtures/scene";

const scene = readonlyScene();
const bundle = proceduralBundle();

describe("gif output", () => {
  it("writes a real GIF89a stream", async () => {
    const target = { ...GIF_800, width: 320, height: 180 };
    const { bytes } = await renderScene({
      plan: planScene(scene),
      bundle,
      scene,
      target,
      ports: {
        frames: createProceduralFrameSource(bundle),
        surface: createOffscreenSurface(),
        gif: createGifSink(target),
      },
    });
    const header = new TextDecoder().decode(bytes.slice(0, 6));
    expect(header).toBe("GIF89a");
    expect(bytes.byteLength).toBeGreaterThan(1000);
  }, 120_000);
});

describe("stills output", () => {
  it("writes one PNG per action marker, named for the action", async () => {
    const target = { ...STILL_1440, width: 640, height: 360 };
    const { files } = await renderStills({
      plan: planScene(scene),
      bundle,
      scene,
      target,
      ports: {
        frames: createProceduralFrameSource(bundle),
        surface: createOffscreenSurface(),
        images: createPngSink(),
      },
    });
    expect(files.map((f) => f.name)).toEqual([
      "act-1.png",
      "act-2.png",
      "act-3.png",
    ]);
    for (const file of files) {
      // PNG magic number: a real encode, not an empty buffer.
      expect([...file.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  }, 120_000);

  // Coverage debt from the prior task: renderScene's own png/ImageSink branch
  // (as opposed to the renderStills helper above, which is a thin wrapper
  // around the same sink but drives its own loop) had zero test coverage
  // after the fix that made it actually add frames and return real bytes
  // instead of silently discarding them. Exercise that branch directly, end
  // to end, with a real encoder — not the schedule-only stub the node lane
  // uses for the mp4 branch.
  it("renderScene's png branch adds every frame and returns real PNG bytes, not an empty buffer", async () => {
    const target = {
      ...STILL_1440,
      format: "png" as const,
      width: 64,
      height: 36,
      fps: 5,
    };
    const images = createPngSink();
    const { bytes } = await renderScene({
      plan: planScene(scene),
      bundle,
      scene,
      target,
      ports: {
        frames: createProceduralFrameSource(bundle),
        surface: createOffscreenSurface(),
        images,
      },
    });
    // PNG magic number on the bytes renderScene actually returned.
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(bytes.byteLength).toBeGreaterThan(0);

    // finish() was already called by renderScene; calling images.add() again
    // should be refused, which is only true if renderScene drove the sink
    // through its normal frame loop rather than bypassing it.
    const canvas = createOffscreenSurface().create(target.width, target.height);
    await expect(images.add(canvas, "extra.png")).rejects.toThrow(/finish/);
  }, 120_000);
});

describe("vertical output", () => {
  it("renders a portrait MP4 from the same plan", async () => {
    const plan = planScene(scene);
    const target = {
      ...VERTICAL_1080,
      width: 360,
      height: 640,
      bitrate: 2_000_000,
    };
    const { bytes } = await renderScene({
      plan: {
        ...plan,
        cameraIntents: verticalCameraIntents(plan.cameraIntents),
      },
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
  }, 120_000);
});

describe("hold output", () => {
  it("an authored hold lengthens the encoded video", async () => {
    const held: SceneDocument = {
      ...scene,
      edits: {
        ...scene.edits,
        holds: [
          {
            id: "hold-1",
            marker: { actionId: "act-3", offsetMs: 0 },
            durationMs: 1000,
          },
        ],
      },
    };
    // Downsized like the other targets in this file: this test's sink only
    // counts addFrame calls, so it never encodes a real frame and pays
    // nothing for resolution — but renderScene still rasterises one, and a
    // full 1920x1080 pass twice over just to count calls was ~60s for no
    // return.
    const target = { ...LANDSCAPE_1080P, width: 320, height: 180 };
    const framesOf = async (doc: SceneDocument): Promise<number> => {
      const sink = createRecordingVideoSink();
      await renderScene({
        plan: planScene(doc),
        bundle,
        scene: doc,
        target,
        ports: {
          frames: createProceduralFrameSource(bundle),
          surface: createOffscreenSurface(),
          video: sink,
        },
      });
      return sink.calls.length;
    };
    // This proves a hold reaches renderScene's real frame loop and lengthens
    // its frame count — not a real encode, since the recording sink below
    // only counts addFrame calls rather than producing bytes. 1000ms at
    // 60fps is 60 frames of screen time, and it is screen time the author
    // asked for on a beat the viewer needs to read.
    expect(await framesOf(held)).toBe((await framesOf(scene)) + 60);
  }, 120_000);
});

/** GIF logical screen size: bytes 6–9, little-endian. */
function gifSize(bytes: Uint8Array): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint16(6, true), view.getUint16(8, true)];
}
/** PNG IHDR width and height: bytes 16–23, big-endian. */
function pngSize(bytes: Uint8Array): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

describe("portrait GIF and stills", () => {
  it("encodes the portrait GIF at 450x800", async () => {
    const { bytes } = await renderScene({
      plan: planScene(scene),
      bundle,
      scene,
      target: GIF_VERTICAL_450,
      ports: {
        frames: createProceduralFrameSource(bundle),
        surface: createOffscreenSurface(),
        gif: createGifSink(GIF_VERTICAL_450),
      },
    });
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe("GIF89a");
    expect(gifSize(bytes)).toEqual([450, 800]);
    // 1.6 s here on 2026-09-23; CI composes ~5x slower, so 15 s is too close.
  }, 30_000);

  it("writes portrait stills at 1080x1920", async () => {
    const { files } = await renderStills({
      plan: planScene(scene),
      bundle,
      scene,
      target: STILL_VERTICAL_1080,
      ports: {
        frames: createProceduralFrameSource(bundle),
        surface: createOffscreenSurface(),
        images: createPngSink(),
      },
    });
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(pngSize(file.bytes)).toEqual([1080, 1920]);
  }, 30_000);
});
