import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileFrameStore,
  fileNameOf,
  type RunnerStore,
} from "../src/frame-store.js";

let store: RunnerStore;
beforeEach(() => {
  store = createFileFrameStore(mkdtempSync(join(tmpdir(), "demoman-store-")));
});

afterEach(() => {
  // Removed, not leaked. Round 2's finding 8: every `mkdtempSync` in this
  // lane outlived its run, and these directories hold real production-sized
  // frames — tens of MB per `pnpm -r test`, accumulating in TMPDIR on every
  // local and CI run. `store.root` is the directory `beforeEach` just made.
  rmSync(store.root, { recursive: true, force: true });
});

describe("the filesystem store", () => {
  it("round-trips a keyframe and puts the bytes on disk under the ref it returns", async () => {
    const ref = await store.putKeyframe("s1", 0, new Uint8Array([1, 2, 3]));
    expect(await store.load(ref)).toEqual(new Uint8Array([1, 2, 3]));
    // On disk, not only in a map: the render phase serves this directory
    // over http, so a store that answered from memory would pass here and
    // serve 404s there.
    expect(readFileSync(join(store.root, fileNameOf(ref))).length).toBe(3);
  });

  it("reads a parked range by index, not by position", async () => {
    // The capture-mux lesson: a putParked that failed leaves a HOLE, and the
    // frames after it must not shift earlier.
    for (const i of [0, 1, 3, 4]) {
      await store.putParked("s1:replay", i, new Uint8Array([i]));
    }
    const slice = await store.readParked("s1:replay", 0, 5);
    expect(slice.map((f) => f.index)).toEqual([0, 1, 3, 4]);
  });

  it("does not let one namespace's prefix reach another's frames", async () => {
    // The memory helper documents this trap against a real IDBKeyRange:
    // "s1:capture"'s prefix also matches "s1:capture:extra"'s refs unless
    // the index segment is required to be the whole remainder.
    await store.putParked("s1", 0, new Uint8Array([1]));
    await store.putParked("s1:extra", 0, new Uint8Array([2]));
    const slice = await store.readParked("s1", 0, 10);
    expect(slice).toHaveLength(1);
    expect(slice[0]?.bytes).toEqual(new Uint8Array([1]));
  });

  it("drops a namespace's parked frames and leaves everything else", async () => {
    await store.putParked("s1:replay", 0, new Uint8Array([1]));
    const kf = await store.putKeyframe("s1", 0, new Uint8Array([9]));
    await store.dropParked("s1:replay");
    expect(await store.readParked("s1:replay", 0, 10)).toEqual([]);
    expect(await store.load(kf)).toEqual(new Uint8Array([9]));
  });

  it("round-trips a bundle", async () => {
    const bundle = {
      source: "replay",
      keyframes: [],
      motionSpans: [],
      cursorSamples: [],
      degradations: [],
    } as never;
    await store.putBundle("s1", bundle);
    expect(await store.getBundle("s1")).toEqual(bundle);
  });

  it("says which ref it could not find, rather than returning empty bytes", async () => {
    // Report before you forgive: an empty Uint8Array here becomes a frame
    // that decodes to nothing three layers away.
    await expect(store.load("kf:s1:7")).rejects.toThrow(/kf:s1:7/);
  });

  it("deletes a bundle AND every blob it names, not just the row", async () => {
    // The extension's own store (and its test helper's fake, whose comment
    // says exactly why) drop the row and every referenced blob together —
    // a fake that dropped only the row would let a caller that leaks blobs
    // pass its tests and leak in the real browser. This is that same test
    // for the filesystem store: `refs()` (what the render phase's http
    // server serves from) must not still be able to hand out a keyframe or
    // span belonging to a bundle this call was told to destroy.
    const kfRef = await store.putKeyframe("s1", 0, new Uint8Array([1]));
    await store.putSpan("span:s1:0", new Uint8Array([2]));
    const bundle = {
      source: "replay",
      keyframes: [{ ref: kfRef }],
      motionSpans: [{ ref: "span:s1:0" }],
      cursorSamples: [],
      degradations: [],
    } as never;
    await store.putBundle("s1", bundle);

    await store.deleteBundle("s1");

    expect(await store.getBundle("s1")).toBeNull();
    await expect(store.load(kfRef)).rejects.toThrow();
    await expect(store.load("span:s1:0")).rejects.toThrow();
    expect(await store.refs()).toEqual([]);
  });

  it("deletes a bundle idempotently — a second call finds nothing left to remove", async () => {
    const kfRef = await store.putKeyframe("s1", 0, new Uint8Array([1]));
    const bundle = {
      source: "replay",
      keyframes: [{ ref: kfRef }],
      motionSpans: [],
      cursorSamples: [],
      degradations: [],
    } as never;
    await store.putBundle("s1", bundle);

    await store.deleteBundle("s1");
    await expect(store.deleteBundle("s1")).resolves.toBeUndefined();
  });

  it("overwrites a span's blob at the ref the encoder already handed the bundle", async () => {
    // The mux writes the real mp4 over the ref closeSpan returned, because
    // the bundle already names it. See encoder.ts.
    await store.putSpan("span:s1:0", new Uint8Array([1]));
    await store.putSpan("span:s1:0", new Uint8Array([2, 2]));
    expect(await store.load("span:s1:0")).toEqual(new Uint8Array([2, 2]));
  });
});
