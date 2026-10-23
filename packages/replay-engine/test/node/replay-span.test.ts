import { describe, expect, it } from "vitest";
import {
  admitFrame,
  degradation,
  HEAP_HIGH_WATER,
  MAX_ENCODE_QUEUE,
  MAX_FRAMES_IN_FLIGHT,
  SPAN_MAX_MS,
  SPAN_QUIET_MS,
  spanEnded,
  spanEndMs,
  spanFps,
  spanIsMotion,
} from "../../src/index.js";

const clean = { inFlight: 0, queueDepth: 0, heapFraction: 0.2 };

describe("admitFrame", () => {
  it("admits a frame when nothing is under pressure", () => {
    expect(admitFrame(clean)).toEqual({ admit: true });
  });

  it("skips a motion frame once the in-flight budget is full", () => {
    expect(admitFrame({ ...clean, inFlight: MAX_FRAMES_IN_FLIGHT })).toEqual({
      admit: false,
      reason: "inFlight",
      keyframeOnly: false,
    });
  });

  it("skips a motion frame when the encoder is not keeping pace", () => {
    expect(admitFrame({ ...clean, queueDepth: MAX_ENCODE_QUEUE + 1 })).toEqual({
      admit: false,
      reason: "encodeQueue",
      keyframeOnly: false,
    });
  });

  // v9: heap is the one breach that degrades the *rest of the span*, not just
  // this frame. Thinning motion cannot recover memory already committed.
  it("degrades the span to keyframe-only at the heap high-water mark", () => {
    expect(admitFrame({ ...clean, heapFraction: HEAP_HIGH_WATER })).toEqual({
      admit: false,
      reason: "heap",
      keyframeOnly: true,
    });
  });

  it("reports heap pressure ahead of a full queue, since it is the worse one", () => {
    expect(
      admitFrame({ inFlight: 9, queueDepth: 99, heapFraction: 0.95 }),
    ).toMatchObject({ reason: "heap", keyframeOnly: true });
  });
});

describe("spanEnded", () => {
  it("keeps a span open while frames keep arriving", () => {
    expect(spanEnded(1000, 500, 900)).toBe(false);
  });

  it("ends a span that has gone quiet", () => {
    expect(spanEnded(900 + SPAN_QUIET_MS, 500, 900)).toBe(true);
  });

  // A page that animates forever (a spinner, a carousel) must not hold the
  // replay open forever with it.
  it("ends a span at the ceiling however busy the page is", () => {
    expect(spanEnded(500 + SPAN_MAX_MS, 500, 500 + SPAN_MAX_MS)).toBe(true);
  });
});

describe("spanEndMs", () => {
  it("ends where the painting ended, not where someone noticed", () => {
    // Last frame at 100, noticed at 5000: the span went quiet at 350.
    expect(spanEndMs(5000, 0, 100)).toBe(100 + SPAN_QUIET_MS);
  });

  it("is never later than now, nor longer than the ceiling, nor before its start", () => {
    expect(spanEndMs(200, 0, 100)).toBe(200);
    expect(spanEndMs(SPAN_MAX_MS + 500, 0, SPAN_MAX_MS + 400)).toBe(
      SPAN_MAX_MS,
    );
    expect(spanEndMs(50, 100, 100)).toBe(100);
  });
});

describe("spanIsMotion", () => {
  // Screencast emits only on paint, so "frames arrived" is the motion
  // detector — but a handful of frames is a repaint, not motion. A span kept
  // for those would hand the compositor a surface-capped still where a full
  // keyframe of the same instant already exists.
  //
  // The boundary is measured rather than chosen, so the literals here are
  // the two measured populations rather than restatements of the constant:
  // against real Chromium a click that changes nothing paints once or twice
  // and never three times (n=150), while a click that opens an 800ms
  // transition paints 49 or 50 times (n=12). See `SPAN_MIN_FRAMES`.
  it("rejects the whole repaint population, one frame and two alike", () => {
    expect(spanIsMotion(1)).toBe(false);
    expect(spanIsMotion(2)).toBe(false);
  });

  it("accepts a span from the first frame count no repaint reached", () => {
    expect(spanIsMotion(3)).toBe(true);
  });

  it("accepts a span the size real motion actually produces", () => {
    expect(spanIsMotion(49)).toBe(true);
  });
});

describe("spanFps", () => {
  it("reports frames over the span's own duration", () => {
    expect(spanFps(30, 1000, 1500)).toBe(60);
  });

  it("never reports zero for a zero-length span", () => {
    expect(spanFps(3, 1000, 1000)).toBeGreaterThan(0);
  });
});

describe("degradation", () => {
  it("records what was lost and when, for the bundle and the counter alike", () => {
    expect(degradation("keyframeOnly", 100, 900, "heap high-water")).toEqual({
      startMs: 100,
      endMs: 900,
      kind: "keyframeOnly",
      note: "heap high-water",
    });
  });
});
