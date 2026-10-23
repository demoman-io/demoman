import {
  coversViewport,
  type Degradation,
  type FrameBundle,
} from "@demoman/compositor";
import { CAPTURE_MOTION_BUDGET_BYTES, SPAN_MIN_FRAMES } from "./constants.js";
import { decodeBase64, jpegSize } from "./image.js";
import {
  admitFrame,
  degradation,
  motionBudgetSpent,
  spanEnded,
  spanEndMs,
  spanWentQuiet,
} from "./span.js";
import type {
  Clock,
  EncodedSpan,
  FrameEncoder,
  ReplayCounters,
} from "./types.js";

export type MotionSpanEntry = FrameBundle["motionSpans"][number];

export interface MotionRecorderDeps {
  encoder: FrameEncoder;
  /** For `close()`'s quiet-threshold polling. */
  clock: Clock;
  /** Run-relative milliseconds — the engine's own `at()`. */
  at: () => number;
  /** The viewport this run emulates, and the shape every frame must be a
   *  scale of. See `coversViewport`. */
  viewport: { width: number; height: number };
  /** Shared with the engine and mutated in place: every count below is the
   *  engine's own counter, persisted and turned into telemetry. */
  counters: ReplayCounters;
  /** Shared with the engine and pushed to, for the same reason. */
  degradations: Degradation[];
  /** The engine's metrics re-assert, sent when a frame shows the surface
   *  has drifted from the override. */
  applyMetrics: () => Promise<void>;
  /** A closed span the encoder kept. The engine owns the bundle's
   *  `motionSpans` array (its hover check reads the length across a beat),
   *  so the recorder hands each one back rather than holding the list. */
  onSpan: (entry: MotionSpanEntry) => void;
  /**
   * `"continuous"` (spec 2026-10-03 §2): a frame that arrives with no span
   * open opens one, and every span closes itself on capture's rule — after
   * SPAN_QUIET_MS without a frame, or at SPAN_MAX_MS of continuous paint.
   * `"sampled"`, the default: spans open and close only when the walk says
   * so, exactly as before.
   */
  mode?: "continuous" | "sampled";
  /**
   * Continuous only. A span was just retired because the page went quiet,
   * at `atMs`. Called before the encoder's close is awaited — the walk
   * takes its settled still here, and finalising a span takes 0.5–0.8 s.
   * Never called for a span retired at the ceiling while still painting.
   * `frames` is how many the span was offered: a one- or two-frame blip (a
   * caret blinking) is not motion, and the walk decides whether it is
   * worth a still.
   */
  onSettled?: (atMs: number, frames: number) => void;
  /** Continuous only. Bytes of kept motion before the rest of the run is
   *  stills. Defaults to capture's own budget. */
  motionBudgetBytes?: number;
}

export interface MotionRecorder {
  /**
   * A screencast frame, after the engine has acked it. The ack stays with
   * the CDP session: Chrome stops sending until the previous frame is
   * acknowledged, whether or not a span is open here.
   */
  onFrame(params: Record<string, unknown>): void;
  /** Open a span at `at()`. The screencast runs for the life of the run;
   *  a span is a logical window over that continuous stream. */
  open(): void;
  /** Wait out the quiet threshold, close the encoder's span, and hand back
   *  what it kept — or null when it held too few frames to be motion. */
  close(): Promise<MotionSpanEntry | null>;
  /** The engine's `finally`: close what is open, and if that fails, still
   *  release the encoder's span so its frames are not held for the rest of
   *  the process. */
  teardown(): Promise<void>;
  isOpen(): boolean;
  /**
   * Continuous only: the `at()` of the latest frame of real motion, a span
   * (or a paint run past the budget) that has reached `SPAN_MIN_FRAMES`;
   * an open span counts from its third frame. Null until there is one. A
   * focused field's caret repaints one frame at a time and never moves it,
   * so it can say when the page stopped reacting to a step (spec
   * 2026-10-19, unhurried beats).
   */
  lastMotionMs(): number | null;
}

