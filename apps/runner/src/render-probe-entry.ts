/**
 * Test-only demux probe for `render.slow.test.ts` — split out of `render-entry.ts`
 * the same way `decode-probe-entry.ts` was split out of `mux-entry.ts` on
 * Task 11's fix round 1, and for the identical measured reason: a decode
 * probe folded into the production entry injects mediabunny's DEMUX side
 * (`Input`/`ALL_FORMATS`/`BufferSource`) into the script every real replay
 * run bundles, for a codepath only a test ever calls. See
 * `mux-entry.ts`'s header docblock for the ~654 KB / ~40% that measured on
 * the mux side of this exact seam.
 *
 * `render.ts`'s production path never bundles or injects this file. Only
 * `render.slow.test.ts` does, via the same `bundleEntry` + `page.addScriptTag`
 * mechanism, onto the same page `renderPhase` already drove.
 *
 * CLAUDE.md: "assert on the picture, not the bundle." Node has no demuxer
 * either, so this — inside the page — is the only place `render.slow.test.ts`
 * can ask the ACTUAL produced mp4 "what track is this, and can it decode",
 * rather than trusting the byte count alone.
 */
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { RENDER_PROBE_GLOBAL } from "./entry-globals.js";

export interface RenderProbeEntry {
  probeTrack(base64: string): Promise<{
    hasTrack: boolean;
    displayWidth: number;
    displayHeight: number;
    canDecode: boolean;
  }>;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Bytes as base64, not a raw `Uint8Array` argument — the same reason
 * `render-entry.ts`'s own `readChunk` hands bytes back as base64 rather
 * than risking an untested binary-typed-array serialization across
 * `page.evaluate`'s boundary. Test-sized in every caller (this repo's
 * fixtures render at well under a minute of 1080p), so the crossing
 * `mux.ts`'s docblock warns about at production span sizes never applies
 * here.
 */
async function probeTrack(base64: string): Promise<{
  hasTrack: boolean;
  displayWidth: number;
  displayHeight: number;
  canDecode: boolean;
}> {
  const bytes = decodeBase64(base64);
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(bytes),
  });
  const track = await input.getPrimaryVideoTrack();
  if (!track)
    return {
      hasTrack: false,
      displayWidth: 0,
      displayHeight: 0,
      canDecode: false,
    };
  return {
    hasTrack: true,
    displayWidth: track.displayWidth,
    displayHeight: track.displayHeight,
    canDecode: await track.canDecode(),
  };
}

const entry: RenderProbeEntry = { probeTrack };
(globalThis as unknown as Record<string, unknown>)[RENDER_PROBE_GLOBAL] = entry;
