import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import { createFileFrameStore } from "../src/frame-store.js";
import {
  LARGE_FIXTURE_HEIGHT,
  LARGE_FIXTURE_WIDTH,
  largeJpeg,
} from "./fixtures/jpeg.js";

/**
 * Design §3's "one measurement this design does not have": screencast
 * frames arrive in node as base64 from CDP and must reach a page to be
 * decoded (`createImageBitmap`) before they can be muxed into mp4, and at a
 * span cap of ~150 frames that crossing is a real per-frame cost nothing in
 * this repo had measured before this task. This is that measurement.
 *
 * **Measured against `frame-large.jpg` — the production frame size**
 * (`REPLAY_DPR` x a 1280x800 scene = 3840x2400, ~1.05 MB per JPEG), not the
 * 100x50 fixture `encoder.test.ts` uses for its unit tests. A first pass of
 * this bench measured the 100x50 fixture (disk 6ms / transfer 6ms / decode
 * 20ms, ~32ms total) and that number was flagged in review as answering a
 * different question: at production size the base64 payload for one span
 * is tens of megabytes, not a few hundred kilobytes, and *that* crossing is
 * the one the design named as unmeasured.
 *
 * **A single `page.evaluate` call carrying the whole span crashes the page
 * at production size.** A one-shot transfer of the span's frames as one
 * base64 array — what the first draft of this bench did, and what a naive
 * mux implementation would do — was measured directly against a range of
 * span sizes: 50 frames (~73 MB of base64) transferred in ~870ms; 55-70
 * frames (~80-103 MB) still transferred, at up to ~1.25s; 75 frames
 * (~110 MB) and above failed every time with "Target page, context or
 * browser has been closed" — the renderer dies, not the call timing out.
 * That lands almost exactly on Chromium's own control-message size ceiling
 * (its Mojo/CDP transport caps a single message well under 128 MB), so a
 * ~150-frame span's ~220 MB of base64 cannot cross in one call at all,
 * regardless of how fast the crossing is. **So this bench — and any real
 * mux — must chunk the transfer.** `BATCH_SIZE` below (25 frames, ~37 MB of
 * base64 per call) was chosen with real margin under the ~70-75 frame
 * boundary that was actually observed to still succeed.
 *
 * It reports rather than gates: the only assertion is a generous ceiling,
 * so a slow machine fails loudly with a printed number rather than a
 * silent skip. It is not in the `test` lane, so CI does not run it: run
 * `pnpm --filter @demoman/runner bench` (after `pnpm -r build`, since this
 * lane reads `dist`) when the crossing it measures changes. The numbers below are quoted in `mux.ts`'s header docblock
 * (once that file exists — Task 11) and in the design document.
 */
const SPAN_CAP = 150;
/**
 * Frames per `page.evaluate` call. Chosen with real margin under the
 * observed single-call failure boundary (75 frames / ~110 MB base64 failed
 * every time; 70 / ~103 MB still succeeded) — see the docblock above. Task
 * 11's real mux needs the same chunking, for the same reason: it is not an
 * optimization, it is what makes a full span transferable at all.
 */
const BATCH_SIZE = 25;
// Generous on purpose (see docblock above); this is a report, not a gate.
// Production-sized frames make this bench genuinely slow (real disk I/O, a
// real multi-ten-megabyte CDP payload per chunk, real JPEG decode), so the
// ceiling is set from what this machine actually measured, with real
// headroom — not the ~30s that was plausible for the 100x50 fixture. If
// this ever trips, the runner's own ~5x-slower-than-dev-Mac rule
// (CLAUDE.md) means the real number is worth re-quoting, not just raising
// the ceiling.
const CEILING_MS = 120_000;

