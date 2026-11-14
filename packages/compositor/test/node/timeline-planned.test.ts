import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import { planScene } from "../../src/plan/plan";
import {
  buildTimeline,
  motionSpansOf,
  type Timeline,
  type TimeSpan,
  toOutputMs,
  toSourceMs,
} from "../../src/plan/timeline";
import type { RenderPlan } from "../../src/plan/types";
import {
  ACT_MS,
  type Idle,
  JOURNEY_MS,
  noPacingCases,
  pacedBundle,
  SLOW,
  twoStepScene,
} from "../fixtures/beats";

/** Plans and timelines as the code drew them at 35f94523, before planned
 *  pacing existed, for `noPacingCases()` in order. */
const beforePlannedPacing = JSON.parse(
  readFileSync(
    new URL("../fixtures/timeline-no-pacing.json", import.meta.url),
    "utf8",
  ),
) as {
  name: string;
  plan: Omit<RenderPlan, "compositorVersion">;
  timeline: Timeline & { interruptions: TimeSpan[] };
}[];

// Spec 2026-11-13 "same take, any machine", Part 3: a take that carries a
// beat plan plays every stretch of idle for its planned length, whatever the
// bundle measured, and its motion at rate 1.0.

const PACING = {
  beats: [
    { beforeActionId: "s1", restMs: 500, arriveMs: 200 },
    { beforeActionId: "s2", restMs: 900, arriveMs: 300 },
  ],
  tailMs: 1000,
};
const plan = planScene(twoStepScene(PACING));

const FAST: Idle = {
  openRest: 100,
  openArrive: 150,
  rest: 400,
  arrive: 300,
  tail: 200,
};

function markerAt(bundle: FrameBundle, actionId: string): number {
  const marker = bundle.markers.find((m) => m.actionId === actionId);
  if (!marker) throw new Error(`no marker for ${actionId}`);
  return marker.sourceTimeMs;
}

/** Motion source-ms inside [from, to], as the timeline classifies it. */
function motionIn(bundle: FrameBundle, from: number, to: number): number {
  return motionSpansOf(bundle).reduce(
    (sum, s) =>
      sum + Math.max(0, Math.min(s.endMs, to) - Math.max(s.startMs, from)),
    0,
  );
}

/** Idle the bundle recorded between two source instants. */
function idleSrc(bundle: FrameBundle, from: number, to: number): number {
  return to - from - motionIn(bundle, from, to);
}

/** Idle the video plays between two source instants: their output distance
 *  less the motion between them, which plays at rate 1.0. */
function idleOut(
  t: Timeline,
  bundle: FrameBundle,
  from: number,
  to: number,
): number {
  return toOutputMs(t, to) - toOutputMs(t, from) - motionIn(bundle, from, to);
}

function idleOutBetween(
  t: Timeline,
  bundle: FrameBundle,
  a: string,
  b: string,
): number {
  return idleOut(t, bundle, markerAt(bundle, a), markerAt(bundle, b));
}

function idleSrcBetween(bundle: FrameBundle, a: string, b: string): number {
  return idleSrc(bundle, markerAt(bundle, a), markerAt(bundle, b));
}

/** The backbone properties every timeline keeps. */
function expectWellFormed(t: Timeline): void {
  let out = 0;
  for (const s of t.segments) {
    expect(s.outStartMs).toBeCloseTo(out, 6);
    expect(s.outEndMs).toBeGreaterThanOrEqual(s.outStartMs);
    if (s.kind === "motion") {
      expect(s.outEndMs - s.outStartMs).toBeCloseTo(
        s.srcEndMs - s.srcStartMs,
        6,
      );
    }
    out = s.outEndMs;
  }
  expect(t.outputDurationMs).toBeCloseTo(out, 6);
  let lastSrc = -1;
  for (let ms = 0; ms <= t.outputDurationMs; ms += 25) {
    const src = toSourceMs(t, ms);
    expect(src).toBeGreaterThanOrEqual(lastSrc);
    lastSrc = src;
  }
  let lastOut = -1;
  for (let ms = 0; ms <= t.sourceDurationMs; ms += 25) {
    const o = toOutputMs(t, ms);
    expect(o).toBeGreaterThanOrEqual(lastOut);
    lastOut = o;
  }
}

