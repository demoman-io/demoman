import type { Degradation } from "@demoman/compositor";
import {
  CAPTURE_MOTION_BUDGET_BYTES,
  HEAP_HIGH_WATER,
  MAX_ENCODE_QUEUE,
  MAX_FRAMES_IN_FLIGHT,
  SPAN_MAX_MS,
  SPAN_MIN_FRAMES,
  SPAN_QUIET_MS,
} from "./constants.js";

export type AdmitVerdict =
  | { admit: true }
  | {
      admit: false;
      reason: "inFlight" | "encodeQueue" | "heap";
      /** True when the rest of the span must go keyframe-only, not just
       *  this frame. */
      keyframeOnly: boolean;
    };

/**
 * v9's budget table as one decision. Degradation is keyframe-only, never
 * OOM: a demo with fewer motion frames is a lesser render, a crashed replay
 * is a broken promise.
 */
export function admitFrame(budget: {
  inFlight: number;
  queueDepth: number;
  heapFraction: number;
}): AdmitVerdict {
  // Heap first: it is the only breach thinning frames cannot recover from,
  // so a page under all three pressures should report the one that matters.
  if (budget.heapFraction >= HEAP_HIGH_WATER) {
    return { admit: false, reason: "heap", keyframeOnly: true };
  }
  if (budget.inFlight >= MAX_FRAMES_IN_FLIGHT) {
    return { admit: false, reason: "inFlight", keyframeOnly: false };
  }
  if (budget.queueDepth > MAX_ENCODE_QUEUE) {
    return { admit: false, reason: "encodeQueue", keyframeOnly: false };
  }
  return { admit: true };
}

export function spanEnded(
  now: number,
  startMs: number,
  lastFrameMs: number,
): boolean {
  return now - lastFrameMs >= SPAN_QUIET_MS || now - startMs >= SPAN_MAX_MS;
}

/**
 * Where a span ends: where its painting ended — its last frame plus the
 * quiet window, the instant it would have been declared quiet had anything
 * been polling — never later than `now`, never longer than `SPAN_MAX_MS`,
 * never before it started. The one rule both recorders close by: capture's
 * `forceCloseOpenSpan` and replay's `motion-recorder.ts`.
 */
export function spanEndMs(
  now: number,
  startMs: number,
  lastFrameMs: number,
): number {
  return Math.max(
    startMs,
    Math.min(now, lastFrameMs + SPAN_QUIET_MS, startMs + SPAN_MAX_MS),
  );
}

/** Whether a span that ended `now` ended because the page stopped
 *  painting, rather than at the ceiling while it was still painting. */
export function spanWentQuiet(now: number, lastFrameMs: number): boolean {
  return now - lastFrameMs >= SPAN_QUIET_MS;
}

/**
 * Whether `keptBytes` of kept motion has used up the budget. Charged after
 * the frame or span that crosses the line is kept, so that one is whole
 * rather than half-written; the next is refused. Capture's harvester and a
 * continuous replay share it, with capture's own budget as the default.
 */
export function motionBudgetSpent(
  keptBytes: number,
  budgetBytes: number = CAPTURE_MOTION_BUDGET_BYTES,
): boolean {
  return keptBytes >= budgetBytes;
}

export function spanIsMotion(
  frames: number,
  min: number = SPAN_MIN_FRAMES,
): boolean {
  return frames >= min;
}

export function spanFps(
  frames: number,
  startMs: number,
  endMs: number,
): number {
  const seconds = Math.max(endMs - startMs, 1) / 1000;
  return frames / seconds;
}

export function degradation(
  kind: Degradation["kind"],
  startMs: number,
  endMs: number,
  note: string,
): Degradation {
  return { startMs, endMs, kind, note };
}
