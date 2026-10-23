import { CanvasSink } from "mediabunny";
import { describe, expect, it } from "vitest";
import { createVideoFrameSource } from "../../src/ports/frame-source-video";
import { createMp4Sink } from "../../src/ports/sink-mp4";
import { createOffscreenSurface } from "../../src/ports/surface";
import { LANDSCAPE_1080P } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { createProceduralFrameSource } from "../fixtures/procedural";

/** Encodes 30 frames of the fixture app's motion span into a real MP4. */
async function encodeMotionSpan(): Promise<Uint8Array> {
  const bundle = proceduralBundle();
  const frames = createProceduralFrameSource(bundle);
  const target = {
    ...LANDSCAPE_1080P,
    width: 640,
    height: 400,
    bitrate: 4_000_000,
  };
  const sink = createMp4Sink(target);
  const canvas = createOffscreenSurface().create(target.width, target.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

  for (let i = 0; i < 30; i++) {
    const sourceMs = 3200 + (i / 30) * 800;
    const frame = await frames.at(sourceMs);
    ctx.drawImage(frame.image, 0, 0, target.width, target.height);
    await sink.addFrame(canvas, i / 60, 1 / 60);
  }
  return sink.finish();
}

function spanBundle() {
  return proceduralBundle({
    keyframes: [
      {
        byteLength: 0,
        sourceTimeMs: 0,
        ref: "k-0",
        width: 1280,
        height: 800,
        actionId: null,
      },
    ],
  });
}

describe("video-backed frame source", () => {
  it("decodes an encoded motion span back into composable frames", async () => {
    const encoded = await encodeMotionSpan();
    const bundle = proceduralBundle({
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 0,
          ref: "k-0",
          width: 1280,
          height: 800,
          actionId: null,
        },
      ],
      motionSpans: [
        {
          byteLength: 0,
          startMs: 3200,
          endMs: 4000,
          ref: "m-0",
          width: 640,
          height: 400,
          fps: 60,
        },
      ],
    });

    const frames = await createVideoFrameSource(bundle, async (ref) => {
      if (ref === "m-0") return encoded;
      const fallback = createProceduralFrameSource(bundle);
      return fallback.at(0);
    });

    const frame = await frames.at(3600);
    expect(frame.width).toBe(640);
    expect(frame.height).toBe(400);

    const probe = new OffscreenCanvas(frame.width, frame.height);
    const ctx = probe.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(frame.image, 0, 0);
    const [, , , alpha] = ctx.getImageData(
      frame.width / 2,
      frame.height / 2,
      1,
      1,
    ).data;
    expect(alpha).toBe(255);
  }, 180_000);

  it("advances through the span rather than returning one frozen frame", async () => {
    const encoded = await encodeMotionSpan();
    const bundle = proceduralBundle({
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 0,
          ref: "k-0",
          width: 1280,
          height: 800,
          actionId: null,
        },
      ],
      motionSpans: [
        {
          byteLength: 0,
          startMs: 3200,
          endMs: 4000,
          ref: "m-0",
          width: 640,
          height: 400,
          fps: 60,
        },
      ],
    });
    const frames = await createVideoFrameSource(bundle, async () => encoded);

    const sample = async (ms: number) => {
      const frame = await frames.at(ms);
      const probe = new OffscreenCanvas(frame.width, frame.height);
      const ctx = probe.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(frame.image, 0, 0);
      // The fixture's panel slides in from the right, so sample near that edge.
      return [
        ...ctx.getImageData(frame.width - 40, frame.height / 2, 1, 1).data,
      ].join();
    };

    expect(await sample(3250)).not.toBe(await sample(3950));
  }, 180_000);

  it("says which span it cannot serve, and why, instead of freezing on a keyframe", async () => {
    const bundle = proceduralBundle({
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 0,
          ref: "k-0",
          width: 1280,
          height: 800,
          actionId: null,
        },
      ],
      motionSpans: [
        {
          byteLength: 0,
          startMs: 3200,
          endMs: 4000,
          ref: "m-0",
          width: 640,
          height: 400,
          fps: 60,
        },
      ],
    });
    const stills = createProceduralFrameSource(bundle);
    const reported: { ref: string; reason: string }[] = [];
    const frames = await createVideoFrameSource(
      bundle,
      // Bytes that are not a container: what a truncated or corrupted
      // store hands back. The render must still complete on keyframes —
      // and must not report that as a clean render.
      async (ref) =>
        ref === "m-0" ? new Uint8Array([1, 2, 3, 4]) : stills.at(0),
      { onSpanUnavailable: (ref, reason) => reported.push({ ref, reason }) },
    );

    expect((await frames.at(3600)).width).toBe(1280);
    expect(frames.unavailable?.()).toEqual([
      { ref: "m-0", reason: expect.stringMatching(/\S/) },
    ]);
    expect(reported).toEqual(frames.unavailable?.());
  }, 180_000);

  it("falls back to keyframes outside every motion span", async () => {
    const bundle = proceduralBundle({ motionSpans: [] });
    const source = createProceduralFrameSource(bundle);
    const frames = await createVideoFrameSource(bundle, async () =>
      source.at(0),
    );
    expect((await frames.at(0)).width).toBe(3840);
  }, 180_000);
});

