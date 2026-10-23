import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameBundle } from "@demoman/compositor";
import type { Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleEntry } from "../src/bundle-js.js";
import type { ParkedSpan } from "../src/encoder.js";
import { DECODE_PROBE_GLOBAL } from "../src/entry-globals.js";
import { createFileFrameStore, type RunnerStore } from "../src/frame-store.js";
import { launch } from "../src/launch.js";
import { muxSpans } from "../src/mux.js";
import {
  LARGE_FIXTURE_HEIGHT,
  LARGE_FIXTURE_WIDTH,
  largeJpeg,
} from "./fixtures/jpeg.js";
import { mp4FrameTimes } from "./mp4-probe.js";

const SCENE_ID = "s1";
const NAMESPACE = `${SCENE_ID}:replay`;

// The decode probe (`mediabunny`'s demux side) lives in its own bundle,
// never `mux.ts`'s production one — see `mux-entry.ts`'s header docblock
// for the ~654 KB / ~40% it used to cost the injected script when it lived
// there. Bundled once per test run, then injected onto whichever page a
// test is using, alongside (not instead of) `mux.ts`'s own production
// script.
const PROBE_ENTRY_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "decode-probe-entry.ts",
);
let probeBundle: Promise<string> | null = null;
function muxProbeBundle(): Promise<string> {
  probeBundle ??= bundleEntry(PROBE_ENTRY_PATH);
  return probeBundle;
}

type BundleSpan = FrameBundle["motionSpans"][number];

let store: RunnerStore;
beforeEach(() => {
  store = createFileFrameStore(mkdtempSync(join(tmpdir(), "demoman-mux-")));
});

afterEach(() => {
  // Removed, not leaked. Round 2's finding 8: every `mkdtempSync` in this
  // lane outlived its run, and these directories hold real production-sized
  // frames — tens of MB per `pnpm -r test`, accumulating in TMPDIR on every
  // local and CI run. `store.root` is the directory `beforeEach` just made.
  rmSync(store.root, { recursive: true, force: true });
});

/**
 * A structurally valid JPEG whose SOF reports `0x0` — real marker bytes
 * `jpegSize` walks cleanly to a "positive()" answer, not garbage it fails
 * to parse at all. That distinction is the whole point of this fixture:
 * `jpegSize` must return `{ width: 0, height: 0 }`, not throw, so the
 * frame is skipped by the explicit `<= 0` check in `mux.ts` rather than by
 * an exception that would (wrongly) cost the entire span.
 *
 * Bytes: SOI (`FFD8`), then an SOF0 marker (`FFC0`) at offset 2 with a
 * 2-byte segment length, a 1-byte precision, then height/width as two
 * zeroed `uint16`s at the exact offsets `jpegSize` reads (`offset+5` /
 * `offset+7`, i.e. absolute 7 and 9 here).
 */
function zeroDimJpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0, 0, 0,
    0, 0, 0, 0, 0, 0,
  ]);
}

/** Not a JPEG at all — `jpegSize` walks off the end of the buffer without
 *  ever finding an SOF marker and throws. Distinct from `zeroDimJpeg()`
 *  above: this is meant to cost the WHOLE span (the "will not encode"
 *  test), not just the one frame. */
function garbageBytes(): Uint8Array {
  return new Uint8Array([1, 2, 3]);
}

/** Parks `count` real (or substituted) JPEGs at consecutive indices from
 *  `firstFrameIndex`, and returns the matching `ParkedSpan` plus the
 *  `bundle.motionSpans` entry it corresponds to — the two halves `mux.ts`
 *  requires to be aligned by `ref`. */
