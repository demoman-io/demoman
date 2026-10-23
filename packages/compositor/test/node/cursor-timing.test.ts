import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import type { CursorSample } from "../../src/bundle";
import {
  GESTURE_RAMP_MAX_MS,
  retimeAlongRoute,
} from "../../src/plan/cursor-timing";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { CURSOR_REST_MS } from "../../src/plan/smooth";
import { toOutputMs } from "../../src/plan/timeline";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

const STEP_MS = 8;

/**
 * A reach with a hesitation in the middle of it: the hand sets off, stalls
 * for ~100ms partway (thinking, or correcting its aim), then completes the
 * reach. Short of `CURSOR_REST_MS` it is not a pause and no hold is
 * inserted — it is just the hand moving unevenly, which is what every real
 * hand does and what a viewer reads as unsteady.
 */
const hesitatingReach = (): CursorSample[] => {
  const samples: CursorSample[] = [];
  let t = 0;
  let x = 100;
  const push = () => samples.push({ sourceTimeMs: t, x, y: 300 });
  push();
  for (let i = 0; i < 20; i++) {
    t += STEP_MS;
    x += 9;
    push();
  }
  // The stall: five frames barely moving.
  for (let i = 0; i < 5; i++) {
    t += STEP_MS;
    x += 0.2;
    push();
  }
  for (let i = 0; i < 20; i++) {
    t += STEP_MS;
    x += 9;
    push();
  }
  return samples;
};

/** Distance from a point to the recorded polyline. */
const offRoutePx = (point: CursorSample, route: CursorSample[]): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1] as CursorSample;
    const b = route[i] as CursorSample;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t =
      len === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len),
          );
    best = Math.min(
      best,
      Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)),
    );
  }
  return best;
};

const steps = (samples: CursorSample[]): number[] => {
  const out: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as CursorSample;
    const b = samples[i] as CursorSample;
    out.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  return out;
};