describe("planned idle", () => {
  it("plays a pair's idle for its planned rest and arrive, on a fast and a slow recording alike", () => {
    // Red if `share(after, approach, pace.restMs)` in `plannedIdleOf` goes.
    const fast = pacedBundle(FAST).bundle;
    const slow = pacedBundle(SLOW).bundle;
    const a = buildTimeline(plan, fast);
    const b = buildTimeline(plan, slow);

    // Premise: the slow bundle really holds more idle, and the same motion.
    expect(idleSrcBetween(slow, "s1", "s2")).toBeGreaterThan(6000);
    expect(idleSrcBetween(fast, "s1", "s2")).toBe(700);
    expect(motionIn(fast, 0, Number.POSITIVE_INFINITY)).toBe(
      motionIn(slow, 0, Number.POSITIVE_INFINITY),
    );
    expect(plan.paces?.map((p) => p.origin)).toEqual(["planned", "planned"]);

    expect(idleOutBetween(a, fast, "s1", "s2")).toBeCloseTo(900 + 300, 6);
    expect(idleOutBetween(b, slow, "s1", "s2")).toBeCloseTo(900 + 300, 6);
    // Rest and arrive each where they belong, not one total spread over both.
    const fastAt = pacedBundle(FAST).at;
    expect(idleOut(a, fast, fastAt.s1, fastAt.approach2)).toBeCloseTo(900, 6);
    expect(idleOut(a, fast, fastAt.approach2, fastAt.s2)).toBeCloseTo(300, 6);
    expect(a.outputDurationMs).toBeCloseTo(b.outputDurationMs, 6);
    expect(a.unplacedPaces).toBe(0);
    expect(b.unplacedPaces).toBe(0);
    expectWellFormed(a);
    expectWellFormed(b);
  });

  it("freezes on the step for a planned stretch with no idle in it", () => {
    // Red if `share`'s `freezes.push` in `plannedIdleOf` goes.
    // The journey runs right up to s2: the arrive stretch holds no idle.
    const { bundle, at } = pacedBundle({ ...FAST, arrive: 0 });
    expect(idleSrc(bundle, at.approach2, at.s2)).toBe(0);
    const t = buildTimeline(plan, bundle);

    expect(idleOutBetween(t, bundle, "s1", "s2")).toBeCloseTo(900 + 300, 6);
    const freezes = t.segments.filter((s) => s.kind === "pace");
    expect(freezes).toHaveLength(1);
    expect(freezes[0]?.srcStartMs).toBe(at.s2);
    expect(freezes[0]?.srcEndMs).toBe(at.s2);
    expect((freezes[0]?.outEndMs ?? 0) - (freezes[0]?.outStartMs ?? 0)).toBe(
      300,
    );
    // The step happens when the wait ends.
    expect(toOutputMs(t, at.s2)).toBe(freezes[0]?.outEndMs);
    expectWellFormed(t);
  });

  it("gives an interruption inside the pair no share of the planned rest", () => {
    // Red if `idleIn` passes `[]` for `removed` to `idleMsIn`.
    const { s1 } = pacedBundle(SLOW).at;
    const { bundle, at } = pacedBundle(SLOW, {
      degradations: [
        {
          startMs: s1 + ACT_MS + 1000,
          endMs: s1 + ACT_MS + 4000,
          kind: "occlusionPause",
          note: "the replay window was covered for 3 s",
        },
      ],
    });
    const t = buildTimeline(plan, bundle);
    // Premise: the pause sits inside the rest stretch and is removed.
    expect(t.interruptions).toEqual([
      { startMs: at.s1 + ACT_MS + 1000, endMs: at.s1 + ACT_MS + 4000 },
    ]);
    expect(at.approach2).toBeGreaterThan(at.s1 + ACT_MS + 4000);

    expect(idleOutBetween(t, bundle, "s1", "s2")).toBeCloseTo(900 + 300, 6);
    expectWellFormed(t);
  });

  it("moves a freeze an interruption removed back to the stretch's last frame that plays", () => {
    // Red if `share`'s `const at = gone ? gone.startMs : srcEndMs` becomes
    // `srcEndMs`, or `buildTimeline` stops emitting paces at `opensInterruption`.
    // The second journey sets off as s1's response ends: the rest stretch
    // [s1, approach2] is all motion, so its rest is a freeze at approach2.
    const { s1 } = pacedBundle({ ...FAST, rest: 0 }).at;
    const pause = { startMs: s1 + 200, endMs: s1 + 600 };
    const { bundle, at } = pacedBundle(
      { ...FAST, rest: 0 },
      {
        degradations: [
          {
            ...pause,
            kind: "occlusionPause",
            note: "the replay window was covered",
          },
        ],
      },
    );
    const t = buildTimeline(plan, bundle);
    // Premise: the stretch holds no idle, its end (the freeze's own instant)
    // is inside the removed pause, and the pause opens inside the stretch.
    expect(idleSrc(bundle, at.s1, at.approach2)).toBe(0);
    expect(t.interruptions).toEqual([pause]);
    expect(at.approach2).toBeGreaterThanOrEqual(pause.startMs);
    expect(at.approach2).toBeLessThan(pause.endMs);
    expect(pause.startMs).toBeGreaterThan(at.s1);

    const freezes = t.segments.filter((s) => s.kind === "pace");
    expect(freezes).toHaveLength(1);
    expect(freezes[0]?.srcStartMs).toBe(pause.startMs);
    expect((freezes[0]?.outEndMs ?? 0) - (freezes[0]?.outStartMs ?? 0)).toBe(
      900,
    );
    expect(t.unplacedPaces).toBe(0);
    expectWellFormed(t);
  });

  it("counts a freeze an interruption removed when the stretch has no frame that plays", () => {
    // Red if `share`'s `if (gone && (at <= srcStartMs || …)) return false`
    // goes, or `plannedIdleOf` stops counting `!rest || !arrive`.
    // The journey runs right up to s2: the arrive stretch [approach2, s2] is
    // all motion, so its arrive is a freeze at s2.
    const { approach2, s2 } = pacedBundle({ ...FAST, arrive: 0 }).at;
    const pause = { startMs: approach2 - 100, endMs: s2 + 100 };
    const { bundle, at } = pacedBundle(
      { ...FAST, arrive: 0 },
      {
        degradations: [
          {
            ...pause,
            kind: "occlusionPause",
            note: "the replay window was covered",
          },
        ],
      },
    );
    const t = buildTimeline(plan, bundle);
    // Premise: the freeze's instant is inside the removed pause, and the
    // pause opens before the stretch does, so no frame of it plays.
    expect(idleSrc(bundle, at.approach2, at.s2)).toBe(0);
    expect(t.interruptions).toEqual([pause]);
    expect(at.s2).toBeGreaterThanOrEqual(pause.startMs);
    expect(at.s2).toBeLessThan(pause.endMs);
    expect(pause.startMs).toBeLessThanOrEqual(at.approach2);

    expect(t.unplacedPaces).toBe(1);
    expect(t.segments.filter((s) => s.kind === "pace")).toEqual([]);
    expectWellFormed(t);
  });

  it("lets an authored gap win over the planned beat", () => {
    // Red if `planScene` asks `planned(...)` before `gapAfter.get(...)`.
    const authored = planScene(
      twoStepScene(PACING, [
        { id: "g1", afterActionId: "s1", durationMs: 2000 },
      ]),
    );
    expect(authored.paces?.map((p) => p.origin)).toEqual([
      "planned",
      "authored",
    ]);
    for (const idle of [FAST, SLOW]) {
      const { bundle } = pacedBundle(idle);
      const t = buildTimeline(authored, bundle);
      expect(idleOutBetween(t, bundle, "s1", "s2")).toBeCloseTo(2000, 6);
    }
  });

  it("counts a beat it cannot place and plays that pair as recorded", () => {
    // Red if `plannedIdleOf`'s `approach === undefined` check or its `unplacedPaces++` goes.
    const { bundle, at } = pacedBundle(SLOW);
    const noApproach: FrameBundle = {
      ...bundle,
      markers: bundle.markers.map((m) =>
        m.actionId === "s2"
          ? { actionId: m.actionId, sourceTimeMs: m.sourceTimeMs }
          : m,
      ),
    };
    // Premise: s2 really lost its approach, and s1 kept its own.
    expect(noApproach.markers[1]).not.toHaveProperty("approachSourceTimeMs");
    expect(noApproach.markers[0]?.approachSourceTimeMs).toBe(at.approach1);

    const t = buildTimeline(plan, noApproach);
    expect(t.unplacedPaces).toBe(1);
    expect(toOutputMs(t, at.s2) - toOutputMs(t, at.s1)).toBeCloseTo(
      at.s2 - at.s1,
      6,
    );

    // A beat for a step the bundle has no marker for counts the same way.
    const missing = buildTimeline(plan, {
      ...bundle,
      markers: bundle.markers.filter((m) => m.actionId !== "s2"),
    });
    // Two: s2's beat, and the tail, which runs from s2.
    expect(missing.unplacedPaces).toBe(2);
  });

  it("plays the idle after the last step for the planned tail", () => {
    // Red if `plannedIdleOf`'s tail `share(last, sourceDurationMs, plan.tailMs)` goes.
    for (const idle of [FAST, SLOW]) {
      const { bundle, at } = pacedBundle(idle);
      const t = buildTimeline(plan, bundle);
      // Premise: the recorded tail is not already the planned one.
      expect(idleSrc(bundle, at.s2, t.sourceDurationMs)).not.toBe(1000);
      expect(idleOut(t, bundle, at.s2, t.sourceDurationMs)).toBeCloseTo(
        1000,
        6,
      );
      expect(t.outputDurationMs - toOutputMs(t, at.s2)).toBeCloseTo(
        ACT_MS + 1000,
        6,
      );
    }
  });

  it("plays the opening beat from the start of the take", () => {
    // Red if the opening's `after` stops being 0, or `planScene` stops pushing `opening`.
    for (const idle of [FAST, SLOW]) {
      const { bundle, at } = pacedBundle(idle);
      const t = buildTimeline(plan, bundle);
      expect(idleSrc(bundle, 0, at.s1)).toBe(idle.openRest + idle.openArrive);
      expect(idleOut(t, bundle, 0, at.approach1)).toBeCloseTo(500, 6);
      expect(idleOut(t, bundle, at.approach1, at.s1)).toBeCloseTo(200, 6);
      expect(toOutputMs(t, at.s1)).toBeCloseTo(500 + JOURNEY_MS + 200, 6);
    }
  });

  it("renders a sampled replay as recorded: planned beats are a real-time rule", () => {
    // Red if `paceInstants` stops skipping `origin === "planned"`.
    const sampled = { ...pacedBundle(SLOW).bundle, timing: undefined };
    const planned = buildTimeline(plan, sampled);
    const unplanned = buildTimeline(planScene(twoStepScene()), sampled);
    expect(planned).toEqual(unplanned);
  });
});