async function parkSpan(opts: {
  index: number;
  firstFrameIndex: number;
  count: number;
  startMs: number;
  endMs: number;
  /** When each frame was painted; spread evenly from start to end if left
   *  out. */
  frameMs?: number[];
  bytesFor?: (i: number) => Uint8Array;
}): Promise<{ parked: ParkedSpan; bundleSpan: BundleSpan }> {
  const bytesFor = opts.bytesFor ?? (() => largeJpeg());
  for (let i = 0; i < opts.count; i++) {
    await store.putParked(NAMESPACE, opts.firstFrameIndex + i, bytesFor(i));
  }
  const ref = `span:${SCENE_ID}:${opts.index}`;
  const fps =
    opts.count > 1 ? (opts.count * 1000) / (opts.endMs - opts.startMs) : 1;
  const parked: ParkedSpan = {
    index: opts.index,
    ref,
    startMs: opts.startMs,
    endMs: opts.endMs,
    firstFrameIndex: opts.firstFrameIndex,
    frames: opts.count,
    frameMs:
      opts.frameMs ??
      Array.from({ length: opts.count }, (_, i) =>
        opts.count > 1
          ? opts.startMs + (i * (opts.endMs - opts.startMs)) / (opts.count - 1)
          : opts.startMs,
      ),
    width: LARGE_FIXTURE_WIDTH,
    height: LARGE_FIXTURE_HEIGHT,
    kept: true,
  };
  const bundleSpan: BundleSpan = {
    startMs: opts.startMs,
    endMs: opts.endMs,
    ref,
    width: LARGE_FIXTURE_WIDTH,
    height: LARGE_FIXTURE_HEIGHT,
    fps,
    byteLength: 0,
  };
  return { parked, bundleSpan };
}

function bundleWith(spans: BundleSpan[]): FrameBundle {
  return {
    bundleVersion: 1,
    sceneId: SCENE_ID,
    source: "replay",
    dpr: 3,
    viewport: { width: 1280, height: 800 },
    keyframes: [
      {
        sourceTimeMs: 0,
        ref: "kf:s1:0",
        width: 100,
        height: 100,
        actionId: null,
        byteLength: 0,
      },
    ],
    motionSpans: spans,
    cursorSamples: [{ sourceTimeMs: 0, x: 0, y: 0 }],
    cursorGaps: [],
    anchorRects: [],
    markers: [],
    degradations: [],
  };
}

/**
 * Decodes one frame out of a produced mp4, in the page — mediabunny's
 * demux needs WebCodecs, which node has none of either. Injects the
 * test-only probe bundle (`decode-probe-entry.ts`) onto `page` — additively,
 * alongside `mux.ts`'s own production script, never in place of it — then
 * calls its `decodeFrame`. Per CLAUDE.md's "assert on the picture, not the
 * bundle" — this is how that assertion gets made here.
 */
async function decodeInPage(
  page: Page,
  bytes: Uint8Array,
  atSec: number,
): Promise<{ width: number; height: number; decoded: boolean }> {
  await page.addScriptTag({ content: await muxProbeBundle() });
  const base64 = Buffer.from(bytes).toString("base64");
  return page.evaluate(
    ([globalName, data, at]) => {
      const entry = (
        globalThis as unknown as Record<
          string,
          | {
              decodeFrame(
                b: string,
                a: number,
              ): Promise<{ width: number; height: number; decoded: boolean }>;
            }
          | undefined
        >
      )[globalName as string];
      if (entry === undefined) {
        throw new Error(`${globalName} is not installed on this page`);
      }
      return entry.decodeFrame(data as string, at as number);
    },
    [DECODE_PROBE_GLOBAL, base64, atSec] as const,
  );
}

