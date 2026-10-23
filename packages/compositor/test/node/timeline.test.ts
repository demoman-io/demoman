import type { SceneDocument } from "@demoman/scene-schema";
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
import type { PlannedPace, RenderPlan } from "../../src/plan/types";
import { readonlyScene } from "../fixtures/scene";

function bundle(overrides: Partial<FrameBundle> = {}): FrameBundle {
  return {
    bundleVersion: 1,
    sceneId: "scene-readonly-001",
    source: "replay",
    dpr: 3,
    viewport: { width: 1280, height: 800 },
    keyframes: [
      {
        byteLength: 0,
        sourceTimeMs: 0,
        ref: "k0",
        width: 3840,
        height: 2400,
        actionId: null,
      },
      {
        byteLength: 0,
        sourceTimeMs: 9000,
        ref: "k1",
        width: 3840,
        height: 2400,
        actionId: "act-3",
      },
    ],
    motionSpans: [],
    cursorSamples: [{ sourceTimeMs: 0, x: 0, y: 0 }],
    cursorGaps: [],
    anchorRects: [],
    markers: [
      { actionId: "act-1", sourceTimeMs: 400 },
      { actionId: "act-2", sourceTimeMs: 3200 },
      { actionId: "act-3", sourceTimeMs: 9000 },
    ],
    degradations: [],
    ...overrides,
  };
}

const plan = planScene(readonlyScene());

describe("motionSpansOf", () => {
  it("reads motion spans straight from the bundle", () => {
    const spans = motionSpansOf(
      bundle({
        motionSpans: [
          {
            byteLength: 0,
            startMs: 500,
            endMs: 1500,
            ref: "m",
            width: 2560,
            height: 1600,
            fps: 60,
          },
        ],
      }),
      [],
    );
    expect(spans).toEqual([{ startMs: 500, endMs: 1500 }]);
  });

  // SP5 telling us it degraded to keyframes is better evidence than any
  // pixel heuristic: it knows there was motion it could not keep.
  it("treats a keyframeOnly degradation as motion", () => {
    const spans = motionSpansOf(
      bundle({
        degradations: [
          {
            startMs: 2000,
            endMs: 2600,
            kind: "keyframeOnly",
            note: "heap high-water",
          },
        ],
      }),
      [],
    );
    expect(spans).toEqual([{ startMs: 2000, endMs: 2600 }]);
  });

  it("ignores degradations that are not about missing motion frames", () => {
    const spans = motionSpansOf(
      bundle({
        degradations: [
          {
            startMs: 2000,
            endMs: 2600,
            kind: "occlusionPause",
            note: "window covered",
          },
        ],
      }),
      [],
    );
    expect(spans).toEqual([]);
  });

  it("merges overlapping and adjacent spans", () => {
    const spans = motionSpansOf(
      bundle({
        motionSpans: [
          {
            byteLength: 0,
            startMs: 500,
            endMs: 1500,
            ref: "m0",
            width: 2560,
            height: 1600,
            fps: 60,
          },
          {
            byteLength: 0,
            startMs: 1500,
            endMs: 2000,
            ref: "m1",
            width: 2560,
            height: 1600,
            fps: 60,
          },
        ],
      }),
      [{ startMs: 1800, endMs: 2400 }],
    );
    expect(spans).toEqual([{ startMs: 500, endMs: 2400 }]);
  });
});

