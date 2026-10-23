import type { Degradation } from "@demoman/compositor";
import { describe, expect, it, vi } from "vitest";
import type {
  EncodedSpan,
  FrameEncoder,
  ReplayCounters,
} from "../../src/index.js";
import {
  createMotionRecorder,
  type MotionRecorderDeps,
  type MotionSpanEntry,
  SPAN_MAX_MS,
  SPAN_QUIET_MS,
} from "../../src/index.js";
import { fakeScreenshotBase64 } from "../helpers/cdp-fake";

/** The default encoder, with the budget dials exposed — the same stub the
 *  engine tests use, so a count asserted here means the same thing there.
 *  Each mock is typed to the `FrameEncoder` method it stands in for, not
 *  narrowed to its default return value — otherwise a later reassignment
 *  to a real span-shaped resolution (as two span tests below do for
 *  `closeSpan`) fails to typecheck against the stub's inferred type. */
function encoderStub(
  over: { queueDepth?: number; heapFraction?: number } = {},
) {
  return {
    openSpan: vi.fn<FrameEncoder["openSpan"]>(),
    push: vi.fn<FrameEncoder["push"]>(async () => undefined),
    closeSpan: vi.fn<FrameEncoder["closeSpan"]>(
      async (): Promise<EncodedSpan | null> => null,
    ),
    queueDepth: () => over.queueDepth ?? 0,
    heapFraction: () => over.heapFraction ?? 0.1,
  };
}

/** A screencast frame as CDP delivers one. */
function frame(sessionId: number, data = fakeScreenshotBase64()) {
  return {
    sessionId,
    data,
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
  };
}

function blankCounters(): ReplayCounters {
  return {
    actions: 1,
    completed: 0,
    replayThrough: 0,
    keyframes: 0,
    motionSpans: 0,
    motionFrames: 0,
    droppedMotionFrames: 0,
    surfaceMismatchFrames: 0,
    encodeRefusedFrames: 0,
    encodeShrunkSpans: 0,
    budgetBreaches: 0,
    keyframeOnlySpans: 0,
    occlusionPauses: 0,
    occlusionMs: 0,
    heapHighWater: 0,
    motionWidth: 0,
    motionHeight: 0,
    durationMs: 0,
    dpr: 1,
    viewportWidth: 1280,
    viewportHeight: 800,
  };
}

/**
 * A recorder over a manual clock. `now` advances only when a test says so,
 * and `clock.sleep` advances it — so `close()`'s quiet-threshold polling
 * runs to completion without real time passing.
 */
