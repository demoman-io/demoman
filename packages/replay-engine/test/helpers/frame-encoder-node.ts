import type { EncodedSpan, FrameEncoder } from "../../src/index.js";
import { SPAN_MIN_FRAMES, spanFps, spanIsMotion } from "../../src/index.js";
import type { MemoryFrameStore } from "./frame-store";

/**
 * A `FrameEncoder` with no WebCodecs under it.
 *
 * `createWebCodecsEncoder` is the production encoder and the one Task 10's
 * browser lane exercises, but it cannot run here: it calls
 * `createImageBitmap` and drives a `VideoEncoder`, and node has neither. The
 * integration lane runs from node because that is the only place a debugger
 * session can be held, so the muxer has to be left on the other side of that
 * line.
 *
 * What is deliberately *not* faked is the decision this lane cares about.
 * Whether a span counts as motion is `spanIsMotion` from core, applied to
 * frames that a real Chromium really emitted — so "the animating click keeps
 * a span and the static one does not" is still answered by the browser's
 * paint behaviour, not by a stub agreeing with us. Only the bytes-to-MP4 step
 * is replaced, and the stored span is the raw JPEGs instead.
 */
/** One span the engine opened and closed, whether or not it survived
 *  `spanIsMotion`. The engine's bundle only carries the survivors, and a
 *  test that wants to say "the static click painted twice and the animating
 *  one fifty times" needs the discarded ones too. */
export interface ClosedSpan {
  frames: number;
  kept: boolean;
  /** How long the span stayed open, from the engine's own clock. The frame
   *  count is a paint rate and so belongs to the machine — the runner paints
   *  about a third as often as a dev laptop — but this is set by the CSS
   *  transition under test and is the same everywhere. A test that wants to
   *  say "it painted *throughout* the animation" has to read this; frames
   *  alone cannot tell continuous painting from a burst. */
  durationMs: number;
}

export function createNodeFrameEncoder(
  store: Pick<MemoryFrameStore, "putSpan">,
  sceneId: string,
  minFrames: number = SPAN_MIN_FRAMES,
): FrameEncoder & {
  spans(): ClosedSpan[];
  /** Every frame the engine pushed, in push order, with its run time — the
   *  raw JPEGs a pixel assertion decodes. */
  pushed(): { ms: number; bytes: Uint8Array }[];
} {
  let open: {
    startMs: number;
    index: number;
    frames: Uint8Array[];
    width: number;
    height: number;
  } | null = null;
  let spanIndex = 0;
  const closed: ClosedSpan[] = [];
  const pushed: { ms: number; bytes: Uint8Array }[] = [];

  return {
    spans: () => [...closed],
    pushed: () => [...pushed],

    openSpan(startMs) {
      open = {
        startMs,
        index: spanIndex++,
        frames: [],
        width: 0,
        height: 0,
      };
    },

    async push(frame) {
      const span = open;
      if (span === null) throw new Error("push() with no span open");
      span.frames.push(frame.bytes);
      pushed.push({ ms: frame.ms, bytes: frame.bytes });
      span.width = frame.width;
      span.height = frame.height;
    },

    async closeSpan(endMs): Promise<EncodedSpan | null> {
      const span = open;
      open = null;
      if (span === null) return null;
      const kept = spanIsMotion(span.frames.length, minFrames);
      closed.push({
        frames: span.frames.length,
        kept,
        durationMs: endMs - span.startMs,
      });
      if (!kept) return null;
      const total = span.frames.reduce((n, f) => n + f.length, 0);
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const frame of span.frames) {
        bytes.set(frame, offset);
        offset += frame.length;
      }
      const ref = await store.putSpan(sceneId, span.index, bytes);
      return {
        ref,
        width: span.width,
        height: span.height,
        fps: spanFps(span.frames.length, span.startMs, endMs),
        frames: span.frames.length,
        byteLength: bytes.byteLength,
      };
    },

    queueDepth: () => 0,
    heapFraction: () => 0,
  };
}
