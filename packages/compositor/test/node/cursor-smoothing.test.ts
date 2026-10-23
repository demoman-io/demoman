import { describe, expect, it } from "vitest";
import { holdThroughRests, sampleCursor } from "../../src/plan/resolve";
import {
  CURSOR_REST_MS,
  CURSOR_SMOOTHING_MS,
  smoothCursor,
} from "../../src/plan/smooth";

/** A straight rightward drag with one-pixel vertical jitter on every sample. */
const jittery = Array.from({ length: 40 }, (_, i) => ({
  sourceTimeMs: i * 8,
  x: i * 10,
  y: i % 2 === 0 ? 100 : 101,
}));

const reversals = (samples: { y: number }[]): number => {
  let count = 0;
  for (let i = 2; i < samples.length; i++) {
    const a = (samples[i - 1]?.y as number) - (samples[i - 2]?.y as number);
    const b = (samples[i]?.y as number) - (samples[i - 1]?.y as number);
    if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) count++;
  }
  return count;
};

describe("smoothCursor", () => {
  it("removes jitter without removing the movement", () => {
    const out = smoothCursor(jittery, 40);
    expect(reversals(out)).toBeLessThan(reversals(jittery) / 4);
    // The drag still crosses the same ground: smoothing is not shrinking.
    expect(out[out.length - 1]?.x as number).toBeCloseTo(
      jittery[jittery.length - 1]?.x as number,
      0,
    );
  });

  it("keeps the first and last sample exactly", () => {
    const out = smoothCursor(jittery, 40);
    // The cursor must arrive where the action fired. A smoothed endpoint
    // would put the pointer next to the button it clicked.
    expect(out[0]).toEqual(jittery[0]);
    expect(out[out.length - 1]).toEqual(jittery[jittery.length - 1]);
  });

  it("preserves timestamps one for one", () => {
    const out = smoothCursor(jittery, 40);
    expect(out.map((s) => s.sourceTimeMs)).toEqual(
      jittery.map((s) => s.sourceTimeMs),
    );
  });

  it("is a no-op at a zero window", () => {
    expect(smoothCursor(jittery, 0)).toEqual(jittery);
  });

  /**
   * Bound check, not a jitter-removal measurement — those are different
   * claims. This only proves the shipped window cannot draw the cursor far
   * from where the pointer really was; it says nothing about how much
   * jitter the window actually removes, which needs real recorded takes
   * (see `CURSOR_SMOOTHING_MS`'s docblock).
   */
  it("never displaces a sample more than 4px from its raw original, at the shipped window", () => {
    const out = smoothCursor(jittery, CURSOR_SMOOTHING_MS);
    let maxDisplacement = 0;
    for (let i = 0; i < out.length; i++) {
      const raw = jittery[i];
      const smoothed = out[i];
      if (!raw || !smoothed) continue;
      const displacement = Math.hypot(smoothed.x - raw.x, smoothed.y - raw.y);
      maxDisplacement = Math.max(maxDisplacement, displacement);
    }
    expect(maxDisplacement).toBeLessThan(4);
  });
});

/**
 * A 125Hz rightward approach that CRUISES at ~1000px/s and then stops at the
 * button, with a short deceleration — the ordinary shape of clicking
 * something you were already moving towards. Deliberately not the
 * uniform-velocity fixture above: a centred average of a constant velocity is
 * that velocity, which is why the 4px bound above held there and does not
 * hold here.
 *
 * The hold after arrival emits nothing, because `createPointerSampler`
 * dedupes a resting pointer (`sensor/pointer.ts`) — so the arrival sample's
 * smoothing window has neighbours only on the approach side, and a
 * backward-only average of a decelerating approach lags behind the arrival.
 */
const CRUISE_PX_PER_STEP = 8; // ~1000 px/s at 8ms samples
const STEP_MS = 8;
const DECEL_PX = [8, 6, 3];

type Sample = { sourceTimeMs: number; x: number; y: number };

