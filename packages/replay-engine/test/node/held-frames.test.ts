import type { Degradation, MotionSpanEntry } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import { HEAP_HIGH_WATER } from "../../src/constants.js";
import {
  createHeldFrames,
  HELD_FRAME_MS,
  type HeldFrame,
  HOLD_MIN_FRAMES,
} from "../../src/index.js";
import type { EncodedSpan, FrameEncoder } from "../../src/types.js";

const t = (n: number) => n * HELD_FRAME_MS;
/** One frame per letter, one frame-time apart; equal letters are equal bytes. */
const seq = (letters: string): HeldFrame[] =>
  [...letters].map((c, i) => ({
    sourceTimeMs: t(i),
    bytes: new Uint8Array([c.charCodeAt(0), 7, 7]),
    width: 2,
    height: 2,
  }));

const ENCODED: EncodedSpan = {
  ref: "r",
  width: 2,
  height: 2,
  fps: 30,
  frames: 2,
  byteLength: 9,
};

function setup(
  opts: {
    heap?: () => number;
    closeSpan?: () => Promise<EncodedSpan | null>;
    push?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const stills: { at: number; byte: number }[] = [];
  const spans: MotionSpanEntry[] = [];
  const degradations: Degradation[] = [];
  const encoder: FrameEncoder = {
    openSpan: (ms) => void calls.push(`open@${ms}`),
    push: async (f) => {
      await opts.push?.();
      calls.push(`push@${f.ms}:${String.fromCharCode(f.bytes[0] as number)}`);
    },
    closeSpan: async (ms) => {
      calls.push(`close@${ms}`);
      return opts.closeSpan ? opts.closeSpan() : null;
    },
    queueDepth: () => 0,
    heapFraction: opts.heap ?? (() => 0),
  };
  const held = createHeldFrames({
    encoder,
    fileStill: async (bytes, at) =>
      void stills.push({ at, byte: bytes[0] as number }),
    onSpan: (e) => spans.push(e),
    degradations,
  });
  return { held, calls, stills, spans, degradations };
}

describe("createHeldFrames", () => {
  it("files a still page as one keyframe and no span", async () => {
    const h = setup();
    for (const f of seq("AAAAAAAAAA")) await h.held.add(f);
    await h.held.finish(t(10));
    expect(h.stills).toEqual([{ at: 0, byte: 65 }]);
    expect(h.calls).toEqual([]);
  });

  it("puts changing frames in a span at their held times", async () => {
    const h = setup();
    for (const f of seq("ABCDDDD")) await h.held.add(f);
    await h.held.finish(t(7));
    expect(h.calls).toEqual([
      `open@${t(0)}`,
      `push@${t(0)}:A`,
      `push@${t(1)}:B`,
      `push@${t(2)}:C`,
      `push@${t(3)}:D`,
      `close@${t(3)}`,
    ]);
    expect(h.stills).toEqual([{ at: t(3), byte: 68 }]);
  });

  it("keeps a one-frame change as motion", async () => {
    const h = setup();
    for (const f of seq("AAABAAA")) await h.held.add(f);
    await h.held.finish(t(7));
    expect(h.stills.map((s) => s.at)).toEqual([t(0), t(4)]);
    expect(h.calls).toEqual([
      `open@${t(3)}`,
      `push@${t(3)}:B`,
      `push@${t(4)}:A`,
      `close@${t(4)}`,
    ]);
  });

  it("treats fewer than HOLD_MIN_FRAMES identical frames as motion", async () => {
    expect(HOLD_MIN_FRAMES).toBe(3);
    const h = setup();
    for (const f of seq("AAB")) await h.held.add(f);
    await h.held.finish(t(3));
    expect(h.calls).toEqual([
      `open@${t(0)}`,
      `push@${t(0)}:A`,
      `push@${t(1)}:A`,
      `push@${t(2)}:B`,
      `close@${t(3)}`,
    ]);
    expect(h.stills).toEqual([]);
  });

  it("files a lone frame as a keyframe at its time on finish", async () => {
    const h = setup();
    await h.held.add(seq("A")[0] as HeldFrame);
    await h.held.finish(t(1));
    expect(h.stills).toEqual([{ at: 0, byte: 65 }]);
    expect(h.calls).toEqual([]);
  });

  it("answers the newest frame from latest", async () => {
    const h = setup();
    expect(h.held.latest()).toBeNull();
    for (const f of seq("ABC")) await h.held.add(f);
    expect(h.held.latest()?.sourceTimeMs).toBe(t(2));
  });

  it("hands an encoded span to onSpan with the times it closed at", async () => {
    const h = setup({ closeSpan: async () => ENCODED });
    for (const f of seq("AB")) await h.held.add(f);
    await h.held.finish(t(5));
    expect(h.spans).toEqual([
      {
        startMs: 0,
        endMs: t(5),
        ref: "r",
        width: 2,
        height: 2,
        fps: 30,
        byteLength: 9,
      },
    ]);
  });

  it("lets an encoder rejection out of add", async () => {
    const h = setup({
      push: async () => {
        throw new Error("encoder gone");
      },
    });
    const [a, b] = seq("AB") as [HeldFrame, HeldFrame];
    await h.held.add(a);
    await expect(h.held.add(b)).rejects.toThrow("encoder gone");
  });

  it("keeps an endless animation in one span, and says when the budget skips frames", async () => {
    let heap = 0;
    const h = setup({ heap: () => heap });
    const frames = seq(
      Array.from({ length: 600 }, (_, i) =>
        String.fromCharCode(33 + (i % 90)),
      ).join(""),
    );
    // The premise: no frame equals its neighbour, so no hold can form.
    expect(
      frames.some((f, i) => i > 0 && f.bytes[0] === frames[i - 1]?.bytes[0]),
    ).toBe(false);
    for (const [i, f] of frames.entries()) {
      if (i === 300) heap = HEAP_HIGH_WATER + 0.01;
      await h.held.add(f);
    }
    await h.held.finish(t(600));
    expect(h.stills).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("open"))).toHaveLength(1);
    // Frames 0..298 went in; 299 onwards met the heap and were skipped.
    expect(h.calls.filter((c) => c.startsWith("push"))).toHaveLength(299);
    expect(h.degradations.map((d) => d.kind)).toEqual(["keyframeOnly"]);
  });
});