function harness(over: Partial<MotionRecorderDeps> = {}) {
  let now = 0;
  const counters = blankCounters();
  const degradations: Degradation[] = [];
  const spans: MotionSpanEntry[] = [];
  const encoder = encoderStub();
  const applyMetrics = vi.fn(async () => undefined);
  const deps: MotionRecorderDeps = {
    encoder,
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    at: () => now,
    viewport: { width: 1280, height: 800 },
    counters,
    degradations,
    applyMetrics,
    onSpan: (entry) => spans.push(entry),
    ...over,
  };
  const recorder = createMotionRecorder(deps);
  return {
    recorder,
    encoder: deps.encoder as ReturnType<typeof encoderStub>,
    counters,
    degradations,
    spans,
    applyMetrics,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("motion recorder intake", () => {
  it("ignores a frame that arrives with no span open, and counts nothing", () => {
    const h = harness();
    h.recorder.onFrame(frame(1));
    expect(h.encoder.push).not.toHaveBeenCalled();
    expect(h.counters.motionFrames).toBe(0);
    expect(h.counters.droppedMotionFrames).toBe(0);
  });

  it("pushes an admitted frame at the size that actually arrived", async () => {
    const h = harness();
    h.recorder.open();
    h.advance(40);
    h.recorder.onFrame(frame(1));
    await flush();
    expect(h.encoder.push).toHaveBeenCalledTimes(1);
    expect(h.encoder.push).toHaveBeenCalledWith(
      expect.objectContaining({ ms: 40, width: 1280, height: 800 }),
    );
    expect(h.counters.motionFrames).toBe(1);
    expect(h.counters.motionWidth).toBe(1280);
    expect(h.counters.motionHeight).toBe(800);
  });

  it("goes keyframe-only under heap pressure and stops consulting the budget", () => {
    // Thinning frames cannot recover committed memory, so the rest of the
    // span is dropped — and dropped WITHOUT re-running the budget, which
    // is what keeps one degradation from becoming one per frame.
    const h = harness({ encoder: encoderStub({ heapFraction: 0.92 }) });
    h.recorder.open();
    h.recorder.onFrame(frame(1));
    h.recorder.onFrame(frame(2));
    h.recorder.onFrame(frame(3));
    expect(h.encoder.push).not.toHaveBeenCalled();
    expect(h.counters.keyframeOnlySpans).toBe(1);
    expect(h.counters.budgetBreaches).toBe(1);
    expect(h.counters.droppedMotionFrames).toBe(3);
    expect(h.degradations.map((d) => d.kind)).toEqual(["keyframeOnly"]);
    expect(h.counters.heapHighWater).toBeCloseTo(0.92);
    expect(h.degradations[0]?.note).toMatch(/0\.92/);
  });

  it("skips one frame on an encoder backlog without latching the span", async () => {
    const h = harness({ encoder: encoderStub({ queueDepth: 99 }) });
    h.recorder.open();
    h.recorder.onFrame(frame(1));
    // A second frame, judged independently: a backlog breach must not
    // latch the span the way a heap breach does, so this one is charged
    // its own budgetBreach rather than being swallowed by a keyframeOnly
    // flag the first breach never set.
    h.recorder.onFrame(frame(2));
    expect(h.counters.budgetBreaches).toBe(2);
    expect(h.counters.keyframeOnlySpans).toBe(0);
    // Counted per frame, REPORTED per span: one entry that says how many.
    expect(h.degradations).toEqual([
      expect.objectContaining({
        kind: "budgetBreach",
        note: "2 of 2 motion frames skipped (encodeQueue)",
      }),
    ]);
    // A later span is its own report, not a continuation of this one.
    await h.recorder.close();
    h.recorder.open();
    h.recorder.onFrame(frame(3));
    expect(h.degradations.map((d) => d.note)).toEqual([
      "2 of 2 motion frames skipped (encodeQueue)",
      "1 of 1 motion frames skipped (encodeQueue)",
    ]);
  });

  // Red while every skipped frame is its own degradation: the KitchenLink
  // FAQ take (2026-10-02) skipped 37 frames and the editor showed 37 cards,
  // none of which said how many frames the span had in all.
  it("reports a span's inFlight skips once, from the first skip to the last, with the frames it was offered", () => {
    const h = harness();
    // Pushes that never finish, so the in-flight cap is reached and held.
    h.encoder.push.mockImplementation(() => new Promise<void>(() => {}));
    h.recorder.open();
    h.advance(10);
    h.recorder.onFrame(frame(1));
    h.recorder.onFrame(frame(2));
    h.recorder.onFrame(frame(3));
    // Premise: three pushes are in flight, which is MAX_FRAMES_IN_FLIGHT.
    expect(h.encoder.push).toHaveBeenCalledTimes(3);
    h.advance(10);
    h.recorder.onFrame(frame(4));
    h.advance(10);
    h.recorder.onFrame(frame(5));
    h.advance(10);
    h.recorder.onFrame(frame(6));
    expect(h.degradations).toEqual([
      {
        kind: "budgetBreach",
        startMs: 20,
        endMs: 40,
        note: "3 of 6 motion frames skipped (inFlight)",
      },
    ]);
    // The counters still count frames: telemetry's numbers do not change.
    expect(h.counters.budgetBreaches).toBe(3);
    expect(h.counters.droppedMotionFrames).toBe(3);
  });

  it("refuses a frame that is not a scale of the viewport, and re-asserts the metrics override once", async () => {
    // The screencast following the window's surface rather than the
    // override. Refused before the encoder, reported once per span, and
    // the correction is sent on detection.
    // 1800x1104 against the harness's default 1280x800 is inside
    // COVERAGE_TOLERANCE (0.019 < 0.02) — not a mismatch at all. This has to
    // be the pair it was actually measured against, HARVESTED_VIEWPORT from
    // replay-engine.test.ts's 2026-08-30 Chrome case (ratio 0.199), or the
    // test is vacuous. Do not "tidy" this back to the harness default.
    const h = harness({ viewport: { width: 1710, height: 840 } });
    h.recorder.open();
    h.recorder.onFrame(frame(1, fakeScreenshotBase64(1800, 1104)));
    h.recorder.onFrame(frame(2, fakeScreenshotBase64(1800, 1104)));
    await flush();
    expect(h.encoder.push).not.toHaveBeenCalled();
    expect(h.counters.surfaceMismatchFrames).toBe(2);
    expect(h.counters.droppedMotionFrames).toBe(2);
    expect(
      h.degradations.filter((d) => d.kind === "surfaceMismatch"),
    ).toHaveLength(1);
    expect(h.applyMetrics).toHaveBeenCalledTimes(1);
  });

  it("reports a metrics override that could not be re-asserted", async () => {
    // Same non-default viewport as the sibling test above, and for the same
    // reason: 1800x1104 is a mismatch only against the measured
    // HARVESTED_VIEWPORT pairing, not against the harness's 1280x800
    // default. At the default this frame is inside COVERAGE_TOLERANCE, the
    // surfaceMismatch branch never runs, applyMetrics is never called, and
    // this test would pass vacuously with no failure to report.
    const h = harness({
      viewport: { width: 1710, height: 840 },
      applyMetrics: vi.fn(async () => {
        throw new Error("Target closed");
      }),
    });
    h.recorder.open();
    h.recorder.onFrame(frame(1, fakeScreenshotBase64(1800, 1104)));
    await flush();
    const notes = h.degradations.map((d) => d.note);
    expect(
      notes.some((n) => /could not re-assert.*Target closed/.test(n)),
    ).toBe(true);
  });

  it("admits a frame that is a scale of the viewport, at that viewport", async () => {
    const h = harness();
    h.recorder.open();
    h.recorder.onFrame(frame(1, fakeScreenshotBase64(2560, 1600)));
    await flush();
    expect(h.encoder.push).toHaveBeenCalledWith(
      expect.objectContaining({ width: 2560, height: 1600 }),
    );
    expect(h.counters.surfaceMismatchFrames).toBe(0);
  });

  it("says the encoder refused a frame, rather than only counting it", async () => {
    const h = harness();
    h.encoder.push = vi.fn(async () => {
      throw new Error("Video sample size must remain constant");
    });
    h.recorder.open();
    h.recorder.onFrame(frame(1));
    h.recorder.onFrame(frame(2));
    await flush();
    expect(h.counters.encodeRefusedFrames).toBe(2);
    expect(h.counters.droppedMotionFrames).toBe(2);
    const refused = h.degradations.filter((d) => d.kind === "encodeRefused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.note).toMatch(/must remain constant/);
  });

  // 2026-10-11: one note per span said THAT the encoder refused, never how
  // much — so a span that lost one frame and a span that lost all of them
  // read the same, and bridge:check could not measure the loss.
  it("says how many of the span's frames the encoder refused, and the size it opened on", async () => {
    const h = harness();
    let pushes = 0;
    h.encoder.push = vi.fn(async () => {
      pushes++;
      if (pushes !== 2) throw new Error("configuration is not supported");
    });
    h.recorder.open();
    h.recorder.onFrame(frame(1, fakeScreenshotBase64(3840, 2400)));
    h.recorder.onFrame(frame(2, fakeScreenshotBase64(2560, 1600)));
    h.recorder.onFrame(frame(3, fakeScreenshotBase64(2560, 1600)));
    await flush();
    // The premise: three frames reached the encoder, two of them refused.
    expect(h.encoder.push).toHaveBeenCalledTimes(3);
    expect(h.counters.encodeRefusedFrames).toBe(2);
    const refused = h.degradations.filter((d) => d.kind === "encodeRefused");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.note).toMatch(/refused 2 of 3 frames/);
    expect(refused[0]?.note).toMatch(/opened on 3840x2400/);
    expect(refused[0]?.note).toMatch(/configuration is not supported/);
  });

  it("keeps the refusal count current as the span's later frames encode", async () => {
    const h = harness();
    let pushes = 0;
    h.encoder.push = vi.fn(async () => {
      pushes++;
      if (pushes === 1) throw new Error("refused");
    });
    h.recorder.open();
    h.recorder.onFrame(frame(1));
    await flush();
    h.recorder.onFrame(frame(2));
    h.recorder.onFrame(frame(3));
    await flush();
    const refused = h.degradations.find((d) => d.kind === "encodeRefused");
    expect(refused?.note).toMatch(/refused 1 of 3 frames/);
  });

  it("drops a frame whose payload will not decode rather than throwing", () => {
    const h = harness();
    h.recorder.open();
    expect(() =>
      h.recorder.onFrame(frame(1, "not base64 at all!!")),
    ).not.toThrow();
    expect(h.counters.droppedMotionFrames).toBe(1);
    expect(h.encoder.push).not.toHaveBeenCalled();
    // A truncated frame must not poison the rest of the span: a good frame
    // right after it is still admitted normally.
    h.recorder.onFrame(frame(2));
    expect(h.counters.motionFrames).toBe(1);
  });

  it("counts an inFlight budget breach once three frames are outstanding with the encoder", () => {
    // MAX_FRAMES_IN_FLIGHT is 3 — the budget's first tier. `admitFrame`'s
    // own inFlight rule is unit-tested against a bare number in
    // replay-span.test.ts; this is the thing that connects it to the
    // recorder's own counter. Without it a slow (not failing) encoder is
    // handed unbounded concurrent frames, with only heapFraction standing
    // between the run and the ceiling.
    const h = harness();
    // Never resolves: a real encoder falling behind, not one refusing.
    h.encoder.push = vi.fn(() => new Promise(() => {}));
    h.recorder.open();
    h.recorder.onFrame(frame(1));
    h.recorder.onFrame(frame(2));
    h.recorder.onFrame(frame(3));
    h.recorder.onFrame(frame(4));
    expect(h.encoder.push).toHaveBeenCalledTimes(3);
    expect(h.counters.budgetBreaches).toBe(1);
    expect(h.degradations).toHaveLength(1);
    expect(h.degradations[0]?.note).toMatch(/inFlight/);
  });

  it("keeps a frame this parser can't read at the size CDP itself reported", async () => {
    // safeJpegSize's catch. A frame whose bytes decode fine as base64 but
    // do not walk as a JPEG this parser understands still carries CDP's
    // own metadata — deviceWidth/deviceHeight — and that is what it must
    // fall back to. Falling back to a fixed size instead (e.g. 1x1) fails
    // coversViewport for a frame that was actually fine, charging it as a
    // confidently wrong surfaceMismatch and firing a spurious applyMetrics
    // re-assert at the page.
    const h = harness();
    h.recorder.open();
    h.recorder.onFrame(frame(1, btoa("not a jpeg, just some plain text")));
    await flush();
    expect(h.encoder.push).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1280, height: 800 }),
    );
  });
});

