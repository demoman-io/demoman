import type { FrameBundle } from "@demoman/compositor";
import { planScene, resolvePlan, toOutputMs } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import {
  captureBundle,
  proceduralBundle,
  stillCursorBundle,
} from "../../../../../packages/replay-engine/test/helpers/bundles";
import {
  readonlyScene,
  redactedScene,
  sceneWithNavigationWait,
} from "../../../../../packages/replay-engine/test/helpers/scenes";
import { applyCommand } from "../../../pages/src/editor/commands";
import {
  anchorLabel,
  buildTimelineView,
} from "../../../pages/src/editor/timeline";

function ids(): () => string {
  let n = 0;
  return () => `gen-${++n}`;
}

function viewOf(scene = readonlyScene()) {
  const bundle = proceduralBundle();
  return buildTimelineView({
    scene,
    bundle,
    resolved: resolvePlan(planScene(scene), bundle, scene),
  });
}

describe("buildTimelineView", () => {
  it("produces one beat per action, in order", () => {
    expect(viewOf().beats.map((b) => b.actionId)).toEqual([
      "act-1",
      "act-2",
      "act-3",
    ]);
  });

  it("places each beat at its real output time, retiming included", () => {
    const view = viewOf();
    const beats = view.beats;
    const scene = readonlyScene();
    const bundle = proceduralBundle();
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const timeline = resolved.timeline;
    const markerSourceMs = new Map(
      (bundle.markers ?? []).map((m) => [m.actionId, m.sourceTimeMs] as const),
    );

    // Every beat's outputMs equals toOutputMs at that marker's sourceTimeMs
    for (const beat of beats) {
      const sourceMs =
        markerSourceMs.get(beat.actionId) ??
        scene.actions.find((a) => a.id === beat.actionId)?.timestamp ??
        0;
      expect(beat.outputMs).toBe(toOutputMs(timeline, sourceMs));
    }

    // Beat positions are strictly increasing
    for (let i = 1; i < beats.length; i++) {
      expect((beats[i]?.outputMs ?? 0) > (beats[i - 1]?.outputMs ?? 0)).toBe(
        true,
      );
    }

    // Last beat's outputMs is never past the end of the video
    expect(beats[beats.length - 1]?.outputMs ?? 0).toBeLessThanOrEqual(
      timeline.outputDurationMs,
    );
  });

  // Auto-zoom-on-click used to put a camera on this beat whether or not the
  // author had asked for one, and `origin` was how the lane told the two
  // apart. Nothing generates a zoom now, so an empty camera is an empty
  // camera and there is no second kind to distinguish.
  it("carries no camera for a beat the author never zoomed", () => {
    const beat = viewOf().beats.find((b) => b.actionId === "act-3");
    expect(beat?.camera).toBeNull();
  });

  it("carries an authored zoom's scale", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-3", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-checkout" },
        scale: 2.2,
      },
      ids(),
    );
    const beat = viewOf(scene).beats.find((b) => b.actionId === "act-3");
    expect(beat?.camera).toEqual({ id: "gen-1", scale: 2.2, offsetMs: -350 });
  });

  // A zoom needs somewhere to aim. The lane offers the toggle from this, so
  // that a beat which cannot carry one says why instead of silently lacking
  // a control.
  it("marks a null-anchor beat as unable to carry a zoom", () => {
    const beats = viewOf(sceneWithNavigationWait()).beats;
    expect(beats.find((b) => b.actionId === "act-nav")?.canZoom).toBe(false);
    expect(beats.find((b) => b.actionId === "act-3")?.canZoom).toBe(true);
  });

  it("carries an authored gap on the beat it comes after", () => {
    const scene = applyCommand(
      readonlyScene(),
      { kind: "setGap", afterActionId: "act-2", durationMs: 800 },
      ids(),
    );
    const beats = viewOf(scene).beats;
    expect(beats.find((b) => b.actionId === "act-2")?.gap).toEqual({
      durationMs: 800,
    });
    // And nowhere else: a gap belongs to one stretch, not to the take.
    expect(beats.find((b) => b.actionId === "act-1")?.gap).toBeNull();
    expect(beats.find((b) => b.actionId === "act-3")?.gap).toBeNull();
  });

  describe("canPace — where a pause is worth offering", () => {
    // Spec §1: "a pair of steps with no idle between them has no gap to
    // author, and the editor offers no handle there rather than offering one
    // that silently does nothing." On a capture bundle `authoredPaceCovering`
    // only matches IDLE segments, so a stretch that is motion end to end
    // never has the authored target applied to it.
    const allMotionCapture = () => ({
      ...captureBundle(),
      sceneId: "scene-readonly-001",
      motionSpans: [
        {
          startMs: 400,
          endMs: 3200,
          ref: "m-0",
          width: 2560,
          height: 1600,
          fps: 60,
          byteLength: 0,
        },
      ],
    });

    const captureViewOf = (bundle: FrameBundle = allMotionCapture()) => {
      const scene = readonlyScene();
      return buildTimelineView({
        scene,
        bundle,
        resolved: resolvePlan(planScene(scene), bundle, scene),
      });
    };

    // A real-time rebuild's source time is real, as a recording's is, so the
    // pause control is offered on the same terms: only where idle exists.
    const realTimeRebuild = (): FrameBundle => ({
      ...allMotionCapture(),
      source: "replay",
      timing: "real",
      cursorSamples: [{ sourceTimeMs: 0, x: 0, y: 0 }],
    });

    it("withholds the pause on a real-time rebuild's stretch with no idle, as on a recording", () => {
      const view = captureViewOf(realTimeRebuild());
      expect(view.beats.find((b) => b.actionId === "act-1")?.canPace).toBe(
        false,
      );
      expect(view.beats.find((b) => b.actionId === "act-2")?.canPace).toBe(
        true,
      );
    });

    // Review 2026-10-03 #1: a gap the engine waited out live is honoured
    // whatever moved inside it — it is in source time. Withholding its
    // control would hide a pause that is playing.
    it("keeps offering a pause the rebuild waited out live, though nothing in it is idle", () => {
      const bundle: FrameBundle = {
        ...realTimeRebuild(),
        pacedGaps: [{ afterActionId: "act-1", durationMs: 2800 }],
      };
      // The premise: the stretch is motion end to end, which without the
      // live pace is what withholds it (the test above).
      expect(
        captureViewOf(realTimeRebuild()).beats.find(
          (b) => b.actionId === "act-1",
        )?.canPace,
      ).toBe(false);
      expect(
        captureViewOf(bundle).beats.find((b) => b.actionId === "act-1")
          ?.canPace,
      ).toBe(true);
    });

    it("reports no reconstructed freeze on a real-time rebuild", () => {
      const view = captureViewOf(realTimeRebuild());
      const beat = view.beats.find((b) => b.actionId === "act-2");
      expect(beat?.renderedPaceFreezeMs).toBeNull();
      expect(beat?.renderedFreezeBeforeMs).toBe(0);
    });

    it("withholds the pause on a stretch a capture bundle finds no idle in", () => {
      const view = captureViewOf();
      // act-1 → act-2 (markers 400 → 3200) is covered end to end by the
      // motion span, so there is nothing for `idleOutputFor` to stretch.
      expect(view.beats.find((b) => b.actionId === "act-1")?.canPace).toBe(
        false,
      );
      // act-2 → act-3 (3200 → 9000) has no motion over it at all, so it does.
      expect(view.beats.find((b) => b.actionId === "act-2")?.canPace).toBe(
        true,
      );
    });

    it("never offers a pause on the take's last beat", () => {
      expect(viewOf().beats.find((b) => b.actionId === "act-3")?.canPace).toBe(
        false,
      );
    });

    it("keeps offering it on a rebuild, where idle is not what decides", () => {
      // `paceInstants` reconstructs `max(0, targetMs − replayElapsed)` with
      // no reference to idle at all, and a replay bundle's idle is synthetic
      // re-render time rather than the author's. Gating on it would withhold
      // a control that works. `proceduralBundle` is `source: "replay"` and
      // carries a motion span over 3200–4000.
      expect(proceduralBundle().source).toBe("replay");
      expect(viewOf().beats.find((b) => b.actionId === "act-1")?.canPace).toBe(
        true,
      );
    });

    it("offers it before anything has been rendered, rather than guessing", () => {
      // No bundle means no idle split to consult. Withholding on a guess
      // would take the control away from every take that has not been
      // developed yet.
      const view = buildTimelineView({
        scene: readonlyScene(),
        bundle: null,
        resolved: null,
      });
      expect(view.beats.find((b) => b.actionId === "act-1")?.canPace).toBe(
        true,
      );
      expect(view.beats.find((b) => b.actionId === "act-3")?.canPace).toBe(
        false,
      );
    });
  });

  it("carries a legacy hold the migration refused to convert", () => {
    // Terminal and mid-clip holds survive `migrateHoldsToGaps` and still
    // render through `plan.holds`. `BeatView` carries them so the editor can
    // say so — a pause in the video the editor names nowhere is the picture
    // and the editor disagreeing with nothing said.
    const scene = readonlyScene();
    const held = {
      ...scene,
      edits: {
        ...scene.edits,
        holds: [
          {
            id: "h-1",
            marker: { actionId: "act-3", offsetMs: 0 },
            durationMs: 800,
          },
        ],
      },
    };
    const beats = viewOf(held).beats;
    expect(beats.find((b) => b.actionId === "act-3")?.legacyHold).toEqual({
      offsetMs: 0,
      durationMs: 800,
    });
    expect(beats.find((b) => b.actionId === "act-1")?.legacyHold).toBeNull();
  });

  it("distinguishes a zero gap from no gap at all", () => {
    // Null means "play back the recorded pause"; zero means "no pause here".
    // Collapsing them is how the author loses the ability to say either.
    const scene = applyCommand(
      readonlyScene(),
      { kind: "setGap", afterActionId: "act-2", durationMs: 0 },
      ids(),
    );
    expect(
      viewOf(scene).beats.find((b) => b.actionId === "act-2")?.gap,
    ).toEqual({ durationMs: 0 });
  });

  it("flags a redacted type so the author learns it here, not from a failed replay", () => {
    const scene = redactedScene();
    const bundle = proceduralBundle();
    const view = buildTimelineView({
      scene,
      bundle,
      resolved: resolvePlan(planScene(scene), bundle, scene),
    });
    expect(view.beats[0]).toMatchObject({ redacted: true, text: null });
  });

  it("marks only the final beat as last, so trims can be offered honestly", () => {
    expect(viewOf().beats.map((b) => b.isLast)).toEqual([false, false, true]);
  });

  it("works with no bundle at all", () => {
    const view = buildTimelineView({ scene: readonlyScene(), resolved: null });
    expect(view.hasBundle).toBe(false);
    expect(view.beats).toHaveLength(3);
    expect(view.beats.every((b) => b.outputMs === null)).toBe(true);
    expect(view.outputDurationMs).toBeNull();
  });

  it("plays dead air back verbatim rather than compressing it", () => {
    // This test used to assert the opposite. The idle clamp that squeezed
    // every pause to at most 400ms was deleted on 2026-09-08 (spec §1): the
    // time an author leaves between two steps is part of the demo, so with
    // nothing authored every beat lands on its own recorded instant.
    // Restoring the clamp turns each of these equalities red.
    const scene = readonlyScene();
    const bundle = stillCursorBundle();
    const view = buildTimelineView({
      scene,
      bundle,
      resolved: resolvePlan(planScene(scene), bundle, scene),
    });
    const markerSourceMs = new Map(
      bundle.markers.map((m) => [m.actionId, m.sourceTimeMs] as const),
    );
    // Fixture guard: the beats really do sit far enough apart for a clamp to
    // have had something to remove. Without it the equalities below could go
    // green against a take with no dead air in it at all.
    expect(markerSourceMs.get("act-3")).toBeGreaterThan(5000);
    expect(view.beats).toHaveLength(3);
    for (const beat of view.beats) {
      expect(beat.outputMs).toBe(markerSourceMs.get(beat.actionId));
    }
  });
});

