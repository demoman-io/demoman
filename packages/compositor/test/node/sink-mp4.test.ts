import { describe, expect, it, vi } from "vitest";
import { createMp4Sink, ENCODER_USED_GLOBAL } from "../../src/ports/sink-mp4";
import {
  LANDSCAPE_1080P,
  type RenderTarget,
  SHARE_LANDSCAPE,
  SHARE_VERTICAL,
} from "../../src/render/target";

// mediabunny's encoder needs WebCodecs, which the node lane has none of.
// The sink's own promise — bytes or a reason — is what is under test, so
// the muxer is a stand-in whose buffer is whatever the test says it is.
const muxer = vi.hoisted(() => ({
  buffer: null as ArrayBuffer | null,
  /** Every `new VideoSampleSource(options)`, in order. */
  sourceOptions: [] as unknown[],
}));

vi.mock("mediabunny", () => ({
  BufferTarget: class {
    get buffer() {
      return muxer.buffer;
    }
  },
  Mp4OutputFormat: class {},
  Output: class {
    target = new (class {
      get buffer() {
        return muxer.buffer;
      }
    })();
    addVideoTrack() {}
    async start() {}
    async finalize() {}
  },
  Quality: class {
    constructor(readonly options: unknown) {}
  },
  VideoSample: class {
    close() {}
  },
  VideoSampleSource: class {
    constructor(options: unknown) {
      muxer.sourceOptions.push(options);
    }
    async add() {}
  },
}));

describe("createMp4Sink.finish", () => {
  it("refuses to finish a file no frame was added to", async () => {
    muxer.buffer = new ArrayBuffer(8);
    const sink = createMp4Sink(LANDSCAPE_1080P);
    await expect(sink.finish()).rejects.toThrow(/no frame/i);
  });

  it("refuses to hand back an empty file when the muxer produced nothing", async () => {
    muxer.buffer = null;
    const sink = createMp4Sink(LANDSCAPE_1080P);
    await sink.addFrame({} as never, 0, 1 / 30);
    await expect(sink.finish()).rejects.toThrow(/no bytes/i);
  });

  it("hands back the muxer's bytes when there are some", async () => {
    muxer.buffer = new Uint8Array([1, 2, 3]).buffer;
    const sink = createMp4Sink(LANDSCAPE_1080P);
    await sink.addFrame({} as never, 0, 1 / 30);
    expect(await sink.finish()).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("createMp4Sink encoder options", () => {
  const optionsOf = (target: RenderTarget) => {
    muxer.sourceOptions.length = 0;
    // The global is process-wide: cleared, so a case cannot pass on the
    // value an earlier sink left there.
    delete (globalThis as Record<string, unknown>)[ENCODER_USED_GLOBAL];
    createMp4Sink(target);
    expect(muxer.sourceOptions).toHaveLength(1);
    return muxer.sourceOptions[0] as Record<string, unknown>;
  };

  it("an absent encoder passes only the bitrate", () => {
    const options = optionsOf(LANDSCAPE_1080P);
    expect(LANDSCAPE_1080P.bitrate).toBe(10_000_000);
    expect(Object.keys(options).sort()).toEqual([
      "codec",
      "onEncoderConfig",
      "quality",
    ]);
    expect(options.codec).toBe("avc");
    expect(
      (globalThis as Record<string, unknown>)[ENCODER_USED_GLOBAL],
    ).toEqual({ bitrate: 10_000_000 });
    expect((options.quality as { options: unknown }).options).toEqual({
      bitrate: 10_000_000,
    });
  });

  // The share targets carry a nominal bitrate (`SHARE_LANDSCAPE`'s doc):
  // red if the sink ever encodes one by it rather than by quality.
  it("the share targets encode by quality, never their nominal bitrate", () => {
    for (const target of [SHARE_LANDSCAPE, SHARE_VERTICAL]) {
      expect(target.bitrate).toBeGreaterThan(0);
      const options = optionsOf(target);
      expect((options.quality as { options: unknown }).options).toEqual({
        quality: 0.5,
      });
      expect(
        (globalThis as Record<string, unknown>)[ENCODER_USED_GLOBAL],
      ).toEqual({ quality: 0.5 });
    }
  });

  // mediabunny offers each candidate config to `onEncoderConfig` before it
  // asks `isConfigSupported`, and stops at the first one supported: a
  // refused quantizer is followed by its bitrate fallback. Red if the
  // record keeps the hint ("quality") as though it were what ran.
  it("records the rate control the encoder was opened with", () => {
    const used = () =>
      (globalThis as Record<string, unknown>)[ENCODER_USED_GLOBAL];
    const options = optionsOf(SHARE_LANDSCAPE);
    const offer = options.onEncoderConfig as (config: unknown) => void;
    // Before a frame, nothing has been opened, and the record says only
    // what was asked.
    expect(used()).toEqual({ quality: 0.5 });
    offer({ bitrateMode: "quantizer" });
    expect(used()).toEqual({ quality: 0.5, rateControl: "quantizer" });
    offer({ bitrateMode: "variable", bitrate: 3_225_600 });
    expect(used()).toEqual({
      quality: 0.5,
      rateControl: "bitrate 3225600",
    });
    const plain = optionsOf(LANDSCAPE_1080P);
    (plain.onEncoderConfig as (config: unknown) => void)({
      bitrateMode: "variable",
      bitrate: 10_000_000,
    });
    expect(used()).toEqual({
      bitrate: 10_000_000,
      rateControl: "bitrate 10000000",
    });
  });

  it("encoder hints reach VideoSampleSource", () => {
    const options = optionsOf({
      ...LANDSCAPE_1080P,
      encoder: {
        quality: 0.6,
        bitrateMode: "variable",
        hardwareAcceleration: "prefer-software",
      },
    });
    expect(options.hardwareAcceleration).toBe("prefer-software");
    expect(
      (globalThis as Record<string, unknown>)[ENCODER_USED_GLOBAL],
    ).toEqual({
      quality: 0.6,
      bitrateMode: "variable",
      hardwareAcceleration: "prefer-software",
    });
    expect((options.quality as { options: unknown }).options).toEqual({
      quality: 0.6,
      bitrateMode: "variable",
    });
  });
});