describe("motion recorder spans", () => {
  it("opens the encoder's span at the instant open() is called", () => {
    const h = harness();
    h.advance(120);
    h.recorder.open();
    expect(h.recorder.isOpen()).toBe(true);
    expect(h.encoder.openSpan).toHaveBeenCalledWith(120);
  });

  it("waits out the quiet threshold, then hands back what the encoder kept", async () => {
    // The clock's sleep advances `now`, so the polling loop terminates on
    // its own once no frame has landed for SPAN_QUIET_MS.
    const h = harness();
    h.encoder.closeSpan = vi.fn(async () => ({
      ref: "span-1",
      width: 1280,
      height: 800,
      fps: 24,
      frames: 12,
      byteLength: 0,
    }));
    h.recorder.open();
    h.advance(100);
    h.recorder.onFrame(frame(1));
    const entry = await h.recorder.close();
    expect(entry).toEqual(
      expect.objectContaining({
        startMs: 0,
        ref: "span-1",
        width: 1280,
        height: 800,
        fps: 24,
      }),
    );
    expect(entry?.endMs).toBeGreaterThan(100);
    expect(h.spans).toEqual([entry]);
    expect(h.counters.motionSpans).toBe(1);
    expect(h.counters.encodeShrunkSpans).toBe(0);
    expect(h.recorder.isOpen()).toBe(false);
  });

  // 2026-10-11: a span the encoder would not take at its opening size is
  // encoded smaller and kept. Its width is honest, but the refusal itself
  // was said nowhere — so it is counted, and the run report carries it.
  it("counts a span the encoder kept only by shrinking it", async () => {
    const h = harness();
    h.encoder.closeSpan = vi.fn(async () => ({
      ref: "span-1",
      width: 3420,
      height: 2214,
      fps: 24,
      frames: 12,
      byteLength: 0,
      shrunkFrom: { width: 5130, height: 3320 },
    }));
    h.recorder.open();
    h.advance(100);
    h.recorder.onFrame(frame(1));
    const entry = await h.recorder.close();
    // The premise: the span was kept, at the box it was encoded into.
    expect(entry?.width).toBe(3420);
    expect(h.counters.motionSpans).toBe(1);
    expect(h.counters.encodeShrunkSpans).toBe(1);
  });

  it("records the encoded span's byteLength on the entry", async () => {
    // Same arrangement as "waits out the quiet threshold, then hands back
    // what the encoder kept" above: open, push one frame, close.
    const h = harness();
    h.encoder.closeSpan = vi.fn(async () => ({
      ref: "span-1",
      width: 1280,
      height: 800,
      fps: 24,
      frames: 12,
      byteLength: 54_321,
    }));
    h.recorder.open();
    h.advance(100);
    h.recorder.onFrame(frame(1));
    const entry = await h.recorder.close();
    expect(entry?.byteLength).toBeGreaterThan(0);
    expect(h.spans[0]?.byteLength).toBe(54_321);
  });

  it("returns null and counts no span when the encoder kept too few frames", async () => {
    const h = harness();
    h.recorder.open();
    expect(await h.recorder.close()).toBeNull();
    expect(h.spans).toEqual([]);
    expect(h.counters.motionSpans).toBe(0);
    expect(h.encoder.closeSpan).toHaveBeenCalledTimes(1);
  });

  it("extends a span's end while the page keeps painting, past the quiet threshold from its start", async () => {
    // Regression for a lost `lastFrameMs` update: `close()`'s quiet check
    // is `now - lastFrameMs`, not `now - startMs`. If a frame stopped
    // moving `lastFrameMs` forward, every span with any motion at all would
    // still end SPAN_QUIET_MS after it opened — an 800ms transition would
    // ship as a 250ms span, with nothing in the bundle to say why.
    const h = harness();
    h.encoder.closeSpan = vi.fn(async () => ({
      ref: "s",
      width: 1280,
      height: 800,
      fps: 24,
      frames: 12,
      byteLength: 0,
    }));
    h.recorder.open();
    h.advance(200);
    h.recorder.onFrame(frame(1));
    const entry = await h.recorder.close();
    // The last frame landed at 200ms, so the span should run until
    // 200 + SPAN_QUIET_MS = 450ms — not SPAN_QUIET_MS (250ms) measured
    // from the span's start.
    expect(entry?.endMs).toBe(200 + SPAN_QUIET_MS);
  });

  it("clamps a span that painted continuously to SPAN_MAX_MS", async () => {
    // A permanent animation must not hold the replay open; the loop's
    // second exit is the ceiling, and the end is clamped to it.
    const h = harness();
    h.encoder.closeSpan = vi.fn(async () => ({
      ref: "s",
      width: 1280,
      height: 800,
      fps: 24,
      frames: 400,
      byteLength: 0,
    }));
    h.recorder.open();
    // Keep painting past the ceiling: a frame every 50 ms for 40 s.
    for (let i = 0; i < 800; i++) {
      h.advance(50);
      h.recorder.onFrame(frame(i));
    }
    const entry = await h.recorder.close();
    const { SPAN_MAX_MS } = await import("@demoman/replay-engine");
    expect(entry?.endMs).toBe(SPAN_MAX_MS);
  });

  it("makes a second close() on an already-retired span a no-op, not a crash or a double encoder close", async () => {
    // This does NOT pin the encoderSpanOpen guard in closeEncoderSpan: the
    // first close() already sets `span = null`, so teardown()'s inner
    // close() returns at `current === null` and never re-enters
    // closeEncoderSpan at all — the guard is never reached on this path.
    // "still releases the encoder's span when close() throws during
    // teardown" (below) is the test that actually exercises the guard.
    const h = harness();
    h.recorder.open();
    await h.recorder.close();
    await expect(h.recorder.teardown()).resolves.toBeUndefined();
    expect(h.encoder.closeSpan).toHaveBeenCalledTimes(1);
  });

  it("still releases the encoder's span when close() throws during teardown", async () => {
    // The failure path of the engine's finally: the encoder span pins its
    // frames for the life of the process, so it closes whether or not the
    // page could be told anything.
    const h = harness();
    let calls = 0;
    h.encoder.closeSpan = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("Target closed");
      return null;
    });
    h.recorder.open();
    await expect(h.recorder.teardown()).resolves.toBeUndefined();
    expect(h.recorder.isOpen()).toBe(false);
    // First call threw inside close(); the flag was already cleared, so the
    // teardown catch has nothing left to close and does not call again.
    expect(calls).toBe(1);
  });

  it("releases the encoder's span when close() throws before ever reaching it", async () => {
    // The other direction from the sibling test above: here the throw
    // happens in close()'s quiet-threshold wait loop, before
    // closeEncoderSpan is ever called — so encoderSpanOpen is still true
    // when teardown()'s catch runs. This is the case that matters most: an
    // encoder span left open pins every frame it holds for the rest of the
    // process, and the whole point of the flag is that it can still be
    // closed here.
    const h = harness({
      clock: {
        now: () => 0,
        sleep: async () => {
          throw new Error("clock stopped");
        },
      },
    });
    h.recorder.open();
    await expect(h.recorder.teardown()).resolves.toBeUndefined();
    expect(h.recorder.isOpen()).toBe(false);
    // The catch's closeEncoderSpan(at()) is the only thing that could have
    // called this: close() never got past the wait loop to call it itself.
    expect(h.encoder.closeSpan).toHaveBeenCalledTimes(1);
  });

  it("charges a frame that lands after close() started to no span", async () => {
    // A span that is already quiet skips close()'s polling loop, so the
    // span is retired synchronously — before the encoder's close is
    // awaited. A frame arriving in that gap must not be charged to it.
    const h = harness();
    h.recorder.open();
    h.advance(SPAN_QUIET_MS + 1);
    const closing = h.recorder.close();
    h.recorder.onFrame(frame(1));
    await closing;
    expect(h.encoder.push).not.toHaveBeenCalled();
    expect(h.counters.motionFrames).toBe(0);
  });
});

