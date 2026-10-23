/**
 * Phase two (a): the parked frames a replay left on disk, turned into the
 * real per-span mp4s the render phase demuxes.
 *
 * **The measured constraint that decided this file's shape** (Task 6,
 * `apps/runner/test/encoder.bench.test.ts`, run against
 * `test/fixtures/frame-large.jpg` — a real 3840x2400 JPEG, `REPLAY_DPR` x a
 * 1280x800 scene, ~1.05 MB each):
 *
 * - Passing a whole span's base64 through a SINGLE `page.evaluate` **kills
 *   the entire browser** above ~70-75 frames (~103-110 MB of base64).
 *   Verified twice independently: 70 frames (~103 MB) transfers; 75
 *   (~110 MB) fails every time. This is not slowness — it lands on
 *   Chromium's own Mojo/CDP control-message size ceiling, so no amount of
 *   patience fixes it.
 * - It presents as `Target page, context or browser has been closed` — not
 *   a timeout, not a catchable error with useful content, and
 *   **unrecoverable in place**: the report that found it also found the
 *   next `browser.newPage()` on the same browser failing too. There is no
 *   retrying on the same page, only on a fresh browser.
 * - The span cap is ~150 frames (`SPAN_MAX_MS` at the admitted frame rate),
 *   so an unchunked mux — a single `page.evaluate` handed a whole span's
 *   base64 — fails HARD on any real motion span, not just a pathological
 *   one.
 * - Chunked at 25 frames per `page.evaluate` (`BATCH_SIZE` in the bench),
 *   150 frames cost ~4.7s total: disk ~50ms, transfer ~2.3s, decode ~2.3s
 *   (~31ms/frame). Real margin under the ~70-75 frame crash boundary.
 *
 * **So chunking is mandatory, not an optimisation** — and this file avoids
 * the base64-through-`page.evaluate` crossing for the INPUT side
 * altogether rather than merely chunking it: `muxSpans` starts a small
 * http server of its own and hands `mux-entry.ts` a manifest of same-origin
 * URLs (tiny — a few numbers per frame) instead of the frames' bytes. The
 * page fetches each JPEG itself; an http response has no CDP
 * control-message ceiling, so no frame count crosses that boundary at all.
 * `mux-entry.ts`'s `readChunk` is the one place this file still crosses
 * bytes through `page.evaluate` — for the OUTPUT mp4, which can also be
 * tens of megabytes — and it reuses the exact chunked-base64 transport
 * `packages/compositor/scripts/render-fixture.ts` already ships
 * (`CHUNK_BYTES` below matches its constant), rather than inventing a
 * second one for the same problem in the other direction.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { type FrameBundle, fitH264Frame } from "@demoman/compositor";
import { jpegSize } from "@demoman/replay-engine";
import type { Page } from "playwright";
import { bundleEntry } from "./bundle-js.js";
import type { ParkedSpan } from "./encoder.js";
import { MUX_ENTRY_GLOBAL } from "./entry-globals.js";
import type { RunnerStore } from "./frame-store.js";
import { listenOnLoopback } from "./loopback.js";
import type { MuxSpanManifest } from "./mux-entry.js";
import { messageOf, type Report } from "./report.js";

/** Bytes pulled back per `page.evaluate` round trip for the finished mp4.
 *  Matches `render-fixture.ts`'s own `CHUNK_BYTES` — the same transport,
 *  reused rather than reinvented at a different number for no reason. */
const CHUNK_BYTES = 4_000_000;

/**
 * The intermediate span's own encode bitrate — matches `SPAN_BITRATE` in
 * `apps/extension/src/adapters/encoder-webcodecs.ts`, the analogous
 * span-level encode on the capture side of this same seam. This mp4 is not
 * the deliverable; the render phase demuxes it and re-encodes at the
 * output target's own bitrate, so this number only has to survive one
 * more generation without visibly degrading, which is exactly what the
 * capture path already asks of the identical number.
 */
const MUX_BITRATE = 12_000_000;