/** `bundle` with `fields` set on `actionId`'s marker. */
function withMarker(
  bundle: FrameBundle,
  actionId: string,
  fields: Partial<FrameBundle["markers"][number]>,
): FrameBundle {
  return {
    ...bundle,
    markers: bundle.markers.map((m) =>
      m.actionId === actionId ? { ...m, ...fields } : m,
    ),
  };
}

/** The act's own idle, after s1's response: what a typed step's lead-in or
 *  the walk's own gaps leave between its marker and its act end, and what
 *  a slower machine lengthens. */
const ACT_IDLE_MS = 800;

describe("the planned rest counts from the act's end", () => {
  const REST = {
    beats: [
      { beforeActionId: "s1", restMs: 500, arriveMs: 200 },
      { beforeActionId: "s2", restMs: 2000, arriveMs: 300 },
    ],
    tailMs: 1000,
  };
  const restPlan = planScene(twoStepScene(REST));
  /** s1's act runs its response and `ACT_IDLE_MS` of idle; the rest
   *  stretch after it holds `idle.rest - ACT_IDLE_MS`. */
  const typed = (idle: Idle) => {
    const { bundle, at } = pacedBundle(idle);
    const actEnd = at.s1 + ACT_MS + ACT_IDLE_MS;
    return {
      bundle: withMarker(bundle, "s1", { actEndSourceTimeMs: actEnd }),
      at: { ...at, actEnd },
    };
  };

  it("plays the act's own idle for 0 and the rest after it for restMs, fast and slow alike", () => {
    // Red if `plannedIdleOf`'s rest starts at the marker again
    // (`share(afterAct(prev, restEnd), …)` to `share(prev.sourceTimeMs, …)`):
    // the act's 800 ms then takes a share of the 2000. Red too if
    // `afterAct` stops setting the act's idle to 0 (`share(…, end, 0)`):
    // the act's 800 ms then plays as recorded.
    const fast = typed({ ...FAST, rest: ACT_IDLE_MS + 400 });
    const slow = typed({ ...SLOW, rest: ACT_IDLE_MS + 6000 });
    // Premise: the act's idle is 800 in both, and the idle after it differs
    // by seconds.
    for (const { bundle, at } of [fast, slow]) {
      expect(idleSrc(bundle, at.s1, at.actEnd)).toBe(ACT_IDLE_MS);
    }
    expect(
      idleSrc(slow.bundle, slow.at.actEnd, slow.at.approach2) -
        idleSrc(fast.bundle, fast.at.actEnd, fast.at.approach2),
    ).toBeGreaterThan(5000);

    const outs = [fast, slow].map(({ bundle, at }) => {
      const t = buildTimeline(restPlan, bundle);
      expect(idleOut(t, bundle, at.s1, at.actEnd)).toBeCloseTo(0, 6);
      expect(idleOut(t, bundle, at.actEnd, at.approach2)).toBeCloseTo(2000, 6);
      expect(idleOut(t, bundle, at.approach2, at.s2)).toBeCloseTo(300, 6);
      expect(t.unplacedPaces).toBe(0);
      expectWellFormed(t);
      return t.outputDurationMs;
    });
    expect(outs[0]).toBeCloseTo(outs[1] ?? Number.NaN, 6);
  });

  it("starts the rest at the marker when the act end is absent, as before act ends were read", () => {
    // Red if `afterAct`'s guard (`end < prev.sourceTimeMs || end > endMs`)
    // goes: an act end past the approach then opens a stretch that runs
    // backwards, and the timeline differs from the one without it.
    const { bundle, at } = typed({ ...FAST, rest: ACT_IDLE_MS + 400 });
    const without = withMarker(bundle, "s1", {
      actEndSourceTimeMs: undefined,
    });
    // Premise: the act end is really gone, and the act's idle is there.
    expect(without.markers[0]?.actEndSourceTimeMs).toBeUndefined();
    expect(idleSrc(without, at.s1, at.approach2)).toBe(ACT_IDLE_MS + 400);
    const t = buildTimeline(restPlan, without);
    // Task 3's rule: every idle ms from the marker to the approach shares
    // the rest in proportion, the act's own included.
    expect(idleOut(t, without, at.s1, at.approach2)).toBeCloseTo(2000, 6);
    expect(idleOut(t, without, at.s1, at.actEnd)).toBeCloseTo(
      (2000 * ACT_IDLE_MS) / (ACT_IDLE_MS + 400),
      6,
    );
    // An act end past this step's approach, or before its own marker, is
    // read as absent.
    for (const actEndSourceTimeMs of [at.approach2 + 1, at.s1 - 1]) {
      expect(
        buildTimeline(
          restPlan,
          withMarker(bundle, "s1", { actEndSourceTimeMs }),
        ),
      ).toEqual(t);
    }
  });

  it("counts the tail from the last act's end, and plays the act's idle for 0", () => {
    // Red if the tail's `share(afterAct(last, …), …)` starts at the last
    // marker again: the act's 300 ms then takes a share of the tail.
    for (const idle of [FAST, SLOW]) {
      const { bundle: raw, at } = pacedBundle({ ...idle, tail: 2000 });
      const actEnd = at.s2 + ACT_MS + 300;
      const bundle = withMarker(raw, "s2", { actEndSourceTimeMs: actEnd });
      const t = buildTimeline(restPlan, bundle);
      // Premise: the act holds 300 of idle and the recorded tail after it
      // is not the planned one.
      expect(idleSrc(bundle, at.s2, actEnd)).toBe(300);
      expect(idleSrc(bundle, actEnd, t.sourceDurationMs)).not.toBe(1000);
      expect(idleOut(t, bundle, at.s2, actEnd)).toBeCloseTo(0, 6);
      expect(idleOut(t, bundle, actEnd, t.sourceDurationMs)).toBeCloseTo(
        1000,
        6,
      );
      expect(t.unplacedPaces).toBe(0);
    }
  });
});

