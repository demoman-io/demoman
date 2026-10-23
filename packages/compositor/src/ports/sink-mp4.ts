import {
  BufferTarget,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSource,
} from "mediabunny";
import type { RenderTarget } from "../render/target.js";
import type { VideoSink } from "./types.js";

/**
 * Where `createMp4Sink` leaves what it asked the encoder for, and, once the
 * first frame has opened the encoder, the rate control that actually ran
 * (`EncoderUsed`).
 */
export const ENCODER_USED_GLOBAL = "__demomanMp4Encoder";

/** The record `createMp4Sink` leaves at `ENCODER_USED_GLOBAL`. */
export interface EncoderUsed {
  /** Asked for: `quality` from `RenderTarget.encoder`, else the target's
   *  `bitrate`. */
  quality?: number;
  bitrate?: number;
  bitrateMode?: "constant" | "variable";
  hardwareAcceleration?:
    | "no-preference"
    | "prefer-hardware"
    | "prefer-software";
  /**
   * What the encoder was opened with: `"quantizer"`, a constant quantizer
   * per frame (mediabunny's mapping of `quality`), or `"bitrate <n>"`, rate
   * control aiming at n bits per second. Absent until the first frame.
   *
   * A `quality` does not promise a quantizer. mediabunny offers the
   * quantizer config first and, when `VideoEncoder.isConfigSupported`
   * refuses it, falls back to variable bitrate at a rate it computes from
   * the frame size and the quality alone (not the frame rate). Measured
   * 2026-10-18, Chromium 151 on macOS: headed accepts AVC quantizer mode at
   * 1920x1080 and 720x1280; headless refuses it at both, so a headless
   * render at `quality: 0.5` and 1080p is a ~3.2 Mbps VBR file.
   */
  rateControl?: string;
}

/**
 * Offline, frame-accurate mux. Every sample carries an explicit timestamp
 * from the fixed output timeline — never a wall-clock reading. SP1 produced
 * both a realtime-assembled sample and an offline one from the same harvest;
 * only the offline one passed the human smoothness bar.
 */
export function createMp4Sink(target: RenderTarget): VideoSink {
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
  });
  const hints = target.encoder;
  const bitrateMode =
    hints?.bitrateMode === undefined ? {} : { bitrateMode: hints.bitrateMode };
  // `quality` asks for a quantizer-driven file; where the encoder refuses
  // quantizer mode, mediabunny falls back to a bitrate of its own reckoning
  // (`EncoderUsed.rateControl`). Without `quality` the target's bitrate is
  // what the file is sized by.
  const quality = new Quality(
    hints?.quality === undefined
      ? { bitrate: target.bitrate, ...bitrateMode }
      : { quality: hints.quality, ...bitrateMode },
  );
  const hardware =
    hints?.hardwareAcceleration === undefined
      ? {}
      : { hardwareAcceleration: hints.hardwareAcceleration };
  // What this sink asked for and what the encoder was opened with, readable
  // from the render page: the measurement harness shows it on each card and
  // the share test asserts it, so a hint that never reached the encoder, or
  // a quantizer the encoder refused, cannot pass for one that ran.
  const used: EncoderUsed = {
    ...(hints?.quality === undefined
      ? { bitrate: target.bitrate }
      : { quality: hints.quality }),
    ...bitrateMode,
    ...hardware,
  };
  (globalThis as Record<string, unknown>)[ENCODER_USED_GLOBAL] = used;
  const source = new VideoSampleSource({
    codec: "avc",
    quality,
    ...hardware,
    // mediabunny calls this with each candidate config, in order, just
    // before asking `VideoEncoder.isConfigSupported` about it, and stops at
    // the first supported one (media-source.js, `ensureEncoder`). So once
    // a frame has been encoded, the last call is the config that ran.
    onEncoderConfig: (config) => {
      used.rateControl =
        config.bitrateMode === "quantizer"
          ? "quantizer"
          : `bitrate ${config.bitrate}`;
    },
  });
  output.addVideoTrack(source);

  let started: Promise<void> | null = null;
  let finished = false;
  let frames = 0;

  return {
    async addFrame(canvas, timestampSec, durationSec) {
      if (finished)
        throw new Error("sink already finish()ed; cannot accept more frames");
      started ??= output.start();
      await started;
      const sample = new VideoSample(canvas, {
        timestamp: timestampSec,
        duration: durationSec,
      });
      await source.add(sample);
      sample.close();
      frames += 1;
    },
    // Bytes or a reason, never an empty array: a 0-byte file stored as a
    // successful output is a Download button that does nothing, and the
    // render loop, the offscreen host and the editor all read `bytes` as
    // "it worked".
    async finish() {
      finished = true;
      if (frames === 0) {
        throw new Error("mp4 sink finished with no frame added");
      }
      started ??= output.start();
      await started;
      await output.finalize();
      const buffer = (output.target as BufferTarget).buffer;
      if (!buffer) {
        throw new Error(
          `mp4 muxer produced no bytes after ${frames} frame${frames === 1 ? "" : "s"}`,
        );
      }
      return new Uint8Array(buffer);
    },
  };
}