interface OpenSpan {
  startMs: number;
  lastFrameMs: number;
  /** Frames that reached this span, admitted or not: the page painted. */
  paints: number;
  keyframeOnly: boolean;
  /** Whether this span has already reported a surface mismatch. One report
   *  per span, not one per frame: the surface stays wrong until the
   *  override is re-asserted, so at paint rate an unguarded push would put
   *  hundreds of identical degradations in the bundle and drown every
   *  other thing it has to say. */
  surfaceReported: boolean;
  /** The same, for an encoder that refused a frame: the one entry, kept
   *  current, and the counts its note is written from. */
  refusal: { entry: Degradation; refused: number; reason: string } | null;
  /** Frames handed to the encoder in this span, and the size of the first:
   *  the encoder configures itself from that one, so a span it refuses
   *  wholesale is explained by it. */
  pushed: number;
  openedOn: { width: number; height: number } | null;
  /** Frames that reached the budget check in this span. */
  offered: number;
  /** One report per budget reason per span, kept current as frames arrive:
   *  a skipped frame used to be a degradation of its own, and one take's 37
   *  became 37 identical cards in the editor, none of which said how many
   *  frames the span had in all — the one number that says whether 37 is a
   *  thinning or a slideshow. The counters still count frames. */
  breaches: Map<string, { entry: Degradation; skipped: number }>;
}

const breachNote = (skipped: number, offered: number, reason: string) =>
  `${skipped} of ${offered} motion frames skipped (${reason})`;

/** How much of the span the encoder lost, not only that it lost some: a
 *  span missing one frame and a span missing all of them read the same
 *  until 2026-10-11, and the loss could not be measured. */
const refusalNote = (
  refused: number,
  pushed: number,
  openedOn: { width: number; height: number } | null,
  reason: string,
) =>
  `the encoder refused ${refused} of ${pushed} frames of a span that ` +
  `opened on ${openedOn?.width ?? 0}x${openedOn?.height ?? 0} (${reason})`;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Null when the payload is not base64 — a truncated frame off a dying
 *  session, which has no bytes to encode and nothing to salvage. */
function safeDecode(data: string): Uint8Array | null {
  try {
    return decodeBase64(data);
  } catch {
    return null;
  }
}

/** A screencast frame whose bytes will not parse still has metadata; the
 *  frame is worth keeping at the size CDP reported for it. */
function safeJpegSize(
  bytes: Uint8Array,
  metadata: { deviceWidth?: number; deviceHeight?: number },
): { width: number; height: number } {
  try {
    return jpegSize(bytes);
  } catch {
    return {
      width: Math.round(metadata.deviceWidth ?? 0) || 1,
      height: Math.round(metadata.deviceHeight ?? 0) || 1,
    };
  }
}

/**
 * The replay run's motion recorder: which screencast frames reach the
 * encoder, under what budget, and the spans they are charged to.
 *
 * Extracted from `engine.ts` on the shape of `capture-motion.ts`, so that
 * the intake's branches are testable by calling them rather than by
 * driving a whole run and hijacking the encoder port. Behaviour is the
 * engine's, verbatim; the engine keeps the CDP subscription, the ack, and
 * the bundle's `motionSpans` array.
 */