describe("a planned step reached by an approach scroll", () => {
  /** The scroll: 200 ms after s1's response, 400 ms long, inside the rest
   *  stretch. */
  const SCROLL_MS = 400;
  const scrolled = (idle: Idle) => {
    const { bundle, at } = pacedBundle(idle);
    const scroll = {
      startMs: at.s1 + ACT_MS + 200,
      endMs: at.s1 + ACT_MS + 200 + SCROLL_MS,
    };
    const withScroll = withMarker(
      {
        ...bundle,
        motionSpans: [
          ...bundle.motionSpans,
          {
            ...scroll,
            byteLength: 0,
            ref: "scroll",
            width: 1280,
            height: 800,
            fps: 60,
          },
        ],
      },
      "s2",
      { scrollEndSourceTimeMs: scroll.endMs },
    );
    return { bundle: withScroll, at: { ...at, scrollEnd: scroll.endMs } };
  };
  const pacing = (afterScrollMs?: number) => ({
    beats: [
      { beforeActionId: "s1", restMs: 500, arriveMs: 200 },
      {
        beforeActionId: "s2",
        restMs: 900,
        arriveMs: 300,
        ...(afterScrollMs === undefined ? {} : { afterScrollMs }),
      },
    ],
    tailMs: 1000,
  });

  it("plays the idle after the scroll for afterScrollMs and the idle before it for restMs", () => {
    // Red if `plannedIdleOf` drops the scroll's stretch
    // (`share(scrollEnd, approach, pace.afterScrollMs)`) or ends the rest at
    // the approach (`restEnd = scrollEnd ?? approach` to `approach`).
    const plan = planScene(twoStepScene(pacing(1500)));
    for (const idle of [
      { ...FAST, rest: 1500 },
      { ...SLOW, rest: 6000 },
    ]) {
      const { bundle, at } = scrolled(idle);
      // Premise: the scroll is motion between s1's act and the approach,
      // with idle on both sides of it.
      expect(motionIn(bundle, at.scrollEnd - SCROLL_MS, at.scrollEnd)).toBe(
        SCROLL_MS,
      );
      expect(idleSrc(bundle, at.s1, at.scrollEnd)).toBe(200);
      expect(idleSrc(bundle, at.scrollEnd, at.approach2)).toBe(
        idle.rest - 200 - SCROLL_MS,
      );
      expect(plan.paces?.[1]).toMatchObject({ afterScrollMs: 1500 });

      const t = buildTimeline(plan, bundle);
      expect(idleOut(t, bundle, at.s1, at.scrollEnd)).toBeCloseTo(900, 6);
      expect(idleOut(t, bundle, at.scrollEnd, at.approach2)).toBeCloseTo(
        1500,
        6,
      );
      expect(idleOut(t, bundle, at.approach2, at.s2)).toBeCloseTo(300, 6);
      expect(t.unplacedPaces).toBe(0);
      expectWellFormed(t);
    }
  });

  it("counts a beat with only one of the scroll's end and afterScrollMs, and plays that pair as recorded", () => {
    // Red if `plannedIdleOf`'s check `(scrollEnd === undefined) !==
    // (pace.afterScrollMs === undefined)` goes: the pair is then paced.
    const { bundle, at } = scrolled({ ...SLOW, rest: 6000 });
    const noScrollEnd = withMarker(bundle, "s2", {
      scrollEndSourceTimeMs: undefined,
    });
    const cases = [
      // The marker says it scrolled, the beat plans nothing after it.
      { plan: planScene(twoStepScene(pacing())), bundle },
      // The beat plans after a scroll the marker does not have.
      { plan: planScene(twoStepScene(pacing(1500))), bundle: noScrollEnd },
    ];
    // Premise: each case has exactly one of the two.
    expect(bundle.markers[1]?.scrollEndSourceTimeMs).toBe(at.scrollEnd);
    expect(cases[0]?.plan.paces?.[1]).not.toHaveProperty("afterScrollMs");
    expect(noScrollEnd.markers[1]?.scrollEndSourceTimeMs).toBeUndefined();
    expect(cases[1]?.plan.paces?.[1]).toMatchObject({ afterScrollMs: 1500 });
    for (const c of cases) {
      const t = buildTimeline(c.plan, c.bundle);
      expect(t.unplacedPaces).toBe(1);
      expect(toOutputMs(t, at.s2) - toOutputMs(t, at.s1)).toBeCloseTo(
        at.s2 - at.s1,
        6,
      );
    }
  });
});

