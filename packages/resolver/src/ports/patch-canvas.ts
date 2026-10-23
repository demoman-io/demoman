import type { ImagePatchMatcher } from "../types.js";

const SIZE = 16;
const DEFAULT_THRESHOLD = 0.9;

/**
 * A signature of the element's rendered colours. Real screenshotting belongs to
 * SP5, which owns frames and the CDP session that can take one; this reads
 * computed style so the tier is exercised end-to-end without the resolver ever
 * reaching for a screenshot API.
 */
function signature(el: Element): number[] {
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const g = canvas.getContext("2d");
  if (g === null) return new Array<number>(SIZE * SIZE).fill(0);

  g.fillStyle = style.backgroundColor;
  g.fillRect(0, 0, SIZE, SIZE);
  g.fillStyle = style.color;
  const bar = Math.max(
    1,
    Math.round((rect.height / Math.max(rect.width, 1)) * SIZE),
  );
  g.fillRect(0, SIZE - bar, SIZE, bar);

  const data = g.getImageData(0, 0, SIZE, SIZE).data;
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const gr = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    out.push((0.299 * r + 0.587 * gr + 0.114 * b) / 255);
  }
  return out;
}

/**
 * Mean absolute difference, not cross-correlation. Correlation is invariant to
 * brightness and contrast, so two flat tiles of *any* two colours score 1.0 —
 * exactly the discrimination this tier needs. Absolute difference keeps it.
 */
function similarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    total += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  }
  return 1 - total / n;
}

const REF_PREFIX = "patch:v1:";

/**
 * The signature travels *inside* the reference rather than in a side table.
 * A scene document is read back by processes that never ran capture — SP8's
 * badge on a page visit, and the phase-2 headless runner — so a ref that
 * points into an in-memory map is a ref that can never match.
 *
 * SIZE*SIZE grayscale values quantised to a byte each: 256 bytes, ~344
 * characters of base64. Small enough to sit in a fingerprint bundle.
 */
function encodeSignature(sig: number[]): string {
  let binary = "";
  for (const value of sig) {
    const clamped = Math.min(1, Math.max(0, value));
    binary += String.fromCharCode(Math.round(clamped * 255));
  }
  return btoa(binary);
}

function decodeSignature(ref: string): number[] | null {
  if (!ref.startsWith(REF_PREFIX)) return null;
  try {
    const binary = atob(ref.slice(REF_PREFIX.length));
    const out: number[] = [];
    for (let i = 0; i < binary.length; i += 1) {
      out.push(binary.charCodeAt(i) / 255);
    }
    // A payload of the wrong length is not a weak match, it is a
    // *confident* one: similarity() averages over min(a.length, b.length),
    // so a three-sample payload is compared against three of the
    // candidate's 256 and sails past the threshold. Refuse it here.
    if (out.length !== SIZE * SIZE) return null;
    return out;
  } catch {
    // A ref from an older resolver, or a corrupted one. Returning no matches
    // leaves runPatchTier's existing "broken" report intact rather than
    // inventing a winner.
    return null;
  }
}

export function createCanvasMatcher(opts?: {
  threshold?: number;
}): ImagePatchMatcher {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;

  return {
    async capture(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return REF_PREFIX + encodeSignature(signature(el));
    },
    async match(ref, candidates) {
      const wanted = decodeSignature(ref);
      if (wanted === null) return [];
      return candidates
        .map((el, index) => ({
          index,
          score: similarity(wanted, signature(el)),
        }))
        .filter((c) => c.score >= threshold)
        .sort((a, b) => b.score - a.score);
    },
  };
}
