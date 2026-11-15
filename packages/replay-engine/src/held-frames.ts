import type { Degradation, MotionSpanEntry } from "@demoman/compositor";
import type { HeldFrame } from "./held-clock.js";
import { admitFrame, degradation } from "./span.js";
import type { FrameEncoder } from "./types.js";

/** A run of identical frames this long is a hold: a keyframe, no span. */
export const HOLD_MIN_FRAMES = 3;

export interface HeldFrames {
  add(frame: HeldFrame): Promise<void>;
  /** Closes the open span or hold at `endMs`. */
  finish(endMs: number): Promise<void>;
  /** The newest frame's bytes (a step's still reuses it). */
  latest(): HeldFrame | null;
}

const same = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

export function createHeldFrames(deps: {
  encoder: FrameEncoder;
  fileStill: (bytes: Uint8Array, atMs: number) => Promise<void>;
  onSpan: (entry: MotionSpanEntry) => void;
  /** Where a frame the encoder's budget skipped is said, as in the motion recorder. */
  degradations: Degradation[];
}): HeldFrames {
  const { encoder, fileStill, onSpan, degradations } = deps;
  /** The identical frames seen last (up to the hold length), not yet in the span. */
  let run: HeldFrame[] = [];
  let held = false;
  let newest: HeldFrame | null = null;
  let span: {
    startMs: number;
    /** The first frame pushed, filed as a keyframe if the span is dropped. */
    opened: HeldFrame | null;
    keyframeOnly: boolean;
    breach: Degradation | null;
    skipped: number;
  } | null = null;

  const push = async (frame: HeldFrame): Promise<void> => {
    span ??= {
      startMs: frame.sourceTimeMs,
      opened: null,
      keyframeOnly: false,
      breach: null,
      skipped: 0,
    };
    if (span.keyframeOnly) return;
    const verdict = admitFrame({
      inFlight: 0,
      queueDepth: encoder.queueDepth(),
      heapFraction: encoder.heapFraction(),
    });
    if (!verdict.admit) {
      if (verdict.keyframeOnly) {
        span.keyframeOnly = true;
        degradations.push(
          degradation(
            "keyframeOnly",
            span.startMs,
            frame.sourceTimeMs,
            `heap high-water at ${encoder.heapFraction().toFixed(2)}`,
          ),
        );
      } else {
        span.skipped++;
        if (span.breach === null) {
          span.breach = degradation(
            "budgetBreach",
            frame.sourceTimeMs,
            frame.sourceTimeMs,
            "",
          );
          degradations.push(span.breach);
        }
        span.breach.endMs = frame.sourceTimeMs;
        span.breach.note = `${span.skipped} frames skipped: ${verdict.reason}`;
      }
      return;
    }
    if (span.opened === null) {
      encoder.openSpan(frame.sourceTimeMs);
      span.opened = frame;
    }
    await encoder.push({
      bytes: frame.bytes,
      ms: frame.sourceTimeMs,
      width: frame.width,
      height: frame.height,
    });
  };

  const close = async (endMs: number): Promise<void> => {
    const open = span;
    span = null;
    if (open?.opened == null) return;
    const encoded = await encoder.closeSpan(endMs);
    if (encoded === null) {
      // Too short to be motion, and no step files a still for this stretch.
      await fileStill(open.opened.bytes, open.opened.sourceTimeMs);
      degradations.push(
        degradation(
          "keyframeOnly",
          open.startMs,
          endMs,
          "a change too short to play as motion was kept as a still",
        ),
      );
      return;
    }
    onSpan({
      startMs: open.startMs,
      endMs,
      ref: encoded.ref,
      width: encoded.width,
      height: encoded.height,
      fps: encoded.fps,
      byteLength: encoded.byteLength,
    });
  };

  return {
    async add(frame) {
      newest = frame;
      const first = run[0];
      if (first !== undefined && same(first.bytes, frame.bytes)) {
        if (held) return;
        run.push(frame);
        if (run.length < HOLD_MIN_FRAMES) return;
        held = true;
        run = [first];
        // The span ends where the still page begins.
        if (span !== null) await push(first);
        await close(first.sourceTimeMs);
        await fileStill(first.bytes, first.sourceTimeMs);
        return;
      }
      if (!held) for (const f of run) await push(f);
      run = [frame];
      held = false;
    },

    // In a hold the span already closed where the hold began; `endMs` ends nothing.
    async finish(endMs) {
      if (!held) {
        // A short run after motion is motion; a short run alone is a still page.
        if (span !== null) for (const f of run) await push(f);
        else if (run[0] !== undefined) {
          await fileStill(run[0].bytes, run[0].sourceTimeMs);
        }
      }
      await close(endMs);
      run = [];
      held = false;
    },

    latest: () => newest,
  };
}
