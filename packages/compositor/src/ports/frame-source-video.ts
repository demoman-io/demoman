import {
  ALL_FORMATS,
  BufferSource,
  CanvasSink,
  Input,
  type WrappedCanvas,
} from "mediabunny";
import {
  coversViewport,
  type FrameBundle,
  type MotionSpanEntry,
  servingMotionSpan,
} from "../bundle.js";
import { shouldReseek } from "./decode-walk.js";
import { findKeyframe, keyframesBetween } from "./keyframe.js";
import type { FrameImage, FrameSource, UnavailableSpan } from "./types.js";

/**
 * Why one span's bytes will not serve frames, or the sink that will.
 * Nothing here is allowed to throw: a span that cannot be demuxed is a
 * degraded render, not a failed one.
 */
async function openSpan(
  bytes: Uint8Array,
): Promise<{ sink: CanvasSink } | { reason: string }> {
  try {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(bytes),
    });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return { reason: "no video track in the encoded span" };
    if (!(await track.canDecode())) {
      return { reason: `cannot decode ${track.codec ?? "an unknown codec"}` };
    }
    return { sink: new CanvasSink(track) };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Motion spans arrive encoded (v9: raw frames are never accumulated), so the
 * compositor decodes them to composite. That costs one H.264 generation on
 * motion spans; keyframes take none and carry the deliverable's resolution.
 *
 * A span whose bytes will not demux or decode is absent from `sinks`, so
 * `at()` falls through to the keyframe path for that span's time range —
 * the degraded-but-working path a partially-broken bundle must still take.
 * Forgiven, never silent: until 2026-09-06 the skip was a bare `continue`,
 * the picture froze on the preceding keyframe for the span's whole window,
 * and the render reported success with no violations. Each skip is now
 * reported to `onSpanUnavailable` as it happens and listed by
 * `unavailable()` for `RenderResult`. A `load` that throws still throws:
 * that is the store failing, not the span.
 */
