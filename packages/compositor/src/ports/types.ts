import type { KeyframeEntry, MotionSpanEntry } from "../bundle.js";

export interface FrameImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  /**
   * The source-timeline millisecond of the frame actually served, which is
   * NOT always the millisecond requested — a keyframe-only stretch serves the
   * nearest preceding keyframe however far away it is.
   *
   * Required, not optional: a consumer that diffs two arbitrary instants has
   * no other way to tell "the frame 20 ms from where I asked" from "the frame
   * 8 s from where I asked", and two requests resolving to one frame diff to
   * exactly zero — a stillness verdict from a comparison that never happened.
   */
  sourceTimeMs: number;
}

/**
 * Where pixels come from. The compositor does not care whether a frame was a
 * hi-res keyframe, an upscaled motion frame, or a fixture drawn on a canvas —
 * which is exactly what lets SP6 develop ahead of SP5.
 */
/** A motion span a frame source cannot serve, and why. */
export interface UnavailableSpan {
  ref: string;
  reason: string;
}

export interface FrameSource {
  at(sourceTimeMs: number): Promise<FrameImage>;
  describe(): { keyframes: KeyframeEntry[]; motionSpans: MotionSpanEntry[] };
  close?(): void;
  /**
   * Start decoding every still `at()` could answer with between two source
   * instants, without waiting for any of them, so a draw that reaches one
   * later does not wait on its decode. The editor's playback calls it a
   * little ahead of the playhead: a full-size still is 5130x3321 and its
   * first decode took tens of milliseconds, all of it dropped frames.
   */
  warm?(fromSourceMs: number, toSourceMs: number): void;
  /**
   * The spans `at()` will answer from the preceding keyframe instead of
   * from their own frames. A source that serves only stills has none to
   * lose and may leave this out; a source that demuxes must say, because
   * a frozen picture for the span's whole window looks exactly like a page
   * holding still, and `RenderResult` carries this out so it is not reported
   * as a clean render.
   */
  unavailable?(): UnavailableSpan[];
}

export interface Surface {
  create(width: number, height: number): OffscreenCanvas;
}

export interface VideoSink {
  addFrame(
    canvas: OffscreenCanvas,
    timestampSec: number,
    durationSec: number,
  ): Promise<void>;
  finish(): Promise<Uint8Array>;
}

export interface GifSink {
  addFrame(canvas: OffscreenCanvas, delayMs: number): Promise<void>;
  finish(): Promise<Uint8Array>;
}

export interface ImageSink {
  add(canvas: OffscreenCanvas, name: string): Promise<void>;
  finish(): Promise<{ name: string; bytes: Uint8Array }[]>;
}

export interface CompositorPorts {
  frames: FrameSource;
  surface: Surface;
  video?: VideoSink;
  gif?: GifSink;
  images?: ImageSink;
}