describe("a take without a beat plan", () => {
  // Drawn by the code at 35f94523, before planned pacing existed.
  const cases = noPacingCases();
  it("carries the fixture the comparison depends on", () => {
    // Red if `noPacingCases()` stops covering approaches, an interruption and a gap.
    expect(beforePlannedPacing.map((c) => c.name)).toEqual(
      cases.map((c) => c.name),
    );
    // The bundles carry approaches, so a timeline that read them unasked
    // would differ; and each case covers a different path.
    for (const { bundle } of cases) {
      expect(
        bundle.markers.every((m) => m.approachSourceTimeMs !== undefined),
      ).toBe(true);
    }
    expect(beforePlannedPacing[0]?.timeline.interruptions).toHaveLength(1);
    expect(cases[1]?.scene.edits.gaps.length).toBe(1);
  });

  for (const [i, { name, scene, bundle }] of cases.entries()) {
    it(`renders exactly as before: ${name}`, () => {
      // Red on any change to `planScene` or `buildTimeline` for a take with no `pacing`.
      const before = beforePlannedPacing[i];
      const { compositorVersion: _v, tailMs, ...unplanned } = planScene(scene);
      expect(tailMs).toBeNull();
      expect(unplanned).toEqual(before?.plan);
      expect(buildTimeline(planScene(scene), bundle)).toEqual(before?.timeline);
    });
  }
});