/**
 * Walking the decoder forward has to answer what seeking to each instant
 * answered, or the preview is faster and showing the wrong frames.
 *
 * The two paths are exercised through the same source: a monotonic sweep
 * walks (`shouldReseek` says so), while the same instants asked for with a
 * rewind between each force a re-seek every time. Both must agree, frame for
 * frame and pixel for pixel.
 */
/**
 * Watches the iterators `CanvasSink.canvases()` hands out: how many were
 * opened, and how many were closed with `return()`.
 *
 * Both halves are needed by a test below, and neither can be observed from
 * outside: `createVideoFrameSource` builds its own sink from the bytes, so
 * there is no seam to inject through, and an iterator that is merely dropped
 * looks exactly like one that finished.
 */
function watchWalks(): {
  opened: () => number;
  closed: () => number;
  restore: () => void;
} {
  type Canvases = CanvasSink["canvases"];
  const original: Canvases = CanvasSink.prototype.canvases;
  let opened = 0;
  let closed = 0;
  CanvasSink.prototype.canvases = function watched(
    this: CanvasSink,
    ...args: Parameters<Canvases>
  ): ReturnType<Canvases> {
    opened += 1;
    const iterator = original.apply(this, args);
    const close = iterator.return.bind(iterator);
    iterator.return = (value) => {
      closed += 1;
      return close(value);
    };
    return iterator;
  };
  return {
    opened: () => opened,
    closed: () => closed,
    restore: () => {
      CanvasSink.prototype.canvases = original;
    },
  };
}

/**
 * A sweep that stays inside the encoded span and steps further than one
 * frame each time.
 *
 * Both matter. The span holds 30 frames at 60fps, so it runs out 483ms in
 * and every instant past that serves the same last frame however it was
 * reached — which is walking and seeking agreeing about nothing. And a step
 * shorter than a frame would leave a backwards request still ahead of the
 * frame currently served, which `shouldReseek` answers by walking.
 */
const SWEEP_INSTANTS = Array.from({ length: 24 }, (_, i) => 3200 + i * 20);