const arrival = (): { samples: Sample[]; markerMs: number } => {
  const raw: Sample[] = [];
  let t = 0;
  let x = 100;
  raw.push({ sourceTimeMs: t, x, y: 300 });
  for (const step of [
    ...Array.from({ length: 30 }, () => CRUISE_PX_PER_STEP),
    ...DECEL_PX,
  ]) {
    t += STEP_MS;
    x += step;
    raw.push({ sourceTimeMs: t, x, y: 300 });
  }
  const arriveMs = t;
  const arriveX = x;
  // The pointer rests on the button, then leaves. Nothing is recorded during
  // the rest itself.
  for (let i = 1; i <= 20; i++) {
    raw.push({
      sourceTimeMs: arriveMs + 500 + i * STEP_MS,
      x: arriveX - i * 8,
      y: 300,
    });
  }
  // The action's own instant, which is NOT any sample's instant: a marker is
  // an integer `Date.now()` rebased on the sessionStart record, a sample is
  // `performance.timeOrigin + event.timeStamp` rebased on `meta.createdAt`.
  // Nothing makes those two land on the same number, which is why the pin has
  // to bracket rather than match.
  return { samples: raw, markerMs: arriveMs + 3 };
};

const drift = (raw: Sample[], smoothed: Sample[], markerMs: number): number => {
  const truth = sampleCursor(raw, markerMs);
  const drawn = sampleCursor(smoothed, markerMs);
  if (!truth || !drawn) throw new Error("no cursor position at the marker");
  return Math.hypot(drawn.x - truth.x, drawn.y - truth.y);
};

/**
 * A click taken on the move: the hand cruises in, decelerates onto the
 * button, clicks, and leaves again on the very next frame without ever
 * stopping.
 *
 * This is what `pinnedMs` is for, and the only shape that still needs it.
 * An arrival that ENDS in a pause — `arrival()` above, and the overwhelming
 * majority of real clicks — is the last sample of its run, so `smoothCursor`
 * passes it through exactly with no pin at all. A click the hand clicks
 * through is mid-run, and the apex of that in-and-out is where a symmetric
 * kernel disagrees with the raw position most.
 */
const clickedThrough = (): { samples: Sample[]; markerMs: number } => {
  const samples: Sample[] = [];
  let t = 0;
  let x = 100;
  samples.push({ sourceTimeMs: t, x, y: 300 });
  for (const step of [
    ...Array.from({ length: 30 }, () => CRUISE_PX_PER_STEP),
    ...DECEL_PX,
  ]) {
    t += STEP_MS;
    x += step;
    samples.push({ sourceTimeMs: t, x, y: 300 });
  }
  const markerMs = t + 3;
  for (let i = 1; i <= 30; i++) {
    samples.push({
      sourceTimeMs: t + i * STEP_MS,
      x: x - i * CRUISE_PX_PER_STEP,
      y: 300,
    });
  }
  return { samples, markerMs };
};

describe("smoothCursor at an arrival that ends in a pause", () => {
  it("draws the cursor where the pointer really was when the action fired", () => {
    // A click is drawn at `sampleCursor(cursor, markerMs)` (render/compose.ts),
    // so this is the pixel distance between the drawn click and the button it
    // hit. No pin is passed: the arrival is the last sample of its run,
    // because the hand then sat on the button for 500ms, and a run's ends
    // pass through untouched.
    const { samples, markerMs } = arrival();
    const out = smoothCursor(samples, CURSOR_SMOOTHING_MS);
    expect(drift(samples, out, markerMs)).toBeLessThan(1);
  });
});