export function createMotionRecorder(deps: MotionRecorderDeps): MotionRecorder {
  const { encoder, clock, at, viewport, counters, degradations } = deps;

  // Frames arrive whether or not a span is open. A span is only *kept* if
  // frames arrived, which is the whole motion detector: screencast emits
  // on paint.
  let span: OpenSpan | null = null;
  let inFlight = 0;
  /** Whether `encoder.openSpan` is outstanding. Tracked separately from
   *  `span` because the two are closed on different paths. */
  let encoderSpanOpen = false;
  /** See `MotionRecorder.lastMotionMs`. */
  let lastMotion: number | null = null;

  const continuous = deps.mode === "continuous";
  const budgetBytes = deps.motionBudgetBytes ?? CAPTURE_MOTION_BUDGET_BYTES;
  /** Continuous only: every span's own close, still running. */
  const pending = new Set<Promise<void>>();
  let keptBytes = 0;
  /** Continuous only: the degradation that says the budget ran out, kept so
   *  its end can follow the run. */
  let spent: Degradation | null = null;
  /**
   * Continuous only, past the budget: the paint run in progress, tracked
   * the way a span is but kept nowhere. Spans stop opening once the budget
   * is spent, and `onSettled` used to ride on a span closing — so the rest
   * of the run took no settled still at all, and a click that opened a
   * panel held the pre-click marker still until the next step's, while the
   * degradation promised "stills" (review of 2026-10-03).
   */
  let spentRun: {
    startMs: number;
    lastFrameMs: number;
    frames: number;
  } | null = null;

  /** Continuous only: a close or watch running in the background, which
   *  teardown waits for. */
  const track = (work: Promise<void>): void => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  /** Wait for a paint run past the budget to end on the span rule, and
   *  settle it the way a span that went quiet is settled. */
  const watchSpentRun = async (run: {
    startMs: number;
    lastFrameMs: number;
    frames: number;
  }): Promise<void> => {
    while (!spanEnded(at(), run.startMs, run.lastFrameMs)) {
      await clock.sleep(50);
    }
    spentRun = null;
    if (spanWentQuiet(at(), run.lastFrameMs)) {
      deps.onSettled?.(
        spanEndMs(at(), run.startMs, run.lastFrameMs),
        run.frames,
      );
    }
  };

  const onFrame = (params: Record<string, unknown>): void => {
    if (continuous && span === null) {
      if (spent !== null) {
        counters.droppedMotionFrames++;
        spent.endMs = at();
        if (spentRun === null) {
          spentRun = { startMs: at(), lastFrameMs: at(), frames: 1 };
          track(watchSpentRun(spentRun));
        } else {
          spentRun.lastFrameMs = at();
          spentRun.frames++;
          if (spentRun.frames >= SPAN_MIN_FRAMES) lastMotion = at();
        }
        return;
      }
      open();
      const openedAt = at();
      // The span closes itself. Forgiven, because one span the encoder
      // could not finish must not fail the take; reported, because a
      // missing stretch of motion must not read as a page that held still.
      // Over the span's own range: a zero-length one at the failure instant
      // is dropped by the timeline's merge, and the lost motion would read
      // as idle an authored gap may compress.
      const closing = close().then(
        () => undefined,
        (error: unknown) => {
          degradations.push(
            degradation(
              "encodeRefused",
              openedAt,
              Math.max(at(), openedAt + 1),
              `a span of motion could not be finished (${messageOf(error)})`,
            ),
          );
        },
      );
      track(closing);
    }
    const current = span;
    if (current === null) return;
    current.lastFrameMs = at();
    current.paints++;
    if (current.paints >= SPAN_MIN_FRAMES) lastMotion = current.lastFrameMs;
    if (current.keyframeOnly) {
      counters.droppedMotionFrames++;
      return;
    }

    current.offered++;
    for (const [reason, breach] of current.breaches) {
      breach.entry.note = breachNote(breach.skipped, current.offered, reason);
    }
    const verdict = admitFrame({
      inFlight,
      queueDepth: encoder.queueDepth(),
      heapFraction: encoder.heapFraction(),
    });
    counters.heapHighWater = Math.max(
      counters.heapHighWater,
      encoder.heapFraction(),
    );

    if (!verdict.admit) {
      counters.droppedMotionFrames++;
      counters.budgetBreaches++;
      if (verdict.keyframeOnly) {
        // Thinning frames cannot recover memory already committed, so the
        // rest of the span goes keyframe-only. Never OOM.
        current.keyframeOnly = true;
        counters.keyframeOnlySpans++;
        degradations.push(
          degradation(
            "keyframeOnly",
            current.startMs,
            at(),
            `heap high-water at ${encoder.heapFraction().toFixed(2)}`,
          ),
        );
      } else {
        let breach = current.breaches.get(verdict.reason);
        if (breach === undefined) {
          breach = {
            entry: degradation("budgetBreach", at(), at(), ""),
            skipped: 0,
          };
          current.breaches.set(verdict.reason, breach);
          degradations.push(breach.entry);
        }
        breach.skipped++;
        breach.entry.endMs = at();
        breach.entry.note = breachNote(
          breach.skipped,
          current.offered,
          verdict.reason,
        );
      }
      return;
    }

    const metadata = (params.metadata ?? {}) as {
      deviceWidth?: number;
      deviceHeight?: number;
    };
    // `safeJpegSize` guards a JPEG this parser cannot read, but `atob`
    // throws first on data that is not base64 at all — so the guard has to
    // start here. A frame whose bytes will not decode is not a frame: count
    // it dropped and keep going, because invariant 4 is keyframe-only under
    // pressure, never a throw out of an event handler nobody can catch.
    const bytes = safeDecode(String(params.data ?? ""));
    if (bytes === null) {
      counters.droppedMotionFrames++;
      return;
    }
    const size = safeJpegSize(bytes, metadata);
    // A frame that is not the viewport at some scale cannot be drawn. The
    // compositor maps a source frame's full extent onto the full viewport
    // rect, so a frame of the window's surface is a magnified, unevenly
    // stretched corner of the page rather than a lower-resolution picture of
    // it — see `coversViewport`. Refused here, so it never reaches the
    // encoder: a span that mixes the two sizes is refused wholesale by
    // mediabunny ("Video sample size must remain constant"), which costs
    // every frame in it rather than the bad ones.
    //
    // Reported before it is forgiven. Dropping these silently would hand
    // back a bundle whose motion spans are short or missing for the same
    // reason a genuinely static page produces short or missing ones, and
    // the author would be told a broken recording succeeded.
    if (!coversViewport(size, viewport)) {
      counters.droppedMotionFrames++;
      counters.surfaceMismatchFrames++;
      if (!current.surfaceReported) {
        current.surfaceReported = true;
        degradations.push(
          degradation(
            "surfaceMismatch",
            current.startMs,
            at(),
            `screencast returned ${size.width}x${size.height} for a ` +
              `${viewport.width}x${viewport.height} viewport; re-asserting ` +
              `the metrics override`,
          ),
        );
        // The correction, and its own failure has somewhere to speak: if it
        // does not land, every later frame of this span is refused too and
        // the span is lost, which must not read as a page that held still.
        void deps.applyMetrics().catch((error: unknown) => {
          degradations.push(
            degradation(
              "surfaceMismatch",
              current.startMs,
              at(),
              `could not re-assert the metrics override (${messageOf(error)})`,
            ),
          );
        });
      }
      return;
    }
    counters.motionWidth = size.width;
    counters.motionHeight = size.height;
    counters.motionFrames++;
    current.pushed++;
    current.openedOn ??= size;
    if (current.refusal !== null) {
      const r = current.refusal;
      r.entry.note = refusalNote(
        r.refused,
        current.pushed,
        current.openedOn,
        r.reason,
      );
    }
    inFlight++;
    void encoder
      .push({ bytes, ms: at(), width: size.width, height: size.height })
      .catch((error: unknown) => {
        // Forgiven, because one frame the encoder would not take must not
        // fail a take — and reported, because until it was, it could not be
        // told apart from the memory budget doing its job. That silence cost
        // a debugging round: mediabunny refuses a mid-span resolution change
        // by default, the screencast changes resolution mid-span, and every
        // frame after the first change landed here and vanished. The span
        // then fell under `SPAN_MIN_FRAMES` and was dropped whole, so a take
        // whose frames were all correct shipped with no motion in it and
        // said nothing about why.
        counters.droppedMotionFrames++;
        counters.encodeRefusedFrames++;
        if (current.refusal === null) {
          current.refusal = {
            entry: degradation("encodeRefused", current.startMs, at(), ""),
            refused: 0,
            reason: `first, a ${size.width}x${size.height} frame: ${messageOf(error)}`,
          };
          degradations.push(current.refusal.entry);
        }
        const r = current.refusal;
        r.refused++;
        r.entry.endMs = at();
        r.entry.note = refusalNote(
          r.refused,
          current.pushed,
          current.openedOn,
          r.reason,
        );
      })
      .finally(() => {
        inFlight--;
      });
  };

  // No protocol call here any more: the screencast runs for the life of the
  // run (the engine starts it once, for the run, not per span), and a span
  // is a logical window over that continuous stream — the intake above
  // routes frames to the encoder exactly while `span` is non-null. Starting
  // the stream per span was what let the page report `hidden` between
  // spans, and occlusionTimeout took four of ten real runs that way
  // (2026-08-31-continuous-capture-design.md).
  const open = (): void => {
    span = {
      startMs: at(),
      lastFrameMs: at(),
      paints: 0,
      keyframeOnly: false,
      surfaceReported: false,
      refusal: null,
      pushed: 0,
      openedOn: null,
      offered: 0,
      breaches: new Map(),
    };
    encoder.openSpan(span.startMs);
    encoderSpanOpen = true;
  };

  /**
   * Close the encoder's span, at most once.
   *
   * The encoder holds a span of its own, and an open one pins every frame
   * pushed into it — which is the memory this whole budget exists to keep
   * down. It must therefore close however the page behaved: whether telling
   * the page to stop screencasting succeeded, failed, or was never reached
   * because teardown arrived first. The flag makes that idempotent, so the
   * failure path can close it without risking a second close on the path
   * that already did.
   */
  const closeEncoderSpan = async (
    endMs: number,
  ): Promise<EncodedSpan | null> => {
    if (!encoderSpanOpen) return null;
    encoderSpanOpen = false;
    return encoder.closeSpan(endMs);
  };

  const close = async (): Promise<MotionSpanEntry | null> => {
    const current = span;
    if (current === null) return null;
    // Wait out the quiet threshold before deciding the page has stopped
    // painting; the ceiling keeps a permanent animation from holding the
    // replay open with it.
    while (!spanEnded(at(), current.startMs, current.lastFrameMs)) {
      await clock.sleep(50);
    }
    const endMs = spanEndMs(at(), current.startMs, current.lastFrameMs);
    const quiet = spanWentQuiet(at(), current.lastFrameMs);
    // Retire the recorder-side span first: from here the intake ignores
    // frames — the stream keeps running — so a late frame cannot be charged
    // to a span that is already closing.
    span = null;
    if (continuous && quiet) deps.onSettled?.(endMs, current.offered);

    const encoded = await closeEncoderSpan(endMs);
    if (encoded === null) return null;
    const entry: MotionSpanEntry = {
      startMs: current.startMs,
      endMs,
      ref: encoded.ref,
      width: encoded.width,
      height: encoded.height,
      fps: encoded.fps,
      byteLength: encoded.byteLength,
    };
    counters.motionSpans++;
    if (encoded.shrunkFrom !== undefined) counters.encodeShrunkSpans++;
    deps.onSpan(entry);
    if (continuous && spent === null) {
      keptBytes += entry.byteLength;
      if (motionBudgetSpent(keptBytes, budgetBytes)) {
        spent = degradation(
          "keyframeOnly",
          endMs,
          endMs,
          `motion budget spent (${Math.round(budgetBytes / 1048576)} MB kept); the rest of the run is stills`,
        );
        degradations.push(spent);
        counters.keyframeOnlySpans++;
      }
    }
    return entry;
  };

  const teardown = async (): Promise<void> => {
    if (continuous) {
      // The open span, if any, already has its own close running: wait for
      // every one, so no span is still finalising when the bundle is built.
      while (pending.size > 0) await Promise.all([...pending]);
      if (spent !== null) spent.endMs = at();
      return;
    }
    try {
      await close();
    } catch {
      // Teardown is best effort. A session that has already gone away
      // cannot be told to stop screencasting — and if it is still there,
      // the attempt was made. Either way this must not replace the reason
      // the run actually stopped.
      span = null;
      // The one part of teardown that still has to happen: an encoder span
      // left open holds its frames for the rest of the process. Whatever it
      // encodes is dropped — the span's boundaries are not knowable here —
      // but the memory is released.
      await closeEncoderSpan(at()).catch(() => null);
    }
  };

  return {
    onFrame,
    open,
    close,
    teardown,
    isOpen: () => span !== null,
    lastMotionMs: () => lastMotion,
  };
}
