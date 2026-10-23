import {
  type FrameBundle,
  planScene,
  resolvePlan,
  sampleCursor,
  toOutputMs,
} from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { framesOf, takeOf } from "../../../replay-engine/test/helpers/film";
import { againstRecording } from "../../src/replay/fidelity.js";

const rect = (x: number, y: number) => ({ x, y, width: 100, height: 40 });

/** The recording: a scroll and a click, its trail resting at (900, 300) through the scroll. */
function recording() {
  const scene = takeOf(["scrollTo", "click"]);
  scene.actions[0] = {
    ...scene.actions[0],
    rect: rect(215, 318),
  } as (typeof scene.actions)[number];
  scene.actions[1] = {
    ...scene.actions[1],
    rect: rect(747, 514),
  } as (typeof scene.actions)[number];
  const bundle: FrameBundle = framesOf({
    source: "capture",
    markers: [
      { actionId: "act-1", sourceTimeMs: 1000 },
      { actionId: "act-2", sourceTimeMs: 2000 },
    ],
    cursorSamples: [
      { sourceTimeMs: 900, x: 900, y: 300 },
      { sourceTimeMs: 1100, x: 900, y: 300 },
      { sourceTimeMs: 1990, x: 798, y: 534 },
    ],
  });
  return { scene, bundle };
}

/** A re-shoot of it: the scroll landed 352px short; the cursor matched. */
function reshoot() {
  const rec = recording();
  const bundle = framesOf({
    markers: [
      { actionId: "act-1", sourceTimeMs: 1500 },
      { actionId: "act-2", sourceTimeMs: 3500 },
    ],
    anchorRects: [
      {
        actionId: "act-1",
        anchorId: "a1",
        rect: { ...rect(215, 318), y: -34 },
      },
      { actionId: "act-2", anchorId: "a2", rect: rect(747, 514) },
    ],
    cursorSamples: [
      { sourceTimeMs: 1400, x: 900, y: 300 },
      // Holds the pose through the marker at 1500: the cursor is linearly
      // interpolated between samples, so without this it would be mid-travel.
      { sourceTimeMs: 1600, x: 900, y: 300 },
      { sourceTimeMs: 3400, x: 798, y: 534 },
    ],
  });
  expect(sampleCursor(bundle.cursorSamples, 1500)).toMatchObject({
    x: 900,
    y: 300,
  });
  const links = rec.scene.actions.map((a) => ({
    runActionId: a.id,
    recordedActionId: a.id,
  }));
  return { rec, run: { scene: rec.scene, bundle, links, unlinked: [] } };
}