describe("smoothCursor at a marker the hand did not stop on", () => {
  it("draws the cursor where the pointer really was when the action fired", () => {
    const { samples, markerMs } = clickedThrough();
    const out = smoothCursor(samples, CURSOR_SMOOTHING_MS, [markerMs]);
    expect(drift(samples, out, markerMs)).toBeLessThan(1);
  });

  it("is measuring a fixture that genuinely defeats the unpinned kernel", () => {
    // Fixture guard. Without the pin this same fixture drifts far enough to
    // draw the click beside the button it hit — the apex of an in-and-out
    // is where a symmetric kernel is furthest from the raw path. If this
    // ever goes green at a small number, the fixture has stopped being
    // adversarial and the test above is passing for free.
    const { samples, markerMs } = clickedThrough();
    const unpinned = smoothCursor(samples, CURSOR_SMOOTHING_MS);
    expect(drift(samples, unpinned, markerMs)).toBeGreaterThan(4);
  });

  it("pins both samples bracketing the marker, not only one landing on it", () => {
    // The marker sits between two samples and equals neither. An
    // implementation matching sample time against marker time by equality
    // pins nothing here — and nothing in production either.
    const { samples, markerMs } = clickedThrough();
    expect(samples.some((s) => s.sourceTimeMs === markerMs)).toBe(false);
    const out = smoothCursor(samples, CURSOR_SMOOTHING_MS, [markerMs]);
    const before = samples.filter((s) => s.sourceTimeMs <= markerMs).at(-1);
    const after = samples.find((s) => s.sourceTimeMs >= markerMs);
    expect(out.find((s) => s.sourceTimeMs === before?.sourceTimeMs)).toEqual(
      before,
    );
    expect(out.find((s) => s.sourceTimeMs === after?.sourceTimeMs)).toEqual(
      after,
    );
  });

  it("smooths everything the pin does not cover", () => {
    // The pin is a scalpel, not an off switch. Shipping
    // `CURSOR_SMOOTHING_MS = 0` would pass every assertion above and delete
    // the feature; this is what separates the two. The marker sits between
    // the samples at 96ms and 104ms, so exactly those two survive untouched
    // and the rest of the jitter still comes out.
    const markerMs = 100;
    const out = smoothCursor(jittery, CURSOR_SMOOTHING_MS, [markerMs]);
    expect(out[12]).toEqual(jittery[12]); // 96ms
    expect(out[13]).toEqual(jittery[13]); // 104ms
    const changed = out.filter(
      (s, i) => s.x !== jittery[i]?.x || s.y !== jittery[i]?.y,
    );
    expect(changed.length).toBeGreaterThan(jittery.length / 2);
  });
});

/**
 * A 12Hz tremor of 1px amplitude riding a slow straight drift, sampled at
 * 8ms — physiological hand tremor sits at 8-12Hz, so this is the signal the
 * filter exists to remove, at the frequency it actually arrives at.
 *
 * The drift is linear and a symmetric kernel passes a straight line through
 * untouched, so `max |y - 400|` over the interior is the residual tremor and
 * nothing else.
 */
const TREMOR_HZ = 12;
const TREMOR_PX = 1;
const TREMOR_BASELINE_Y = 400;
const tremor = Array.from({ length: 120 }, (_, i) => {
  const t = i * STEP_MS;
  return {
    sourceTimeMs: t,
    x: 200 + i * 2,
    y:
      TREMOR_BASELINE_Y +
      TREMOR_PX * Math.sin(2 * Math.PI * TREMOR_HZ * (t / 1000)),
  };
});

const residualTremorPx = (out: { y: number }[]): number => {
  let worst = 0;
  // Interior only: a run's first and last sample are exact by contract, so
  // they carry their raw tremor by design and are not the kernel's to
  // answer for.
  for (let i = 4; i < out.length - 4; i++) {
    const y = out[i]?.y;
    if (y === undefined) continue;
    worst = Math.max(worst, Math.abs(y - TREMOR_BASELINE_Y));
  }
  return worst;
};