describe("buildTimeline", () => {
  it("no longer compresses a long idle span; every ms survives to output", () => {
    const timeline = buildTimeline(plan, bundle());
    // 0→400→3200→9000 with no motion at all: the idle clamp used to collapse
    // this to 3 * maxIdleMs (1200ms). It is gone (P5, 2026-09-08), so the
    // three idle gaps (400 + 2800 + 5800) pass straight through and the
    // output matches the source exactly.
    expect(timeline.outputDurationMs).toBe(9000);
  });

  it("does not stretch idle spans shorter than the old policy minimum", () => {
    // Markers only, so `bundle()`'s own keyframe at 9000 still sets
    // sourceDurationMs — this leaves a fourth, long trailing idle segment
    // (30→9000) alongside the three short ones. Fine here: this test's claim
    // is per-segment (every idle span matches its own source span, long or
    // short), not about the total, which the two dedicated `twoActionBundle`
    // tests above already cover.
    const short = bundle({
      markers: [
        { actionId: "act-1", sourceTimeMs: 10 },
        { actionId: "act-2", sourceTimeMs: 20 },
        { actionId: "act-3", sourceTimeMs: 30 },
      ],
    });
    // paces: null, not `plan` verbatim: `plan.paces` carries the recorded
    // gaps from readonlyScene()'s OWN timestamps (thousands of ms, matching
    // bundle()'s default 400/3200/9000 markers), and this fixture's
    // compressed 10/20/30 markers would make every one of those a huge,
    // legitimate rebuild-mode shortfall (Task 4) — a second, unrelated
    // feature this test predates and isn't about.
    const timeline = buildTimeline({ ...plan, paces: null }, short);
    // Three 10ms gaps used to each be floored to minIdleMs (120ms). Un-clamped,
    // each segment matches its own source span exactly.
    for (const segment of timeline.segments) {
      expect(segment.outEndMs - segment.outStartMs).toBeCloseTo(
        segment.srcEndMs - segment.srcStartMs,
        6,
      );
    }
  });

  // These two extra fixtures avoid `plan`/`bundle()`'s shared markers so the
  // long- and short-gap cases below aren't muddied by the motion span or the
  // other idle gaps already covered above.
  function twoActionBundle(
    gapMs: number,
    overrides: Partial<FrameBundle> = {},
  ): FrameBundle {
    return bundle({
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 0,
          ref: "k0",
          width: 3840,
          height: 2400,
          actionId: null,
        },
        {
          byteLength: 0,
          sourceTimeMs: gapMs,
          ref: "k1",
          width: 3840,
          height: 2400,
          actionId: "a2",
        },
      ],
      markers: [
        { actionId: "a1", sourceTimeMs: 0 },
        { actionId: "a2", sourceTimeMs: gapMs },
      ],
      ...overrides,
    });
  }

  function authoredPace(targetMs: number): PlannedPace[] {
    return [
      {
        afterActionId: "a1",
        beforeActionId: "a2",
        origin: "authored",
        idleTargetMs: targetMs,
      },
    ];
  }

  it("passes a long idle span through at its recorded duration", () => {
    // Six seconds of dead air used to render as 400ms (maxIdleMs).
    const timeline = buildTimeline(
      { ...plan, paces: null },
      twoActionBundle(6000),
    );
    expect(timeline.outputDurationMs).toBeCloseTo(6000, 0);
  });

  it("does not stretch a short idle span", () => {
    // 50ms used to become 120ms (minIdleMs).
    const timeline = buildTimeline(
      { ...plan, paces: null },
      twoActionBundle(50),
    );
    expect(timeline.outputDurationMs).toBeCloseTo(50, 0);
  });

  it("lets an authored gap shorten the idle stretch without touching motion", () => {
    // 0..1000 motion, 1000..6000 idle. An authored 200ms gap must leave the
    // motion at rate 1.0 and cut only the dead air: 1000 + 200 = 1200.
    const captured = twoActionBundle(6000, {
      source: "capture",
      motionSpans: [
        {
          byteLength: 0,
          startMs: 0,
          endMs: 1000,
          ref: "m",
          width: 2560,
          height: 1600,
          fps: 60,
        },
      ],
    });
    const planWithGap: RenderPlan = { ...plan, paces: authoredPace(200) };
    const timeline = buildTimeline(planWithGap, captured);

    // Fixture guard: without a motion span this test would pass for the
    // wrong reason — it would be asserting on one idle segment, not on the
    // boundary between motion and idle.
    expect(captured.motionSpans.length).toBe(1);
    expect(timeline.outputDurationMs).toBeCloseTo(1200, 0);
    const motion = timeline.segments.filter((s) => s.kind === "motion");
    for (const s of motion) {
      expect(s.outEndMs - s.outStartMs).toBeCloseTo(
        s.srcEndMs - s.srcStartMs,
        6,
      );
    }
  });

  it("ignores a recorded pace in recording mode, where the bundle already holds it", () => {
    // The capture bundle's source time IS real time. Applying a recorded
    // target on top would be applying it twice.
    const captured = twoActionBundle(6000, { source: "capture" });
    const planWithRecordedPace: RenderPlan = {
      ...plan,
      paces: [
        {
          afterActionId: "a1",
          beforeActionId: "a2",
          origin: "recorded",
          recordedSpanMs: 6000,
        },
      ],
    };
    expect(
      buildTimeline(planWithRecordedPace, captured).outputDurationMs,
    ).toBeCloseTo(6000, 0);
  });

  it("does not apply an authored gap on a replay bundle — that's rebuild mode's mechanism", () => {
    // Ruling P1: a replay bundle's source time is not real time, so
    // idleOutputFor must not touch it here. Task 4 covers rebuild mode with
    // a dedicated "pace" segment; applying both would double-count the gap.
    // Without the `bundle.source === "capture"` gate this would come out to
    // 1200 (the same shortened stretch as the capture case above), not 6000.
    const replayed = twoActionBundle(6000, {
      motionSpans: [
        {
          byteLength: 0,
          startMs: 0,
          endMs: 1000,
          ref: "m",
          width: 2560,
          height: 1600,
          fps: 60,
        },
      ],
    }); // source defaults to "replay" — see bundle()'s overrides.
    const planWithGap: RenderPlan = { ...plan, paces: authoredPace(200) };
    expect(buildTimeline(planWithGap, replayed).outputDurationMs).toBeCloseTo(
      6000,
      0,
    );
  });

  it("realizes an authored gap exactly even when a caller-supplied hint narrows the idle stretch", () => {
    // buildTimeline's own motion set is bundle spans + degradations + hints
    // (see motionSpansOf), and that merged set is what segments idle vs
    // motion here. idleMsBetweenMarkers's denominator must agree with it, or
    // an authored target gets diluted against a stale, hint-less idle total.
    // This mirrors resolvePlan's real call shape (resolve.ts), which always
    // passes `cursorMotionSpans(cursor)` as hints — the cursor moving toward
    // the next target during an idle stretch is exactly this case.
    const captured = twoActionBundle(6000, { source: "capture" }); // no bundle-level motion spans
    const hints: TimeSpan[] = [{ startMs: 1000, endMs: 2000 }];
    const planWithGap: RenderPlan = { ...plan, paces: authoredPace(200) };
    const timeline = buildTimeline(planWithGap, captured, hints);

    // Fixture guard: without the hint carving out real motion inside the
    // pair, the correct and the stale-denominator computation coincide and
    // this test could not tell them apart.
    const motion = timeline.segments.filter((s) => s.kind === "motion");
    expect(motion.length).toBe(1);
    for (const s of motion) {
      expect(s.outEndMs - s.outStartMs).toBeCloseTo(
        s.srcEndMs - s.srcStartMs,
        6,
      );
    }
    // motion (1000ms, rate 1.0) + the authored idle target (200ms) = 1200,
    // exactly — not diluted by treating the whole 6000ms marker span as idle
    // the way recomputing motionSpansOf(bundle) with no hints would.
    expect(timeline.outputDurationMs).toBeCloseTo(1200, 0);
  });

  it("does not apply a recorded pace's targetMs even when it differs from the bundle's own gap", () => {
    // "ignores a recorded pace in recording mode" above uses targetMs: 6000,
    // which equals the bundle's own gap — so it cannot tell a working
    // origin==="authored" filter apart from a missing one (both produce
    // 6000). This target (500) can: if the filter in authoredPaceCovering
    // were ever dropped, this would come out to 500, not 6000.
    const captured = twoActionBundle(6000, { source: "capture" });
    const planWithRecordedPace: RenderPlan = {
      ...plan,
      paces: [
        {
          afterActionId: "a1",
          beforeActionId: "a2",
          origin: "recorded",
          recordedSpanMs: 500,
        },
      ],
    };
    expect(
      buildTimeline(planWithRecordedPace, captured).outputDurationMs,
    ).toBeCloseTo(6000, 0);
  });

  // The backbone property. A motion span passing through at anything other
  // than rate 1.0 is the bug v8 §4 names by hand.
  it("passes every motion span through at rate exactly 1.0", () => {
    const timeline = buildTimeline(
      plan,
      bundle({
        motionSpans: [
          {
            byteLength: 0,
            startMs: 400,
            endMs: 3200,
            ref: "m",
            width: 2560,
            height: 1600,
            fps: 60,
          },
        ],
      }),
    );
    const motion = timeline.segments.filter((s) => s.kind === "motion");
    expect(motion.length).toBeGreaterThan(0);
    for (const segment of motion) {
      expect(segment.outEndMs - segment.outStartMs).toBeCloseTo(
        segment.srcEndMs - segment.srcStartMs,
        6,
      );
    }
  });

  it("splits a gap that is part motion and part idle", () => {
    const timeline = buildTimeline(
      plan,
      bundle({
        motionSpans: [
          {
            byteLength: 0,
            startMs: 400,
            endMs: 1400,
            ref: "m",
            width: 2560,
            height: 1600,
            fps: 60,
          },
        ],
      }),
    );
    const kinds = timeline.segments.map((s) => s.kind);
    expect(kinds).toContain("motion");
    expect(kinds).toContain("idle");
  });

  it("produces a monotone, gapless output timeline", () => {
    const timeline = buildTimeline(
      plan,
      bundle({
        motionSpans: [
          {
            byteLength: 0,
            startMs: 1000,
            endMs: 2000,
            ref: "m",
            width: 2560,
            height: 1600,
            fps: 60,
          },
        ],
      }),
    );
    let cursor = 0;
    for (const segment of timeline.segments) {
      expect(segment.outStartMs).toBeCloseTo(cursor, 6);
      expect(segment.outEndMs).toBeGreaterThanOrEqual(segment.outStartMs);
      expect(segment.srcEndMs).toBeGreaterThanOrEqual(segment.srcStartMs);
      cursor = segment.outEndMs;
    }
    expect(cursor).toBeCloseTo(timeline.outputDurationMs, 6);
  });

  // Rebuild mode has no recorded pacing at all — replay races through the
  // page, so the gap between two markers is however long re-rendering took,
  // not how long the author waited. `plan.paces[*].targetMs` (Task 2) is
  // what the author actually left; the shortfall between it and what replay
  // measured is reconstructed here as a `"pace"` segment, at the END of the
  // stretch so the page's own response still plays at 1x before the freeze.
  describe("pace segments (rebuild mode)", () => {
    // A minimal two-marker replay bundle. Deliberately leaner than
    // twoActionBundle above: these tests want the marker gap itself to be
    // "however long replay took", not a duration the fixture pre-decided.
    function replayBundleWithMarkers(
      markers: { actionId: string; sourceTimeMs: number }[],
    ): FrameBundle {
      const last = markers[markers.length - 1];
      return bundle({
        source: "replay",
        keyframes: [
          {
            byteLength: 0,
            sourceTimeMs: 0,
            ref: "k0",
            width: 3840,
            height: 2400,
            actionId: null,
          },
          ...(last
            ? [
                {
                  byteLength: 0,
                  sourceTimeMs: last.sourceTimeMs,
                  ref: "k1",
                  width: 3840,
                  height: 2400,
                  actionId: last.actionId,
                },
              ]
            : []),
        ],
        markers,
      });
    }

    function planWith(overrides: Partial<RenderPlan>): RenderPlan {
      return { ...plan, ...overrides };
    }

    it("inserts the shortfall between what the author left and what replay took", () => {
      // Author left 3000ms; replay covered it in 400ms. Shortfall 2600ms.
      const bundle = replayBundleWithMarkers([
        { actionId: "a1", sourceTimeMs: 0 },
        { actionId: "a2", sourceTimeMs: 400 },
      ]);
      const plan = planWith({
        paces: [
          {
            afterActionId: "a1",
            beforeActionId: "a2",
            origin: "recorded",
            recordedSpanMs: 3000,
          },
        ],
      });
      const timeline = buildTimeline(plan, bundle);

      expect(bundle.source).toBe("replay"); // fixture guard
      const pace = timeline.segments.filter((s) => s.kind === "pace");
      expect(pace).toHaveLength(1);
      const [first] = pace;
      if (!first) throw new Error("unreachable");
      expect(first.outEndMs - first.outStartMs).toBeCloseTo(2600, 0);
      // A freeze: source time does not advance across it.
      expect(first.srcStartMs).toBe(first.srcEndMs);
    });

    it("freezes on the settled frame, not the pre-response one", () => {
      const bundle = replayBundleWithMarkers([
        { actionId: "a1", sourceTimeMs: 0 },
        { actionId: "a2", sourceTimeMs: 400 },
      ]);
      const plan = planWith({
        paces: [
          {
            afterActionId: "a1",
            beforeActionId: "a2",
            origin: "recorded",
            recordedSpanMs: 3000,
          },
        ],
      });
      const pace = buildTimeline(plan, bundle).segments.find(
        (s) => s.kind === "pace",
      );

      // At the END of the stretch: whatever the page did while responding has
      // already played at 1x before the freeze begins.
      expect(pace?.srcStartMs).toBeCloseTo(400, 0);
    });

    /**
     * The pace is the wait BEFORE a2, so a2 itself — its click, the camera
     * aimed at it, a range anchored on it — happens when the wait ends.
     * Mapped to the freeze's first instant instead, a click pulsed, the
     * picture held for the whole pace, and the page's response played after
     * it: on the runner's fixture a 4.1s freeze between the checkout click
     * and the panel it opens, with the camera zoomed out before the panel
     * moved. Verified failable: `toOutputMs` without the pace tie-break
     * answers the pace's start and fails the first assertion.
     */
    it("puts the paced action after the wait, not before it", () => {
      const bundle = replayBundleWithMarkers([
        { actionId: "a1", sourceTimeMs: 0 },
        { actionId: "a2", sourceTimeMs: 400 },
        // Past a2, so a2 is not the terminal instant — `toOutputMs` clamps
        // that to the end of the output, which would pass without the fix.
        { actionId: "a3", sourceTimeMs: 1000 },
      ]);
      const timeline = buildTimeline(
        planWith({
          paces: [
            {
              afterActionId: "a1",
              beforeActionId: "a2",
              origin: "recorded",
              recordedSpanMs: 3000,
            },
          ],
        }),
        bundle,
      );
      const pace = timeline.segments.find((s) => s.kind === "pace");
      // Premise: a real freeze, at a2, with source time left after it.
      expect(pace?.srcStartMs).toBe(400);
      expect(pace && pace.outEndMs - pace.outStartMs).toBeGreaterThan(2000);
      expect(timeline.sourceDurationMs).toBeGreaterThan(400);

      expect(toOutputMs(timeline, 400)).toBeCloseTo(pace?.outEndMs ?? 0, 6);
      // Still monotone across the tie: a hair earlier is before the wait,
      // a hair later is after it.
      expect(toOutputMs(timeline, 399)).toBeLessThanOrEqual(
        pace?.outStartMs ?? 0,
      );
      expect(toOutputMs(timeline, 401)).toBeGreaterThan(pace?.outEndMs ?? 0);
    });

    it("never compresses when replay was slower than the author", () => {
      const bundle = replayBundleWithMarkers([
        { actionId: "a1", sourceTimeMs: 0 },
        { actionId: "a2", sourceTimeMs: 5000 },
      ]);
      const plan = planWith({
        paces: [
          {
            afterActionId: "a1",
            beforeActionId: "a2",
            origin: "recorded",
            recordedSpanMs: 1000,
          },
        ],
      });
      const timeline = buildTimeline(plan, bundle);

      expect(timeline.segments.filter((s) => s.kind === "pace")).toHaveLength(
        0,
      );
      expect(timeline.outputDurationMs).toBeGreaterThanOrEqual(5000);
    });

    it("reports a pace it cannot place instead of silently shortening the video", () => {
      // a2 has no marker: the rebuild stopped early. Dropping this pause
      // silently is the exact symptom this whole design exists to fix.
      const bundle = replayBundleWithMarkers([
        { actionId: "a1", sourceTimeMs: 0 },
      ]);
      const plan = planWith({
        paces: [
          {
            afterActionId: "a1",
            beforeActionId: "a2",
            origin: "recorded",
            recordedSpanMs: 3000,
          },
        ],
      });
      const timeline = buildTimeline(plan, bundle);

      expect(timeline.unplacedPaces).toBe(1);
    });

    it("reports a recorded pace whose interval runs backwards", () => {
      // A backwards interval means the action log is not in time order, and
      // the pacing built from it is wrong in both directions: this pair
      // contributes nothing, and the pair after it claims dead air this one
      // already covered. `idleTargetMsFor` floors the negative so the output
      // cursor still walks forwards — a floor that, alone, renders a longer
      // video and says nothing about why.
      const bundle = replayBundleWithMarkers([
        { actionId: "a1", sourceTimeMs: 0 },
        { actionId: "a2", sourceTimeMs: 400 },
      ]);
      const plan = planWith({
        paces: [
          {
            afterActionId: "a1",
            beforeActionId: "a2",
            origin: "recorded",
            recordedSpanMs: -18453,
          },
        ],
      });
      const timeline = buildTimeline(plan, bundle);

      expect(timeline.nonMonotonicPaces).toBe(1);
      // Still forwards: the count is a report, not a change of behaviour.
      expect(timeline.outputDurationMs).toBeGreaterThanOrEqual(400);
    });

    it("counts no backwards pace for a log that ascends", () => {
      const bundle = replayBundleWithMarkers([
        { actionId: "a1", sourceTimeMs: 0 },
        { actionId: "a2", sourceTimeMs: 400 },
      ]);
      const plan = planWith({
        paces: [
          {
            afterActionId: "a1",
            beforeActionId: "a2",
            origin: "recorded",
            recordedSpanMs: 3000,
          },
        ],
      });

      expect(buildTimeline(plan, bundle).nonMonotonicPaces).toBe(0);
    });

    it("does not invent pacing for a plan that never computed any", () => {
      const bundle = replayBundleWithMarkers([
        { actionId: "a1", sourceTimeMs: 0 },
        { actionId: "a2", sourceTimeMs: 400 },
      ]);
      const timeline = buildTimeline(planWith({ paces: null }), bundle);

      expect(timeline.segments.filter((s) => s.kind === "pace")).toHaveLength(
        0,
      );
      expect(timeline.unplacedPaces).toBe(0);
    });

    it("measures an authored gap against the replay's idle, never its whole span", () => {
      // The pair took 1600ms in the rebuild: 1200ms of the app actually
      // moving, then 400ms of dead air before the automation fired the next
      // step. An authored gap names the IDLE stretch only (spec §1's Global
      // Constraint), so a 500ms gap asks for 500ms of dead air and the
      // shortfall is 500 − 400 = 100.
      //
      // Measured against the whole 1600ms span — which is what this did
      // until 2026-09-08 — `max(0, 500 − 1600)` floors to nothing and the
      // gap silently does not happen. That is the failing half of the
      // cross-mode table below, stated on its own so a regression names
      // itself here first.
      const replayed = replayBundleWithMarkers([
        { actionId: "a1", sourceTimeMs: 0 },
        { actionId: "a2", sourceTimeMs: 1600 },
      ]);
      const motion: TimeSpan[] = [{ startMs: 0, endMs: 1200 }];
      const timeline = buildTimeline(
        planWith({
          paces: [
            {
              afterActionId: "a1",
              beforeActionId: "a2",
              origin: "authored",
              idleTargetMs: 500,
            },
          ],
        }),
        replayed,
        motion,
      );

      // Fixture guards. Without motion inside the pair the whole span IS the
      // idle, and the broken arithmetic and the correct one coincide — this
      // test would then pass either way. And an `origin: "authored"` pace on
      // a REPLAY bundle is the combination the branch never exercised.
      expect(replayed.source).toBe("replay");
      expect(
        timeline.segments.filter((s) => s.kind === "motion").length,
      ).toBeGreaterThan(0);

      const pace = timeline.segments.filter((s) => s.kind === "pace");
      expect(pace).toHaveLength(1);
      const [first] = pace;
      if (!first) throw new Error("unreachable");
      expect(first.outEndMs - first.outStartMs).toBeCloseTo(100, 0);
    });

    // Addendum note (not a separate scenario): every case above already puts
    // a2's marker exactly at replayBundleWithMarkers's last keyframe, so
    // a2's resolved pace instant IS sourceDurationMs — the terminal instant,
    // never any raw segment's srcStartMs. "inserts the shortfall..." above
    // is what would go red without buildTimeline's post-loop
    // emitPacesAt(sourceDurationMs) call (mirroring emitHoldsAt's own).

    it("reconstructs no pace on a real-time replay, whose source already holds it", () => {
      const sampled = replayBundleWithMarkers([
        { actionId: "a1", sourceTimeMs: 0 },
        { actionId: "a2", sourceTimeMs: 400 },
      ]);
      const recorded = planWith({
        paces: [
          {
            afterActionId: "a1",
            beforeActionId: "a2",
            origin: "recorded",
            recordedSpanMs: 3000,
          },
        ],
      });
      // The control: the same bundle, sampled, does get its freeze.
      expect(
        buildTimeline(recorded, sampled).segments.some(
          (s) => s.kind === "pace",
        ),
      ).toBe(true);
      const real = { ...sampled, timing: "real" as const };
      expect(
        buildTimeline(recorded, real).segments.some((s) => s.kind === "pace"),
      ).toBe(false);
    });

    it("applies an authored gap to a real-time replay's idle, as on a capture", () => {
      // No motion spans: the whole 1000ms between the markers is idle.
      const sampled = replayBundleWithMarkers([
        { actionId: "a1", sourceTimeMs: 0 },
        { actionId: "a2", sourceTimeMs: 1000 },
      ]);
      expect(sampled.motionSpans).toEqual([]);
      const authored = planWith({
        paces: [
          {
            afterActionId: "a1",
            beforeActionId: "a2",
            origin: "authored",
            idleTargetMs: 300,
          },
        ],
      });
      const between = (t: Timeline) => toOutputMs(t, 1000) - toOutputMs(t, 0);
      // Sampled replay: an authored gap is a floor, and 1000 already clears 300.
      expect(between(buildTimeline(authored, sampled))).toBeCloseTo(1000, 6);
      // Real time: the idle is rescaled to the authored 300, as capture does.
      const real = { ...sampled, timing: "real" as const };
      expect(between(buildTimeline(authored, real))).toBeCloseTo(300, 6);
    });

    // Review 2026-10-03 #1: a gap the engine waited out live is in source
    // time already; one the author changed since is a new instruction.
    it("applies an authored gap once: not again where the engine paced it live", () => {
      // 1400ms between the markers: the walk's own locate, path and settle
      // ran past the 1000ms it was asked to leave.
      const real: FrameBundle = {
        ...replayBundleWithMarkers([
          { actionId: "a1", sourceTimeMs: 0 },
          { actionId: "a2", sourceTimeMs: 1400 },
        ]),
        timing: "real",
        pacedGaps: [{ afterActionId: "a1", durationMs: 1000 }],
      };
      const gapOf = (idleTargetMs: number) =>
        planWith({
          paces: [
            {
              afterActionId: "a1",
              beforeActionId: "a2",
              origin: "authored",
              idleTargetMs,
            },
          ],
        });
      const between = (t: Timeline) => toOutputMs(t, 1400) - toOutputMs(t, 0);
      // The control: with nothing paced live, the 1400 is rescaled to 1000.
      const unpaced = { ...real, pacedGaps: undefined };
      expect(between(buildTimeline(gapOf(1000), unpaced))).toBeCloseTo(1000, 6);
      // Paced live at 1000: the source plays as it is, the gap not again.
      expect(between(buildTimeline(gapOf(1000), real))).toBeCloseTo(1400, 6);
      // Edited to 300 since: a new instruction, rescaled as on a capture.
      expect(between(buildTimeline(gapOf(300), real))).toBeCloseTo(300, 6);
    });

    // Review 2026-10-03 #5: a removed occlusion pause is not idle that
    // plays, so it must not take a share of the authored gap.
    it("gives an authored gap whole to the idle a removed pause leaves", () => {
      const real: FrameBundle = {
        ...replayBundleWithMarkers([
          { actionId: "a1", sourceTimeMs: 0 },
          { actionId: "a2", sourceTimeMs: 5000 },
        ]),
        timing: "real",
        degradations: [
          {
            startMs: 1000,
            endMs: 4500,
            kind: "occlusionPause",
            note: "the replay window was covered for 3.5 s and the run waited for it",
          },
        ],
      };
      const authored = planWith({
        paces: [
          {
            afterActionId: "a1",
            beforeActionId: "a2",
            origin: "authored",
            idleTargetMs: 1000,
          },
        ],
      });
      const t = buildTimeline(authored, real);
      // The premise: the pause is removed, and nothing moved in the pair.
      expect(t.interruptions).toEqual([{ startMs: 1000, endMs: 4500 }]);
      expect(real.motionSpans).toEqual([]);
      expect(toOutputMs(t, 5000) - toOutputMs(t, 0)).toBeCloseTo(1000, 6);
    });
  });
});

