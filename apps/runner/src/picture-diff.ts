// The pure pixel arithmetic of refresh's comparison (`imagesDiff` in
// decode-probe-entry.ts), apart from the decoders so node can test it.

/** A frame drawn small: its RGBA pixels, row-major. */
export interface Drawn {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/** One way of looking for a change: average each pixel's colour over the
 *  `block`-wide square around it (`blockMoves`), and count it changed when
 *  any channel's mean moved more than `levels` (0-255). */
export interface PictureLook {
  block: number;
  levels: number;
}

/**
 * Per pixel: how far its colour moved from `a` to `b`, as the largest of
 * the three channels' moves, each averaged over the `block`-wide square
 * around it (clipped at the frame's edges). Averaging first is what tells a
 * change from the encoder's noise: that noise is single pixels scattered
 * along edges, a change is a patch (a glyph, a fill) that moves together.
 * Colour, not grey: a blue button turned a green of the same lightness
 * keeps its grey level.
 */
export function blockMoves(a: Drawn, b: Drawn, block: number): Float32Array {
  const { width: w, height: h } = a;
  const W = w + 1;
  const lo = Math.floor((block - 1) / 2);
  const hi = block - 1 - lo;
  const moves = new Float32Array(w * h);
  // One summed-area table per channel, of a minus b.
  for (let c = 0; c < 3; c++) {
    const sum = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4 + c;
        row += (a.rgba[p] as number) - (b.rgba[p] as number);
        sum[(y + 1) * W + x + 1] = (sum[y * W + x + 1] as number) + row;
      }
    }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - lo);
      const y1 = Math.min(h, y + hi + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - lo);
        const x1 = Math.min(w, x + hi + 1);
        const total =
          (sum[y1 * W + x1] as number) -
          (sum[y0 * W + x1] as number) -
          (sum[y1 * W + x0] as number) +
          (sum[y0 * W + x0] as number);
        const move = Math.abs(total / ((x1 - x0) * (y1 - y0)));
        const i = y * w + x;
        if (move > (moves[i] as number)) moves[i] = move;
      }
    }
  }
  return moves;
}

/** The share of the picture `look` counts changed from `a` to `b`. */
export function changedShare(a: Drawn, b: Drawn, look: PictureLook): number {
  const moves = blockMoves(a, b, look.block);
  let changed = 0;
  for (const m of moves) if (m > look.levels) changed++;
  return changed / moves.length;
}