export async function createVideoFrameSource(
  bundle: FrameBundle,
  load: (ref: string) => Promise<Uint8Array | FrameImage>,
  options: {
    onSpanUnavailable?: (ref: string, reason: string) => void;
  } = {},
): Promise<FrameSource> {
  const sinks = new Map<string, CanvasSink>();
  const unavailable: UnavailableSpan[] = [];
  const skip = (ref: string, reason: string): void => {
    unavailable.push({ ref, reason });
    options.onSpanUnavailable?.(ref, reason);
  };

  for (const span of bundle.motionSpans) {
    const loaded = await load(span.ref);
    if (!(loaded instanceof Uint8Array)) {
      skip(span.ref, "loaded as an image, not encoded bytes");
      continue;
    }
    const opened = await openSpan(loaded);
    if ("reason" in opened) {
      skip(span.ref, opened.reason);
      continue;
    }
    sinks.set(span.ref, opened.sink);
  }

  const stills = new Map<string, Promise<FrameImage>>();
  const still = (ref: string): Promise<FrameImage> => {
    const hit = stills.get(ref);
    if (hit) return hit;
    const pending = load(ref).then((value) => {
      if (value instanceof Uint8Array) {
        throw new Error(
          `keyframe "${ref}" must load as an image, not encoded bytes`,
        );
      }
      return value;
    });
    stills.set(ref, pending);
    return pending;
  };

  /** Span-relative seconds: the encoded span starts at its own zero, not at
   *  its position on the source timeline. */
  /**
   * Where the decoder currently stands in one span.
   *
   * `CanvasSink.getCanvas` is random access, and calling it once per output
   * frame is what held the editor's preview at 47 of the 60 frames a second
   * it asked for: measured in Chromium on a 2560x1600 span, 15.09ms per
   * frame against 4.43ms walking `canvases()` forward, which pre-decodes
   * ahead. Playback is monotonic, so nearly every request can walk; a scrub
   * is not, so `shouldReseek` decides and a re-seek starts a new iterator.
   *
   * `current` is the frame being served and `pending` is the one after it,
   * peeked to know whether to advance — `getCanvas` returns the last frame
   * whose timestamp is at or before the instant asked for, and matching that
   * exactly needs a look at the next one. Holding two at once is safe
   * because the sink is built with no canvas pool, so each yields its own.
   */
  interface Walk {
    ref: string;
    iterator: AsyncGenerator<WrappedCanvas, void, unknown>;
    current: WrappedCanvas | null;
    pending: WrappedCanvas | null;
    exhausted: boolean;
  }
  let walk: Walk | null = null;

  /**
   * Let go of a walk that is being replaced.
   *
   * An abandoned iterator is not collected, it is parked. `canvases()` runs a
   * pump loop that pre-decodes ahead and then waits on mediabunny's
   * backpressure promise, and only `next()` or `return()` settles that — so
   * dropping the reference leaves the loop alive, its `finally` unreached and
   * the `VideoDecoder` it closes there open, still holding every frame it had
   * queued. At a 2560x1600 span that is megabytes apiece, and the editor
   * re-seeks on every backwards step of the playhead, which while a scrub is
   * being dragged can be once per animation frame.
   */
  const letGo = async (abandoned: Walk): Promise<void> => {
    try {
      await abandoned.iterator.return();
    } catch (error) {
      // Forgiven, because a decoder that will not close cannot be allowed to
      // fail the frame being served. Not silent, because what it means is
      // that a decoder and its queued frames are still held, and the next
      // scrub will hold another.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[demoman] compositor: a decode walk on span "${abandoned.ref}" ` +
          `would not close (${reason}); its decoder is still held`,
      );
    }
  };

  const frameFrom = async (
    span: MotionSpanEntry,
    sourceTimeMs: number,
  ): Promise<FrameImage | null> => {
    const sink = sinks.get(span.ref);
    if (!sink) return null;
    const wanted = (sourceTimeMs - span.startMs) / 1000;

    const standing =
      walk !== null && walk.ref === span.ref && walk.current !== null
        ? { servedSeconds: walk.current.timestamp }
        : null;
    if (shouldReseek(standing, wanted)) {
      const abandoned = walk;
      walk = {
        ref: span.ref,
        iterator: sink.canvases(wanted),
        current: null,
        pending: null,
        exhausted: false,
      };
      // Not awaited: closing the old decoder must not delay the frame the new
      // one is being opened to serve. `letGo` settles its own failure, so
      // there is no rejection left for the page to catch.
      if (abandoned) void letGo(abandoned);
    }
    const at = walk as Walk;

    // Advance to the last frame at or before `wanted`, which is what
    // `getCanvas` would have answered with.
    for (;;) {
      if (at.pending === null && !at.exhausted) {
        const next = await at.iterator.next();
        if (next.done) at.exhausted = true;
        else at.pending = next.value;
      }
      if (at.pending === null) break;
      // The first frame after a seek is taken whatever its timestamp: the
      // iterator started there, so it is the one covering this instant.
      if (at.current !== null && at.pending.timestamp > wanted) break;
      at.current = at.pending;
      at.pending = null;
    }

    const result = at.current;
    if (!result) return null;
    return {
      image: result.canvas,
      width: result.canvas.width,
      height: result.canvas.height,
      // The decoder's own timestamp rebased onto the take, not the time
      // requested: the sample covering an instant can be tens of ms earlier
      // at low frame rates.
      sourceTimeMs: span.startMs + result.timestamp * 1000,
    };
  };

  /**
   * The span whose last frame is still the most recent picture at this
   * instant — later than the newest keyframe, and already finished.
   *
   * There is always a gap between a span's end and the keyframe that follows
   * it, and it cannot be closed where it is made: the engine shoots the
   * moment the span closes, and a `Page.captureScreenshot` of a 5130x2520
   * page is not instant. Measured on a two-navigation take through the real
   * engine, the gaps were 114ms and 157ms — about nine output frames apiece.
   *
   * Answering that gap with `findKeyframe` alone is answering it with the
   * nearest keyframe *at or before*, and across a navigation that is the page
   * the take has already left. The video arrived on the new page inside the
   * span, snapped back to the old one for the gap, and arrived a second time
   * at the next keyframe — a flip per navigation, which is what the author
   * saw and what no assertion in this package could see, because the
   * keyframes either side of it are in perfect order.
   *
   * `coversViewport` is applied here as well as in `servingMotionSpan`. A
   * span refused for drawing inside its own window must not come back as the
   * answer to the gap after it; the two are the same claim about the same
   * pixels, and forgetting it here would reintroduce the stretch through the
   * back door.
   */
  const trailingSpan = (
    sourceTimeMs: number,
    keyframeMs: number,
  ): MotionSpanEntry | null =>
    bundle.motionSpans.reduce<MotionSpanEntry | null>((best, span) => {
      if (span.endMs > sourceTimeMs || span.endMs <= keyframeMs) return best;
      if (!coversViewport(span, bundle.viewport)) return best;
      return best === null || span.endMs > best.endMs ? span : best;
    }, null);

  return {
    async at(sourceTimeMs: number): Promise<FrameImage> {
      const span = servingMotionSpan(bundle, sourceTimeMs);
      if (span) {
        const frame = await frameFrom(span, sourceTimeMs);
        if (frame) return frame;
      }
      const keyframe = findKeyframe(bundle, sourceTimeMs);
      const trailing = trailingSpan(sourceTimeMs, keyframe.sourceTimeMs);
      if (trailing) {
        // Its own end, not `sourceTimeMs`: the span is over, and what it
        // leaves on screen is the last thing it painted.
        const frame = await frameFrom(trailing, trailing.endMs);
        if (frame) return frame;
      }
      return {
        ...(await still(keyframe.ref)),
        sourceTimeMs: keyframe.sourceTimeMs,
      };
    },
    warm(fromSourceMs: number, toSourceMs: number): void {
      for (const keyframe of keyframesBetween(
        bundle,
        fromSourceMs,
        toSourceMs,
      )) {
        // Only this reference forgives: the failed load stays cached, and the
        // draw that reaches this still rejects with its reason.
        still(keyframe.ref).catch(() => undefined);
      }
    },
    describe: () => ({
      keyframes: bundle.keyframes,
      motionSpans: bundle.motionSpans,
    }),
    unavailable: () => [...unavailable],
  };
}