// Ruling 2026-11-13: a keyframe-diff hint (two stills that differ with no
// motion recorded between them) is not motion on a planned take. Only the
// render detects one, so counting it gave the render a longer video than
// every reader without pixels: the cap ladder, the Studio, the run report.
describe("a keyframe-diff hint on a planned take", () => {
  const { bundle, at } = pacedBundle(SLOW);
  /** Two seconds of the rest between s1's act and the second journey. */
  const hint = {
    startMs: at.s1 + ACT_MS + 1000,
    endMs: at.s1 + ACT_MS + 3000,
  };
  const outputs = (t: Timeline) => ({
    duration: t.outputDurationMs,
    markers: bundle.markers.map((m) => toOutputMs(t, m.sourceTimeMs)),
  });

  it("leaves the planned length and every step's place as they are", () => {
    // Red if `buildTimeline` counts `keyframeHints` as motion on a planned
    // plan (drop `isPlanned ? hints :` and keep the merged list).
    // Premise: the hint lies inside the planned rest, on idle the bundle
    // recorded, and counted as motion it would lengthen the video.
    expect(hint.startMs).toBeGreaterThan(at.s1 + ACT_MS);
    expect(hint.endMs).toBeLessThan(at.approach2);
    expect(idleSrc(bundle, hint.startMs, hint.endMs)).toBe(2000);
    const asMotion = buildTimeline(plan, bundle, [hint]);
    const without = buildTimeline(plan, bundle);
    // The rest still plays its 900 on the idle left, so the hint adds its
    // whole 2 s at rate 1.0.
    expect(asMotion.outputDurationMs - without.outputDurationMs).toBeCloseTo(
      2000,
      6,
    );

    const withHint = buildTimeline(plan, bundle, [], [hint]);
    expect(outputs(withHint)).toEqual(outputs(without));
    expect(withHint.segments.filter((s) => s.kind === "motion")).toEqual(
      without.segments.filter((s) => s.kind === "motion"),
    );
    expectWellFormed(withHint);
  });

  it("is motion as before on a take without a beat plan", () => {
    // Red if `keyframeHints` are dropped whatever the plan is.
    const unplanned = planScene(twoStepScene());
    // Premise: no beat plan, so nothing here is planned.
    expect(unplanned.tailMs).toBeNull();
    expect(unplanned.paces?.some((p) => p.origin === "planned")).toBe(false);
    const asKeyframe = buildTimeline(unplanned, bundle, [], [hint]);
    expect(asKeyframe).toEqual(buildTimeline(unplanned, bundle, [hint]));
    // And it is classified motion there: a segment spans exactly the hint.
    expect(
      asKeyframe.segments.some(
        (s) =>
          s.kind === "motion" &&
          s.srcStartMs === hint.startMs &&
          s.srcEndMs === hint.endMs,
      ),
    ).toBe(true);
    for (const c of noPacingCases()) {
      const p = planScene(c.scene);
      expect(buildTimeline(p, c.bundle, [], [hint]), c.name).toEqual(
        buildTimeline(p, c.bundle, [hint]),
      );
    }
  });
});
