import { describe, expect, it } from "vitest";
import type { CursorSample } from "../../src/bundle";
import { lerpVec, type Vec } from "../../src/geometry";
import { sampleCursor } from "../../src/plan/resolve";

/**
 * `sampleCursor` as it was written until the binary search replaced it: a
 * walk from index 0 to the first sample at or after `sourceMs`.
 *
 * Kept verbatim as the oracle. The search was introduced for speed alone —
 * `compose.ts` calls it eleven times per frame at the default blur, each
 * call crossing the take's whole sample list — so the thing that must not
 * change is the answer, and the cheapest way to say that is to keep the old
 * answer around and demand they agree.
 */
function sampleCursorByScan(
  samples: CursorSample[],
  sourceMs: number,
): Vec | null {
  const first = samples[0];
  if (!first) return null;
  if (sourceMs <= first.sourceTimeMs) return { x: first.x, y: first.y };
  const last = samples[samples.length - 1];
  if (!last) return null;
  if (sourceMs >= last.sourceTimeMs) return { x: last.x, y: last.y };

  for (let i = 1; i < samples.length; i++) {
    const to = samples[i];
    const from = samples[i - 1];
    if (!to || !from) continue;
    if (sourceMs > to.sourceTimeMs) continue;
    const span = to.sourceTimeMs - from.sourceTimeMs;
    const t = span === 0 ? 0 : (sourceMs - from.sourceTimeMs) / span;
    return lerpVec({ x: from.x, y: from.y }, { x: to.x, y: to.y }, t);
  }
  return { x: last.x, y: last.y };
}

/** Deterministic, so a disagreement reported by CI reproduces here. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Sample lists shaped like the ones the resolver actually hands over:
 * irregular spacing, and REPEATED timestamps, which `holdThroughRests` and
 * the gap holds both emit. Duplicates are where an off-by-one in the search
 * shows up — they are the only times where "the first sample at or after
 * `sourceMs`" and "any sample at `sourceMs`" name different samples.
 */
function buildSamples(rand: () => number, count: number): CursorSample[] {
  const out: CursorSample[] = [];
  let t = Math.floor(rand() * 400);
  for (let i = 0; i < count; i++) {
    out.push({ sourceTimeMs: t, x: rand() * 1200, y: rand() * 800 });
    // A third of the steps stand still in time, which is what a hold is.
    t += rand() < 0.33 ? 0 : 1 + Math.floor(rand() * 90);
  }
  return out;
}

describe("sampleCursor's search", () => {
  it("answers exactly what the linear scan answered", () => {
    const rand = seeded(20260920);
    let compared = 0;
    let duplicateTimes = 0;
    for (let listNo = 0; listNo < 40; listNo++) {
      const samples = buildSamples(rand, 2 + Math.floor(rand() * 120));
      duplicateTimes += samples.filter(
        (s, i) => i > 0 && s.sourceTimeMs === samples[i - 1]?.sourceTimeMs,
      ).length;
      const lastMs = samples[samples.length - 1]?.sourceTimeMs ?? 0;
      const times = [
        // Every sample's own instant, which is where duplicates bite.
        ...samples.map((s) => s.sourceTimeMs),
        // Both clamps, and a spread across the middle.
        -50,
        lastMs + 50,
        ...Array.from({ length: 30 }, () => rand() * (lastMs + 100) - 50),
      ];
      for (const ms of times) {
        compared++;
        expect(
          sampleCursor(samples, ms),
          `list ${listNo} (${samples.length} samples) at ${ms}ms`,
        ).toEqual(sampleCursorByScan(samples, ms));
      }
    }
    // The fixture assertion: a generator that stopped producing repeated
    // timestamps, or stopped producing lists at all, would leave every
    // comparison above trivially true.
    expect(compared).toBeGreaterThan(2000);
    expect(duplicateTimes).toBeGreaterThan(50);
  });

  it("still refuses an empty list, and only an empty list", () => {
    expect(sampleCursor([], 0)).toBeNull();
    // Out of range CLAMPS — `compose.ts`'s trail depends on knowing that
    // null never means "outside the take".
    const one: CursorSample[] = [{ sourceTimeMs: 500, x: 7, y: 9 }];
    expect(sampleCursor(one, 0)).toEqual({ x: 7, y: 9 });
    expect(sampleCursor(one, 9999)).toEqual({ x: 7, y: 9 });
  });
});