describe("retimeAlongRoute", () => {
  const raw = hesitatingReach();

  it("draws only positions the hand actually visited", () => {
    // The route is not re-invented: every drawn point lies on the recorded
    // polyline. This is the whole difference between re-timing and
    // synthesizing a path.
    const out = retimeAlongRoute(raw, [], CURSOR_REST_MS);
    for (const point of out) expect(offRoutePx(point, raw)).toBeLessThan(0.01);
  });

  it("starts and ends the gesture exactly where the hand did, and when", () => {
    const out = retimeAlongRoute(raw, [], CURSOR_REST_MS);
    expect(out[0]).toEqual(raw[0]);
    expect(out[out.length - 1]).toEqual(raw[raw.length - 1]);
    expect(out.map((s) => s.sourceTimeMs)).toEqual(
      raw.map((s) => s.sourceTimeMs),
    );
  });

  it("never travels backwards along the route", () => {
    const out = retimeAlongRoute(raw, [], CURSOR_REST_MS);
    for (let i = 1; i < out.length; i++) {
      expect((out[i]?.x as number) + 1e-9).toBeGreaterThanOrEqual(
        out[i - 1]?.x as number,
      );
    }
  });

  it("carries the cursor through the hand's hesitation", () => {
    // The point of the feature. Mid-reach the hand nearly stopped; the drawn
    // cursor should not, because a viewer reads that stall as the recording
    // stuttering rather than as a person thinking.
    // The stall is steps 20-24, mid-gesture, where the drawn cursor is at
    // its cruise; the ends are ramping on purpose and are not the question.
    const out = retimeAlongRoute(raw, [], CURSOR_REST_MS);
    const drawn = steps(out);
    const mean = drawn.reduce((a, b) => a + b, 0) / drawn.length;
    expect(Math.min(...drawn.slice(20, 25))).toBeGreaterThan(mean);
  });

  it("is measuring a hesitation that is really in the recording", () => {
    // Fixture guard: those same steps are the stall in the recording.
    const recorded = steps(raw);
    const mean = recorded.reduce((a, b) => a + b, 0) / recorded.length;
    expect(Math.max(...recorded.slice(20, 25))).toBeLessThan(mean * 0.1);
  });

  it("gathers itself from rest and settles into rest", () => {
    // The author's ask of 2026-10-09: a ramp-up and a settle on every move.
    // The hand's recorded first and last steps here are full-speed ones
    // (the fixture's 9px), so a stage that kept an even pace would draw them
    // at the mean; the ramp draws them at a crawl.
    expect(steps(raw)[0]).toBe(9);
    expect(steps(raw).at(-1)).toBe(9);
    const drawn = steps(retimeAlongRoute(raw, [], CURSOR_REST_MS));
    const mean = drawn.reduce((a, b) => a + b, 0) / drawn.length;
    expect(drawn[0]).toBeLessThan(mean * 0.1);
    expect(drawn.at(-1)).toBeLessThan(mean * 0.1);
  });

  /** One steady reach of `ms`, 8ms a sample, 2px a sample. */
  const steadyReach = (ms: number): CursorSample[] =>
    Array.from({ length: ms / STEP_MS + 1 }, (_, i) => ({
      sourceTimeMs: i * STEP_MS,
      x: 100 + i * 2,
      y: 300,
    }));

  it("ramps for a fixed time on a long reach, not a share of it", () => {
    // Easing over the WHOLE run — what this stage did before the spring
    // landed — is slow for hundreds of milliseconds at each end of a long
    // reach and quick in the middle, which reads as pumping. A body with
    // weight gathers itself in about the same time whether it is going far
    // or near, so past `GESTURE_RAMP_MAX_MS` a three-second reach cruises.
    const raw3s = steadyReach(3000);
    const drawn = steps(retimeAlongRoute(raw3s, [], CURSOR_REST_MS));
    const mean = drawn.reduce((a, b) => a + b, 0) / drawn.length;
    const cruise = drawn.slice(
      Math.ceil(GESTURE_RAMP_MAX_MS / STEP_MS),
      -Math.ceil(GESTURE_RAMP_MAX_MS / STEP_MS),
    );
    // Premise: there is a long cruise to measure.
    expect(cruise.length).toBeGreaterThan(250);
    for (const step of cruise) {
      // Even, and faster than the mean by exactly what the two ramps lost:
      // 3000 / (3000 - 350).
      expect(step / mean).toBeCloseTo(3000 / (3000 - GESTURE_RAMP_MAX_MS), 2);
    }
    // ...and the first tenth of a second is still a crawl.
    expect(drawn.slice(0, 12).every((s) => s < mean * 0.5)).toBe(true);
  });

  it("still ramps at both ends of a gesture with a marker inside it", () => {
    // A marker splits the run into two intervals; the ramp belongs to the
    // run's own ends, so it has to land on the first interval's start and
    // the last one's end rather than vanish because neither interval is the
    // whole run.
    const raw1s = steadyReach(1000);
    const markerMs = 504;
    expect(markerMs).toBeGreaterThan(raw1s[0]?.sourceTimeMs as number);
    expect(markerMs).toBeLessThan(raw1s.at(-1)?.sourceTimeMs as number);
    const drawn = steps(retimeAlongRoute(raw1s, [markerMs], CURSOR_REST_MS));
    const mean = drawn.reduce((a, b) => a + b, 0) / drawn.length;
    expect(drawn[0]).toBeLessThan(mean * 0.1);
    expect(drawn.at(-1)).toBeLessThan(mean * 0.1);
    // And no step anywhere is more than the one-ramp cruise's 1.25x over
    // the two-ramp one, so the seam at the marker is a nudge, not a lurch.
    expect(Math.max(...drawn) / mean).toBeLessThan(1.6);
  });

  it("keeps a short gesture's ramps inside it", () => {
    // 200ms: each ramp is 40% of it, so the two never meet and the cursor
    // still crosses its middle at an even pace.
    const drawn = steps(retimeAlongRoute(steadyReach(200), [], CURSOR_REST_MS));
    const mean = drawn.reduce((a, b) => a + b, 0) / drawn.length;
    const middle = drawn.slice(10, 15);
    expect(middle.length).toBe(5);
    for (const step of middle) expect(step / mean).toBeCloseTo(1 / 0.6, 1);
  });

  it("puts the cursor where the hand was at a marker the hand did not stop on", () => {
    // A click taken mid-reach has to be drawn on the button it hit, and
    // re-timing is exactly the thing that would otherwise move it: the drawn
    // cursor is somewhere else along the route at that instant.
    const markerMs = 25 * STEP_MS + 3;
    const out = retimeAlongRoute(raw, [markerMs], CURSOR_REST_MS);
    const atMarker = (s: CursorSample[]): number => {
      for (let i = 1; i < s.length; i++) {
        const b = s[i] as CursorSample;
        const a = s[i - 1] as CursorSample;
        if (b.sourceTimeMs < markerMs) continue;
        const span = b.sourceTimeMs - a.sourceTimeMs;
        const u = span === 0 ? 0 : (markerMs - a.sourceTimeMs) / span;
        return a.x + (b.x - a.x) * u;
      }
      return (s[s.length - 1] as CursorSample).x;
    };
    // Not exact to the last bit, and it cannot be: the anchor is honoured at
    // the sample times either side of the marker, while `sampleCursor` reads
    // a straight line between them and the progress curve through them is a
    // cubic. Over one 8ms sample interval that gap measures 0.06px, which is
    // three orders of magnitude inside "on the right button".
    expect(Math.abs(atMarker(out) - atMarker(raw))).toBeLessThan(0.25);
  });

  it("is measuring a marker re-timing really would have moved", () => {
    // Fixture guard: without the anchor the drawn cursor is far from the
    // recorded position at that instant, because the hand was mid-stall and
    // the eased profile was not.
    const markerMs = 25 * STEP_MS + 3;
    const out = retimeAlongRoute(raw, [], CURSOR_REST_MS);
    const at = (s: CursorSample[]): number => {
      for (let i = 1; i < s.length; i++) {
        const b = s[i] as CursorSample;
        const a = s[i - 1] as CursorSample;
        if (b.sourceTimeMs < markerMs) continue;
        const span = b.sourceTimeMs - a.sourceTimeMs;
        const u = span === 0 ? 0 : (markerMs - a.sourceTimeMs) / span;
        return a.x + (b.x - a.x) * u;
      }
      return (s[s.length - 1] as CursorSample).x;
    };
    expect(Math.abs(at(out) - at(raw))).toBeGreaterThan(10);
  });

  it("leaves a run with no travel alone", () => {
    const still = [
      { sourceTimeMs: 0, x: 50, y: 50 },
      { sourceTimeMs: 8, x: 50, y: 50 },
      { sourceTimeMs: 16, x: 50, y: 50 },
    ];
    expect(retimeAlongRoute(still, [], CURSOR_REST_MS)).toEqual(still);
  });

  it("re-times each gesture separately, never across a pause", () => {
    const twoReaches: CursorSample[] = [
      ...hesitatingReach(),
      ...hesitatingReach().map((s) => ({
        sourceTimeMs: s.sourceTimeMs + 2000,
        x: s.x + 500,
        y: 600,
      })),
    ];
    const out = retimeAlongRoute(twoReaches, [], CURSOR_REST_MS);
    // The pause's own two bracketing samples are each a gesture's end, so
    // both survive exactly; a re-timing that ran across the pause would
    // slide them along a route that joins two unrelated reaches.
    const boundary = hesitatingReach().length;
    expect(out[boundary - 1]).toEqual(twoReaches[boundary - 1]);
    expect(out[boundary]).toEqual(twoReaches[boundary]);
  });
});