/**
 * The branch's thesis, stated as an assertion.
 *
 * Spec §1: "mode is a render-time toggle, changeable after the fact… One
 * policy read by both modes means the toggle changes provenance and nothing
 * else." Nothing anywhere compared the two modes' `outputDurationMs` until
 * 2026-09-08, and the property did not hold: every authored gap rendered a
 * video whose length differed between the modes by exactly the motion
 * duration inside the paced stretch.
 *
 * The two bundles below are the same take seen twice. The app took the same
 * 1200ms to respond in both — that is what makes them comparable at all, and
 * it is the honest limit of the claim: where the rebuild's own motion
 * genuinely differs from the recording's, the videos differ by that
 * difference, which is provenance rather than policy. What must NOT differ
 * is anything the pacing policy decides.
 */
describe("one pacing policy, two render modes", () => {
  const APP_MOTION_MS = 1200;
  const RECORDED_SPAN_MS = 6200;
  // The rebuild reproduced the app's 1200ms response and then raced: 400ms
  // of dead air where the author left 5000.
  const REPLAY_SPAN_MS = 1600;

  const motionSpan = (endMs: number) => ({
    byteLength: 0,
    startMs: 0,
    endMs,
    ref: "m",
    width: 2560,
    height: 1600,
    fps: 60,
  });

  const twoStepScene = (gapMs: number | null): SceneDocument => {
    const base = readonlyScene();
    const [first, , third] = base.actions;
    if (!first || !third) throw new Error("unreachable");
    return {
      ...base,
      actions: [
        { ...first, timestamp: 0 },
        { ...third, timestamp: RECORDED_SPAN_MS },
      ],
      edits: {
        ...base.edits,
        gaps:
          gapMs === null
            ? []
            : [{ id: "g1", afterActionId: first.id, durationMs: gapMs }],
      },
    };
  };

  const modeBundle = (source: "capture" | "replay"): FrameBundle => {
    const spanMs = source === "capture" ? RECORDED_SPAN_MS : REPLAY_SPAN_MS;
    return bundle({
      source,
      keyframes: [
        {
          byteLength: 0,
          sourceTimeMs: 0,
          ref: "k0",
          width: 3840,
          height: 2400,
          actionId: null,
        },
        {
          byteLength: 0,
          sourceTimeMs: spanMs,
          ref: "k1",
          width: 3840,
          height: 2400,
          actionId: "act-3",
        },
      ],
      motionSpans: [motionSpan(APP_MOTION_MS)],
      markers: [
        { actionId: "act-1", sourceTimeMs: 0 },
        { actionId: "act-3", sourceTimeMs: spanMs },
      ],
    });
  };

  const recording = modeBundle("capture");
  const rebuild = modeBundle("replay");

  const lengthOf = (gapMs: number | null, mode: FrameBundle): number =>
    buildTimeline(planScene(twoStepScene(gapMs)), mode).outputDurationMs;

  it("carries the fixture the comparison depends on", () => {
    // Assert the fixture, not only the picture it produces. Both bundles
    // must carry the SAME motion duration — with none, or with different
    // amounts, the two modes would be allowed to differ and every row below
    // would go green without saying anything.
    expect(recording.source).toBe("capture");
    expect(rebuild.source).toBe("replay");
    for (const mode of [recording, rebuild]) {
      const spans = motionSpansOf(mode);
      expect(spans).toEqual([{ startMs: 0, endMs: APP_MOTION_MS }]);
    }
    // And the two really are different renders of it: the rebuild raced.
    expect(rebuild.markers[1]?.sourceTimeMs).toBeLessThan(
      recording.markers[1]?.sourceTimeMs ?? 0,
    );
    // The scene's gap has to reach the plan as an AUTHORED pace, or the
    // rows below are all testing the recorded path twice.
    expect(planScene(twoStepScene(500)).paces).toEqual([
      {
        afterActionId: "act-1",
        beforeActionId: "act-3",
        origin: "authored",
        idleTargetMs: 500,
      },
    ]);
  });

  // motion + the idle the policy asks for, in both modes. The unedited row
  // was already right before this fix, which is why the plan's own manual
  // check missed it.
  const rows: { name: string; gapMs: number | null; expectedMs: number }[] = [
    { name: "no edit", gapMs: null, expectedMs: RECORDED_SPAN_MS },
    { name: "a gap shorter than the recording", gapMs: 500, expectedMs: 1700 },
    {
      name: "a gap longer than the recording",
      gapMs: 10_000,
      expectedMs: 11_200,
    },
  ];

  for (const row of rows) {
    it(`renders the same length in both modes: ${row.name}`, () => {
      const asRecording = lengthOf(row.gapMs, recording);
      const asRebuild = lengthOf(row.gapMs, rebuild);
      expect(asRecording).toBeCloseTo(row.expectedMs, 0);
      expect(asRebuild).toBeCloseTo(row.expectedMs, 0);
      expect(asRebuild).toBeCloseTo(asRecording, 0);
    });
  }

  it("leaves the app's own motion at rate 1.0 in both modes", () => {
    // The equality above could also be bought by compressing motion, which
    // v8 §4 forbids outright. Both modes must reach it the honest way.
    for (const mode of [recording, rebuild]) {
      const timeline = buildTimeline(planScene(twoStepScene(500)), mode);
      const motion = timeline.segments.filter((s) => s.kind === "motion");
      expect(motion.length).toBeGreaterThan(0);
      let motionMs = 0;
      for (const seg of motion) {
        expect(seg.outEndMs - seg.outStartMs).toBeCloseTo(
          seg.srcEndMs - seg.srcStartMs,
          6,
        );
        motionMs += seg.srcEndMs - seg.srcStartMs;
      }
      expect(motionMs).toBeCloseTo(APP_MOTION_MS, 0);
    }
  });
});

