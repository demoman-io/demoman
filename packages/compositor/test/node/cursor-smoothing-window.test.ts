import { describe, expect, it } from "vitest";
import type { CursorSample } from "../../src/bundle";
import { CURSOR_REST_MS, smoothCursor } from "../../src/plan/smooth";

/**
 * The kernel written the obvious way, kept as the oracle: every sample
 * scanned against every other, with no window search and no run index. On a
 * 3-minute take at 120Hz that is ~450M comparisons per resolve, and the
 * editor resolves on every edit — which is why the shipped version bounds
 * the search. It has to give the same answer to the last bit, which it does
 * by summing the same neighbours with the same weights; only the search for
 * them changed.
 *
 * It scans the run rather than the whole array, and that is load-bearing
 * rather than an optimisation copied over. An earlier version of this
 * comment claimed the two were interchangeable — "the reach is clamped to
 * the run's ends, so no sample outside the run can be within reach" — which
 * the padding made false: `padBefore` reaches back to `t[start] - quiet`,
 * i.e. exactly the previous run's last sample, whenever the pause is
 * shorter than 3 sigma. A whole-array scan then averages the end of one
 * gesture into the middle of the next. The oracle caught the disagreement
 * at sigma 120 and the shipped kernel was the correct side of it; a
 * from-scratch brute force written to settle it agreed with the kernel to
 * the last bit.
 */
function smoothCursorReference(
  samples: CursorSample[],
  sigmaMs: number,
  pinnedMs: readonly number[] = [],
): CursorSample[] {
  if (sigmaMs <= 0 || samples.length < 3) return samples;
  const maxReach = 3 * sigmaMs;
  const twoSigmaSquared = 2 * sigmaMs * sigmaMs;

  const at = (i: number): number => samples[i]?.sourceTimeMs ?? 0;
  const runStartOf = (i: number): number => {
    let k = i;
    while (k > 0 && at(k) - at(k - 1) <= CURSOR_REST_MS) k--;
    return k;
  };
  const runEndOf = (i: number): number => {
    let k = i;
    while (k < samples.length - 1 && at(k + 1) - at(k) <= CURSOR_REST_MS) k++;
    return k;
  };

  const pinned = new Set<number>();
  for (const t of pinnedMs) {
    let before: number | null = null;
    let after: number | null = null;
    for (let i = 0; i < samples.length; i++) {
      const sampleAt = samples[i]?.sourceTimeMs;
      if (sampleAt === undefined) continue;
      if (sampleAt <= t) before = i;
      if (sampleAt >= t) {
        after = i;
        break;
      }
    }
    if (before !== null) pinned.add(before);
    if (after !== null) pinned.add(after);
  }

  return samples.map((sample, i) => {
    const start = runStartOf(i);
    const end = runEndOf(i);
    if (i === start || i === end) return sample;
    if (pinned.has(i)) return sample;

    const first = samples[start] as CursorSample;
    const last = samples[end] as CursorSample;
    const cadence = end > start ? (at(end) - at(start)) / (end - start) : 0;
    const padBefore =
      start > 0 ? Math.min(maxReach, at(start) - at(start - 1)) : 0;
    const padAfter =
      end < samples.length - 1 ? Math.min(maxReach, at(end + 1) - at(end)) : 0;
    const reach = Math.min(
      maxReach,
      at(i) - at(start) + padBefore,
      at(end) - at(i) + padAfter,
    );
    if (reach <= 0) return sample;

    let sx = 0;
    let sy = 0;
    let weight = 0;
    const add = (dt: number, x: number, y: number): void => {
      const w = Math.exp(-(dt * dt) / twoSigmaSquared);
      sx += x * w;
      sy += y * w;
      weight += w;
    };
    for (let j = start; j <= end; j++) {
      const other = samples[j];
      if (!other) continue;
      const dt = other.sourceTimeMs - sample.sourceTimeMs;
      if (Math.abs(dt) > reach) continue;
      add(dt, other.x, other.y);
    }
    if (cadence > 0) {
      for (let step = cadence; step <= padBefore + 1e-6; step += cadence) {
        const dt = first.sourceTimeMs - step - sample.sourceTimeMs;
        if (-dt > reach + 1e-6) break;
        add(dt, first.x, first.y);
      }
      for (let step = cadence; step <= padAfter + 1e-6; step += cadence) {
        const dt = last.sourceTimeMs + step - sample.sourceTimeMs;
        if (dt > reach + 1e-6) break;
        add(dt, last.x, last.y);
      }
    }
    return weight === 0
      ? sample
      : { sourceTimeMs: sample.sourceTimeMs, x: sx / weight, y: sy / weight };
  });
}

/** A real-hand-shaped take: irregular sample spacing, ties, rests, jitter. */
function take(count: number, seed: number): CursorSample[] {
  let state = seed;
  const rand = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const out: CursorSample[] = [];
  let t = 0;
  let x = 300;
  let y = 200;
  for (let i = 0; i < count; i++) {
    const r = rand();
    // Mostly ~8 ms apart, sometimes a burst at the same instant, sometimes
    // a long rest — every spacing the sampler can produce.
    t +=
      r < 0.05 ? 0 : r < 0.9 ? 4 + Math.floor(rand() * 9) : 200 + rand() * 900;
    x += (rand() - 0.5) * 6 + Math.sin(i / 40) * 3;
    y += (rand() - 0.5) * 6 + Math.cos(i / 55) * 3;
    out.push({ sourceTimeMs: t, x, y });
  }
  return out;
}

describe("smoothCursor's window search", () => {
  it("answers exactly what the full scan answered, pins and ties included", () => {
    for (const seed of [1, 7, 42]) {
      const samples = take(2500, seed);
      const pinned = [
        samples[100]?.sourceTimeMs ?? 0,
        (samples[900]?.sourceTimeMs ?? 0) + 0.5,
        samples[2499]?.sourceTimeMs ?? 0,
        99_999_999,
      ];
      for (const sigmaMs of [0, 8, 30, 120]) {
        expect(smoothCursor(samples, sigmaMs, pinned)).toEqual(
          smoothCursorReference(samples, sigmaMs, pinned),
        );
      }
    }
  });

  it("matches the full scan on the degenerate shapes too", () => {
    const flat = Array.from({ length: 50 }, (_, i) => ({
      sourceTimeMs: 1000,
      x: i,
      y: -i,
    }));
    expect(smoothCursor(flat, 30)).toEqual(smoothCursorReference(flat, 30));
    const two = take(2, 3);
    expect(smoothCursor(two, 30)).toEqual(smoothCursorReference(two, 30));
  });
});