describe("beat timing provenance", () => {
  it("marks a beat the bundle has no marker for as estimated", () => {
    const scene = readonlyScene();
    // A replay that stopped after act-2: act-3 was never reached, so no
    // marker was recorded for it.
    const bundle = proceduralBundle({
      markers: [
        { actionId: "act-1", sourceTimeMs: 400 },
        { actionId: "act-2", sourceTimeMs: 3200 },
      ],
    });
    const view = buildTimelineView({
      scene,
      bundle,
      resolved: resolvePlan(planScene(scene), bundle, scene),
    });
    expect(view.beats.map((b) => b.timing)).toEqual([
      "rendered",
      "rendered",
      "estimated",
    ]);
  });

  it("marks every beat rendered when every marker is present", () => {
    expect(viewOf().beats.map((b) => b.timing)).toEqual([
      "rendered",
      "rendered",
      "rendered",
    ]);
  });

  it("marks every beat estimated when there is no bundle at all", () => {
    const scene = readonlyScene();
    const view = buildTimelineView({ scene, bundle: null, resolved: null });
    expect(view.beats.every((b) => b.timing === "estimated")).toBe(true);
  });

  it("carries the capture timestamp so a bundle-less axis has somewhere to draw", () => {
    const scene = readonlyScene();
    const view = buildTimelineView({ scene, bundle: null, resolved: null });
    expect(view.beats.map((b) => b.captureMs)).toEqual([400, 3200, 9000]);
  });

  it("reports the SAME pause for one gap on either side of the mode toggle", () => {
    // The promise the whole gap concept exists to buy (spec §1): the toggle
    // changes provenance and nothing else. The two modes reach it by
    // completely different routes — a capture bundle retimes the pair's idle
    // segments in place (`idleOutputFor`), a rebuild leaves its own idle
    // alone and reconstructs the shortfall as a `"pace"` freeze on top of it
    // (`paceInstants`) — and `renderedPauseMs` returned only the freeze on
    // the rebuild until 2026-09-08, so the editor drew the same take's same
    // pause 7000 wide in one mode and 12000 in the other.
    const scene = readonlyScene();
    const paced = {
      ...scene,
      edits: {
        ...scene.edits,
        gaps: [{ id: "g-1", afterActionId: "act-2", durationMs: 12_000 }],
      },
    };
    const pauseOn = (bundle: FrameBundle) => {
      const resolved = resolvePlan(planScene(paced), bundle, paced);
      const view = buildTimelineView({ scene: paced, bundle, resolved });
      return {
        resolved,
        beat: view.beats.find((b) => b.actionId === "act-2"),
      };
    };
    const recording = pauseOn(stillCursorBundle({ source: "capture" }));
    const rebuild = pauseOn(stillCursorBundle());

    // Fixture guard: they really did get there differently. Without this a
    // pair of identical numbers proves nothing about either route.
    expect(
      recording.resolved.timeline.segments.filter((x) => x.kind === "pace"),
    ).toHaveLength(0);
    expect(
      rebuild.resolved.timeline.segments.filter((x) => x.kind === "pace"),
    ).toHaveLength(1);

    expect(recording.beat?.renderedPauseMs).toBeCloseTo(12_000, 6);
    expect(rebuild.beat?.renderedPauseMs).toBeCloseTo(12_000, 6);
    // And the freeze is a rebuild-only quantity: null where nothing is
    // reconstructed, so `data-gap-floored` cannot fire on a recording.
    expect(recording.beat?.renderedPaceFreezeMs).toBeNull();
    expect(rebuild.beat?.renderedPaceFreezeMs).toBeCloseTo(7000, 6);
  });

  it("reads a legacy row that predates edits.gaps rather than throwing", () => {
    // The frame store casts raw IndexedDB rows, so Zod's `.default([])` never
    // runs on a document written before either field existed —
    // `migrateHoldsToGaps` and `commands.ts` both write `?? []` for exactly
    // this. Unreachable through `scene-store.ts`'s `migrateToCurrent` today;
    // asserted because a row that reaches here without it took the whole
    // editor render down with a TypeError rather than degrading.
    const scene = readonlyScene();
    const legacy = {
      ...scene,
      edits: { masks: [] },
    } as unknown as typeof scene;
    const bundle = proceduralBundle();
    const resolved = resolvePlan(planScene(legacy), bundle, legacy);
    const view = buildTimelineView({ scene: legacy, bundle, resolved });
    expect(view.beats.map((b) => b.gap)).toEqual([null, null, null]);
    expect(view.beats.map((b) => b.legacyHold)).toEqual([null, null, null]);
  });
});

describe("anchorLabel", () => {
  it("prefers the accessible name", () => {
    expect(
      anchorLabel(readonlyScene().anchors.find((a) => a.id === "a-checkout")),
    ).toBe("a-checkout");
  });

  it("names a navigation wait rather than showing an empty row", () => {
    expect(anchorLabel(undefined)).toBe("(navigation)");
  });
});