describe("smoothCursor's kernel", () => {
  it("takes hand tremor down to a fraction of a pixel", () => {
    // The whole point of the feature. Nobody can see 0.2px of wobble; half a
    // pixel of it at 12Hz is a shimmer, and that is what the 40ms box
    // average left behind (0.590px, measured on this fixture).
    expect(
      residualTremorPx(smoothCursor(tremor, CURSOR_SMOOTHING_MS)),
    ).toBeLessThan(0.2);
  });

  it("is measuring a tremor that is really there to remove", () => {
    // Fixture guard.
    expect(residualTremorPx(tremor)).toBeCloseTo(TREMOR_PX, 1);
  });

  it("passes deliberate movement through untouched", () => {
    // The other end of the trade: a kernel that removed tremor by flattening
    // everything would pass the test above and ruin the take. A straight
    // constant-velocity drag is the signal that must survive exactly, and a
    // symmetric kernel is what makes that true — the same property that
    // makes this filter zero-phase, i.e. no lag behind the real pointer.
    const ramp = Array.from({ length: 60 }, (_, i) => ({
      sourceTimeMs: i * STEP_MS,
      x: 100 + i * 9,
      y: 500 - i * 4,
    }));
    const out = smoothCursor(ramp, CURSOR_SMOOTHING_MS);
    for (const [i, sample] of out.entries()) {
      expect(sample.x).toBeCloseTo(ramp[i]?.x as number, 6);
      expect(sample.y).toBeCloseTo(ramp[i]?.y as number, 6);
    }
  });
});

/**
 * An approach that decelerates into a stop, then a 600ms pause, then the
 * hand leaves again — the ordinary shape of reaching for something, and the
 * shape `holdThroughRests` hands the filter.
 */
const pausedArrival = (): { samples: Sample[]; arrival: Sample } => {
  const samples: Sample[] = [];
  let t = 0;
  let x = 100;
  for (const step of [...Array.from({ length: 16 }, () => 8), 8, 6, 3, 1]) {
    samples.push({ sourceTimeMs: t, x, y: 300 });
    t += STEP_MS;
    x += step;
  }
  const arrival = { sourceTimeMs: t, x, y: 300 };
  samples.push(arrival);
  for (let i = 1; i <= 16; i++) {
    samples.push({ sourceTimeMs: t + 600 + i * STEP_MS, x: x - i * 8, y: 300 });
  }
  return { samples, arrival };
};

describe("smoothCursor across a pause", () => {
  it("draws an arrival into a pause exactly where the hand stopped", () => {
    // The last sample before a pause is where the pointer then sat for
    // 600ms, so it is an observation the kernel has no licence to move —
    // and it is where a click lands.
    const { samples, arrival } = pausedArrival();
    const out = smoothCursor(samples, CURSOR_SMOOTHING_MS);
    const drawn = out.find((s) => s.sourceTimeMs === arrival.sourceTimeMs);
    expect(drawn?.x).toBeCloseTo(arrival.x, 2);
  });

  it("is exact because of the pause, not because the fixture is easy", () => {
    // Fixture guard, and the gate on `runBounds`. The same positions with
    // the pause collapsed to an ordinary 8ms step are one single run, which
    // is how the reach clamped until 2026-09-11: the arrival then has
    // neighbours on its approach side only, and a one-sided average pulls it
    // backward along the path it came in on.
    const { samples, arrival } = pausedArrival();
    const collapsed = samples.map((s, i) => ({
      ...s,
      sourceTimeMs: i * STEP_MS,
    }));
    const out = smoothCursor(collapsed, CURSOR_SMOOTHING_MS);
    const index = samples.findIndex(
      (s) => s.sourceTimeMs === arrival.sourceTimeMs,
    );
    expect(Math.abs((out[index]?.x as number) - arrival.x)).toBeGreaterThan(1);
  });

  it("does not average the approach together with the departure", () => {
    // The two sides of a pause are 600ms and a whole gesture apart. A window
    // that reaches across it blends two unrelated stretches of motion: the
    // box average pulled the first post-pause sample 12px back onto the
    // approach, measured.
    const { samples } = pausedArrival();
    const out = smoothCursor(samples, CURSOR_SMOOTHING_MS);
    const first = samples.findIndex((s) => s.sourceTimeMs > 600);
    expect(out[first]?.x).toBeCloseTo(samples[first]?.x as number, 2);
  });
});