describe("walking the decoder forward", () => {
  it("serves the frames seeking to each instant would have served", async () => {
    const encoded = await encodeMotionSpan();
    const bundle = spanBundle();
    const instants = SWEEP_INSTANTS;

    const walked = await createVideoFrameSource(bundle, async () => encoded);
    const walkedFrames: number[] = [];
    for (const ms of instants)
      walkedFrames.push((await walked.at(ms)).sourceTimeMs);

    // Descending, which is what makes every one of these a fresh seek: an
    // iterator cannot rewind, so `shouldReseek` answers `true` to each
    // request and the next frame served is the first one the new iterator
    // yields — the frame `getCanvas` would have found for that instant.
    //
    // This used to rewind to 3200 before each read instead, and the rewind
    // did re-seek — but the read after it was only ever 0 to 690ms further
    // on, and `MAX_WALK_SECONDS` lets anything within half a second walk. So
    // 17 of these 24 instants were reached by walking in both columns and
    // the comparison was walk against walk, holding nothing.
    const seeked = await createVideoFrameSource(bundle, async () => encoded);
    const seekedFrames: number[] = [];
    for (const ms of [...instants].reverse()) {
      seekedFrames.unshift((await seeked.at(ms)).sourceTimeMs);
    }

    expect(walkedFrames).toEqual(seekedFrames);
  });

  it("is comparing a sweep that really does cross several frames", async () => {
    // Fixture guard: if the span served one frame throughout, the two paths
    // would agree trivially.
    const encoded = await encodeMotionSpan();
    const source = await createVideoFrameSource(
      spanBundle(),
      async () => encoded,
    );
    const seen = new Set<number>();
    for (let i = 0; i < 24; i++)
      seen.add((await source.at(3200 + i * 30)).sourceTimeMs);
    expect(seen.size).toBeGreaterThan(4);
  });

  it("is comparing one column that walks against one that seeks every time", async () => {
    // Fixture guard for the test above, and for the way that test used to be
    // written: it rewound to the span's start before each read, and the
    // rewind did re-seek, but the read after it was only ever a short hop
    // forward and `MAX_WALK_SECONDS` lets anything under half a second walk.
    // So the seeks all belonged to the rewinds, every read in BOTH columns
    // walked, and the comparison held nothing. Counting the whole column
    // cannot tell those apart — the rewinds make up the same total — so this
    // asks of each read on its own whether it opened a decoder.
    const encoded = await encodeMotionSpan();
    const watched = watchWalks();
    try {
      const walked = await createVideoFrameSource(
        spanBundle(),
        async () => encoded,
      );
      for (const ms of SWEEP_INSTANTS) await walked.at(ms);
      expect(watched.opened()).toBe(1);

      const seeked = await createVideoFrameSource(
        spanBundle(),
        async () => encoded,
      );
      for (const ms of [...SWEEP_INSTANTS].reverse()) {
        const before = watched.opened();
        await seeked.at(ms);
        expect(watched.opened()).toBe(before + 1);
      }
    } finally {
      watched.restore();
    }
  });

  it("lets go of the decoder it abandons on a re-seek", async () => {
    // An abandoned iterator is not collected, it is parked: `canvases()`
    // pre-decodes ahead and then waits on mediabunny's backpressure promise,
    // which only `next()` or `return()` settles, so dropping the reference
    // leaves the loop alive and its `VideoDecoder` open with every frame it
    // had queued still held. Dragging the playhead back re-seeks, and can do
    // so once per animation frame while the drag lasts.
    const encoded = await encodeMotionSpan();
    const watched = watchWalks();
    try {
      const source = await createVideoFrameSource(
        spanBundle(),
        async () => encoded,
      );
      for (let i = 0; i < 6; i++) {
        await source.at(3900);
        await source.at(3210);
      }
      expect(watched.opened()).toBeGreaterThan(6);
      // Every one but the walk still being served.
      expect(watched.closed()).toBe(watched.opened() - 1);
    } finally {
      watched.restore();
    }
  });

  it("goes back to an earlier frame when the playhead is dragged back", async () => {
    // An iterator cannot rewind, so a backwards scrub has to start again —
    // and if it did not, the preview would freeze on the newest frame it had
    // reached and never show an earlier one again.
    const encoded = await encodeMotionSpan();
    const source = await createVideoFrameSource(
      spanBundle(),
      async () => encoded,
    );
    const late = (await source.at(3900)).sourceTimeMs;
    const early = (await source.at(3210)).sourceTimeMs;
    expect(early).toBeLessThan(late);
  });
});
