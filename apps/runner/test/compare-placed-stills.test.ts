// apps/runner/test/compare-placed-stills.test.ts
import { planScene, resolvePlan } from "@demoman/compositor";
import { placedIdleSpans } from "@demoman/run-core";
import { describe, expect, it } from "vitest";
import {
  pacedBundle,
  SLOW,
  twoStepScene,
} from "../../../packages/compositor/test/fixtures/beats";
import { STILL_CHANGE_MAX, stills } from "../src/compare/numbers.js";

// The gate's long-still count follows the film check's rule: a still wholly
// inside idle the beat plan placed (`placedIdleSpans`, read off the
// timeline's own idle segments) is the plan's pause; any other still counts,
// motion-classified time included. `film-compare` passes these spans to
// `measure`; it has no test lane of its own, so the rule is covered here, on
// spans from the real timeline.

const FPS_MS = 1000 / 60;

/** A film of `ms` at 60 fps whose picture holds still over each of `holds`
 *  and changes on every other frame. */
function film(ms: number, holds: [number, number][]) {
  const n = Math.ceil(ms / FPS_MS);
  const timesMs = Array.from({ length: n }, (_, i) => i * FPS_MS);
  const changes = timesMs.map((t, i) =>
    i > 0 && holds.some(([a, b]) => t >= a && t <= b)
      ? 0
      : 3 * STILL_CHANGE_MAX,
  );
  return { timesMs, changes };
}

const beats = (restMs: number, tailMs: number) => ({
  beats: [
    { beforeActionId: "s1", restMs, arriveMs: 200 },
    { beforeActionId: "s2", restMs: 900, arriveMs: 300 },
  ],
  tailMs,
});

describe("stills on a take with a beat plan", () => {
  it("counts a still inside motion-classified time between two placed steps", () => {
    // Red if `insidePlacedIdle` says yes to a stretch that is not wholly
    // inside a placed span (the first review's step-to-step spans did):
    // this still would then go uncounted.
    const scene = twoStepScene(beats(500, 1000));
    const bundle = pacedBundle(SLOW).bundle;
    const spans = placedIdleSpans(scene, bundle);
    const timeline = resolvePlan(planScene(scene), bundle, scene).timeline;
    // The first step's act: motion in the timeline's own segments, output
    // 1400..1900, between s1 and s2 (3800).
    const motion = timeline.segments.find(
      (s) => s.kind === "motion" && s.outStartMs === 1400,
    );
    expect(motion?.outEndMs).toBe(1900);
    // Premise: the held picture lies in that motion segment and in no span,
    // and is long enough to count (250 ms is this gate's line).
    const hold: [number, number] = [1450, 1850];
    expect(hold[1] - hold[0]).toBeGreaterThan(250);
    expect(spans.some(([a, b]) => hold[0] >= a && hold[1] <= b)).toBe(false);
    const { timesMs, changes } = film(timeline.outputDurationMs, [hold]);
    const bare = stills(timesMs, changes, timeline.outputDurationMs);
    expect(bare.longStills).toBe(1);
    expect(
      stills(timesMs, changes, timeline.outputDurationMs, spans).longStills,
    ).toBe(1);
  });

  it("counts a still that starts in placed idle and runs on into motion", () => {
    // Red if `insidePlacedIdle` accepts an overlap instead of a stretch
    // wholly inside a span.
    const scene = twoStepScene(beats(500, 1000));
    const bundle = pacedBundle(SLOW).bundle;
    const spans = placedIdleSpans(scene, bundle);
    const { outputDurationMs } = resolvePlan(
      planScene(scene),
      bundle,
      scene,
    ).timeline;
    // Premise: the rest after s1 is placed idle ending at 2800, and the
    // journey after it is motion; the held picture crosses that edge.
    expect(spans).toContainEqual([1900, 2800]);
    const hold: [number, number] = [2500, 3100];
    const { timesMs, changes } = film(outputDurationMs, [hold]);
    expect(stills(timesMs, changes, outputDurationMs).longStills).toBe(1);
    expect(stills(timesMs, changes, outputDurationMs, spans).longStills).toBe(
      1,
    );
  });

  it("does not count a long planned opening rest or a long planned tail", () => {
    // Red if `placedIdleSpans` leaves the opening or the tail out: both
    // stills would be counted.
    const scene = twoStepScene(beats(2000, 2500));
    const bundle = pacedBundle(SLOW).bundle;
    const spans = placedIdleSpans(scene, bundle);
    const { outputDurationMs } = resolvePlan(
      planScene(scene),
      bundle,
      scene,
    ).timeline;
    // Premise: the picture holds over the whole opening rest and the whole
    // tail, each well past the line, and the spans start at 0 and end at the
    // video's end.
    const holds: [number, number][] = [
      [0, 2000],
      [outputDurationMs - 2500, outputDurationMs],
    ];
    expect(spans[0]?.[0]).toBe(0);
    expect(spans.at(-1)?.[1]).toBe(outputDurationMs);
    const { timesMs, changes } = film(outputDurationMs, holds);
    expect(stills(timesMs, changes, outputDurationMs).longStills).toBe(2);
    expect(stills(timesMs, changes, outputDurationMs, spans).longStills).toBe(
      0,
    );
  });
});
