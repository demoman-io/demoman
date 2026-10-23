import type { EncodedSpan, FrameEncoder } from "@demoman/replay-engine";
import { SPAN_MIN_FRAMES, spanFps, spanIsMotion } from "@demoman/replay-engine";
import type { RunnerStore } from "./frame-store.js";

/**
 * One span the encoder opened and closed, kept or not, and where its frames
 * are parked. The mux (Task 11) consumes this list to know which spans to
 * read back and mux; the bundle the engine produces only ever carries the
 * survivors (`kept: true`), so a caller that wants to say "the static click
 * painted twice" needs this list too, not the bundle.
 */
export interface ParkedSpan {
  index: number;
  ref: string;
  startMs: number;
  endMs: number;
  firstFrameIndex: number;
  frames: number;
  /** When each parked frame was painted, in source time, in index order
   *  from `firstFrameIndex`: the mux places each frame here. The span's own
   *  `endMs` is its last paint plus the quiet window, so spreading the
   *  frames evenly to it played every span's tail late (2026-10-19). */
  frameMs: number[];
  width: number;
  height: number;
  kept: boolean;
}

/**
 * A `FrameEncoder` with no WebCodecs under it — there is no node encoder
 * (design §3, "There is no node encoder"). `createMp4Sink` is mediabunny,
 * whose encode path is WebCodecs `VideoEncoder`, and node has none. So this
 * encoder does what the extension's capture already does when it faces the
 * same shape: it PARKS each pushed frame to the filesystem store rather than
 * encoding it, and hands back the span's ref. A later browser-side pass
 * (Task 11's mux) reads the parked frames back and turns them into a real
 * mp4 span before the render reads it.
 *
 * **The parked namespace is `${sceneId}:replay` — a contract with the mux,
 * not a local choice.** Task 11 derives the identical string to call
 * `store.readParked(namespace, span.firstFrameIndex, span.frames)`. Diverge
 * here and the mux reads an empty range and reports every span as a total
 * loss.
 *
 * Frame indices are a single counter across the whole encoder, not reset
 * per span: `firstFrameIndex` on each span is where the previous span's
 * indices ended, so two spans share one index space and `readParked`'s
 * range read (by index, contiguous) can address either one.
 */
export function createParkingEncoder(
  store: RunnerStore,
  sceneId: string,
  minFrames: number = SPAN_MIN_FRAMES,
): FrameEncoder & { spans(): ParkedSpan[] } {
  const namespace = `${sceneId}:replay`;

  let open: {
    startMs: number;
    index: number;
    firstFrameIndex: number;
    frameCount: number;
    frameMs: number[];
    width: number;
    height: number;
  } | null = null;
  let spanIndex = 0;
  let nextFrameIndex = 0;
  const closed: ParkedSpan[] = [];
  let parking: Promise<unknown> = Promise.resolve();
  const park = async (
    span: NonNullable<typeof open>,
    frame: { bytes: Uint8Array; ms: number; width: number; height: number },
  ): Promise<void> => {
    const frameIndex = nextFrameIndex;
    // A park that fails REJECTS — it is not caught here. The engine's
    // motion recorder is the one `push` call site, and it already
    // forgives the rejection the way a take needs (one frame, not the
    // span), counts it (`droppedMotionFrames`, `encodeRefusedFrames`) and
    // reports it once per span, with the reason, as an `encodeRefused`
    // degradation on the bundle the pipeline prints. The extension's
    // WebCodecs encoder honours the same contract. A catch here (review
    // of the runner audit, finding 6) hid that path and rebuilt a noisier
    // copy of it one layer up. The counters below advance only after the
    // park lands, so `frames` stays the number the mux will find on disk
    // (`readParked` reads a contiguous range from `firstFrameIndex`), and
    // `frameMs` keeps one time per parked frame, in the same order.
    await store.putParked(namespace, frameIndex, frame.bytes);
    nextFrameIndex++;
    span.frameCount++;
    span.frameMs.push(frame.ms);
    span.width = frame.width;
    span.height = frame.height;
  };

  return {
    spans: () => [...closed],

    openSpan(startMs) {
      open = {
        startMs,
        index: spanIndex++,
        firstFrameIndex: nextFrameIndex,
        frameCount: 0,
        frameMs: [],
        width: 0,
        height: 0,
      };
    },

    push(frame) {
      // One park at a time, in the order pushed. The motion recorder does
      // not wait for a push before the next, and a write can finish out of
      // order: read before the await, two pushes took the same index, the
      // later bytes overwrote the earlier and the next index was never
      // written (code review, 2026-10-20). A park that fails still rejects
      // its own push and does not stop the ones queued behind it.
      // The span it was pushed into, not whichever is open when its turn
      // comes.
      const span = open;
      if (span === null) {
        return Promise.reject(new Error("push() with no span open"));
      }
      const parked = parking.then(() => park(span, frame));
      parking = parked.catch(() => undefined);
      return parked;
    },

    async closeSpan(endMs): Promise<EncodedSpan | null> {
      const span = open;
      open = null;
      if (span === null) return null;
      // Its frames still in line land before it is counted.
      await parking;
      const kept = spanIsMotion(span.frameCount, minFrames);
      const ref = `span:${sceneId}:${span.index}`;
      closed.push({
        index: span.index,
        ref,
        startMs: span.startMs,
        endMs,
        firstFrameIndex: span.firstFrameIndex,
        frames: span.frameCount,
        frameMs: span.frameMs,
        width: span.width,
        height: span.height,
        kept,
      });
      if (!kept) return null;
      return {
        ref,
        width: span.width,
        height: span.height,
        fps: spanFps(span.frameCount, span.startMs, endMs),
        frames: span.frameCount,
        // Not known here: the frames on disk are parked JPEGs, not an
        // encoded mp4, so the real byte count only exists once Task 11's
        // mux has produced it. That task patches the bundle's
        // `motionSpans[i].byteLength` after muxing. A fabricated number here
        // would be one nobody measured, and the storage lifecycle reads
        // this field — so it is 0 until the mux writes the true one.
        byteLength: 0,
      };
    },

    queueDepth: () => 0,
    heapFraction: () => 0,
  };
}
