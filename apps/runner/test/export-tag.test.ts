import { describe, expect, it } from "vitest";
import { readTag, tagBytes } from "../src/executor/export-tag.js";

const tag = {
  flow: "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90",
  video: "take-5678",
  commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  dirty: false,
};
const enc = new TextEncoder();
const be32 = (n: number) => Uint8Array.of(n >>> 24, n >>> 16, n >>> 8, n);
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
const box = (type: string, ...body: Uint8Array[]) => {
  const inner = cat(...body);
  return cat(be32(8 + inner.length), enc.encode(type), inner);
};

const ftyp = box("ftyp", enc.encode("isom"), be32(0));
const mdat = box("mdat", Uint8Array.of(11, 22, 33, 44, 55));
/** moov > trak > mdia > minf > stbl > stco, one chunk at `offset`. */
const moovAt = (offset: number) =>
  box(
    "moov",
    box("mvhd", new Uint8Array(20)),
    box(
      "trak",
      box(
        "mdia",
        box("minf", box("stbl", box("stco", be32(0), be32(1), be32(offset)))),
      ),
    ),
  );
// A sink that puts moov last: the chunk points into mdat, before moov.
const moovLast = cat(ftyp, mdat, moovAt(ftyp.length + 8 + 2));
// A fast-start sink (what the real one does): moov first, mdat after it.
const fastStart = cat(
  ftyp,
  moovAt(ftyp.length + moovAt(0).length + 8 + 2),
  mdat,
);
const chunkOf = (b: Uint8Array) => {
  const at = String.fromCharCode(...b).indexOf("stco") + 12;
  const offset = new DataView(b.buffer).getUint32(at);
  return { offset, byte: b[offset] };
};

// A 1x1 PNG: signature, IHDR, IDAT, IEND (crcs are not read back by readTag).
const chunk = (type: string, data: Uint8Array) =>
  cat(be32(data.length), enc.encode(type), data, be32(0));
const png = cat(
  Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  chunk("IHDR", new Uint8Array(13)),
  chunk("IDAT", Uint8Array.of(1, 2, 3)),
  chunk("IEND", new Uint8Array(0)),
);

// A 1x1 GIF with a 2-colour global table and one image.
const gif = cat(
  enc.encode("GIF89a"),
  Uint8Array.of(1, 0, 1, 0, 0x80, 0, 0),
  new Uint8Array(6),
  Uint8Array.of(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0),
  Uint8Array.of(2, 2, 0x44, 0x01, 0),
  Uint8Array.of(0x3b),
);

const tagged = (type: "mp4" | "gif" | "png", bytes: Uint8Array) => {
  const out = tagBytes(type, bytes, tag);
  if (!out.ok) throw new Error(out.error);
  return out.bytes;
};