describe("toSourceMs", () => {
  const timeline: Timeline = buildTimeline(
    plan,
    bundle({
      motionSpans: [
        {
          byteLength: 0,
          startMs: 400,
          endMs: 3200,
          ref: "m",
          width: 2560,
          height: 1600,
          fps: 60,
        },
      ],
    }),
  );

  it("is monotone non-decreasing across the whole output", () => {
    let previous = -1;
    for (let out = 0; out <= timeline.outputDurationMs; out += 5) {
      const src = toSourceMs(timeline, out);
      expect(src).toBeGreaterThanOrEqual(previous);
      previous = src;
    }
  });

  it("pins the endpoints", () => {
    expect(toSourceMs(timeline, 0)).toBeCloseTo(0, 6);
    expect(toSourceMs(timeline, timeline.outputDurationMs)).toBeCloseTo(
      timeline.sourceDurationMs,
      6,
    );
  });

  it("clamps outside the timeline rather than extrapolating", () => {
    expect(toSourceMs(timeline, -500)).toBe(0);
    expect(toSourceMs(timeline, timeline.outputDurationMs + 500)).toBeCloseTo(
      timeline.sourceDurationMs,
      6,
    );
  });
});

describe("toOutputMs", () => {
  // Same timeline as the toSourceMs block: one idle gap, one motion span at
  // rate 1.0, one more idle gap.
  const timeline: Timeline = buildTimeline(
    plan,
    bundle({
      motionSpans: [
        {
          byteLength: 0,
          startMs: 400,
          endMs: 3200,
          ref: "m",
          width: 2560,
          height: 1600,
          fps: 60,
        },
      ],
    }),
  );

  it("is the inverse of toSourceMs at every segment boundary", () => {
    for (const segment of timeline.segments) {
      expect(toOutputMs(timeline, segment.srcStartMs)).toBeCloseTo(
        segment.outStartMs,
        6,
      );
      expect(toOutputMs(timeline, segment.srcEndMs)).toBeCloseTo(
        segment.outEndMs,
        6,
      );
    }
  });

  // Round-tripping through toSourceMs only stays exact where the map is
  // strictly increasing in both directions. Off the motion span the idle
  // gaps are compressed (a large source span onto a small output span), so
  // sweeping there and asserting only rounds to the compression step would
  // be asserting a weaker, fuzzier property. Inside the motion span the
  // segment runs at rate 1.0 (src and out spans are equal), so the linear
  // maps in each direction are exact inverses and the round trip holds to
  // full float precision.
  it("round-trips with toSourceMs across the motion span, where the rate is 1.0", () => {
    const motion = timeline.segments.find((s) => s.kind === "motion");
    expect(motion).toBeDefined();
    if (!motion) return;
    for (let out = motion.outStartMs; out <= motion.outEndMs; out += 50) {
      const src = toSourceMs(timeline, out);
      expect(toOutputMs(timeline, src)).toBeCloseTo(out, 6);
    }
  });

  it("is monotone non-decreasing across the whole source range", () => {
    let previous = -1;
    for (let src = 0; src <= timeline.sourceDurationMs; src += 25) {
      const out = toOutputMs(timeline, src);
      expect(out).toBeGreaterThanOrEqual(previous);
      previous = out;
    }
  });

  it("pins the endpoints", () => {
    expect(toOutputMs(timeline, 0)).toBeCloseTo(0, 6);
    expect(toOutputMs(timeline, timeline.sourceDurationMs)).toBeCloseTo(
      timeline.outputDurationMs,
      6,
    );
  });

  it("clamps outside the timeline rather than extrapolating", () => {
    expect(toOutputMs(timeline, -500)).toBe(0);
    expect(toOutputMs(timeline, timeline.sourceDurationMs + 500)).toBeCloseTo(
      timeline.outputDurationMs,
      6,
    );
  });
});