describe("the base64 crossing at production frame size (bench, not a gate)", () => {
  // Launches Chromium and does real IPC + decode work at production frame
  // size, chunked across several page.evaluate calls — genuinely slow, not
  // the sub-second a small-fixture browser test would need. The runner's
  // own rule (CLAUDE.md) says give any browser test near 3s locally an
  // explicit timeout with 5x CI headroom; this is well past that bar
  // already, so the timeout below is set from the measured total with real
  // margin, not the 60s that was enough for the 100x50 fixture.
  it(`parks ${SPAN_CAP} real ${LARGE_FIXTURE_WIDTH}x${LARGE_FIXTURE_HEIGHT} JPEGs, then times disk read, chunked page-evaluate transfer as base64, and createImageBitmap decode`, async () => {
    // Removed when this test finishes (whole-branch review finding 7): it
    // parks SPAN_CAP production-sized JPEGs — 158 MB per run, and 1.1 GB
    // was measured sitting in one TMPDIR from earlier runs that removed
    // none of it.
    const benchRoot = mkdtempSync(join(tmpdir(), "demoman-encoder-bench-"));
    // `onTestFinished`, not a `finally` around the browser below: this runs
    // whichever way the test ends — assertion failure, timeout, a throw in
    // the parking loop before Chromium is even launched — and a bench that
    // tripped its ceiling has no more claim on 158 MB of disk than one that
    // passed.
    onTestFinished(() => {
      rmSync(benchRoot, { recursive: true, force: true });
    });
    const store = createFileFrameStore(benchRoot);
    const namespace = "bench:replay";
    const frameBytes = largeJpeg();
    for (let i = 0; i < SPAN_CAP; i++) {
      await store.putParked(namespace, i, frameBytes);
    }

    // (a) Off disk, as the mux would read a span's worth of frames back.
    const diskStart = performance.now();
    const parked = await store.readParked(namespace, 0, SPAN_CAP);
    const diskMs = performance.now() - diskStart;
    expect(parked).toHaveLength(SPAN_CAP);

    // Node-side base64 encoding is part of "getting them into a page as
    // base64" — CDP already hands screencast frames over this way, so
    // this mirrors the shape without re-decoding what CDP already gave.
    const base64Frames = parked.map((frame) =>
      Buffer.from(frame.bytes).toString("base64"),
    );
    const base64Bytes = base64Frames.reduce((n, f) => n + f.length, 0);

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();

      // (b) + (c): chunked. Each chunk crosses once — a real mux would
      // decode in the same call that receives the frames, not do a
      // separate transfer-only pass, so this measures it the way
      // production would actually run it: node-side wall time around the
      // call is the transfer+decode round trip, and the in-page
      // `performance.now()` return value is decode alone, so
      // transfer = roundtrip - decode.
      let transferMs = 0;
      let decodeMs = 0;
      for (let start = 0; start < base64Frames.length; start += BATCH_SIZE) {
        const chunk = base64Frames.slice(start, start + BATCH_SIZE);
        const roundTripStart = performance.now();
        const chunkDecodeMs: number = await page.evaluate(
          async (frames: string[]) => {
            const decodeStart = performance.now();
            for (const base64 of frames) {
              const binary = atob(base64);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              const blob = new Blob([bytes], { type: "image/jpeg" });
              const bitmap = await createImageBitmap(blob);
              bitmap.close();
            }
            return performance.now() - decodeStart;
          },
          chunk,
        );
        const roundTripMs = performance.now() - roundTripStart;
        decodeMs += chunkDecodeMs;
        transferMs += roundTripMs - chunkDecodeMs;
      }

      const totalMs = diskMs + transferMs + decodeMs;
      const chunkCount = Math.ceil(base64Frames.length / BATCH_SIZE);
      console.log(
        `[encoder.bench] ${SPAN_CAP} frames @ ${LARGE_FIXTURE_WIDTH}x${LARGE_FIXTURE_HEIGHT} ` +
          `(${(frameBytes.byteLength / 1024).toFixed(0)}KB/frame raw, ` +
          `${(base64Bytes / 1024 / 1024).toFixed(1)}MB base64 total, ` +
          `${chunkCount} chunks of ${BATCH_SIZE}): ` +
          `disk read ${diskMs.toFixed(1)}ms, ` +
          `page-evaluate transfer (base64, chunked) ${transferMs.toFixed(1)}ms, ` +
          `createImageBitmap decode ${decodeMs.toFixed(1)}ms, ` +
          `total ${totalMs.toFixed(1)}ms ` +
          `(${(totalMs / SPAN_CAP).toFixed(1)}ms/frame)`,
      );
      expect(totalMs).toBeLessThan(CEILING_MS);
    } finally {
      await browser.close();
    }
  }, 150_000);
});
