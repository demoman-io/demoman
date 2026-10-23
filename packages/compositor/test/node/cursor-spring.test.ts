import { describe, expect, it } from "vitest";
import type { CursorSample } from "../../src/bundle";
import {
  CURSOR_SPRING_TAU_MS,
  followWithSpring,
  springLeadMs,
  springSettleMs,
} from "../../src/plan/cursor-spring";
import { CURSOR_REST_MS } from "../../src/plan/smooth";

const STEP_MS = 8;

/** A target that rests, crosses the screen at a steady clip, then rests. */
const target = (): CursorSample[] => {
  const out: CursorSample[] = [];
  for (let t = 0; t <= 300; t += STEP_MS)
    out.push({ sourceTimeMs: t, x: 100, y: 200 });
  for (let t = 308; t <= 1100; t += STEP_MS) {
    out.push({ sourceTimeMs: t, x: 100 + (t - 300) * 0.8, y: 200 });
  }
  const settled = 100 + 800 * 0.8;
  for (let t = 1108; t <= 2000; t += STEP_MS) {
    out.push({ sourceTimeMs: t, x: settled, y: 200 });
  }
  return out;
};

const at = (samples: CursorSample[], ms: number): CursorSample => {
  let best = samples[0] as CursorSample;
  for (const s of samples) if (s.sourceTimeMs <= ms) best = s;
  return best;
};

/** The sharpest change of speed anywhere in a path, in px per ms per ms. */
const sharpestSpeedChange = (samples: CursorSample[]): number => {
  let worst = 0;
  let previousSpeed: number | null = null;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as CursorSample;
    const b = samples[i] as CursorSample;
    const dt = b.sourceTimeMs - a.sourceTimeMs;
    if (dt <= 0) continue;
    const speed = Math.hypot(b.x - a.x, b.y - a.y) / dt;
    if (previousSpeed !== null) {
      worst = Math.max(worst, Math.abs(speed - previousSpeed) / dt);
    }
    previousSpeed = speed;
  }
  return worst;
};

