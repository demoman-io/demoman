import { describe, expect, it } from "vitest";
import {
  createMotionRecorder,
  type FrameEncoder,
  type ReplayCounters,
  SPAN_MIN_FRAMES,
} from "../../src/index.js";

// What counts as the page reacting (spec 2026-10-19): real motion, a span
// that reached SPAN_MIN_FRAMES. A focused field's caret repaints one frame
// about every 500 ms, and must never read as the act still going on.

const counters = (): ReplayCounters =>
  ({ droppedMotionFrames: 0, motionFrames: 0 }) as unknown as ReplayCounters;

function recorder() {
  let now = 0;
  const encoder: FrameEncoder = {
    openSpan: () => undefined,
    push: async () => undefined,
    closeSpan: async () => null,
    queueDepth: () => 0,
    heapFraction: () => 0,
  };
  const c = counters();
  const r = createMotionRecorder({
    encoder,
    // Time moves only when a test paints; `sleep` yields a real tick so the
    // recorder's own quiet check runs between paints without moving it.
    clock: {
      now: () => now,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    },
    at: () => now,
    viewport: { width: 1280, height: 800 },
    counters: c,
    degradations: [],
    applyMetrics: async () => undefined,
    onSpan: () => undefined,
    mode: "continuous",
  } as never);
  let seen = 0;
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  const paintAt = async (ms: number) => {
    now = ms;
    // The recorder sees the time before the frame: a span quiet by now closes.
    await tick();
    seen++;
    // Not a JPEG: the frame is dropped after it reaches its span, which is
    // all this measures (the page painted).
    r.onFrame({ sessionId: seen, data: "", metadata: {} });
    await tick();
  };
  return { r, paintAt, frames: () => seen };
}

describe("lastMotionMs", () => {
  it("is not moved by a caret's one-frame repaints", async () => {
    const { r, paintAt, frames } = recorder();
    expect(SPAN_MIN_FRAMES).toBe(3);
    for (const ms of [0, 70, 140]) await paintAt(ms);
    // Each blink comes after the span before it went quiet (250 ms).
    for (const ms of [700, 1200, 1700]) await paintAt(ms);
    expect(frames(), "premise: six paints reached the recorder").toBe(6);
    expect(r.lastMotionMs()).toBe(140);
  });

  it("follows an open span once it is motion", async () => {
    const { r, paintAt } = recorder();
    await paintAt(0);
    await paintAt(50);
    expect(r.lastMotionMs()).toBeNull();
    await paintAt(100);
    expect(r.lastMotionMs()).toBe(100);
  });
});