describe("continuous recording", () => {
  const kept = (ref: string) => ({
    ref,
    width: 1280,
    height: 800,
    fps: 30,
    frames: 3,
    byteLength: 100,
  });

  it("opens a span on its own when a frame arrives, and closes it once the page is quiet", async () => {
    const settled: number[] = [];
    const h = harness({
      mode: "continuous",
      onSettled: (ms) => settled.push(ms),
    });
    h.encoder.closeSpan.mockResolvedValue(kept("m-0"));
    h.recorder.onFrame(frame(1));
    h.recorder.onFrame(frame(2));
    h.recorder.onFrame(frame(3));
    expect(h.encoder.openSpan).toHaveBeenCalledTimes(1);
    expect(h.encoder.push).toHaveBeenCalledTimes(3);
    await h.recorder.teardown();
    expect(h.spans.map((s) => s.ref)).toEqual(["m-0"]);
    expect(settled.length).toBe(1);
  });

  it("does not call a span that hit the ceiling while painting settled", async () => {
    const settled: number[] = [];
    const h = harness({
      mode: "continuous",
      onSettled: (ms) => settled.push(ms),
      // A sleep that yields without moving time. The harness's own sleep
      // advances the clock, which lets the background close loop run ahead
      // of the paint this test drives and retire every span as quiet.
      clock: { now: () => 0, sleep: () => flush() },
    });
    h.recorder.onFrame(frame(1));
    // Paint every 50ms past the ceiling: never quiet, so the close loop
    // retires the span at SPAN_MAX_MS.
    for (let t = 50; t <= SPAN_MAX_MS + 100; t += 50) {
      h.advance(50);
      h.recorder.onFrame(frame(t));
      await flush();
    }
    expect(h.encoder.openSpan.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(settled).toEqual([]);
    // The paint stops: the last span goes quiet and closes, settled.
    h.advance(SPAN_QUIET_MS + 1);
    await h.recorder.teardown();
    expect(settled.length).toBe(1);
  });

  it("opens the next span without waiting for the previous close", async () => {
    const h = harness({ mode: "continuous" });
    let release: () => void = () => undefined;
    h.encoder.closeSpan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(kept("m-0"));
        }),
    );
    h.recorder.onFrame(frame(1));
    h.advance(400); // quiet: the first span retires and its close hangs
    await flush();
    h.recorder.onFrame(frame(2));
    expect(h.encoder.openSpan).toHaveBeenCalledTimes(2);
    expect(h.encoder.push).toHaveBeenCalledTimes(2);
    release();
    await h.recorder.teardown();
  });

  // Review Focus 2: a run that stops while a background close fails.
  it("reports a background close that throws, and teardown still returns", async () => {
    const h = harness({ mode: "continuous" });
    h.encoder.closeSpan.mockRejectedValueOnce(new Error("store refused"));
    h.recorder.onFrame(frame(1));
    await expect(h.recorder.teardown()).resolves.toBeUndefined();
    const refused = h.degradations.find((d) => d.kind === "encodeRefused");
    expect(refused?.note).toMatch(/store refused/);
    // The lost span's own range (final review I3): it opened on the frame
    // at 0 and ran until it closed. A zero-length range at the failure
    // instant is dropped by the timeline's merge, so the lost motion would
    // read as idle that an authored gap may compress.
    expect(refused?.startMs).toBe(0);
    expect(refused?.endMs ?? 0).toBeGreaterThan(refused?.startMs ?? 0);
  });

  it("stops keeping motion once the budget is spent, and says from when", async () => {
    const h = harness({ mode: "continuous", motionBudgetBytes: 150 });
    h.encoder.closeSpan.mockResolvedValue(kept("m"));
    h.recorder.onFrame(frame(1));
    h.advance(400);
    await flush();
    h.recorder.onFrame(frame(2)); // second span: 200 bytes kept >= 150
    h.advance(400);
    await flush();
    const pushesBefore = h.encoder.push.mock.calls.length;
    h.recorder.onFrame(frame(3)); // refused: the budget is spent
    expect(h.encoder.push.mock.calls.length).toBe(pushesBefore);
    await h.recorder.teardown();
    const spent = h.degradations.find((d) => d.kind === "keyframeOnly");
    expect(spent?.note).toMatch(/motion budget spent/);
  });

  // Review 2026-10-03 #2: past the budget no span opens, and `onSettled`
  // rode on a span closing — so nothing photographed a click's result for
  // the rest of the run, while the degradation promised "stills".
  it("still says when the page settles once the budget is spent", async () => {
    const settled: number[] = [];
    const h = harness({
      mode: "continuous",
      motionBudgetBytes: 50,
      onSettled: (ms) => settled.push(ms),
    });
    h.encoder.closeSpan.mockResolvedValue(kept("m"));
    h.recorder.onFrame(frame(1));
    h.advance(400);
    await flush();
    // The premise: the first span spent the budget, and it settled once.
    expect(h.degradations.some((d) => /motion budget spent/.test(d.note))).toBe(
      true,
    );
    expect(settled.length).toBe(1);
    const opened = h.encoder.openSpan.mock.calls.length;
    // A click past the budget paints, then the page goes quiet.
    h.recorder.onFrame(frame(2));
    h.recorder.onFrame(frame(3));
    h.recorder.onFrame(frame(4));
    // The premise: nothing was kept or opened for it.
    expect(h.encoder.openSpan.mock.calls.length).toBe(opened);
    h.advance(400);
    await h.recorder.teardown();
    expect(settled.length, `settled at ${settled.join(",")}`).toBe(2);
  });

  it("is the sampled recorder, unchanged, when no mode is given", () => {
    const h = harness();
    h.recorder.onFrame(frame(1));
    expect(h.encoder.openSpan).not.toHaveBeenCalled();
  });
});