/**
 * A short gesture with a pause on each side of it, shaped the way production
 * shapes it — `holdThroughRests` first, so the run begins with the hold
 * sample carrying the true resting position.
 *
 * This is the ordinary unit of a demo: a hand at rest, one quick reach, back
 * to rest. It is also where the surviving tremor was. The kernel's reach is
 * clamped by the distance to the ends of its run, and a gesture this short
 * is nearly all "end", so raising sigma could not widen a window a boundary
 * was holding shut — measured across sigma 30/60/90 the residual barely
 * moved (0.274 / 0.270 / 0.273 px RMS). That is what sent the fix to the
 * padding rather than to the constant.
 */
const GESTURE_MS = 250;
const shortGestureBetweenRests = (): Sample[] => {
  const samples: Sample[] = [{ sourceTimeMs: 0, x: 200, y: 400 }];
  const steps = Math.round(GESTURE_MS / STEP_MS);
  for (let i = 0; i <= steps; i++) {
    const t = 900 + i * STEP_MS;
    samples.push({
      sourceTimeMs: t,
      x: 200 + i * 4,
      y: 400 + Math.sin(2 * Math.PI * 12 * (t / 1000)),
    });
  }
  samples.push({
    sourceTimeMs: 900 + steps * STEP_MS + 900,
    x: 200 + steps * 4,
    y: 400,
  });
  return holdThroughRests(samples, CURSOR_REST_MS);
};

/**
 * The wiggle left in the drawn path: RMS of the second difference of y.
 *
 * A second difference, rather than distance from a known trend line,
 * because it is immune to a slow offset — the trailing padding legitimately
 * carries the position the hand came to rest at, tremor and all, and a
 * trend-distance metric would score that correct behaviour as error.
 *
 * Measured over the gesture's interior, three samples clear of each end of
 * the run: those ends are returned exactly by contract in every version of
 * this function, so including them would measure the contract rather than
 * the kernel.
 */
const wigglePx = (samples: Sample[]): number => {
  let sum = 0;
  let n = 0;
  for (let i = 5; i < 31; i++) {
    const d =
      (samples[i + 1]?.y ?? 0) -
      2 * (samples[i]?.y ?? 0) +
      (samples[i - 1]?.y ?? 0);
    sum += d * d;
    n++;
  }
  return Math.sqrt(sum / Math.max(1, n));
};

describe("smoothCursor at the edges of a gesture", () => {
  const gesture = shortGestureBetweenRests();

  it("smooths a short reach as hard as it smooths a long one", () => {
    // The pointer's position either side of this gesture is not unknown: it
    // sat still there for 900ms, and that is an observation the kernel can
    // stand on rather than an edge it has to shrink away from. Measured on
    // this fixture: 0.0795 with the reach clamped to the run, 0.0227 with
    // the pause padded in.
    expect(wigglePx(smoothCursor(gesture, CURSOR_SMOOTHING_MS))).toBeLessThan(
      0.04,
    );
  });

  it("is measuring a gesture that is really rough to begin with", () => {
    // Fixture guard.
    expect(wigglePx(gesture)).toBeGreaterThan(0.2);
  });

  it("never drifts far enough from the hand to sit on a different control", () => {
    // The bound on what the padding costs. Rounding the corner at each end
    // of a gesture moves the drawn cursor off the recorded path — measured,
    // 5.4px at the worst point of this fixture against 1.3px with the reach
    // clamped — and a drawn cursor half a button away from the recorded one
    // would disagree with the hover pixels underneath it.
    const out = smoothCursor(gesture, CURSOR_SMOOTHING_MS);
    let worst = 0;
    for (const [i, drawn] of out.entries()) {
      const truth = gesture[i];
      if (!truth) continue;
      worst = Math.max(worst, Math.hypot(drawn.x - truth.x, drawn.y - truth.y));
    }
    expect(worst).toBeLessThan(16);
  });
});
