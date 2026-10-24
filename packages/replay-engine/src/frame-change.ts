import { MOVING_RECENT_MS, MOVING_SHARE } from "./constants.js";
import { decodeBase64 } from "./image.js";

/**
 * A JPEG's luma at one value per 8x8 block: each block's DC coefficient,
 * scaled by its quantiser so two frames with different tables compare.
 * An eighth of the frame each way, from the entropy decode alone — no
 * inverse DCT, no colour — which is what makes it cheap enough to run on
 * screencast frames during a take: 5–16 ms for a 3420x2214 frame in node,
 * against the 90–270 ms `Page.captureScreenshot` it decides about.
 */
export interface LumaBlocks {
  width: number;
  height: number;
  dc: Int32Array;
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
}

/**
 * The blocks of a baseline JPEG, or null for any JPEG this does not read:
 * progressive, restart intervals, 12-bit, or bytes that are not a JPEG at
 * all. Chrome's screencast and screenshot encoder writes baseline 4:2:0
 * with no restart markers (inspected 2026-10-24), so null is the exception,
 * and the caller treats it as "cannot tell".
 */
export function lumaBlocks(bytes: Uint8Array): LumaBlocks | null {
  try {
    return readLumaBlocks(bytes);
  } catch {
    // Not a reason anyone acts on: the caller falls back to the full still,
    // which is what every step took before this existed.
    return null;
  }
}