describe("resolvePlan with a re-timed cursor", () => {
  const START_MS = 900;
  const END_MS = 1900;

  /** A capture take whose hand makes one steady one-second reach. */
  const reaching = () => {
    const samples = [{ sourceTimeMs: 0, x: 100, y: 300 }];
    for (let i = 0; i <= 125; i++) {
      samples.push({
        sourceTimeMs: START_MS + i * 8,
        x: 100 + i * 6,
        y: 300 + i * 2,
      });
    }
    samples.push({ sourceTimeMs: 3000, x: 850, y: 550 });
    return proceduralBundle({ source: "capture", cursorSamples: samples });
  };

  /**
   * The author has cut the gap after the first action down to 300ms. Without
   * that the surrounding stretch is a *recorded* pace, which reproduces the
   * take's own timing and compresses nothing — so a version of this test
   * without an authored gap asserted that an uncompressed timeline had not
   * compressed anything, which is no assertion at all. Its own fixture guard
   * is what caught that.
   */
  const impatient = (): SceneDocument => {
    const base = readonlyScene();
    return {
      ...base,
      edits: {
        ...base.edits,
        gaps: [{ id: "gap-1", afterActionId: "act-1", durationMs: 300 }],
      },
    };
  };

  it("plays the whole gesture at real speed, its eased ends included", () => {
    // An eased gesture moves a fraction of a pixel per frame at each end,
    // which `cursorMotionSpans` reads as a hold — so the travel hints are
    // taken from the path as recorded rather than as re-timed. Without that
    // the retimer squeezes the ease at both ends of every gesture, which
    // puts a speed change exactly where the motion is meant to be smoothest.
    const scene = impatient();
    const resolved = resolvePlan(planScene(scene), reaching(), scene);
    const played =
      toOutputMs(resolved.timeline, END_MS) -
      toOutputMs(resolved.timeline, START_MS);
    expect(played).toBeCloseTo(END_MS - START_MS, 0);
  });

  it("is measuring a timeline that really is compressing around it", () => {
    // Fixture guard: the dead air on either side of the gesture is being cut
    // hard, so the assertion above is a claim about protection rather than
    // about a timeline that happens to be uniform.
    const scene = impatient();
    const resolved = resolvePlan(planScene(scene), reaching(), scene);
    const before =
      toOutputMs(resolved.timeline, START_MS) -
      toOutputMs(resolved.timeline, 400);
    expect(before).toBeLessThan(300);
  });
});