export interface MuxOutcome {
  /** Per span: whether it encoded, how many of its claimed frames the span
   *  does not contain, and — when it did not encode — why. Required, not
   *  optional — an implementation that omitted it would be
   *  indistinguishable from one reporting no loss. */
  muxed: MuxedSpan[];
  shortfall: number;
}

/**
 * One span's mux result.
 *
 * `index` is the span's position among the KEPT spans passed in — the same
 * position it holds in `bundle.motionSpans`, the array this outcome's
 * caller just had patched — and exists for that alignment. `spanIndex` is
 * the PARKED index: the encoder's own counter over every span it opened,
 * kept or not, and the number in the span's ref (`span:<scene>:<N>`). The
 * two drift apart as soon as one static click is not kept, so every line a
 * human reads names `spanIndex` — the number they can find in the bundle
 * — never `index` (review of the runner audit, finding 3).
 *
 * `reason` is the failure's own message on an unkept span and `null` on a
 * kept one, and the type says so: an implementation that pushed
 * `{ kept: false, reason: null }` does not compile, so no consumer needs
 * a fallback for it. Runner audit 2026-09-14, finding 1: the reason used
 * to go to `console.warn` and nothing else, so the CLI's sentence could
 * only say how much was lost, an in-process caller never learned why, and
 * a terminal read the why ABOVE the sentence it explains.
 */
export type MuxedSpan = { index: number; spanIndex: number; lost: number } & (
  | { kept: true; reason: null }
  | { kept: false; reason: string }
);

/** The in-page entry, as this module is running: `src/mux-entry.ts` under
 *  vite-node/tsx, `dist/mux-entry.js` from the shipped CLI. Same rule as
 *  `page-agent.ts`'s `ENTRY_PATH` — decided from this module's own
 *  extension, never by probing the filesystem. */
const ENTRY_PATH = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "./mux-entry.ts" : "./mux-entry.js",
    import.meta.url,
  ),
);

let bundled: Promise<string> | null = null;
function muxEntryBundle(): Promise<string> {
  bundled ??= bundleEntry(ENTRY_PATH).catch((error: unknown) => {
    bundled = null;
    throw error;
  });
  return bundled;
}

/**
 * Runs `muxSpan` on the page's `MUX_ENTRY_GLOBAL`.
 *
 * `page.evaluate` serializes only this function's own source text and
 * re-runs it inside the page — it carries no closure over anything else in
 * this module, `MuxEntry` included (erased at compile time, harmless) — so
 * the "is the global even installed" check has to be written out again
 * here rather than shared with `readChunkInPage` below. Same duplication
 * `page-agent.ts`'s `frameForHop` and its resolve call already carry across
 * their own two `page.evaluate` call sites, for the identical reason.
 */
async function muxSpanInPage(
  page: Page,
  manifest: MuxSpanManifest,
): Promise<{ byteLength: number }> {
  return page.evaluate(
    ([globalName, spanManifest]) => {
      const entry = (
        globalThis as unknown as Record<
          string,
          { muxSpan(m: unknown): Promise<{ byteLength: number }> } | undefined
        >
      )[globalName as string];
      if (entry === undefined) {
        throw new Error(
          `${globalName} is not installed on this page — mux.ts must inject ` +
            "mux-entry.ts's bundle before calling into it",
        );
      }
      return entry.muxSpan(spanManifest);
    },
    [MUX_ENTRY_GLOBAL, manifest] as const,
  );
}

async function readChunkInPage(
  page: Page,
  offset: number,
  length: number,
): Promise<string> {
  return page.evaluate(
    ([globalName, chunkOffset, chunkLength]) => {
      const entry = (
        globalThis as unknown as Record<
          string,
          { readChunk(o: number, l: number): string } | undefined
        >
      )[globalName as string];
      if (entry === undefined) {
        throw new Error(
          `${globalName} is not installed on this page — mux.ts must inject ` +
            "mux-entry.ts's bundle before calling into it",
        );
      }
      return entry.readChunk(chunkOffset as number, chunkLength as number);
    },
    [MUX_ENTRY_GLOBAL, offset, length] as const,
  );
}

