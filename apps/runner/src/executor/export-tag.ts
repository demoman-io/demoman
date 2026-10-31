/**
 * Writes which video and version an export came from into the file itself,
 * so a person (or `readTag`) can tell later. MP4: `moov/udta/dmvi`; GIF: a
 * comment extension; PNG: a `tEXt` chunk. The take id is the version: numbers
 * are positions and move when a version is deleted.
 */
export interface VideoTag {
  video: string;
  take: string;
}

export type Tagged =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string };

export type TagRead =
  | { found: VideoTag }
  | { none: string }
  | { unreadable: string };

const enc = new TextEncoder();
const dec = new TextDecoder();
const KEY = "demoman";

const ascii = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at);
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const be32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

const isPng = (b: Uint8Array) => b[0] === 0x89 && ascii(b, 1, 3) === "PNG";
const isGif = (b: Uint8Array) => ascii(b, 0, 3) === "GIF";
const isMp4 = (b: Uint8Array) => ascii(b, 4, 4) === "ftyp";

const parseTag = (text: string): TagRead => {
  try {
    const v = JSON.parse(text) as Partial<VideoTag>;
    if (typeof v.video === "string" && typeof v.take === "string") {
      return { found: { video: v.video, take: v.take } };
    }
    return { unreadable: `the tag is not a flow and a video: ${text}` };
  } catch (error) {
    return { unreadable: `the tag is not JSON (${(error as Error).message})` };
  }
};

// ---- PNG ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function tagPng(bytes: Uint8Array, tag: VideoTag): Tagged {
  // IHDR is always first: 8 signature + 4 length + 4 type + 13 data + 4 crc.
  if (bytes.length < 33 || ascii(bytes, 12, 4) !== "IHDR") {
    return { ok: false, error: "the PNG has no IHDR chunk to follow" };
  }
  const body = join(
    enc.encode(`tEXt${KEY}\0`),
    enc.encode(JSON.stringify(tag)),
  );
  const chunk = join(be32(body.length - 4), body, be32(crc32(body)));
  return {
    ok: true,
    bytes: join(bytes.subarray(0, 33), chunk, bytes.subarray(33)),
  };
}

function readPng(b: Uint8Array): TagRead {
  let at = 8;
  while (at < b.length) {
    if (at + 12 > b.length) {
      return { unreadable: `the PNG is cut off in a chunk header at ${at}` };
    }
    const len = u32(b, at);
    const type = ascii(b, at + 4, 4);
    if (at + 12 + len > b.length) {
      return { unreadable: `the PNG's ${type} chunk runs past the end` };
    }
    if (type === "tEXt") {
      const data = b.subarray(at + 8, at + 8 + len);
      const nul = data.indexOf(0);
      if (nul >= 0 && dec.decode(data.subarray(0, nul)) === KEY) {
        return parseTag(dec.decode(data.subarray(nul + 1)));
      }
    }
    if (type === "IEND") break;
    at += 12 + len;
  }
  return { none: "the PNG carries no demoman chunk" };
}

// ---- GIF ----

function tagGif(bytes: Uint8Array, tag: VideoTag): Tagged {
  if (bytes.length < 14 || bytes[bytes.length - 1] !== 0x3b) {
    return { ok: false, error: "the GIF does not end in its trailer" };
  }
  const text = enc.encode(`${KEY}:${JSON.stringify(tag)}`);
  const parts: number[] = [0x21, 0xfe];
  for (let i = 0; i < text.length; i += 255) {
    const sub = text.subarray(i, i + 255);
    parts.push(sub.length, ...sub);
  }
  parts.push(0);
  return {
    ok: true,
    bytes: join(
      bytes.subarray(0, -1),
      Uint8Array.from(parts),
      Uint8Array.of(0x3b),
    ),
  };
}

function readGif(b: Uint8Array): TagRead {
  const cut = (what: string) => ({
    unreadable: `the GIF is cut off in ${what}`,
  });
  if (b.length < 13) return cut("its header");
  const table = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
  let at = 13 + table(b[10] ?? 0);
  /** Sub-blocks from `from`; the bytes joined and where the terminator ends. */
  const subs = (from: number) => {
    const chunks: Uint8Array[] = [];
    let p = from;
    for (;;) {
      if (p >= b.length) return null;
      const n = b[p] ?? 0;
      if (n === 0) return { data: join(...chunks), end: p + 1 };
      if (p + 1 + n > b.length) return null;
      chunks.push(b.subarray(p + 1, p + 1 + n));
      p += 1 + n;
    }
  };
  while (at < b.length) {
    const kind = b[at];
    if (kind === 0x3b) return { none: "the GIF carries no demoman comment" };
    if (kind === 0x21) {
      const s = subs(at + 2);
      if (s === null) return cut(`an extension at ${at}`);
      if (b[at + 1] === 0xfe) {
        const text = dec.decode(s.data);
        if (text.startsWith(`${KEY}:`))
          return parseTag(text.slice(KEY.length + 1));
      }
      at = s.end;
    } else if (kind === 0x2c) {
      if (at + 10 > b.length) return cut(`an image at ${at}`);
      const s = subs(at + 10 + table(b[at + 9] ?? 0) + 1);
      if (s === null) return cut(`an image at ${at}`);
      at = s.end;
    } else {
      return {
        unreadable: `the GIF has an unknown block 0x${(kind ?? 0).toString(16)} at ${at}`,
      };
    }
  }
  return cut("its blocks, before the trailer");
}