function readLumaBlocks(bytes: Uint8Array): LumaBlocks | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const tables = new Map<number, Uint16Array>();
  const quant = new Map<number, number>();
  let components: Component[] | null = null;
  let width = 0;
  let height = 0;
  let pos = 2;
  let scan: { c: Component; dc: Uint16Array; ac: Uint16Array }[] | null = null;

  while (scan === null) {
    if (pos + 4 > bytes.length || bytes[pos] !== 0xff) return null;
    const marker = bytes[pos + 1] as number;
    const length =
      ((bytes[pos + 2] as number) << 8) | (bytes[pos + 3] as number);
    const seg = pos + 4;
    const end = pos + 2 + length;
    if (marker === 0xc0) {
      if (bytes[seg] !== 8) return null;
      height = ((bytes[seg + 1] as number) << 8) | (bytes[seg + 2] as number);
      width = ((bytes[seg + 3] as number) << 8) | (bytes[seg + 4] as number);
      const n = bytes[seg + 5] as number;
      components = [];
      for (let k = 0; k < n; k++) {
        const at = seg + 6 + 3 * k;
        components.push({
          id: bytes[at] as number,
          h: (bytes[at + 1] as number) >> 4,
          v: (bytes[at + 1] as number) & 15,
          tq: bytes[at + 2] as number,
        });
      }
    } else if (
      marker >= 0xc1 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return null; // progressive, lossless, arithmetic: not read here
    } else if (marker === 0xdd) {
      if ((((bytes[seg] as number) << 8) | (bytes[seg + 1] as number)) !== 0) {
        return null;
      }
    } else if (marker === 0xdb) {
      for (let p = seg; p < end; ) {
        const precision = (bytes[p] as number) >> 4;
        const id = (bytes[p] as number) & 15;
        quant.set(
          id,
          precision
            ? ((bytes[p + 1] as number) << 8) | (bytes[p + 2] as number)
            : (bytes[p + 1] as number),
        );
        p += 1 + (precision ? 128 : 64);
      }
    } else if (marker === 0xc4) {
      for (let p = seg; p < end; ) {
        const key = bytes[p] as number; // class << 4 | id
        const counts = bytes.subarray(p + 1, p + 17);
        let total = 0;
        for (const c of counts) total += c;
        tables.set(key, lookup(counts, bytes.subarray(p + 17, p + 17 + total)));
        p += 17 + total;
      }
    } else if (marker === 0xda) {
      if (components === null) return null;
      const n = bytes[seg] as number;
      scan = [];
      for (let k = 0; k < n; k++) {
        const id = bytes[seg + 1 + 2 * k] as number;
        const t = bytes[seg + 2 + 2 * k] as number;
        const c = components.find((x) => x.id === id);
        const dc = tables.get(t >> 4);
        const ac = tables.get(0x10 | (t & 15));
        if (!c || !dc || !ac) return null;
        scan.push({ c, dc, ac });
      }
      // A scan that leaves a component out is a progressive or multi-scan
      // file under a baseline marker, and the MCU walk below would misread.
      if (n !== components.length) return null;
    }
    pos = end;
  }

  // The entropy-coded data, a bit at a time, with 0xFF00 unstuffed. A
  // marker ends the scan and zeros are fed past it, which the lookahead
  // always reads a little of; reading them as data is a truncated frame,
  // refused below, because zeros decode as codes as readily as anything.
  let acc = 0;
  let held = 0;
  let ended = false;
  let padding = 0;
  const fill = (): void => {
    while (held <= 24) {
      let byte = 0;
      if (ended || pos >= bytes.length) padding += 8;
      else {
        byte = bytes[pos] as number;
        if (byte === 0xff) {
          if (bytes[pos + 1] === 0) pos += 2;
          else {
            ended = true;
            padding += 8;
            byte = 0;
          }
        } else pos++;
      }
      if (padding - held > 64) throw new Error("truncated scan");
      acc = ((acc << 8) | byte) >>> 0;
      held += 8;
    }
  };
  const decode = (table: Uint16Array): number => {
    fill();
    const entry = table[(acc >>> (held - 16)) & 0xffff] as number;
    if (entry === 0) throw new Error("no such Huffman code");
    held -= entry >> 8;
    return entry & 0xff;
  };
  const receive = (size: number): number => {
    if (size === 0) return 0;
    fill();
    const value = (acc >>> (held - size)) & ((1 << size) - 1);
    held -= size;
    return value < 1 << (size - 1) ? value - (1 << size) + 1 : value;
  };

  const hMax = Math.max(...scan.map((s) => s.c.h));
  const vMax = Math.max(...scan.map((s) => s.c.v));
  const mcusX = Math.ceil(width / (8 * hMax));
  const mcusY = Math.ceil(height / (8 * vMax));
  const luma = scan[0] as (typeof scan)[number];
  const q0 = quant.get(luma.c.tq) ?? 1;
  const blocksX = mcusX * luma.c.h;
  const blocksY = mcusY * luma.c.v;
  const dc = new Int32Array(blocksX * blocksY);
  const predictors = new Int32Array(scan.length);

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (let ci = 0; ci < scan.length; ci++) {
        const s = scan[ci] as (typeof scan)[number];
        for (let by = 0; by < s.c.v; by++) {
          for (let bx = 0; bx < s.c.h; bx++) {
            const predicted =
              (predictors[ci] as number) + receive(decode(s.dc));
            predictors[ci] = predicted;
            if (ci === 0) {
              dc[(my * s.c.v + by) * blocksX + mx * s.c.h + bx] =
                predicted * q0;
            }
            // The 63 AC coefficients, decoded only to be stepped over.
            for (let k = 1; k < 64; ) {
              const rs = decode(s.ac);
              const size = rs & 15;
              if (size === 0) {
                if (rs >> 4 !== 15) break; // end of block
                k += 16;
                continue;
              }
              fill();
              held -= size;
              k += (rs >> 4) + 1;
            }
          }
        }
      }
    }
  }
  if (padding > held) return null; // the last codes were padding
  return { width: blocksX, height: blocksY, dc };
}

/** A 16-bit-indexed Huffman lookup: `(length << 8) | symbol`, 0 for no code. */
function lookup(counts: Uint8Array, symbols: Uint8Array): Uint16Array {
  const table = new Uint16Array(65536);
  let code = 0;
  let next = 0;
  for (let length = 1; length <= 16; length++) {
    for (let c = 0; c < (counts[length - 1] as number); c++) {
      table.fill(
        (length << 8) | (symbols[next++] as number),
        code << (16 - length),
        (code + 1) << (16 - length),
      );
      code++;
    }
    code <<= 1;
  }
  return table;
}