describe("muxSpans", () => {
  // Real Chromium, real production-sized (3840x2400) JPEGs, real WebCodecs
  // encode+decode — genuinely a browser-lane test, not the sub-second a
  // small-fixture test would need. `apps/runner/test/encoder.bench.test.ts`
  // measured the crossing this file's `mux.ts` is built around: ~4.7s for a
  // full 150-frame span (disk ~50ms, transfer ~2.3s, decode ~2.3s). Every
  // span below is 3 frames, two orders of magnitude smaller, plus one
  // browser launch (~100-500ms per `launch.test.ts`'s own measurement) — so
  // a few seconds is the expected order of magnitude here, and 120s leaves
  // room for CI's measured ~5x-slower browser work (CLAUDE.md) many times
  // over.
  it("turns a span's parked JPEGs into an mp4 the compositor can demux", async () => {
    const { parked, bundleSpan } = await parkSpan({
      index: 0,
      firstFrameIndex: 0,
      count: 3,
      startMs: 0,
      endMs: 100,
    });
    const bundle = bundleWith([bundleSpan]);
    const launched = await launch();
    try {
      const outcome = await muxSpans({
        sceneId: SCENE_ID,
        page: launched.page,
        store,
        spans: [parked],
        bundle,
        report: () => undefined,
      });
      expect(outcome.muxed).toEqual([
        { index: 0, spanIndex: 0, kept: true, lost: 0, reason: null },
      ]);
      expect(outcome.shortfall).toBe(0);

      const bytes = await store.load(parked.ref);
      const probe = await decodeInPage(launched.page, bytes, 0);
      expect(probe.width).toBe(3840);
      expect(probe.decoded).toBe(true);
    } finally {
      await launched.close();
    }
  }, 120_000);

  // A 1710x1107 window screencast at REPLAY_DPR 3 (2026-10-21): every
  // such span was refused whole and cut from Excalidraw's and Actual's films.
  it("muxes a span too large for the encoder at the largest size it takes, and the bundle says that size", async () => {
    const launched = await launch();
    try {
      const page = launched.page;
      const big = Buffer.from(
        await page.evaluate(async () => {
          const canvas = new OffscreenCanvas(5130, 3320);
          const ctx = canvas.getContext(
            "2d",
          ) as OffscreenCanvasRenderingContext2D;
          ctx.fillStyle = "#1971c2";
          ctx.fillRect(0, 0, 5130, 3320);
          const blob = await canvas.convertToBlob({ type: "image/jpeg" });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (const b of bytes) binary += String.fromCharCode(b);
          return btoa(binary);
        }),
        "base64",
      );
      const { parked, bundleSpan } = await parkSpan({
        index: 0,
        firstFrameIndex: 0,
        count: 3,
        startMs: 0,
        endMs: 100,
        bytesFor: () => new Uint8Array(big),
      });
      bundleSpan.width = 5130;
      bundleSpan.height = 3320;
      const bundle = bundleWith([bundleSpan]);
      const outcome = await muxSpans({
        sceneId: SCENE_ID,
        page,
        store,
        spans: [parked],
        bundle,
        report: () => undefined,
      });
      // The premise: this browser's encoder refuses the span's own size. Asked
      // after the mux, whose loopback page is the secure context WebCodecs needs.
      const supported = await page.evaluate(
        async () =>
          (
            await VideoEncoder.isConfigSupported({
              codec: "avc1.64003c",
              width: 5130,
              height: 3320,
            })
          ).supported,
      );
      expect(supported).toBe(false);
      expect(outcome.muxed).toEqual([
        { index: 0, spanIndex: 0, kept: true, lost: 0, reason: null },
      ]);
      const { width, height } = bundle.motionSpans[0] as BundleSpan;
      expect(width).toBeLessThan(5130);
      expect(width / height).toBeCloseTo(5130 / 3320, 2);
      const probe = await decodeInPage(page, await store.load(parked.ref), 0);
      expect(probe).toEqual({ width, height, decoded: true });
    } finally {
      await launched.close();
    }
  }, 120_000);

  // A continuous replay's span ends SPAN_QUIET_MS (250) after its last
  // paint, and the frames inside it are as sparse as the page's changes: a
  // `type` of "4800" paints a key every 70 ms. Spread evenly to the span's
  // end, the last key played 250 ms after it landed, while the cursor and
  // the camera, on the real clock, had already left for the next click
  // (the site's hero, 2026-10-19). Each frame belongs at its own time.
  it("places each frame at the time it was painted, not spread to the span's end", async () => {
    const frameMs = [5000, 5070, 5140];
    const { parked, bundleSpan } = await parkSpan({
      index: 0,
      firstFrameIndex: 0,
      count: 3,
      startMs: 5000,
      endMs: 5390,
      frameMs,
    });
    // Premise: the span runs on past its last frame, as a real one does, so
    // an even spread and the real times put the frames in different places.
    expect(parked.endMs - (frameMs.at(-1) as number)).toBe(250);
    const bundle = bundleWith([bundleSpan]);
    const launched = await launch();
    let bytes: Uint8Array;
    try {
      const outcome = await muxSpans({
        sceneId: SCENE_ID,
        page: launched.page,
        store,
        spans: [parked],
        bundle,
        report: () => undefined,
      });
      expect(outcome.muxed).toEqual([
        { index: 0, spanIndex: 0, kept: true, lost: 0, reason: null },
      ]);
      bytes = await store.load(parked.ref);
    } finally {
      await launched.close();
    }
    const read = await mp4FrameTimes(bytes);
    // Relative to the span's start, which is what the renderer seeks by.
    const wantSec = frameMs.map((ms) => (ms - 5000) / 1000);
    expect(
      read.timesSec,
      `decoded ${JSON.stringify(read.timesSec)}`,
    ).toHaveLength(3);
    read.timesSec.forEach((t, i) => {
      expect(
        Math.abs(t - (wantSec[i] as number)),
        `frame ${i} decoded at ${t}s, painted at ${wantSec[i]}s; all: ${JSON.stringify(read.timesSec)}`,
      ).toBeLessThan(0.002);
    });
  }, 120_000);

  it("patches each span's byteLength on the bundle with the real number", async () => {
    // closeSpan cannot know it — the frames are not encoded yet — so it
    // writes 0 and this is where the number comes from. A bundle
    // carrying a fabricated byteLength is a number nobody measured, and
    // the storage lifecycle reads it.
    const { parked, bundleSpan } = await parkSpan({
      index: 0,
      firstFrameIndex: 0,
      count: 3,
      startMs: 0,
      endMs: 100,
    });
    const bundle = bundleWith([bundleSpan]);
    expect(bundle.motionSpans[0]?.byteLength).toBe(0);

    const launched = await launch();
    try {
      await muxSpans({
        sceneId: SCENE_ID,
        page: launched.page,
        store,
        spans: [parked],
        bundle,
        report: () => undefined,
      });
      expect(bundle.motionSpans[0]?.byteLength).toBeGreaterThan(1000);
    } finally {
      await launched.close();
    }
  }, 120_000);

  it("costs one span, not the run, when a span will not encode — and says which", async () => {
    const good = await parkSpan({
      index: 0,
      firstFrameIndex: 0,
      count: 3,
      startMs: 0,
      endMs: 100,
    });
    const corrupt = await parkSpan({
      index: 1,
      firstFrameIndex: 3,
      count: 3,
      startMs: 100,
      endMs: 200,
      bytesFor: garbageBytes,
    });
    const good2 = await parkSpan({
      index: 2,
      firstFrameIndex: 6,
      count: 3,
      startMs: 200,
      endMs: 300,
    });
    const bundle = bundleWith([
      good.bundleSpan,
      corrupt.bundleSpan,
      good2.bundleSpan,
    ]);

    const warnings: unknown[][] = [];
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args);
      });

    const launched = await launch();
    try {
      const outcome = await muxSpans({
        sceneId: SCENE_ID,
        page: launched.page,
        store,
        spans: [good.parked, corrupt.parked, good2.parked],
        bundle,
        report: () => undefined,
      });
      expect(outcome.muxed).toEqual([
        { index: 0, spanIndex: 0, kept: true, lost: 0, reason: null },
        {
          index: 1,
          spanIndex: 1,
          kept: false,
          lost: corrupt.parked.frames,
          reason: expect.stringMatching(/JPEG|SOF|parse/i),
        },
        { index: 2, spanIndex: 2, kept: true, lost: 0, reason: null },
      ]);
      expect(outcome.shortfall).toBe(corrupt.parked.frames);

      // Runner audit 2026-09-14, finding 1. The reason used to reach a
      // `console.warn` and nothing else: `kept: false` said a span was lost
      // and the WHY went to the process's own stderr, where an in-process
      // consumer of `main(argv, io, run)` (the door `index.ts` exists for)
      // never sees it, and where a terminal read it ABOVE the failure
      // sentence it explains. It rides on the outcome now, so the pipeline
      // can put it in the sentence, and nothing goes to the console at all.
      expect(warnings).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      await launched.close();
    }
  }, 120_000);

  it("writes the patched bundle back to the store, so the row on disk names what the run actually has", async () => {
    // Runner audit 2026-09-14, finding 4. `muxSpans` patched `byteLength`
    // and dropped failed spans on the in-memory bundle only, so the
    // `bundles/<scene>.json` the engine stored before the mux — the row
    // the scratch directory keeps "for debugging" on a failed run — still
    // named a span with no bytes behind it and a byteLength nobody
    // measured: the exact lying row fix round 1 removed from memory.
    const good = await parkSpan({
      index: 0,
      firstFrameIndex: 0,
      count: 3,
      startMs: 0,
      endMs: 100,
    });
    const corrupt = await parkSpan({
      index: 1,
      firstFrameIndex: 3,
      count: 3,
      startMs: 100,
      endMs: 200,
      bytesFor: garbageBytes,
    });
    const bundle = bundleWith([good.bundleSpan, corrupt.bundleSpan]);
    // What the engine does before `runReplay` returns: the row is on disk
    // before the mux ever runs.
    await store.putBundle(SCENE_ID, bundle);

    const launched = await launch();
    try {
      await muxSpans({
        sceneId: SCENE_ID,
        page: launched.page,
        store,
        spans: [good.parked, corrupt.parked],
        bundle,
        report: () => undefined,
      });
    } finally {
      await launched.close();
    }

    const stored = await store.getBundle(SCENE_ID);
    expect(stored).not.toBeNull();
    expect(stored?.motionSpans.map((s) => s.ref)).toEqual([good.parked.ref]);
    expect(stored?.motionSpans[0]?.byteLength).toBeGreaterThan(0);
  }, 120_000);

  it("skips a frame whose measured size is not positive rather than putting 0x0 in the bundle", async () => {
    // capture-mux's lesson: a truncated SOF becomes a 0x0 dimension.
    // Skipping it, not pushing it, is what keeps that dimension from
    // reaching anything a schema later validates.
    const { parked, bundleSpan } = await parkSpan({
      index: 0,
      firstFrameIndex: 0,
      count: 3,
      startMs: 0,
      endMs: 100,
      bytesFor: (i) => (i === 1 ? zeroDimJpeg() : largeJpeg()),
    });
    const bundle = bundleWith([bundleSpan]);

    const launched = await launch();
    try {
      const outcome = await muxSpans({
        sceneId: SCENE_ID,
        page: launched.page,
        store,
        spans: [parked],
        bundle,
        report: () => undefined,
      });
      expect(outcome.muxed).toEqual([
        { index: 0, spanIndex: 0, kept: true, lost: 1, reason: null },
      ]);
      expect(outcome.shortfall).toBe(1);
      // The span still produced a real mp4 from its two good frames —
      // one degenerate frame costs itself, not the span.
      expect(bundle.motionSpans[0]?.byteLength).toBeGreaterThan(1000);
    } finally {
      await launched.close();
    }
  }, 120_000);

  it("removes a span that failed to mux from the bundle, rather than leaving a ref with nothing behind it", async () => {
    // Fix round 1: a failed span used to stay in `bundle.motionSpans`
    // carrying its placeholder `byteLength: 0` and a `ref` the store
    // never wrote bytes under — schema-indistinguishable from a
    // legitimately unmeasured row, and undetectable except by reading
    // `outcome.muxed`, which nothing downstream was made to do.
    const good = await parkSpan({
      index: 0,
      firstFrameIndex: 0,
      count: 3,
      startMs: 0,
      endMs: 100,
    });
    const failing = await parkSpan({
      index: 1,
      firstFrameIndex: 3,
      count: 3,
      startMs: 100,
      endMs: 200,
      bytesFor: garbageBytes,
    });
    const bundle = bundleWith([good.bundleSpan, failing.bundleSpan]);

    const launched = await launch();
    try {
      const outcome = await muxSpans({
        sceneId: SCENE_ID,
        page: launched.page,
        store,
        spans: [good.parked, failing.parked],
        bundle,
        report: () => undefined,
      });

      // The bundle handed back is coherent on its own: only the span
      // that actually muxed remains, and it is the SAME span (by ref).
      expect(bundle.motionSpans.map((s) => s.ref)).toEqual([good.parked.ref]);
      // Every remaining ref actually loads — not merely present, but
      // backed by real bytes in the store.
      for (const span of bundle.motionSpans) {
        await expect(store.load(span.ref)).resolves.toBeInstanceOf(Uint8Array);
      }
      // The store still has nothing under the failed span's ref.
      await expect(store.load(failing.parked.ref)).rejects.toThrow();

      // The outcome still reports the failure, with its lost count —
      // removing the row from the bundle must not also remove the fact
      // from the outcome.
      expect(outcome.muxed).toEqual([
        { index: 0, spanIndex: 0, kept: true, lost: 0, reason: null },
        {
          index: 1,
          spanIndex: 1,
          kept: false,
          lost: failing.parked.frames,
          reason: expect.any(String),
        },
      ]);
      expect(outcome.shortfall).toBe(failing.parked.frames);
    } finally {
      await launched.close();
    }
  }, 120_000);

  it("names spans by the parked index the ref carries, not by their position among the kept ones", async () => {
    // Review of the runner audit, finding 3. `muxed[].index` is the
    // position among KEPT spans — what indexes `bundle.motionSpans` — while
    // the encoder numbers every span it opens, kept or not, and puts that
    // number in the ref (`span:<scene>:<N>`). A static click that opened
    // span 0 and was not kept shifts the two apart, and the same span was
    // being reported as "span 1" by one line and "span 0" by the next.
    // `spanIndex` is the parked one — the number the author can find in
    // the bundle's own ref — for every line the pipeline prints.
    const motion = await parkSpan({
      index: 1,
      firstFrameIndex: 1,
      count: 3,
      startMs: 100,
      endMs: 200,
    });
    const bundle = bundleWith([motion.bundleSpan]);
    const launched = await launch();
    try {
      const outcome = await muxSpans({
        sceneId: SCENE_ID,
        page: launched.page,
        store,
        // Only the kept span is passed in — the unkept span 0 never
        // reaches the mux — so `index` is 0 and `spanIndex` is 1.
        spans: [motion.parked],
        bundle,
        report: () => undefined,
      });
      expect(outcome.muxed).toEqual([
        { index: 0, spanIndex: 1, kept: true, lost: 0, reason: null },
      ]);
    } finally {
      await launched.close();
    }
  }, 120_000);

  it("reports, rather than throws, when the patched bundle cannot be written back", async () => {
    // Review of the runner audit, finding 1 of that review: the write-back
    // was unguarded, so a scratch store that refused the row — the very
    // failure the engine forgives as `storageRefused` — escaped `muxSpans`
    // as an exit-70 "bug in the runner" over spans that had all muxed.
    // The write is bookkeeping for the scratch directory, not a render
    // precondition: it is forgiven, and it says so through the reporter.
    const good = await parkSpan({
      index: 0,
      firstFrameIndex: 0,
      count: 3,
      startMs: 0,
      endMs: 100,
    });
    const bundle = bundleWith([good.bundleSpan]);
    const refusing: RunnerStore = {
      ...store,
      putBundle: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    };
    const reported: string[] = [];
    const launched = await launch();
    try {
      const outcome = await muxSpans({
        sceneId: SCENE_ID,
        page: launched.page,
        store: refusing,
        spans: [good.parked],
        bundle,
        report: (line) => reported.push(line),
      });
      expect(outcome.muxed[0]?.kept).toBe(true);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("ENOSPC");
    } finally {
      await launched.close();
    }
  }, 120_000);

  it("throws, rather than reporting a span failure, when the bundle and the parked spans are misaligned", async () => {
    // Round 2's finding 6. `spans` and `bundle.motionSpans` disagreeing is
    // this engine's own invariant broken, not a scene the author can fix —
    // but the guard for it lived INSIDE the per-span try, so it came back
    // through the same channel a span whose frames would not encode does:
    // `muxFailed`, exit 5, "span N could not be encoded", sending the reader
    // to look at frame data. Worse, the catch then did
    // `failedRefs.add(bundleSpan.ref)` — marking for removal the row that
    // happened to sit at that index, which by definition is a DIFFERENT span
    // from the one that failed, and here is one that would have muxed fine.
    //
    // Two spans, their bundle rows swapped, so index 0 pairs parked span 0
    // with bundle row 1.
    const first = await parkSpan({
      index: 0,
      firstFrameIndex: 0,
      count: 2,
      startMs: 0,
      endMs: 100,
    });
    const second = await parkSpan({
      index: 1,
      firstFrameIndex: 2,
      count: 2,
      startMs: 100,
      endMs: 200,
    });
    const bundle = bundleWith([second.bundleSpan, first.bundleSpan]);
    const refsBefore = bundle.motionSpans.map((span) => span.ref);

    const launched = await launch();
    try {
      await expect(
        muxSpans({
          sceneId: SCENE_ID,
          page: launched.page,
          store,
          spans: [first.parked, second.parked],
          bundle,
          report: () => undefined,
        }),
      ).rejects.toThrow(/misaligned/i);

      // And it removed nothing on the way out. The old code dropped
      // `bundle.motionSpans[0]` — `second`'s row — over `first`'s failure.
      expect(bundle.motionSpans.map((span) => span.ref)).toEqual(refsBefore);
    } finally {
      await launched.close();
    }
  }, 120_000);
});
