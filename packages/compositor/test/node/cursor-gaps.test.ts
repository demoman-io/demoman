import { describe, expect, it } from "vitest";
import type { CursorSample } from "../../src/bundle";
import { leaveThroughEdges, offPageDirection } from "../../src/plan/off-page";
import { planScene } from "../../src/plan/plan";
import {
  holdAcrossGaps,
  holdThroughRests,
  resolvePlan,
  sampleCursor,
} from "../../src/plan/resolve";
import { CURSOR_REST_MS } from "../../src/plan/smooth";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

describe("holdAcrossGaps", () => {
  const samples = [
    { sourceTimeMs: 0, x: 0, y: 0 },
    { sourceTimeMs: 1000, x: 1000, y: 0 },
  ];

  it("holds the last known position through the hole", () => {
    const held = holdAcrossGaps(samples, [{ startMs: 100, endMs: 900 }]);
    // Without the hold, linear interpolation puts the cursor at x=500
    // halfway through — a straight line across 800ms in which the pointer's
    // position was not observed at all.
    expect(sampleCursor(held, 500)?.x).toBe(100);
    expect(sampleCursor(held, 880)?.x).toBe(100);
  });

  it("leaves samples untouched when nothing was lost", () => {
    expect(holdAcrossGaps(samples, [])).toEqual(samples);
    expect(sampleCursor(samples, 500)?.x).toBe(500);
  });

  it("ignores a gap that starts before any sample", () => {
    // Nothing known to hold at. Inventing a position would be worse than
    // letting the first real sample stand.
    const held = holdAcrossGaps(samples, [{ startMs: -50, endMs: -10 }]);
    expect(held).toEqual(samples);
  });

  it("keeps the samples in time order", () => {
    const held = holdAcrossGaps(samples, [{ startMs: 700, endMs: 900 }]);
    const times = held.map((s) => s.sourceTimeMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

// `holdAcrossGaps` passing in isolation does not prove `resolvePlan` actually
// calls it — a test that only exercises the helper directly would pass
// whether or not the selection at resolve.ts wires `bundle.cursorGaps` in at
// all. This goes through `resolvePlan` itself so an unwired call is caught.
describe("resolvePlan", () => {
  it("holds the resolved cursor across a recorded gap", () => {
    const scene = readonlyScene();
    const bundle = proceduralBundle({
      cursorGaps: [{ startMs: 1000, endMs: 3000 }],
    });
    const resolved = resolvePlan(planScene(scene), bundle, scene);

    // Pre-gap position: where the raw, un-held samples say the pointer was
    // the instant the gap opened.
    const preGap = sampleCursor(bundle.cursorSamples, 1000);
    // What a naive (unwired) interpolation across the raw samples would say
    // mid-gap — the straight line this task exists to stop drawing.
    const naiveMidGap = sampleCursor(bundle.cursorSamples, 2000);
    const midGap = sampleCursor(resolved.cursor, 2000);

    expect(midGap).toEqual(preGap);
    expect(midGap).not.toEqual(naiveMidGap);
  });
});

/**
 * The stages that run between the samples and the drawn cursor on a capture
 * take — the re-timer, the smoothing kernel, the spring — each write
 * positions of their own, and each has to be told where the pointer was not
 * observed. `proceduralBundle` is a replay bundle by default and none of
 * them run on one, so the gap test above never reached any of this.
 */
describe("a capture take with a gap in it", () => {
  /** A reach to (100,100), a hole, and a short gesture from (900,700). */
  const around = (gapMs: number): CursorSample[] => {
    const samples: CursorSample[] = [];
    for (let t = 0; t <= 1000; t += 16) {
      samples.push({
        sourceTimeMs: t,
        x: (100 * t) / 1000,
        y: (100 * t) / 1000,
      });
    }
    const back = 1000 + gapMs;
    for (let t = back; t <= back + 80; t += 16) {
      samples.push({
        sourceTimeMs: t,
        x: 900 + (50 * (t - back)) / 80,
        y: 700,
      });
    }
    return samples;
  };

  const resolveWith = (gapMs: number) => {
    const scene = readonlyScene();
    const bundle = proceduralBundle({
      source: "capture",
      cursorSamples: around(gapMs),
      cursorGaps: [{ startMs: 1000, endMs: 1000 + gapMs }],
      markers: [],
    });
    return resolvePlan(planScene(scene), bundle, scene);
  };

  it("draws no movement at all inside the hole", () => {
    // The spring writes its own grid into exactly the long holes a gap
    // makes, and its lead starts it moving toward whatever follows the hole
    // before the hole is over. Appending two hold samples to that leaves the
    // fabricated curve sitting between them: measured before this was fixed,
    // the drawn cursor crossed 600px of a stretch in which the pointer's
    // position was never observed, and then snapped back inside the last
    // millisecond of it.
    const resolved = resolveWith(2000);
    const inside = [1200, 2000, 2800, 2900, 2950, 2990, 2999].map((ms) =>
      sampleCursor(resolved.cursor, ms),
    );
    const first = inside[0];
    expect(first).not.toBeNull();
    for (const position of inside) expect(position).toEqual(first);
    // And it holds where the pointer actually was, not somewhere along the
    // way to where it came back. Within a few pixels rather than exactly:
    // what freezes is the DRAWN cursor, and that is a body with weight which
    // was still a spring's-lag short of the hand at the instant the
    // observations stopped — it would have finished settling onto it over
    // the next `springSettleMs`, but that settle is inside the hole and goes
    // with the rest of it. Measured at 5.3px here, against the 1131px
    // journey to where the pointer reappeared and the 600px of travel across
    // this hole that the bound above exists to keep out.
    expect(
      Math.hypot((first?.x ?? 0) - 100, (first?.y ?? 0) - 100),
    ).toBeLessThan(10);
  });

  it("is measuring a hole the cursor would otherwise have been drawn across", () => {
    // Fixture guard. Without the gap the same samples are a journey, and a
    // test that held a flat line through a stretch nothing crosses anyway
    // would pass with and without every line it is aimed at.
    const scene = readonlyScene();
    const bundle = proceduralBundle({
      source: "capture",
      cursorSamples: around(2000),
      cursorGaps: [],
      markers: [],
    });
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const early = sampleCursor(resolved.cursor, 1200);
    const late = sampleCursor(resolved.cursor, 2990);
    expect(
      Math.hypot(
        (late?.x ?? 0) - (early?.x ?? 0),
        (late?.y ?? 0) - (early?.y ?? 0),
      ),
    ).toBeGreaterThan(100);
  });

  it("puts the pointer where it was seen again, the instant it was seen", () => {
    // The other half, and the one a rest boundary does not catch: a gap
    // shorter than `CURSOR_REST_MS` leaves its two sides inside one run, so
    // `retimeAlongRoute` measures arc length along the teleport across it
    // and spreads that distance over the gesture that follows. Measured on a
    // two-second gap before the fix, the hand's first position after it,
    // (900,700), was drawn at (110,108) and the whole gesture crawled along
    // a line the pointer never crossed.
    const resolved = resolveWith(30);
    const back = sampleCursor(resolved.cursor, 1030);
    expect(back?.x).toBeCloseTo(900, 0);
    expect(back?.y).toBeCloseTo(700, 0);
  });

  it("is measuring a gap too short for the rest boundary to break", () => {
    // Fixture guard for the test above: 30ms is under `CURSOR_REST_MS`, so
    // nothing but the gap itself tells the re-timer these are two gestures.
    expect(30).toBeLessThan(CURSOR_REST_MS);
  });

  it("holds where the pointer rested before it left, not partway to where it returned", () => {
    // The shape a real gap actually has: the hand stops, sits still for a
    // while, and only then leaves the document. `pointerleave` opens the gap
    // half a second into a pause that recorded nothing, so the position at
    // the gap's start is only known because the stillness before it was
    // written down. Without that, the hold reads a straight-line
    // interpolation across the whole pause and freezes 100px along a journey
    // that had not started.
    const scene = readonlyScene();
    const samples: CursorSample[] = [];
    for (let t = 0; t <= 1000; t += 16) {
      samples.push({
        sourceTimeMs: t,
        x: (100 * t) / 1000,
        y: (100 * t) / 1000,
      });
    }
    samples.push({ sourceTimeMs: 3000, x: 900, y: 700 });
    const bundle = proceduralBundle({
      source: "capture",
      cursorSamples: samples,
      cursorGaps: [{ startMs: 1500, endMs: 3000 }],
      markers: [],
    });
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    for (const ms of [1100, 1400, 1500, 2000, 2900]) {
      const drawn = sampleCursor(resolved.cursor, ms);
      expect(
        Math.hypot((drawn?.x ?? 0) - 100, (drawn?.y ?? 0) - 100),
      ).toBeLessThan(5);
    }
  });
});

describe("holdThroughRests", () => {
  const samples: CursorSample[] = [
    { sourceTimeMs: 0, x: 10, y: 10 },
    { sourceTimeMs: 1000, x: 20, y: 20 },
  ];

  it("holds the pointer still through a pause", () => {
    const held = holdThroughRests(samples, 50);
    expect(held).toHaveLength(3);
    expect(held[1]).toEqual({ sourceTimeMs: 999, x: 10, y: 10 });
  });

  it("ends the hold where the pointer stopped being observed", () => {
    // The pointer sat still from 0 to 100 and then left. The stillness is
    // real and worth writing down; what follows it is not this function's to
    // claim, because the claim its sample makes — the pointer really was
    // there, for that whole stretch — is exactly what a gap says is unknown.
    const held = holdThroughRests(samples, 50, [{ startMs: 100, endMs: 900 }]);
    expect(held).toEqual([
      { sourceTimeMs: 0, x: 10, y: 10 },
      { sourceTimeMs: 100, x: 10, y: 10 },
      { sourceTimeMs: 1000, x: 20, y: 20 },
    ]);
  });

  it("holds nothing when the gap opens at the pausing sample itself", () => {
    const held = holdThroughRests(samples, 50, [{ startMs: 0, endMs: 900 }]);
    expect(held).toEqual(samples);
  });

  it("still holds through a pause that no gap overlaps", () => {
    const held = holdThroughRests(samples, 50, [
      { startMs: 2000, endMs: 2500 },
    ]);
    expect(held).toHaveLength(3);
  });
});

/**
 * A gap that opens at the page's edge is the pointer leaving the page, and
 * the real pointer does not stop there — it carries on out of the window.
 * Holding the drawn one at its last sighting parked it just inside the edge
 * for the whole time the hand was over the browser's toolbar.
 */
describe("leaveThroughEdges", () => {
  const viewport = { width: 1280, height: 800 };

  /** The hand moving right at 1px/ms, out through the right-hand edge. */
  const outward: CursorSample[] = [];
  for (let t = 0; t <= 64; t += 16) {
    outward.push({ sourceTimeMs: t, x: 1200 + t, y: 400 });
  }
  /** ...and back in through the same edge, moving left at 1px/ms. */
  const inward = (back: number, y = 500): CursorSample[] => {
    const samples: CursorSample[] = [];
    for (let t = back; t <= back + 64; t += 16) {
      samples.push({ sourceTimeMs: t, x: 1270 - (t - back), y });
    }
    return samples;
  };

  it("is fed sightings the classifier calls exits through the right-hand edge", () => {
    // Fixture guard: every case below rests on these being edge exits, and
    // on the interior case further down not being one.
    expect(
      offPageDirection({ x: 1264, y: 400 }, { x: 1, y: 0 }, viewport),
    ).toEqual({ x: 1, y: 0 });
    expect(
      offPageDirection({ x: 1270, y: 500 }, { x: 1, y: 0 }, viewport),
    ).toEqual({ x: 1, y: 0 });
  });

  it("carries the pointer on out of the page, at the speed it was going", () => {
    const samples = [...outward, ...inward(2064)];
    const out = leaveThroughEdges(
      samples,
      [{ startMs: 64, endMs: 2064 }],
      viewport,
    );
    // Ten milliseconds on, it has moved on by about ten pixels.
    expect(sampleCursor(out.samples, 74)?.x).toBeCloseTo(1274, 0);
    expect(sampleCursor(out.samples, 74)?.y).toBe(400);
    // And it is not one sample at the far end: a lone sample 300ms away
    // reads as the hand at rest to every stage that looks for rests.
    const run = out.samples.filter(
      (s) => s.sourceTimeMs > 64 && s.sourceTimeMs < 400,
    );
    for (let i = 1; i < run.length; i++) {
      const gap =
        (run[i] as CursorSample).sourceTimeMs -
        (run[i - 1] as CursorSample).sourceTimeMs;
      expect(gap).toBeLessThan(CURSOR_REST_MS);
    }
    expect(run.length).toBeGreaterThan(10);
  });

  it("cuts the gap down to the wait off the page", () => {
    const samples = [...outward, ...inward(2064)];
    const out = leaveThroughEdges(
      samples,
      [{ startMs: 64, endMs: 2064 }],
      viewport,
    );
    expect(out.gaps).toHaveLength(1);
    const [wait] = out.gaps;
    // It opens and closes with the pointer clear of the frame — further
    // out than any drawn arrow is tall.
    expect(sampleCursor(out.samples, wait?.startMs ?? 0)?.x).toBeGreaterThan(
      viewport.width + 200,
    );
    expect(sampleCursor(out.samples, wait?.endMs ?? 0)?.x).toBeGreaterThan(
      viewport.width + 200,
    );
  });

  it("brings it back in along the line it re-entered on", () => {
    const samples = [...outward, ...inward(2064)];
    const out = leaveThroughEdges(
      samples,
      [{ startMs: 64, endMs: 2064 }],
      viewport,
    );
    expect(sampleCursor(out.samples, 2054)?.x).toBeCloseTo(1280, 0);
    expect(sampleCursor(out.samples, 2054)?.y).toBe(500);
    expect(sampleCursor(out.samples, 2064)).toEqual({ x: 1270, y: 500 });
  });

  it("peeks out and back without a jump when the gap is brief", () => {
    // The pointer brushed past the edge for 40ms. Out and back at the speed
    // it was going, so it only gets about 20px out, and no gap is left:
    // it was moving the whole time.
    const samples = [...outward, ...inward(104, 400)];
    const out = leaveThroughEdges(
      samples,
      [{ startMs: 64, endMs: 104 }],
      viewport,
    );
    expect(out.gaps).toEqual([]);
    let widest = 0;
    let previous = sampleCursor(out.samples, 64);
    for (let t = 65; t <= 104; t++) {
      const at = sampleCursor(out.samples, t);
      widest = Math.max(widest, at?.x ?? 0);
      expect(Math.abs((at?.x ?? 0) - (previous?.x ?? 0))).toBeLessThan(3);
      previous = at;
    }
    expect(widest).toBeLessThan(1300);
    expect(widest).toBeGreaterThan(1280);
  });

  it("does not cut across a corner when a brief gap leaves and returns through different edges", () => {
    // Up through the top edge near the top-right corner, back in through
    // the right edge 60ms later: too short for both runs in full. Turning
    // straight back from the exit's far point drew a diagonal from above
    // the page to the right edge, through the page's corner, that the
    // pointer never travelled — it went round outside.
    const up: CursorSample[] = [];
    for (let t = 0; t <= 64; t += 16) {
      up.push({ sourceTimeMs: t, x: 1200, y: 74 - t });
    }
    const left: CursorSample[] = [];
    for (let t = 124; t <= 188; t += 16) {
      left.push({ sourceTimeMs: t, x: 1270 - (t - 124), y: 200 });
    }
    const samples = [...up, ...left];
    const out = leaveThroughEdges(
      samples,
      [{ startMs: 64, endMs: 124 }],
      viewport,
    );
    // Fixture guard: both are edge crossings, through different edges.
    expect(
      offPageDirection({ x: 1200, y: 10 }, { x: 0, y: -1 }, viewport),
    ).toEqual({ x: 0, y: -1 });
    expect(
      offPageDirection({ x: 1270, y: 200 }, { x: 1, y: 0 }, viewport),
    ).toEqual({ x: 1, y: 0 });
    // Read as the pipeline reads it: a gap is held, never interpolated.
    const drawn = holdAcrossGaps(out.samples, out.gaps);
    for (let t = 80; t <= 108; t++) {
      const at = sampleCursor(drawn, t);
      const inside =
        (at?.x ?? 0) > 0 &&
        (at?.x ?? 0) < viewport.width &&
        (at?.y ?? 0) > 0 &&
        (at?.y ?? 0) < viewport.height;
      expect(inside, `at ${t}ms: ${JSON.stringify(at)}`).toBe(false);
    }
  });

  it("waits off the page when the take ends before the pointer comes back", () => {
    // The take that ends on the toolbar's Stop: the gap runs to the end.
    const out = leaveThroughEdges(
      outward,
      [{ startMs: 64, endMs: 3000 }],
      viewport,
    );
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]?.endMs).toBe(3000);
    expect(
      sampleCursor(out.samples, out.gaps[0]?.startMs ?? 0)?.x,
    ).toBeGreaterThan(viewport.width + 200);
  });

  it("leaves a gap that opens in the middle of the page exactly as it was", () => {
    // The pointer went into an iframe, or onto a native <select> popup: the
    // position is unknown, but it is not off the page, and carrying it to
    // an edge would draw a journey nothing made.
    const interior: CursorSample[] = [];
    for (let t = 0; t <= 64; t += 16) {
      interior.push({ sourceTimeMs: t, x: 600 + t, y: 400 });
    }
    expect(offPageDirection({ x: 664, y: 400 }, { x: 1, y: 0 }, viewport)).toBe(
      null,
    );
    const samples = [...interior, { sourceTimeMs: 2064, x: 900, y: 600 }];
    const gaps = [{ startMs: 64, endMs: 2064 }];
    expect(leaveThroughEdges(samples, gaps, viewport)).toEqual({
      samples,
      gaps,
    });
  });

  it("brings the take's first sighting in from the edge it is beside", () => {
    // First sighted half a second in, 5px from the left edge, moving right:
    // the hand arriving from the Record button.
    const arriving: CursorSample[] = [];
    for (let t = 500; t <= 564; t += 16) {
      arriving.push({ sourceTimeMs: t, x: 5 + (t - 500), y: 300 });
    }
    const out = leaveThroughEdges(arriving, [], viewport);
    expect(sampleCursor(out.samples, 0)?.x).toBeLessThan(-200);
    expect(sampleCursor(out.samples, 490)?.x).toBeCloseTo(-5, 0);
    expect(sampleCursor(out.samples, 500)).toEqual({ x: 5, y: 300 });

    // A first sighting inside the page is a hand that was already there.
    const inside = arriving.map((s) => ({ ...s, x: s.x + 400 }));
    expect(leaveThroughEdges(inside, [], viewport).samples).toEqual(inside);
    // And one at the very start of the take has no time to arrive in.
    const atZero = arriving.map((s) => ({
      ...s,
      sourceTimeMs: s.sourceTimeMs - 500,
    }));
    expect(leaveThroughEdges(atZero, [], viewport).samples).toEqual(atZero);
  });
});

describe("leaveThroughEdges, for a pointer that rested before it left", () => {
  const viewport = { width: 1280, height: 800 };
  // Up to a nav item 10px under the top edge, arriving at 1000ms, and a
  // rest there; the gap opens three seconds later, when the hand flicks up
  // to the toolbar. The flick's first event is already off the page, so
  // there is no sighting of it — the last one is the arrival at the rest.
  const samples: CursorSample[] = [];
  for (let t = 800; t <= 1000; t += 20) {
    samples.push({ sourceTimeMs: t, x: 640, y: 10 + (1000 - t) });
  }
  const gaps = [{ startMs: 4000, endMs: 6000 }];

  it("is fed a rest: the last sighting is long before the gap", () => {
    const last = samples.at(-1);
    expect(last?.y).toBe(10);
    expect(4000 - (last?.sourceTimeMs ?? 0)).toBeGreaterThan(CURSOR_REST_MS);
  });

  it("keeps the pointer at rest until it left, then takes it out", () => {
    const out = leaveThroughEdges(samples, gaps, viewport);
    // Still resting a moment before the gap opened...
    expect(sampleCursor(out.samples, 3900)).toEqual({ x: 640, y: 10 });
    // ...and off the page, upward, once it has.
    const gone = sampleCursor(out.samples, out.gaps[0]?.startMs ?? 0);
    expect(gone?.y).toBeLessThan(-200);
    expect(gone?.x).toBeCloseTo(640, 0);
  });
});

describe("leaveThroughEdges, for a take started from off the page", () => {
  const viewport = { width: 1280, height: 800 };
  /** First sighted at `at`, 5px from the left edge, moving right at 1px/ms. */
  const arriving = (at: number): CursorSample[] => {
    const samples: CursorSample[] = [];
    for (let t = at; t <= at + 64; t += 16) {
      samples.push({ sourceTimeMs: t, x: 5 + (t - at), y: 300 });
    }
    return samples;
  };
  // The gap every take started from the toolbar or the popup carries: the
  // pointer left the page to press Record before the take began, so the gap
  // opens before it (clamped to 0) and closes at the first sighting.
  const leading = (at: number) => [{ startMs: 0, endMs: at }];

  it("drops the gap the arrival run now accounts for", () => {
    const out = leaveThroughEdges(arriving(500), leading(500), viewport);
    // Left in place, the run sits inside a gap: every stage that will not
    // join across one leaves it unshaped, and `holdAcrossGaps` deletes it
    // outright once the run starts at 0.
    expect(out.gaps).toEqual([]);
    expect(sampleCursor(out.samples, 490)?.x).toBeCloseTo(-5, 0);
  });

  it("keeps a leading gap when the take's first sighting is inside the page", () => {
    const inside = arriving(500).map((s) => ({ ...s, x: s.x + 400 }));
    expect(leaveThroughEdges(inside, leading(500), viewport).gaps).toEqual(
      leading(500),
    );
  });
});

describe("resolvePlan, for a take started from off the page", () => {
  const scene = readonlyScene();
  const resolveArrival = (at: number) => {
    const samples: CursorSample[] = [];
    for (let t = at; t <= at + 400; t += 8) {
      samples.push({ sourceTimeMs: t, x: 4 + 1.5 * (t - at), y: 300 });
    }
    return resolvePlan(
      planScene(scene),
      proceduralBundle({
        source: "capture",
        cursorSamples: samples,
        cursorGaps: [{ startMs: 0, endMs: at }],
        markers: [],
      }),
      scene,
    );
  };

  it("draws the arrival when there is room for all of it", () => {
    // Glides in rather than waiting off the page and popping in at the first
    // sighting. This asked for x in (-40, 4) at 990ms until 2026-10-09 —
    // which held only while the retimer drew the gesture at the hand's even
    // pace; a gesture that settles into its rest cruises a little faster to
    // arrive on time, so it crosses the edge a little earlier. The claim is
    // the glide, so the glide is what is measured.
    const resolved = resolveArrival(1000);
    expect(sampleCursor(resolved.cursor, 0)?.x).toBeLessThan(-200);
    expect(sampleCursor(resolved.cursor, 1000)?.x).toBeGreaterThan(0);
    let largest = 0;
    let previous = sampleCursor(resolved.cursor, 0)?.x ?? 0;
    for (let t = 8; t <= 1000; t += 8) {
      const x = sampleCursor(resolved.cursor, t)?.x ?? 0;
      largest = Math.max(largest, Math.abs(x - previous));
      previous = x;
    }
    // The hand's 1.5px/ms is 12px a step; the cruise adds at most a quarter.
    // A pop is the whole 200px-plus at once.
    expect(largest).toBeLessThan(20);
  });

  it("draws the arrival when the first sighting comes before the run would have begun", () => {
    // The run is compressed into the 150ms there is; it must still be drawn
    // rather than held off the page and popped in at the first sighting.
    const resolved = resolveArrival(150);
    expect(sampleCursor(resolved.cursor, 0)?.x).toBeLessThan(-200);
    const mid = sampleCursor(resolved.cursor, 75)?.x ?? 0;
    expect(mid).toBeGreaterThan(-250);
    expect(mid).toBeLessThan(0);
  });
});

describe("offPageDirection", () => {
  const viewport = { width: 1280, height: 800 };

  it("takes the way the pointer was heading when that reaches an edge soon", () => {
    // A flick at 3px/ms, 90px short of the top edge: there within 30ms.
    const out = offPageDirection({ x: 640, y: 90 }, { x: 0, y: -3 }, viewport);
    expect(out?.x).toBeCloseTo(0);
    expect(out?.y).toBeCloseTo(-1);
  });

  it("does not call a fast move toward an iframe an exit", () => {
    // Same speed, 300px from the edge: more than 50ms away, so the pointer
    // stopped being observed somewhere inside the page.
    expect(offPageDirection({ x: 980, y: 400 }, { x: 3, y: 0 }, viewport)).toBe(
      null,
    );
  });

  it("falls back to the nearest edge when the pointer was barely moving", () => {
    expect(
      offPageDirection({ x: 640, y: 790 }, { x: 0, y: 0 }, viewport),
    ).toEqual({ x: 0, y: 1 });
  });

  it("takes a pointer already past the edge out through it, whichever way it was heading", () => {
    // A drag with pointer capture samples outside the page. Heading back in
    // when the gap opened, the heading is not the way out: a run along it
    // is drawn straight across the page.
    expect(
      offPageDirection({ x: -40, y: 300 }, { x: 2, y: 0 }, viewport),
    ).toEqual({ x: -1, y: 0 });
  });

  it("calls a pointer already past the edge an exit through it", () => {
    expect(
      offPageDirection({ x: -4, y: 300 }, { x: 0, y: 0 }, viewport),
    ).toEqual({ x: -1, y: 0 });
  });
});

/**
 * Through the whole capture pipeline. The first version of this feature
 * passed every case above in its own shape and still drew a hitch at the
 * edge, because smoothing, re-timing and the spring all ran before it and
 * eased the cursor to a near-stop where the gap began.
 */
describe("resolvePlan, for a capture take that leaves through an edge", () => {
  const scene = readonlyScene();
  const { width, height } = scene.meta.capture.viewport;

  /** A steady 1.5px/ms sweep right, out through the right-hand edge at
   *  1000ms; back in through it at 3000ms, steady at 1.5px/ms leftward. */
  const sweep = (): CursorSample[] => {
    const samples: CursorSample[] = [];
    for (let t = 0; t <= 1000; t += 8) {
      samples.push({ sourceTimeMs: t, x: width - 1504 + 1.5 * t, y: 400 });
    }
    for (let t = 3000; t <= 3600; t += 8) {
      samples.push({
        sourceTimeMs: t,
        x: width - 4 - 1.5 * (t - 3000),
        y: 400,
      });
    }
    return samples;
  };
  const resolveSweep = (gaps: { startMs: number; endMs: number }[]) =>
    resolvePlan(
      planScene(scene),
      proceduralBundle({
        source: "capture",
        cursorSamples: sweep(),
        cursorGaps: gaps,
        markers: [],
      }),
      scene,
    );
  /** Drawn speed in px/ms over each 16ms step from `fromMs` to `toMs`. */
  const speeds = (
    cursor: CursorSample[],
    fromMs: number,
    toMs: number,
  ): number[] => {
    const out: number[] = [];
    for (let t = fromMs; t < toMs; t += 16) {
      const a = sampleCursor(cursor, t);
      const b = sampleCursor(cursor, t + 16);
      out.push(Math.abs((b?.x ?? 0) - (a?.x ?? 0)) / 16);
    }
    return out;
  };

  it("crosses the edge at the speed the hand was going, both ways", () => {
    // Measured before the off-page run moved ahead of the pipeline: 0.74
    // px/ms just inside the edge on the way out, then 1.5 again, and 0.73
    // at the edge on the way back in. The hand never slowed.
    const resolved = resolveSweep([{ startMs: 1000, endMs: 3000 }]);
    const out = speeds(resolved.cursor, 880, 1100);
    const back = speeds(resolved.cursor, 2880, 3100);
    expect(Math.min(...out), out.join(" ")).toBeGreaterThan(1.3);
    expect(Math.min(...back), back.join(" ")).toBeGreaterThan(1.3);
  });

  it("is sampling a stretch where the drawn cursor really does cross the edge", () => {
    // Fixture guard for the case above: both windows straddle the edge, so
    // a hitch at the edge falls inside them.
    const resolved = resolveSweep([{ startMs: 1000, endMs: 3000 }]);
    expect(sampleCursor(resolved.cursor, 880)?.x).toBeLessThan(width - 100);
    expect(sampleCursor(resolved.cursor, 1100)?.x).toBeGreaterThan(width + 50);
    expect(sampleCursor(resolved.cursor, 2880)?.x).toBeGreaterThan(width + 50);
    expect(sampleCursor(resolved.cursor, 3100)?.x).toBeLessThan(width - 100);
  });

  it("draws the cursor off the page while the pointer is off it", () => {
    const resolved = resolveSweep([{ startMs: 1000, endMs: 3000 }]);
    const midGap = sampleCursor(resolved.cursor, 2000);
    expect(midGap?.x).toBeGreaterThan(width + 200);
    expect(midGap?.y).toBeGreaterThan(0);
    expect(midGap?.y).toBeLessThan(height);
  });

  it("does not cross the page while it is out of it", () => {
    // Out through the right-hand edge, back through the left: a line
    // between the two off-page points is the whole width of the page.
    const samples: CursorSample[] = [];
    for (let t = 0; t <= 1000; t += 8) {
      samples.push({ sourceTimeMs: t, x: width - 1504 + 1.5 * t, y: 400 });
    }
    for (let t = 3000; t <= 3600; t += 8) {
      samples.push({ sourceTimeMs: t, x: 4 + 1.5 * (t - 3000), y: 400 });
    }
    const resolved = resolvePlan(
      planScene(scene),
      proceduralBundle({
        source: "capture",
        cursorSamples: samples,
        cursorGaps: [{ startMs: 1000, endMs: 3000 }],
        markers: [],
      }),
      scene,
    );
    for (let t = 1300; t < 2800; t += 10) {
      const at = sampleCursor(resolved.cursor, t);
      const inside = (at?.x ?? 0) >= 0 && (at?.x ?? 0) <= width;
      expect(inside, `at ${t}ms: ${JSON.stringify(at)}`).toBe(false);
    }
  });

  it("glides the cursor in at the start of a take first sighted at an edge", () => {
    const samples: CursorSample[] = [];
    for (let t = 800; t <= 1200; t += 16) {
      samples.push({ sourceTimeMs: t, x: 640, y: 4 + (t - 800) });
    }
    const resolved = resolvePlan(
      planScene(scene),
      proceduralBundle({
        source: "capture",
        cursorSamples: samples,
        cursorGaps: [],
        markers: [],
      }),
      scene,
    );
    expect(sampleCursor(resolved.cursor, 0)?.y).toBeLessThan(-200);
  });
});