/**
 * The share of blocks whose brightness differs between two frames. JPEG
 * codes an unchanged 8x8 block identically, so any difference is the page.
 * Two frames of different sizes are a surface that changed: all of it.
 */
export function changedShare(a: LumaBlocks, b: LumaBlocks): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  for (let i = 0; i < a.dc.length; i++) {
    if (a.dc[i] !== b.dc[i]) changed++;
  }
  return a.dc.length === 0 ? 0 : changed / a.dc.length;
}

/** A screencast frame as the walk keeps it: CDP's base64, and when it came. */
export interface SeenFrame {
  data: string;
  atMs: number;
}

/**
 * Whether the page is moving at `nowMs`, from the two newest screencast
 * frames: both recent, and the newer one different from the older over
 * more than `MOVING_SHARE` of the page.
 *
 * Painting alone is not moving. A caret, a spinner or a toast's countdown
 * repaints at frame rate and changes a sliver; the author chose those to
 * count as still (2026-10-24), so they keep the full still and its stall.
 * A single big repaint with nothing before it is a page that changed, not
 * one that is changing, and a full still loses nothing there either.
 */
export function pageMoving(
  newest: SeenFrame | null,
  prior: SeenFrame | null,
  nowMs: number,
): boolean {
  if (newest === null || prior === null) return false;
  if (nowMs - newest.atMs > MOVING_RECENT_MS) return false;
  if (newest.atMs - prior.atMs > MOVING_RECENT_MS) return false;
  let a: LumaBlocks | null;
  let b: LumaBlocks | null;
  try {
    a = lumaBlocks(decodeBase64(prior.data));
    b = lumaBlocks(decodeBase64(newest.data));
  } catch {
    // Not base64: cannot tell, so the full still, as before.
    return false;
  }
  if (a === null || b === null) return false;
  return changedShare(a, b) > MOVING_SHARE;
}

/**
 * The screencast frame to stand in for a step's still, or null for a full
 * still, decided when the still is about to be taken.
 *
 * - Two fresh frames say the page is moving: the next frame, so the picture
 *   is never older than the step (a `waitFor` photographs what it waited for).
 * - A full still has just ended: the screencast sent nothing while it ran,
 *   so the newest frame says nothing about now. Two frames after it decide.
 * - Otherwise the page has been still for `MOVING_RECENT_MS`: a full still
 *   loses nothing, and nothing is waited for.
 *
 * Not decided here, and left on purpose (author, 2026-10-24): a step that
 * comes right after a click often decides before the page has begun to react
 * — the sheet on that day's take moved ~200 ms after its click — and takes a
 * full still into the start of the motion. Waiting up to ~300 ms after each
 * action to see whether the page reacts would close it, at the cost of that
 * long on steps after actions on pages that do not react. Revisit here.
 */
export async function standInFrame(
  seen: {
    newest: SeenFrame | null;
    prior: SeenFrame | null;
    /** When the last full still came back, in run time. */
    captureEndedMs: number;
    nowMs: number;
  },
  nextFrame: (ms: number) => Promise<SeenFrame | null>,
  waitMs: number,
): Promise<SeenFrame | null> {
  const { newest, prior, captureEndedMs, nowMs } = seen;
  if (
    newest !== null &&
    newest.atMs >= captureEndedMs &&
    pageMoving(newest, prior, nowMs)
  ) {
    return nextFrame(waitMs);
  }
  if (nowMs - captureEndedMs >= MOVING_RECENT_MS) return null;
  const first = await nextFrame(waitMs);
  if (first === null) return null;
  const second = await nextFrame(waitMs);
  if (second === null) return null;
  return pageMoving(second, first, second.atMs) ? second : null;
}
