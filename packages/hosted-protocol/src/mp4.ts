/**
 * What the hosted service and the runner both read from an MP4: its length
 * (`moov/mvhd`) and Demoman's tag (`moov/udta/dmvi`, written by the runner's
 * `export-tag.ts`). Pure: no I/O but the `read` a caller passes in.
 */

export interface VideoTag {
  flow: string;
  video: string;
  commit: string | null;
  dirty: boolean | null;
}

export type TagRead =
  | { found: VideoTag }
  | { none: string }
  | { unreadable: string };

const dec = new TextDecoder();
const ascii = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, at + n));
const view = (b: Uint8Array) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength);

/** A tag's JSON, including the shape exports had before shared ids. */
export function parseVideoTag(text: string): TagRead {
  try {
    const v = JSON.parse(text) as Partial<VideoTag> & { take?: unknown };
    if (typeof v.flow === "string" && typeof v.video === "string") {
      return {
        found: {
          flow: v.flow,
          video: v.video,
          commit: typeof v.commit === "string" ? v.commit : null,
          dirty: typeof v.dirty === "boolean" ? v.dirty : null,
        },
      };
    }
    // Exports made before shared ids: { video: <flow>, take }.
    if (typeof v.video === "string" && typeof v.take === "string") {
      return {
        found: { flow: v.video, video: v.take, commit: null, dirty: null },
      };
    }
    return { unreadable: `the tag is not a flow and a video: ${text}` };
  } catch (error) {
    return { unreadable: `the tag is not JSON (${(error as Error).message})` };
  }
}

interface Box {
  type: string;
  start: number;
  size: number;
}

/** Boxes laid end to end in [from, to); a box that does not fit is `null`. */
function boxes(b: Uint8Array, from: number, to: number): Box[] | null {
  const out: Box[] = [];
  let at = from;
  while (at < to) {
    if (at + 8 > to) return null;
    const size = view(b).getUint32(at);
    if (size < 8 || at + size > to) return null;
    out.push({ type: ascii(b, at + 4, 4), start: at, size });
    at += size;
  }
  return out;
}

function durationOf(b: Uint8Array, mvhd: Box): number | null {
  const v = view(b);
  const at = mvhd.start + 8;
  if (mvhd.size < 8 + 4) return null;
  const version = b[at];
  if (version === 0 && mvhd.size >= 8 + 20) {
    const scale = v.getUint32(at + 12);
    return scale === 0 ? null : v.getUint32(at + 16) / scale;
  }
  if (version === 1 && mvhd.size >= 8 + 32) {
    const scale = v.getUint32(at + 20);
    return scale === 0 ? null : Number(v.getBigUint64(at + 24)) / scale;
  }
  return null;
}

/** The length and tag of a `moov` box, given its bytes from its header on. */
export function moovFacts(moov: Uint8Array): {
  durationS: number | null;
  tag: TagRead;
} {
  const kids = boxes(moov, 8, moov.length);
  if (kids === null) {
    return {
      durationS: null,
      tag: { unreadable: "the MP4's moov is cut off in a child box" },
    };
  }
  const mvhd = kids.find((x) => x.type === "mvhd");
  const durationS = mvhd === undefined ? null : durationOf(moov, mvhd);
  const udtas = kids.filter((x) => x.type === "udta");
  if (udtas.length === 0)
    return { durationS, tag: { none: "the MP4 carries no udta box" } };
  for (const udta of udtas) {
    const inner = boxes(moov, udta.start + 8, udta.start + udta.size);
    if (inner === null) {
      return {
        durationS,
        tag: { unreadable: "the MP4's udta is cut off in a child box" },
      };
    }
    const dmvi = inner.find((x) => x.type === "dmvi");
    if (dmvi !== undefined) {
      return {
        durationS,
        tag: parseVideoTag(
          dec.decode(moov.subarray(dmvi.start + 8, dmvi.start + dmvi.size)),
        ),
      };
    }
  }
  return { durationS, tag: { none: "the MP4's udta holds no dmvi box" } };
}

const HEAD = 65_536;
/** A 10-minute 60 fps video's moov is well under this; an upload declaring
 *  more is refused rather than read into a Worker's memory. */
export const MAX_MOOV_BYTES = 16_000_000;
/** An MP4 Demoman exports has a handful of top-level boxes. */
export const MAX_TOP_BOXES = 64;

/**
 * The `moov` box of a file read through `read(offset, length)`, walking the
 * top-level boxes: one read of the file's start, one header read per box
 * past it, and one read of `moov` when it was not already in hand. Null when
 * the file has no `moov`, a box header does not fit the file, the `moov` is
 * over `MAX_MOOV_BYTES`, or it is not among the first `MAX_TOP_BOXES` boxes.
 */
export async function findMoov(
  read: (offset: number, length: number) => Promise<Uint8Array>,
  size: number,
): Promise<Uint8Array | null> {
  const head = await read(0, Math.min(size, HEAD));
  let at = 0;
  for (let boxes = 0; at + 8 <= size; boxes++) {
    if (boxes >= MAX_TOP_BOXES) return null;
    const inHead = at + 16 <= head.length;
    const h = inHead ? head.subarray(at, at + 16) : await read(at, 16);
    if (h.length < 8) return null;
    let boxSize = view(h).getUint32(0);
    const type = ascii(h, 4, 4);
    if (boxSize === 1) {
      if (h.length < 16) return null;
      boxSize = Number(view(h).getBigUint64(8));
    } else if (boxSize === 0) {
      boxSize = size - at;
    }
    if (boxSize < 8 || at + boxSize > size) return null;
    if (type === "moov") {
      if (boxSize > MAX_MOOV_BYTES) return null;
      return at + boxSize <= head.length
        ? head.slice(at, at + boxSize)
        : await read(at, boxSize);
    }
    at += boxSize;
  }
  return null;
}
