/**
 * The in-page half of the mux (Task 11) — see `mux.ts`'s header docblock
 * for the measurement that decided why frames arrive the way they do.
 *
 * Bundled by `bundleEntry` and injected with `page.addScriptTag` into the
 * one blank page `muxSpans` drives once for the whole run. There is no
 * navigation here beyond the one to `mux.ts`'s own http server, and no DOM
 * to resolve against — just `fetch`, `OffscreenCanvas` and WebCodecs.
 *
 * `createMp4Sink` is `@demoman/compositor`'s mediabunny wrapper — never a
 * second encoder. `apps/extension`'s `createWebCodecsEncoder` is the
 * extension's own and cannot be imported here; writing a second one would
 * be the divergent double this design keeps refusing (see `capture-mux.ts`
 * for the same refusal on the extension's side of the same seam).
 *
 * **No test-only code lives in this file.** It used to carry a decode probe
 * for `mux.test.ts`'s "assert on the picture" checks, and a reviewer
 * measured what that actually cost: this file's own bundled output alone
 * (`muxSpan`/`readChunk`, no probe) is 987,225 bytes; with the probe's
 * `mediabunny` demux imports (`Input`/`ALL_FORMATS`/`CanvasSink`) it was
 * 1,657,504 bytes — ~654 KB, ~40%, of dead weight injected into the page on
 * every real replay run for a codepath only a test ever calls. The probe
 * now lives in `decode-probe-entry.ts`, its own bundle that only
 * `mux.test.ts` loads.
 */
import { createMp4Sink, type RenderTarget } from "@demoman/compositor";
import { MUX_ENTRY_GLOBAL } from "./entry-globals.js";

/** One parked frame, described rather than carried: `url` is a same-origin
 *  path `mux.ts`'s own http server answers with this frame's raw JPEG
 *  bytes — never base64 through `page.evaluate`'s own transport, which is
 *  exactly the crossing `mux.ts`'s docblock measures and refuses. */
export interface MuxFrameManifest {
  url: string;
  /** Seconds from the span's own start. Computed in node from the frame's
   *  CLAIMED index, never from this array's position — a hole upstream
   *  (a frame `readParked` did not find, or one this page's caller
   *  rejected for a non-positive size) must not pull a later frame
   *  earlier. See `mux.ts`'s `muxSpans` for the arithmetic. */
  timestampSec: number;
}

export interface MuxSpanManifest {
  frames: MuxFrameManifest[];
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  /** Constant across every frame in the span: the bundle's own
   *  already-computed rate (`1 / fps`), not a second fps this file works
   *  out for itself from what it happens to receive. */
  durationSec: number;
}

export interface MuxEntry {
  muxSpan(manifest: MuxSpanManifest): Promise<{ byteLength: number }>;
  /** `packages/compositor/scripts/render-fixture.ts`'s `readChunk`
   *  transport, reused: the finished mp4 can be tens of megabytes, so node
   *  pulls it back in bounded base64 slices instead of risking the same
   *  crossing as one `page.evaluate` return value. */
  readChunk(offset: number, length: number): string;
}

// One span at a time: `muxSpans` processes spans sequentially against this
// one page, so a single slot — not a namespaced map — is enough, and it is
// overwritten (not appended) so nothing here accumulates across a whole run.
let output: Uint8Array | null = null;

const RENDER_TARGET_DEFAULTS = {
  format: "mp4" as const,
  cornerRadius: 0,
  fit: "contain" as const,
};

async function muxSpan(
  manifest: MuxSpanManifest,
): Promise<{ byteLength: number }> {
  const target: RenderTarget = {
    ...RENDER_TARGET_DEFAULTS,
    width: manifest.width,
    height: manifest.height,
    fps: manifest.fps,
    bitrate: manifest.bitrate,
  };
  const sink = createMp4Sink(target);
  const canvas = new OffscreenCanvas(manifest.width, manifest.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("mux-entry: OffscreenCanvas 2d context unavailable");
  }

  for (const frame of manifest.frames) {
    const response = await fetch(frame.url);
    if (!response.ok) {
      throw new Error(
        `mux-entry: fetching parked frame ${frame.url} answered ${response.status}`,
      );
    }
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    try {
      ctx.drawImage(bitmap, 0, 0, manifest.width, manifest.height);
    } finally {
      bitmap.close();
    }
    await sink.addFrame(canvas, frame.timestampSec, manifest.durationSec);
  }

  // Bytes or a reason, never an empty array — `createMp4Sink`'s own
  // `finish()` already refuses a zero-frame span (see `sink-mp4.ts`), so a
  // span with no usable frames throws here rather than handing back a
  // deliverable nobody produced.
  output = await sink.finish();
  return { byteLength: output.byteLength };
}

function readChunk(offset: number, length: number): string {
  if (!output) {
    throw new Error(
      "mux-entry: readChunk called before muxSpan produced bytes",
    );
  }
  const slice = output.subarray(offset, offset + length);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < slice.length; i += CHUNK) {
    binary += String.fromCharCode(...slice.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const entry: MuxEntry = { muxSpan, readChunk };
(globalThis as unknown as Record<string, unknown>)[MUX_ENTRY_GLOBAL] = entry;
