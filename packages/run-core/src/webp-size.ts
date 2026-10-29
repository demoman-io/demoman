// Pure, so node (the run door) and the render page both read it.

/**
 * A WebP's size from its header (`VP8 `, `VP8L` or `VP8X`), else null: how
 * the run door tells a file that is already what a fit makes from one that
 * needs fitting, and how the render page knows an image's own size before
 * decoding it smaller. Reads the header only.
 */
export function webpSize(
  b: Uint8Array,
): { width: number; height: number } | null {
  const ascii = (at: number, n: number) =>
    String.fromCharCode(...b.subarray(at, at + n));
  if (b.length < 30 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") {
    return null;
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u24 = (at: number) =>
    (b[at] as number) |
    ((b[at + 1] as number) << 8) |
    ((b[at + 2] as number) << 16);
  switch (ascii(12, 4)) {
    case "VP8X":
      return { width: 1 + u24(24), height: 1 + u24(27) };
    case "VP8 ":
      // A key frame's start code, then 14-bit width and height.
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    case "VP8L": {
      if (b[20] !== 0x2f) return null;
      const bits = view.getUint32(21, true);
      return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    }
    default:
      return null;
  }
}