describe("followWithSpring", () => {
  const raw = target();

  it("starts where the target starts", () => {
    const out = followWithSpring(raw, CURSOR_SPRING_TAU_MS, []);
    expect(out[0]).toEqual(raw[0]);
  });

  it("keeps every recorded instant, in order", () => {
    // Not one for one: the spring writes extra samples inside a long hole so
    // its own settle is on the record rather than being read as a straight
    // line across the whole pause. Every original instant survives, and the
    // result stays ascending, which is what the readers downstream need.
    const out = followWithSpring(raw, CURSOR_SPRING_TAU_MS, []);
    const times = out.map((s) => s.sourceTimeMs);
    for (const s of raw) expect(times).toContain(s.sourceTimeMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("writes its settle down finely enough to be drawn", () => {
    // Consumers interpolate straight lines between these samples, so a
    // settle with no samples in it is not a settle. A pause is where this
    // bites: nothing is recorded during one.
    const pausing = [
      { sourceTimeMs: 0, x: 100, y: 200 },
      { sourceTimeMs: 100, x: 500, y: 200 },
      { sourceTimeMs: 2000, x: 500, y: 200 },
    ];
    const out = followWithSpring(pausing, CURSOR_SPRING_TAU_MS, []);
    const inSettle = out.filter(
      (s) => s.sourceTimeMs > 100 && s.sourceTimeMs < 500,
    );
    expect(inSettle.length).toBeGreaterThan(20);
  });

  it("gathers speed instead of leaving at full pace", () => {
    // The floaty start. The target steps straight from a standstill to
    // 0.8px/ms in one 8ms sample; a body with weight cannot, and the drawn
    // cursor spreads that change over about a time constant.
    //
    // Asserted as the sharpest change of speed anywhere in the path, rather
    // than as the speed inside some window, because the lead moves the
    // window: the target is read `2 * tau` ahead, so the drawn cursor starts
    // gathering itself before the recorded hand did.
    //
    // Note what this does NOT assert: that the cursor is behind. It is not.
    // The lead exists precisely so the follower does not sit `2 * V * tau`
    // behind the hand for a whole traverse, which at ordinary speeds is over
    // a tenth of the frame. What survives it is the transient, which is the
    // part worth having.
    const out = followWithSpring(raw, CURSOR_SPRING_TAU_MS, []);
    expect(sharpestSpeedChange(out)).toBeLessThan(
      sharpestSpeedChange(raw) * 0.25,
    );
  });

  it("is measuring a target that itself changes speed instantly", () => {
    // Fixture guard: the target has no acceleration in it at all — it is at
    // a standstill, then at full pace one sample later — so the gathering
    // above belongs to the spring and not to the fixture.
    expect(sharpestSpeedChange(raw)).toBeGreaterThan(0.05);
  });

  it("keeps gliding after the hand has stopped", () => {
    // The floaty stop, and the half a viewer notices most. The target is
    // frozen from 1100ms; the drawn cursor is still closing on it.
    const out = followWithSpring(raw, CURSOR_SPRING_TAU_MS, []);
    const a = at(out, 1120).x;
    const b = at(out, 1180).x;
    expect(b - a).toBeGreaterThan(1);
  });

  it("is measuring a stop the target itself makes instantly", () => {
    // Fixture guard: the target really does stop dead at 1100ms, so the
    // glide above belongs to the spring and not to the fixture.
    expect(at(raw, 1120).x).toBe(at(raw, 1180).x);
  });

  it("arrives, and stays arrived", () => {
    // Critically damped: it closes on the target and does not ring past it.
    const out = followWithSpring(raw, CURSOR_SPRING_TAU_MS, []);
    const destination = at(raw, 2000).x;
    const settled = at(out, 1100 + springSettleMs(CURSOR_SPRING_TAU_MS)).x;
    expect(Math.abs(settled - destination)).toBeLessThan(1);
    for (const sample of out) {
      expect(sample.x).toBeLessThanOrEqual(destination + 0.01);
    }
  });

  it("is exact at a marker taken while the cursor is still gathering", () => {
    // A click has to be drawn on the button it hit. The lead cancels the
    // steady-state lag, so a marker mid-cruise needs almost no correction
    // (3.2px on this fixture) — but a marker inside the acceleration is a
    // different matter, and that is where this is aimed.
    const markerMs = 340;
    const out = followWithSpring(raw, CURSOR_SPRING_TAU_MS, [markerMs]);
    expect(at(out, markerMs).x).toBeCloseTo(at(raw, markerMs).x, 0);
  });

  it("is measuring a marker the transient really would have moved", () => {
    // Fixture guard for the anchor.
    const markerMs = 340;
    const out = followWithSpring(raw, CURSOR_SPRING_TAU_MS, []);
    expect(Math.abs(at(out, markerMs).x - at(raw, markerMs).x)).toBeGreaterThan(
      10,
    );
  });

  it("is a no-op at a zero time constant", () => {
    expect(followWithSpring(raw, 0, [])).toEqual(raw);
  });
});

/**
 * The spring written the obvious way, kept as the oracle for the one thing
 * the shipped version does differently: it reads its target with a fresh
 * scan from the start of the array for every instant. That scan is what made
 * `followWithSpring` quadratic in the take's length, and the walking index
 * that replaced it is only correct because the instants it reads at never go
 * backwards. Same steps, same targets, same arithmetic — only the search for
 * the bracketing pair changed — so the two have to agree exactly.
 */
function positionAtReference(
  samples: CursorSample[],
  ms: number,
): { x: number; y: number } {
  const first = samples[0] as CursorSample;
  if (ms <= first.sourceTimeMs) return { x: first.x, y: first.y };
  for (let i = 1; i < samples.length; i++) {
    const to = samples[i] as CursorSample;
    if (to.sourceTimeMs < ms) continue;
    const from = samples[i - 1] as CursorSample;
    const span = to.sourceTimeMs - from.sourceTimeMs;
    const u = span === 0 ? 0 : (ms - from.sourceTimeMs) / span;
    return { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u };
  }
  const last = samples[samples.length - 1] as CursorSample;
  return { x: last.x, y: last.y };
}

function followWithSpringReference(
  samples: CursorSample[],
  tauMs: number,
  anchorMs: readonly number[],
): CursorSample[] {
  const omega = 1 / tauMs;
  const settleMs = springSettleMs(tauMs);
  const lead = springLeadMs(tauMs);
  const GRID_MS = 8;

  const first = samples[0] as CursorSample;
  const out: CursorSample[] = [{ ...first }];
  let x = first.x;
  let y = first.y;
  let vx = 0;
  let vy = 0;
  const advance = (
    dt: number,
    targetX: number,
    targetY: number,
    atMs: number,
  ): void => {
    if (dt <= 0) {
      out.push({ sourceTimeMs: atMs, x, y });
      return;
    }
    const decay = Math.exp(-omega * dt);
    const ex = x - targetX;
    const ey = y - targetY;
    const bx = vx + omega * ex;
    const by = vy + omega * ey;
    const nx = (ex + bx * dt) * decay;
    const ny = (ey + by * dt) * decay;
    vx = (bx - omega * (ex + bx * dt)) * decay;
    vy = (by - omega * (ey + by * dt)) * decay;
    x = targetX + nx;
    y = targetY + ny;
    out.push({ sourceTimeMs: atMs, x, y });
  };

  const times: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const from = samples[i - 1] as CursorSample;
    const to = samples[i] as CursorSample;
    if (to.sourceTimeMs - from.sourceTimeMs > CURSOR_REST_MS) {
      const headUntil = Math.min(to.sourceTimeMs, from.sourceTimeMs + settleMs);
      const tailFrom = Math.max(
        from.sourceTimeMs,
        to.sourceTimeMs - lead - settleMs,
      );
      for (
        let ms = from.sourceTimeMs + GRID_MS;
        ms < to.sourceTimeMs;
        ms += GRID_MS
      ) {
        if (ms < headUntil || ms >= tailFrom) times.push(ms);
      }
    }
    times.push(to.sourceTimeMs);
  }

  let previous = first.sourceTimeMs;
  for (const ms of times) {
    const target = positionAtReference(samples, (previous + ms) / 2 + lead);
    advance(ms - previous, target.x, target.y, ms);
    previous = ms;
  }
  const last = samples[samples.length - 1] as CursorSample;
  for (
    let ms = previous + GRID_MS;
    ms <= last.sourceTimeMs + settleMs;
    ms += GRID_MS
  ) {
    advance(ms - previous, last.x, last.y, ms);
    previous = ms;
  }

  const anchors = [...new Set(anchorMs)].sort((a, b) => a - b);
  const anchored = out.map((sample) => ({ ...sample }));
  for (const [index, ms] of anchors.entries()) {
    const before = anchors[index - 1];
    const next = anchors[index + 1];
    const room = Math.min(
      before === undefined ? Number.POSITIVE_INFINITY : (ms - before) / 2,
      next === undefined ? Number.POSITIVE_INFINITY : (next - ms) / 2,
    );
    const shoulder = Math.min(settleMs, room);
    if (!Number.isFinite(shoulder) || shoulder <= 0) continue;
    const truth = positionAtReference(samples, ms);
    const here = positionAtReference(anchored, ms);
    const dx = truth.x - here.x;
    const dy = truth.y - here.y;
    if (dx === 0 && dy === 0) continue;
    for (const sample of anchored) {
      const away = Math.abs(sample.sourceTimeMs - ms);
      if (away > shoulder) continue;
      const weight = 0.5 * (1 + Math.cos((Math.PI * away) / shoulder));
      sample.x += dx * weight;
      sample.y += dy * weight;
    }
  }
  return anchored;
}

/** A long run of continuous motion at 120Hz, for the cost assertions. */
const sweep = (seconds: number): CursorSample[] => {
  const out: CursorSample[] = [];
  for (let t = 0; t <= seconds * 1000; t += 8) {
    out.push({ sourceTimeMs: t, x: 500 + (t % 977), y: 400 + (t % 613) });
  }
  return out;
};

describe("what followWithSpring writes down", () => {
  /** A dense run at a frame's cadence, the shape a real take has. */
  const dense = (): CursorSample[] => {
    const out: CursorSample[] = [];
    for (let i = 0; i <= 120; i++) {
      const t = i * 16.7;
      out.push({ sourceTimeMs: t, x: 100 + t, y: 300 });
    }
    return out;
  };

  it("subdivides a hole and leaves an ordinary interval alone", () => {
    // The grid exists to write the spring's own curve into a stretch that
    // has no samples to carry it. Two samples one frame apart have nothing
    // between them to record, and the analytic step is exact over an
    // interval of any length, so subdividing one adds points that say
    // nothing. It did anyway until 2026-09-12: the tail window spans the
    // whole of any interval shorter than `lead + settle`, which is every
    // ordinary one, and 8640 recorded samples came back as 24095.
    const run = dense();
    const out = followWithSpring(run, CURSOR_SPRING_TAU_MS, []);
    const inside = out.filter(
      (s) =>
        s.sourceTimeMs > (run[0] as CursorSample).sourceTimeMs &&
        s.sourceTimeMs < (run[run.length - 1] as CursorSample).sourceTimeMs &&
        !run.some((r) => r.sourceTimeMs === s.sourceTimeMs),
    );
    expect(inside).toHaveLength(0);
  });

  it("reads the samples a bounded number of times per instant it emits", () => {
    // The target was read with a fresh scan from index 1 for every instant
    // emitted, which is quadratic in the take's length and is paid on every
    // edit the editor resolves: measured at 6.4ms / 25.5ms / 172ms for 30s /
    // 60s / 180s of continuous motion.
    //
    // Counted rather than timed. A wall-clock budget on a shared runner is a
    // flake, and a ratio of two timings is worse — measured here, the
    // quadratic version's ratio swung from 63 down to under the bound
    // depending on when the JIT warmed, so a timing test passed with the
    // defect in place. How many times the array is indexed is the same
    // number on every machine.
    const reads = (samples: CursorSample[]): number => {
      let count = 0;
      const watched = new Proxy(samples, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) count += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      followWithSpring(watched, CURSOR_SPRING_TAU_MS, []);
      return count;
    };
    const long = sweep(120);
    expect(long.length).toBeGreaterThan(10_000);
    // Per sample, not in total: the walk reads a handful (the step's own
    // bracketing pair, plus the index it advances over), while a rescan
    // reads half the array — 7500 apiece on this take.
    expect(reads(long) / long.length).toBeLessThan(20);
  });

  it("arrives at the take's last recorded position", () => {
    // The samples run out before the spring does. Stepping only as far as
    // the last recorded instant froze whatever error the follower still
    // carried into the final drawn position, and `sampleCursor` clamps to
    // that for the rest of the video: measured on this reach, the take ended
    // at (696,398) and the drawn cursor stopped 31.6px short and stayed.
    const reach: CursorSample[] = [];
    for (let t = 0; t <= 500; t += 16) {
      const u = t / 500;
      reach.push({ sourceTimeMs: t, x: 200 + 500 * u, y: 150 + 250 * u });
    }
    const last = reach[reach.length - 1] as CursorSample;
    const out = followWithSpring(reach, CURSOR_SPRING_TAU_MS, []);
    const end = out[out.length - 1] as CursorSample;
    expect(Math.hypot(end.x - last.x, end.y - last.y)).toBeLessThan(1);
    // And it gets there by gliding on past the last sample, not by jumping
    // to it: the arrival is the effect, so it has to be on the record at a
    // finer interval than the deliverable's frames.
    expect(end.sourceTimeMs).toBeGreaterThan(last.sourceTimeMs);
    const during = out.filter(
      (s) =>
        s.sourceTimeMs > last.sourceTimeMs &&
        s.sourceTimeMs <
          last.sourceTimeMs + springSettleMs(CURSOR_SPRING_TAU_MS),
    );
    expect(during.length).toBeGreaterThan(20);
  });

  it("is measuring a reach the follower really is still short of", () => {
    // Fixture guard: the spring has to be genuinely behind at the last
    // sample, or arriving there would prove nothing.
    const reach: CursorSample[] = [];
    for (let t = 0; t <= 500; t += 16) {
      const u = t / 500;
      reach.push({ sourceTimeMs: t, x: 200 + 500 * u, y: 150 + 250 * u });
    }
    const last = reach[reach.length - 1] as CursorSample;
    const out = followWithSpring(reach, CURSOR_SPRING_TAU_MS, []);
    const atLastInstant = out.filter(
      (s) => s.sourceTimeMs <= last.sourceTimeMs,
    );
    const drawn = atLastInstant[atLastInstant.length - 1] as CursorSample;
    expect(Math.hypot(drawn.x - last.x, drawn.y - last.y)).toBeGreaterThan(10);
  });

  it("reads its target exactly where an unbounded scan would", () => {
    // The walking index is an optimisation, so its answer has to be the same
    // two samples read the same way — not merely close. This is the oracle:
    // the whole drawn path against the same path with the scan restarted
    // from the beginning for every instant.
    const run = dense();
    const out = followWithSpring(run, CURSOR_SPRING_TAU_MS, [700]);
    const slow = followWithSpringReference(run, CURSOR_SPRING_TAU_MS, [700]);
    expect(out).toEqual(slow);
  });
});