describe("tagBytes and readTag", () => {
  it("round-trips an MP4 whose moov is last, moving no chunk offset", () => {
    const out = tagged("mp4", moovLast);
    expect(readTag(out)).toEqual({ found: tag });
    expect(out.length).toBeGreaterThan(moovLast.length);
    // The premise: the fixture's chunk really points at mdat's third byte (33).
    expect(chunkOf(moovLast)).toMatchObject({ byte: 33 });
    expect(chunkOf(out)).toEqual(chunkOf(moovLast));
  });

  it("round-trips a fast-start MP4, moving the chunk offset with mdat", () => {
    // The premise: moov precedes mdat, so tagging pushes mdat later.
    expect(String.fromCharCode(...fastStart)).toMatch(/moov[\s\S]*mdat/);
    expect(chunkOf(fastStart)).toMatchObject({ byte: 33 });
    const out = tagged("mp4", fastStart);
    expect(readTag(out)).toEqual({ found: tag });
    // Red if the offsets are not shifted: the chunk would then land in moov.
    expect(chunkOf(out)).toMatchObject({ byte: 33 });
    expect(chunkOf(out).offset).toBeGreaterThan(chunkOf(fastStart).offset);
  });

  it("puts the tag inside a udta the sink already wrote, not in a second one", () => {
    const withMeta = cat(
      ftyp,
      mdat,
      box(
        "moov",
        box("udta", box("meta", Uint8Array.of(7, 7))),
        box("free", Uint8Array.of(1)),
      ),
    );
    const out = tagged("mp4", withMeta);
    expect(readTag(out)).toEqual({ found: tag });
    const text = String.fromCharCode(...out);
    // The premise: the fixture has one udta, and still has exactly one.
    expect(String.fromCharCode(...withMeta).split("udta").length - 1).toBe(1);
    expect(text.split("udta").length - 1).toBe(1);
    expect(text).toContain("meta");
  });

  it("answers not-ok, never throws, whatever the parse hits", () => {
    // The ways a damaged file can break the walk (a short stco, a box past
    // the end) are refused by the walk's own checks; this is the net under
    // them. The premise: reading this input really does throw.
    const notBytes = { length: 100 } as unknown as Uint8Array;
    expect(() => new DataView(notBytes.buffer, 0, 8)).toThrow();
    for (const type of ["mp4", "gif", "png"] as const) {
      const out = tagBytes(type, notBytes, tag);
      expect(out, type).toMatchObject({ ok: false });
    }
  });

  it("refuses an MP4 with no moov, naming moov", () => {
    const out = tagBytes("mp4", cat(ftyp, mdat), tag);
    expect(out).toMatchObject({ ok: false });
    if (out.ok) return;
    expect(out.error).toContain("moov");
  });

  it("round-trips a GIF, including a tag over 255 bytes", () => {
    expect(readTag(tagged("gif", gif))).toEqual({ found: tag });
    const long = { ...tag, flow: "v".repeat(400) };
    const out = tagBytes("gif", gif, long);
    if (!out.ok) throw new Error(out.error);
    expect(
      JSON.stringify(long).length,
      "the tag spans sub-blocks",
    ).toBeGreaterThan(255);
    expect(readTag(out.bytes)).toEqual({ found: long });
    expect(out.bytes.at(-1)).toBe(0x3b);
  });

  it("round-trips a PNG, its tEXt chunk right after IHDR with a correct CRC", () => {
    const out = tagged("png", png);
    expect(readTag(out)).toEqual({ found: tag });
    // Sits at byte 33 (after signature + IHDR), and its CRC is the bitwise
    // CRC-32 of type + data, computed here without the implementation's table.
    const len = new DataView(out.buffer, out.byteOffset).getUint32(33);
    expect(String.fromCharCode(...out.subarray(37, 41))).toBe("tEXt");
    let c = 0xffffffff;
    for (const x of out.subarray(37, 41 + len)) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    expect(new DataView(out.buffer, out.byteOffset).getUint32(41 + len)).toBe(
      (c ^ 0xffffffff) >>> 0,
    );
  });

  it("says untagged bytes are untagged, and cut-off ones are unreadable", () => {
    for (const bytes of [moovLast, gif, png]) {
      expect(readTag(bytes), "an untagged file").toHaveProperty("none");
    }
    expect(readTag(tagged("mp4", moovLast).subarray(0, 60))).toHaveProperty(
      "unreadable",
    );
    expect(readTag(tagged("gif", gif).subarray(0, 40))).toHaveProperty(
      "unreadable",
    );
    expect(readTag(tagged("png", png).subarray(0, 50))).toHaveProperty(
      "unreadable",
    );
  });

  it("a new tag round-trips in mp4, gif and png", () => {
    for (const [type, bytes] of [
      ["mp4", moovLast],
      ["gif", gif],
      ["png", png],
    ] as const) {
      expect(readTag(tagged(type, bytes)), type).toEqual({ found: tag });
    }
    // Null commit and dirty (the report would not say) also round-trip.
    const unknown = { ...tag, commit: null, dirty: null };
    const out = tagBytes("png", png, unknown);
    if (!out.ok) throw new Error(out.error);
    expect(readTag(out.bytes)).toEqual({ found: unknown });
  });

  it("an old tag reads as flow and video", () => {
    // Fixture: the pre-share-links JSON shape, written by hand into a PNG.
    const old = JSON.stringify({ video: "old-flow", take: "old-take" });
    expect(old).not.toContain('"flow"');
    const body = cat(enc.encode("tEXtdemoman\0"), enc.encode(old));
    const chunkBytes = cat(be32(body.length - 4), body, be32(0));
    const withOld = cat(png.subarray(0, 33), chunkBytes, png.subarray(33));
    expect(readTag(withOld)).toEqual({
      found: { flow: "old-flow", video: "old-take", commit: null, dirty: null },
    });
  });
});