describe("interruptions (real-time replay)", () => {
  // No paces: this is about removal, and a paced plan would rescale idle
  // around the removed stretch and blur the arithmetic.
  const unpaced: RenderPlan = { ...plan, paces: null };
  const covered = {
    startMs: 1000,
    endMs: 3000,
    kind: "occlusionPause" as const,
    note: "the replay window was covered for 2.0 s and the run waited for it",
  };

  it("removes a recovered occlusion pause from the output axis", () => {
    const base = bundle({ timing: "real" });
    const interrupted = bundle({ timing: "real", degradations: [covered] });
    const t = buildTimeline(unpaced, interrupted);
    expect(t.interruptions).toEqual([{ startMs: 1000, endMs: 3000 }]);
    expect(
      buildTimeline(unpaced, base).outputDurationMs - t.outputDurationMs,
    ).toBeCloseTo(2000, 6);
    // The author's cuts stay the author's.
    expect(t.cuts).toEqual([]);
  });

  it("leaves a sampled replay's occlusion pause where it is", () => {
    const t = buildTimeline(unpaced, bundle({ degradations: [covered] }));
    expect(t.interruptions).toEqual([]);
    expect(t.outputDurationMs).toBeCloseTo(
      buildTimeline(unpaced, bundle()).outputDurationMs,
      6,
    );
  });

  it("does not remove twice what an authored cut already removes", () => {
    // The cut runs act-2 (3200) to act-3 (9000); the pause is 3000-4000, so
    // only 3000-3200 is the interruption's own.
    const cutPlan: RenderPlan = {
      ...unpaced,
      removed: [
        {
          id: "cut-1",
          start: { actionId: "act-2", sourceOffsetMs: 0 },
          end: { actionId: "act-3", sourceOffsetMs: 0 },
        },
      ],
    };
    const pause = { ...covered, startMs: 3000, endMs: 4000 };
    const base = buildTimeline(cutPlan, bundle({ timing: "real" }));
    const t = buildTimeline(
      cutPlan,
      bundle({ timing: "real", degradations: [pause] }),
    );
    expect(t.cuts.length).toBe(1);
    expect(t.interruptions).toEqual([{ startMs: 3000, endMs: 3200 }]);
    expect(base.outputDurationMs - t.outputDurationMs).toBeCloseTo(200, 6);
  });
});