/**
 * Turns a replay's parked motion spans into real mp4s, inside `page` — a
 * BLANK page, because WebCodecs (`createMp4Sink`, behind `mux-entry.ts`)
 * exists there and nowhere in node.
 *
 * Only the spans the ORIGINAL parking encoder marked `kept` are attempted:
 * an unkept span never reached `bundle.motionSpans` (see `encoder.ts`'s
 * `closeSpan` and `motion-recorder.ts`'s `onSpan`, which is called only for
 * a non-null `EncodedSpan`), so there is nothing in the bundle for this
 * function to patch and nothing a caller could do with a report about it —
 * that span's story was already told, by Task 6's own `ParkedSpan.kept`.
 * The kept spans' order, preserved through the filter below, is exactly
 * `bundle.motionSpans`'s order, which is what lets `muxed[].index` double
 * as the patch target's array index.
 *
 * Each kept span is read by its CLAIMED range —
 * `store.readParked(namespace, span.firstFrameIndex, span.frames)` — and
 * every surviving frame is placed at the time it was painted
 * (`span.frameMs`, looked up by its own index), never from its position in
 * the array `readParked` hands back: a frame `readParked` did not find, or
 * one this function rejects for a non-positive measured size, leaves a
 * hole, and nothing after it may be pulled earlier to fill it.
 *
 * Until 2026-10-19 the frames were spread evenly from the span's start to
 * its end, as `capture-mux.ts` still does. A replay span ends its quiet
 * window (`SPAN_QUIET_MS`, 250 ms) after its last paint, so that put every
 * span's last frame 250 ms late and stretched the frames before it, while
 * the cursor and the camera ran on the real clock: on the site's hero the
 * cursor left a typed amount for the next click before its last key showed.
 * The extension's WebCodecs encoder has always used each frame's own time
 * (`encoder-webcodecs.ts`); this is the same rule.
 *
 * A span that throws — a corrupt frame `jpegSize` cannot parse at all, a
 * WebCodecs configuration `createMp4Sink` refuses, an http fetch that
 * fails — costs that span and none after it: caught, reported in `muxed`
 * with every one of its claimed frames counted as lost (a span that threw
 * mid-loop may have muxed some frames and still produced nothing usable,
 * so counting only what it reached would report a partial loss for a total
 * one — the same reasoning `capture-mux.ts`'s own comment gives). The
 * REASON rides on the outcome as `MuxedSpan.reason`: `kept: false` says a
 * span was lost, and the pipeline puts the why in its own sentence.
 *
 * **A span that fails to mux is REMOVED from `bundle.motionSpans`, not
 * left in it.** Fix round 1: a reviewer found that a failed span used to
 * stay in the bundle carrying its placeholder `byteLength: 0` and a `ref`
 * with no bytes ever written under it — `MotionSpanSchema`'s `byteLength`
 * is `.nonnegative()`, not `.positive()`, so that row validates silently
 * and is schema-indistinguishable from a legitimately unmeasured one. A
 * bundle that validates, names a motion span, and cannot serve it is
 * exactly the failure shape CLAUDE.md's "report before you forgive" rule
 * exists to catch: `outcome.muxed[i].kept === false` said so, but nothing
 * made a caller act on it, and the bundle itself kept lying. The removal
 * happens once, after the loop, so index arithmetic inside the loop never
 * has to account for a shrinking array mid-iteration.
 */
