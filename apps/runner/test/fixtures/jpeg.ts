import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `frame.jpg`: a real 100x50 baseline JPEG (generated once from a filled
 * canvas via Chromium's own `toDataURL`, not hand-rolled bytes that only
 * look like a JPEG). Its SOF marker is real, so `@demoman/replay-engine`'s
 * `jpegSize` reads back `{ width: 100, height: 50 }` — exercised by
 * `encoder.test.ts`'s "is a real JPEG" check.
 *
 * This size is fine for `encoder.test.ts`'s unit tests, which never look at
 * the bytes beyond "is this a real, decodable JPEG" — but it is NOT what
 * `encoder.bench.test.ts` measures against. See `largeJpeg()` below.
 */
const FIXTURE_PATH = join(import.meta.dirname, "frame.jpg");
const FIXTURE_BYTES = new Uint8Array(readFileSync(FIXTURE_PATH));
export const FIXTURE_WIDTH = 100;
export const FIXTURE_HEIGHT = 50;

/** A fresh copy each call: callers may mutate or hand bytes to code that
 *  takes ownership of the buffer (e.g. structured-clone across a worker). */
export function jpeg(): Uint8Array {
  return new Uint8Array(FIXTURE_BYTES);
}

/**
 * `frame-large.jpg`: a real 3840x2400 baseline JPEG — `REPLAY_DPR` (3, from
 * `@demoman/replay-engine`) applied to a 1280x800 scene, the production
 * frame size the design's base64-crossing measurement is actually about.
 * Generated once the same way as `frame.jpg` (a real Chromium canvas via
 * `toDataURL`, quality 0.85 against the harvester's real `quality: 80`
 * screencast setting), but drawn with a gradient, a card grid, image-data
 * noise and rendered text rather than a flat fill, so the JPEG's entropy —
 * and therefore its compressed size — is realistic rather than a
 * near-empty file that would understate the transfer cost it exists to
 * measure. Real size: 1,097,787 bytes (~1.05 MB). Its SOF also reads back
 * correctly via `jpegSize` (`{ width: 3840, height: 2400 }`).
 */
const LARGE_FIXTURE_PATH = join(import.meta.dirname, "frame-large.jpg");
const LARGE_FIXTURE_BYTES = new Uint8Array(readFileSync(LARGE_FIXTURE_PATH));
export const LARGE_FIXTURE_WIDTH = 3840;
export const LARGE_FIXTURE_HEIGHT = 2400;

/** A fresh copy each call, for the same reason as `jpeg()`. */
export function largeJpeg(): Uint8Array {
  return new Uint8Array(LARGE_FIXTURE_BYTES);
}