// ---- MP4 ----

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
    const size = u32(b, at);
    if (size < 8 || at + size > to) return null; // also refuses 0 and 1 (64-bit): mediabunny writes neither
    out.push({ type: ascii(b, at + 4, 4), start: at, size });
    at += size;
  }
  return out;
}

const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

/** Adds `delta` to every chunk offset (stco/co64) at or past `from`, inside
 *  the container whose children fill [start, end) of `b`. Null when it did
 *  not parse; otherwise how many entries moved. */
function shiftOffsets(
  b: Uint8Array,
  start: number,
  end: number,
  from: number,
  delta: number,
): number | null {
  const kids = boxes(b, start, end);
  if (kids === null) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let moved = 0;
  for (const k of kids) {
    if (MP4_CONTAINERS.has(k.type)) {
      const n = shiftOffsets(b, k.start + 8, k.start + k.size, from, delta);
      if (n === null) return null;
      moved += n;
    } else if (k.type === "stco" || k.type === "co64") {
      const wide = k.type === "co64";
      const count = view.getUint32(k.start + 12);
      const width = wide ? 8 : 4;
      if (16 + count * width > k.size) return null;
      for (let i = 0; i < count; i++) {
        const at = k.start + 16 + i * width;
        const old = wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
        if (old < from) continue;
        if (wide) view.setBigUint64(at, BigInt(old + delta));
        else if (old + delta > 0xffffffff) return null;
        else view.setUint32(at, old + delta);
        moved++;
      }
    }
  }
  return moved;
}

function tagMp4(bytes: Uint8Array, tag: VideoTag): Tagged {
  const top = boxes(bytes, 0, bytes.length);
  if (top === null) {
    return {
      ok: false,
      error: "the MP4's top-level boxes could not be walked",
    };
  }
  const moov = top.find((x) => x.type === "moov");
  if (moov === undefined) {
    return { ok: false, error: "the MP4 has no moov box to tag" };
  }
  const payload = enc.encode(JSON.stringify(tag));
  const dmvi = join(be32(8 + payload.length), enc.encode("dmvi"), payload);
  const end = moov.start + moov.size;
  const kids = boxes(bytes, moov.start + 8, end);
  if (kids === null) {
    return { ok: false, error: "the MP4's moov could not be walked" };
  }
  // A sink that already wrote a udta (metadata) gets the dmvi inside it: a
  // second udta is not allowed. Otherwise a udta of our own ends moov.
  const had = kids.find((x) => x.type === "udta");
  const add = had
    ? dmvi
    : join(be32(8 + dmvi.length), enc.encode("udta"), dmvi);
  const at = had ? had.start + had.size : end;
  const out = join(bytes.subarray(0, at), add, bytes.subarray(at));
  const view = new DataView(out.buffer);
  view.setUint32(moov.start, moov.size + add.length);
  if (had) view.setUint32(had.start, had.size + add.length);
  const udta = add;
  // Growing moov moves everything after it (mdat, when the sink put moov
  // first), so every chunk offset that pointed past it moves too.
  const moved = shiftOffsets(
    out,
    moov.start + 8,
    end + udta.length,
    end,
    udta.length,
  );
  if (moved === null) {
    return {
      ok: false,
      error: "the MP4's moov chunk offsets (stco/co64) could not be moved",
    };
  }
  return { ok: true, bytes: out };
}

function readMp4(b: Uint8Array): TagRead {
  const top = boxes(b, 0, b.length);
  if (top === null)
    return { unreadable: "the MP4 is cut off in a top-level box" };
  const moov = top.find((x) => x.type === "moov");
  if (moov === undefined) return { unreadable: "the MP4 has no moov box" };
  const kids = boxes(b, moov.start + 8, moov.start + moov.size);
  if (kids === null)
    return { unreadable: "the MP4's moov is cut off in a child box" };
  const udtas = kids.filter((x) => x.type === "udta");
  if (udtas.length === 0) return { none: "the MP4 carries no udta box" };
  for (const udta of udtas) {
    const inner = boxes(b, udta.start + 8, udta.start + udta.size);
    if (inner === null)
      return { unreadable: "the MP4's udta is cut off in a child box" };
    const dmvi = inner.find((x) => x.type === "dmvi");
    if (dmvi !== undefined) {
      return parseTag(
        dec.decode(b.subarray(dmvi.start + 8, dmvi.start + dmvi.size)),
      );
    }
  }
  return { none: "the MP4's udta holds no dmvi box" };
}

export function tagBytes(
  type: "mp4" | "gif" | "png",
  bytes: Uint8Array,
  tag: VideoTag,
): Tagged {
  // Never throws: a malformed file (an stco cut short) is a refusal the
  // export reports, not a failed export.
  try {
    return type === "mp4"
      ? tagMp4(bytes, tag)
      : type === "gif"
        ? tagGif(bytes, tag)
        : tagPng(bytes, tag);
  } catch (error) {
    return {
      ok: false,
      error: `the ${type} could not be tagged (${(error as Error).message})`,
    };
  }
}

export function readTag(bytes: Uint8Array): TagRead {
  if (isPng(bytes)) return readPng(bytes);
  if (isGif(bytes)) return readGif(bytes);
  if (isMp4(bytes)) return readMp4(bytes);
  return { none: "not an MP4, GIF or PNG" };
}