export async function muxSpans(input: {
  sceneId: string;
  page: Page;
  store: RunnerStore;
  spans: ParkedSpan[];
  bundle: FrameBundle;
  /** Where the one forgiven failure below — the bundle row that could not
   *  be written back — says why. See `report.ts`. */
  report: Report;
}): Promise<MuxOutcome> {
  const { sceneId, page, store, spans, bundle, report } = input;
  const namespace = `${sceneId}:replay`;

  // Only spans the original encoder considered motion — see the docblock.
  const kept = spans.filter((span) => span.kept);
  const muxed: MuxedSpan[] = [];
  if (kept.length === 0) return { muxed, shortfall: 0 };

  // Refs of spans that failed to mux — removed from `bundle.motionSpans`
  // once, after the loop below, rather than spliced mid-iteration: this
  // loop indexes `bundle.motionSpans` by the kept spans' own position, and
  // shrinking that array while iterating it would misalign every span
  // after the one just removed.
  const failedRefs = new Set<string>();

  // One http server for the whole run: `frames` is overwritten per span
  // (never accumulated), and every request it answers is same-origin to
  // the page `mux-entry.ts` runs in.
  const frames = new Map<string, Uint8Array>();
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><meta charset=utf-8><title>mux</title>");
      return;
    }
    const bytes = frames.get(url);
    if (!bytes) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(Buffer.from(bytes));
  });
  // Loopback only — see `listenOnLoopback`. `listen(0, resolve)` with no
  // host binds every interface, which would put every frame this server
  // holds on the local network, unauthenticated, for the length of the run.
  const origin = await listenOnLoopback(server);

  try {
    await page.goto(origin);
    await page.addScriptTag({ content: await muxEntryBundle() });

    for (let index = 0; index < kept.length; index++) {
      const span = kept[index] as ParkedSpan;
      const bundleSpan = bundle.motionSpans[index];
      // OUTSIDE the per-span try, deliberately (whole-branch review, round
      // 2's finding 6). Inside it, this throw was caught by the same catch
      // that handles a span whose frames would not encode, and reported the
      // same way: `muxFailed`, exit 5, "span N could not be encoded" — which
      // sends the reader to look at frame data, when what is actually true
      // is that `spans` and `bundle.motionSpans` no longer describe the same
      // run. That is this engine's invariant, not the author's scene, and
      // design §5 has a row for it: escaping `muxSpans` entirely reaches
      // `runPipeline`'s catch and exits 70 saying so.
      if (bundleSpan === undefined || bundleSpan.ref !== span.ref) {
        throw new Error(
          `bundle.motionSpans[${index}] is ${bundleSpan === undefined ? "absent" : `"${bundleSpan.ref}"`}, ` +
            `not parked span "${span.ref}" — spans and bundle are misaligned. ` +
            "This is an engine invariant violation, not a problem with the scene.",
        );
      }
      try {
        const slice = await store.readParked(
          namespace,
          span.firstFrameIndex,
          span.frames,
        );
        frames.clear();
        const manifestFrames: { url: string; timestampSec: number }[] = [];
        for (const frame of slice) {
          // Real dimensions off the parked bytes themselves, never the
          // bundle's — a truncated or pathological SOF is exactly what
          // this guards. jpegSize throwing outright (not a JPEG this
          // parser understands at all) is NOT caught here: it propagates
          // to the per-span catch below and costs the whole span, the same
          // way `capture-mux.ts` lets it.
          const size = jpegSize(frame.bytes);
          // A frame whose measured size is not positive is skipped, not
          // pushed: pushing it would eventually hand `createMp4Sink` a
          // 0x0 draw, and worse, `MotionSpanSchema`'s `positive()` would
          // throw a ZodError out of a later bundle re-validation. Skipping
          // it makes it `lost`, which is reported below.
          if (size.width <= 0 || size.height <= 0) continue;
          // Each frame at its own painted time — see the docblock. Looked up
          // by index, so a hole leaves the frames after it where they were.
          const paintedMs = span.frameMs[frame.index - span.firstFrameIndex];
          if (paintedMs === undefined) {
            // Thrown into the per-span catch: the span is lost and says why,
            // rather than muxing a frame at a time nobody measured.
            throw new Error(
              `span ${span.ref} has no painted time for frame ${frame.index} ` +
                `(${span.frameMs.length} times for ${span.frames} frames)`,
            );
          }
          const url = `/f${frame.index}`;
          frames.set(url, frame.bytes);
          const relativeMs = Math.max(0, paintedMs - span.startMs);
          manifestFrames.push({ url, timestampSec: relativeMs / 1000 });
        }
        if (manifestFrames.length === 0) {
          throw new Error(`span ${span.ref} has no usable frames to mux`);
        }

        // At most the size the encoder takes, and the bundle then says so:
        // `span.width` is what a zoom's sharpness is judged against.
        const size = fitH264Frame(bundleSpan.width, bundleSpan.height);
        const manifest: MuxSpanManifest = {
          frames: manifestFrames,
          width: size.width,
          height: size.height,
          fps: bundleSpan.fps,
          bitrate: MUX_BITRATE,
          durationSec: 1 / bundleSpan.fps,
        };
        const { byteLength } = await muxSpanInPage(page, manifest);

        const parts: Buffer[] = [];
        for (let offset = 0; offset < byteLength; offset += CHUNK_BYTES) {
          const base64 = await readChunkInPage(page, offset, CHUNK_BYTES);
          parts.push(Buffer.from(base64, "base64"));
        }
        const bytes = new Uint8Array(Buffer.concat(parts));

        await store.putSpan(span.ref, bytes);
        // Not fabricated: this is the number `sink.finish()` actually
        // produced, read back and measured, over the `0` `encoder.ts`
        // wrote at close time because the real one did not exist yet.
        bundleSpan.byteLength = bytes.byteLength;
        bundleSpan.width = size.width;
        bundleSpan.height = size.height;

        muxed.push({
          index,
          spanIndex: span.index,
          kept: true,
          lost: span.frames - manifestFrames.length,
          reason: null,
        });
      } catch (error) {
        // Keyed on the PARKED span's ref, never on the bundle row that
        // happened to sit at this index. They are the same string here —
        // the guard above this try has already refused any index where they
        // are not — and naming the parked one is what keeps that true if the
        // guard ever moves: `span.ref` is the span that failed, and the row
        // to drop is whichever row names it.
        failedRefs.add(span.ref);
        // The reason rides on the outcome — never the console (report.ts).
        muxed.push({
          index,
          spanIndex: span.index,
          kept: false,
          lost: span.frames,
          reason: messageOf(error),
        });
      }
    }
  } finally {
    server.close();

    if (failedRefs.size > 0) {
      // The bundle this hands back must be coherent on its own: no motion
      // span may name a `ref` with no bytes behind it in the store,
      // whatever `outcome.muxed` also says about why. Reassigning the
      // array (not splicing in place) is still "patched in place" from a
      // caller's point of view — `bundle` is the same object, only this
      // one property moved.
      bundle.motionSpans = bundle.motionSpans.filter(
        (span) => !failedRefs.has(span.ref),
      );
    }

    // Runner audit 2026-09-14, finding 4. Every patch above — the measured
    // `byteLength`s, the removed spans — landed on the in-memory bundle
    // only, while the row the engine stored before `runReplay` returned
    // kept naming spans with no bytes behind them and byteLengths nobody
    // measured. That row is what a failed run's kept scratch directory
    // holds "for debugging", so it has to describe the same run this
    // function just hands back — including on the misalignment throw
    // above, which is why this sits in the `finally`.
    //
    // FORGIVEN, and reported (review of the runner audit, finding 1 of
    // that review): this is bookkeeping for the scratch directory, not a
    // render precondition, and a scratch store that refuses the row is the
    // very failure the engine already forgives as `storageRefused`. Left
    // unguarded, it escaped as an exit-70 "bug in the runner" over spans
    // that had all muxed. The render reads the in-memory bundle either
    // way.
    await store.putBundle(sceneId, bundle).catch((error: unknown) => {
      report(
        "demoman: the bundle row in this run's scratch directory could not " +
          "be updated after the mux — the row on disk still describes the " +
          `bundle as it was before the spans were encoded. ${messageOf(error)}`,
      );
    });
  }

  const shortfall = muxed.reduce((total, m) => total + m.lost, 0);
  return { muxed, shortfall };
}