describe("againstRecording", () => {
  it("reports each step's landing, cursor and pace against the recording", () => {
    const { rec, run } = reshoot();
    const report = againstRecording(run, rec);
    if ("unavailable" in report) throw new Error(report.unavailable);
    expect(report.recordingTakeId).toBe(rec.scene.meta.id);
    expect(report.steps[0]?.landing).toEqual({ dx: 0, dy: -352 });
    expect(report.steps[1]?.landing).toEqual({ dx: 0, dy: 0 });
    expect(report.steps[0]?.cursor).toMatchObject({ distancePx: 0 });
    expect(report.steps[0]?.pace).toEqual({ unavailable: "firstStep" });
    // Each film's gap, worked out here through the film's own timeline.
    const outputGap = (scene: SceneDocument, bundle: FrameBundle) => {
      const { timeline } = resolvePlan(planScene(scene), bundle, scene);
      const at = (id: string) => {
        const m = bundle.markers.find((k) => k.actionId === id);
        if (m === undefined) throw new Error(`no marker ${id}`);
        return toOutputMs(timeline, m.sourceTimeMs);
      };
      return at("act-2") - at("act-1");
    };
    const recordedGap = outputGap(rec.scene, rec.bundle);
    const runGap = outputGap(run.scene, run.bundle);
    // Premise: the films differ, so a swapped or zeroed gap cannot pass.
    expect(Math.abs(runGap - recordedGap)).toBeGreaterThan(100);
    expect(report.steps[1]?.pace).toEqual({
      recordedGapMs: recordedGap,
      runGapMs: runGap,
      diffMs: runGap - recordedGap,
    });
  });

  it("says when the recording kept no trail, and still reports landing and pace", () => {
    const { rec, run } = reshoot();
    const trailless = { ...rec, bundle: { ...rec.bundle, cursorSamples: [] } };
    const report = againstRecording(run, trailless);
    if ("unavailable" in report) throw new Error(report.unavailable);
    expect(report.steps[1]?.cursor).toEqual({ unavailable: "noTrail" });
    expect(report.steps[1]?.landing).toEqual({ dx: 0, dy: 0 });
  });

  it("says when the trail has no sample near the step", () => {
    const { rec, run } = reshoot();
    const far = {
      ...rec,
      bundle: {
        ...rec.bundle,
        cursorSamples: [{ sourceTimeMs: 0, x: 1, y: 1 }],
      },
    };
    const report = againstRecording(run, far);
    if ("unavailable" in report) throw new Error(report.unavailable);
    expect(report.steps[1]?.cursor).toEqual({ unavailable: "noTrailNearStep" });
  });

  // Review Focus 5.
  it("lists the agent's own steps as not in the recording", () => {
    const { rec, run } = reshoot();
    const report = againstRecording(
      { ...run, links: run.links.slice(0, 1), unlinked: ["ac-9"] },
      rec,
    );
    if ("unavailable" in report) throw new Error(report.unavailable);
    expect(report.steps).toHaveLength(1);
    expect(report.notInRecording).toEqual(["ac-9"]);
  });

  it("does not measure a link whose recorded action is not in the recording", () => {
    const { rec, run } = reshoot();
    const links = [
      ...run.links,
      { runActionId: "act-2", recordedActionId: "act-99" },
    ];
    const report = againstRecording({ ...run, links, unlinked: ["ac-9"] }, rec);
    if ("unavailable" in report) throw new Error(report.unavailable);
    expect(report.steps.map((x) => x.recordedActionId)).toEqual([
      "act-1",
      "act-2",
    ]);
    expect(report.steps).toHaveLength(2);
    expect(report.notInRecording).toEqual(["ac-9", "act-2"]);
  });

  it("does not let an unmeasured link become the previous step for pace", () => {
    const { rec, run } = reshoot();
    // act-1's link names a missing action; act-2 is then the first measured.
    const links = [
      { runActionId: "act-1", recordedActionId: "act-99" },
      { runActionId: "act-2", recordedActionId: "act-2" },
    ];
    const report = againstRecording({ ...run, links }, rec);
    if ("unavailable" in report) throw new Error(report.unavailable);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]?.pace).toEqual({ unavailable: "firstStep" });
  });

  describe("names why a measure is unavailable", () => {
    const report = (
      run: ReturnType<typeof reshoot>["run"],
      rec: ReturnType<typeof reshoot>["rec"],
    ) => {
      const r = againstRecording(run, rec);
      if ("unavailable" in r) throw new Error(r.unavailable);
      return r;
    };

    it("landing: noRunRect", () => {
      const { rec, run } = reshoot();
      const bare = { ...run.bundle, anchorRects: [] };
      expect(rec.scene.actions[0]?.rect).toBeDefined();
      expect(report({ ...run, bundle: bare }, rec).steps[0]?.landing).toEqual({
        unavailable: "noRunRect",
      });
    });

    it("landing: noRecordedRect", () => {
      const { rec, run } = reshoot();
      const { rect: _gone, ...noRect } = rec.scene.actions[0] as never as {
        rect: unknown;
      };
      const scene = {
        ...rec.scene,
        actions: [noRect, ...rec.scene.actions.slice(1)],
      } as unknown as SceneDocument;
      expect(scene.actions[0]).toBeDefined();
      expect("rect" in (scene.actions[0] as object)).toBe(false);
      expect(report(run, { ...rec, scene }).steps[0]?.landing).toEqual({
        unavailable: "noRecordedRect",
      });
    });

    it("cursor: notInRunVideo, and pace: notInRunVideo, when the run has no marker", () => {
      const { rec, run } = reshoot();
      const bundle = {
        ...run.bundle,
        markers: run.bundle.markers.filter((m) => m.actionId !== "act-2"),
      };
      expect(rec.bundle.cursorSamples.length).toBeGreaterThan(0);
      const step = report({ ...run, bundle }, rec).steps[1];
      expect(step?.cursor).toEqual({ unavailable: "notInRunVideo" });
      expect(step?.pace).toEqual({ unavailable: "notInRunVideo" });
    });

    it("pace: notInRecordingVideo when the recording has no marker", () => {
      const { rec, run } = reshoot();
      const bundle = {
        ...rec.bundle,
        markers: rec.bundle.markers.filter((m) => m.actionId !== "act-2"),
      };
      expect(report(run, { ...rec, bundle }).steps[1]?.pace).toEqual({
        unavailable: "notInRecordingVideo",
      });
    });

    it("cursor: noRunCursor when the trail is near and the run kept none", () => {
      const { rec, run } = reshoot();
      const bundle = { ...run.bundle, cursorSamples: [] };
      expect(sampleCursor(bundle.cursorSamples, 1500)).toBeNull();
      // A trail sample within the window of act-1 (at 1000): 900 and 1100.
      expect(
        rec.bundle.cursorSamples.some((c) => c.sourceTimeMs === 1100),
      ).toBe(true);
      expect(report({ ...run, bundle }, rec).steps[0]?.cursor).toEqual({
        unavailable: "noRunCursor",
      });
    });
  });
});
