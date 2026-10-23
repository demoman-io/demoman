import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jpegSize } from "@demoman/replay-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createParkingEncoder } from "../src/encoder.js";
import { createFileFrameStore, type RunnerStore } from "../src/frame-store.js";
import { jpeg, largeJpeg } from "./fixtures/jpeg.js";

let store: RunnerStore;
beforeEach(() => {
  store = createFileFrameStore(mkdtempSync(join(tmpdir(), "demoman-encoder-")));
});

afterEach(() => {
  // Removed, not leaked. Round 2's finding 8: every `mkdtempSync` in this
  // lane outlived its run, and these directories hold real production-sized
  // frames — tens of MB per `pnpm -r test`, accumulating in TMPDIR on every
  // local and CI run. `store.root` is the directory `beforeEach` just made.
  rmSync(store.root, { recursive: true, force: true });
});

describe("the fixtures", () => {
  it("frame.jpg is a real JPEG whose SOF the engine's jpegSize can read", () => {
    // Not a property of the encoder — a guard on the fixture itself, so a
    // fixture that stopped producing a decodable JPEG would fail here
    // rather than let every test below pass against bytes that only look
    // like one.
    expect(jpegSize(jpeg())).toEqual({ width: 100, height: 50 });
  });

  it("frame-large.jpg is a real, production-sized JPEG (REPLAY_DPR x a 1280x800 scene)", () => {
    // Guards encoder.bench.test.ts's premise: the fixture it measures
    // against must actually be the production frame size, or the bench's
    // numbers are a floor on a different question than the one asked.
    expect(jpegSize(largeJpeg())).toEqual({ width: 3840, height: 2400 });
  });
});

describe("the parking encoder", () => {
  it("parks every pushed frame and returns a span ref the bundle can name", async () => {
    const encoder = createParkingEncoder(store, "s1", 2);
    encoder.openSpan(0);
    await encoder.push({ bytes: jpeg(), ms: 0, width: 100, height: 50 });
    await encoder.push({ bytes: jpeg(), ms: 33, width: 100, height: 50 });
    const span = await encoder.closeSpan(66);
    expect(span?.ref).toBe("span:s1:0");
    expect(span?.frames).toBe(2);
    expect(span?.width).toBe(100);
    // The parked frames are on disk, indexed contiguously from the span's
    // own first index — which is what readParked's range asks for.
    const parked = await store.readParked("s1:replay", 0, 2);
    expect(parked).toHaveLength(2);
  });

  it("returns null for a span too short to be motion, and records it anyway", async () => {
    // The bundle carries survivors only, but a caller that wants to say
    // 'the static click painted twice' needs the discards too.
    const encoder = createParkingEncoder(store, "s1", 5);
    encoder.openSpan(0);
    await encoder.push({ bytes: jpeg(), ms: 0, width: 100, height: 50 });
    expect(await encoder.closeSpan(16)).toBeNull();
    expect(encoder.spans()).toEqual([
      expect.objectContaining({ index: 0, frames: 1, kept: false }),
    ]);
  });

  it("keeps the time each frame was painted, in park order", async () => {
    // The mux places every frame at this time. Without it the mux could
    // only spread the frames evenly to the span's end, which is the last
    // paint plus SPAN_QUIET_MS: a typed value's last key played 250 ms late,
    // after the cursor had left for the next click (hero take, 2026-10-19).
    const encoder = createParkingEncoder(store, "s1", 2);
    encoder.openSpan(1000);
    await encoder.push({ bytes: jpeg(), ms: 1000, width: 100, height: 50 });
    await encoder.push({ bytes: jpeg(), ms: 1250, width: 100, height: 50 });
    await encoder.push({ bytes: jpeg(), ms: 1320, width: 100, height: 50 });
    await encoder.closeSpan(1570);
    expect(encoder.spans()).toEqual([
      expect.objectContaining({ frames: 3, frameMs: [1000, 1250, 1320] }),
    ]);
  });

  it("parks overlapping pushes at their own index, with their own time", async () => {
    // The motion recorder does not wait for one push before the next (up to
    // MAX_FRAMES_IN_FLIGHT at once), and a write can finish out of order.
    // Code review 2026-10-20: both pushes read the same index, the later
    // bytes overwrote the earlier, and the next index was never written.
    const slow = createFileFrameStore(store.root);
    let first = true;
    const racing: RunnerStore = {
      ...slow,
      putParked: async (ns, index, bytes) => {
        if (first) {
          first = false;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return slow.putParked(ns, index, bytes);
      },
    };
    const encoder = createParkingEncoder(racing, "s1", 2);
    encoder.openSpan(100);
    const a = jpeg();
    const b = largeJpeg();
    await Promise.all([
      encoder.push({ bytes: a, ms: 100, width: 100, height: 50 }),
      encoder.push({ bytes: b, ms: 116, width: 3840, height: 2400 }),
    ]);
    await encoder.closeSpan(400);
    expect(encoder.spans()).toEqual([
      expect.objectContaining({ frames: 2, frameMs: [100, 116] }),
    ]);
    const parked = await store.readParked("s1:replay", 0, 2);
    expect(parked.map((p) => [p.index, p.bytes.byteLength])).toEqual([
      [0, a.byteLength],
      [1, b.byteLength],
    ]);
  });

  it("indexes each span's frames from where the last one ended", async () => {
    // Alignment is by index, never by position: two spans sharing an index
    // space is what lets readParked take a range.
    const encoder = createParkingEncoder(store, "s1", 1);
    encoder.openSpan(0);
    await encoder.push({ bytes: jpeg(), ms: 0, width: 10, height: 10 });
    await encoder.closeSpan(16);
    encoder.openSpan(100);
    await encoder.push({ bytes: jpeg(), ms: 100, width: 10, height: 10 });
    await encoder.closeSpan(116);
    expect(encoder.spans().map((s) => s.firstFrameIndex)).toEqual([0, 1]);
  });

  it("rejects a park that failed, and does not count the frame", async () => {
    // Report before you forgive — but this is NOT the place that reports.
    // Review of the runner audit, finding 6: a `catch` here swallowed the
    // rejection and rebuilt, one layer up, the channel the engine already
    // has for exactly this: `motion-recorder.ts`'s own `.catch` on
    // `encoder.push` counts the frame as dropped and pushes one
    // `encodeRefused` degradation per span, with the reason, into the
    // bundle the pipeline already prints. So `push` rejects, the way the
    // extension's WebCodecs encoder already does — and the span's `frames`
    // is still the number the mux will actually find, because the counters
    // only advance after the park lands.
    const failing = {
      ...store,
      putParked: async () => {
        throw new Error("disk full");
      },
    };
    const encoder = createParkingEncoder(failing as RunnerStore, "s1", 1);
    encoder.openSpan(0);
    await expect(
      encoder.push({ bytes: jpeg(), ms: 0, width: 10, height: 10 }),
    ).rejects.toThrow("disk full");
    const span = await encoder.closeSpan(16);
    expect(span).toBeNull();
    expect(encoder.spans()[0]).toMatchObject({ frames: 0, kept: false });
  });

  it("names the byteLength as unknown at close time, for the mux to patch later", async () => {
    // Not 0 by coincidence: the frames on disk are parked JPEGs, not an
    // encoded mp4, so no real byte count exists until Task 11 muxes them. A
    // non-zero value here would be a number nobody measured.
    const encoder = createParkingEncoder(store, "s1", 1);
    encoder.openSpan(0);
    await encoder.push({ bytes: jpeg(), ms: 0, width: 10, height: 10 });
    const span = await encoder.closeSpan(16);
    expect(span?.byteLength).toBe(0);
  });
});
