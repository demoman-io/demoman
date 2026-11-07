import { describe, expect, it } from "vitest";
import { findMoov, moovFacts } from "../src/mp4.js";

const enc = new TextEncoder();
const be32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const box = (type: string, ...body: Uint8Array[]) => {
  const inner = join(...body);
  return join(be32(8 + inner.length), enc.encode(type), inner);
};
/** mvhd version 0 or 1 with the given timescale and duration. */
const mvhd = (version: 0 | 1, timescale: number, duration: number) => {
  const vf = new Uint8Array([version, 0, 0, 0]);
  if (version === 0)
    return box(
      "mvhd",
      vf,
      be32(0),
      be32(0),
      be32(timescale),
      be32(duration),
      new Uint8Array(80),
    );
  const d = new Uint8Array(8);
  new DataView(d.buffer).setBigUint64(0, BigInt(duration));
  return box(
    "mvhd",
    vf,
    new Uint8Array(16),
    be32(timescale),
    d,
    new Uint8Array(80),
  );
};
const dmvi = (json: string) => box("udta", box("dmvi", enc.encode(json)));
const TAG = '{"flow":"f1","video":"v1","commit":"abc","dirty":false}';

describe("moovFacts", () => {
  it("reads a 145.33 s duration from mvhd v0 and v1", () => {
    for (const v of [0, 1] as const) {
      const facts = moovFacts(box("moov", mvhd(v, 1000, 145_333)));
      expect(facts.durationS, `mvhd v${v}`).toBeCloseTo(145.33, 2);
    }
  });

  it("reads the dmvi tag", () => {
    const facts = moovFacts(box("moov", mvhd(0, 600, 1200), dmvi(TAG)));
    expect(facts.tag).toEqual({
      found: { flow: "f1", video: "v1", commit: "abc", dirty: false },
    });
  });

  it("says none for a moov without udta", () => {
    const facts = moovFacts(box("moov", mvhd(0, 600, 1200)));
    expect("none" in facts.tag, JSON.stringify(facts.tag)).toBe(true);
  });
});

describe("findMoov", () => {
  /** A sparse file: ftyp, an mdat whose header declares 40 MB, then moov. */
  const sparse = (moov: Uint8Array | null) => {
    const ftyp = box("ftyp", enc.encode("isom"), be32(0));
    const mdatSize = 40_000_000;
    const head = join(ftyp, be32(mdatSize), enc.encode("mdat"));
    const tailAt = ftyp.length + mdatSize;
    const tail = moov ?? box("free", new Uint8Array(8));
    const size = tailAt + tail.length;
    const reads: Array<[number, number]> = [];
    const read = async (offset: number, length: number) => {
      reads.push([offset, length]);
      const out = new Uint8Array(Math.min(length, size - offset));
      for (let i = 0; i < out.length; i++) {
        const at = offset + i;
        if (at < head.length) out[i] = head[at] as number;
        else if (at >= tailAt) out[i] = tail[at - tailAt] as number;
      }
      return out;
    };
    return { read, size, reads, mdatSize };
  };

  it("finds a moov after a 40 MB mdat with three ranged reads or fewer", async () => {
    const moov = box("moov", mvhd(0, 1000, 2000), dmvi(TAG));
    const f = sparse(moov);
    expect(f.mdatSize, "premise: the mdat header declares 40 MB").toBe(
      40_000_000,
    );
    const found = await findMoov(f.read, f.size);
    expect(found).toEqual(moov);
    expect(f.reads.length, JSON.stringify(f.reads)).toBeLessThanOrEqual(3);
  });

  it("answers null for a file with no moov", async () => {
    const f = sparse(null);
    expect(await findMoov(f.read, f.size)).toBeNull();
  });
});
