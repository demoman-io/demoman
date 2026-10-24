import {
  CAMERA_DEFAULTS,
  planScene,
  resolvePlan,
  toOutputMs,
} from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import {
  compressionBundle,
  proceduralBundle,
} from "../../../../../packages/replay-engine/test/helpers/bundles";
import {
  authoredScene,
  hoverScene,
  readonlyScene,
} from "../../../../../packages/replay-engine/test/helpers/scenes";
import { renderTakeNotes } from "../../../pages/entrypoints/editor/view";
import { applyCommand } from "../../../pages/src/editor/commands";
import {
  HOVER_CHECK_FAILED,
  type HoverReport,
} from "../../../pages/src/editor/hover-report";
import {
  buildLaneModel,
  CAPTURED_TAIL_MS,
  MOTION_RECLAIMED_LABEL,
  markerAt,
} from "../../../pages/src/editor/lanes";
import { buildTimelineView } from "../../../pages/src/editor/timeline";

const ids = () => {
  let n = 0;
  return () => `gen-${++n}`;
};

function modelOf(
  scene = readonlyScene(),
  bundle = proceduralBundle(),
  hoverReport: HoverReport | null = null,
) {
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const view = buildTimelineView({ scene, bundle, resolved });
  return {
    model: buildLaneModel({ scene, view, bundle, resolved, hoverReport }),
    resolved,
  };
}

describe("ticks", () => {
  it("puts one tick per step at its output instant, hovers included", () => {
    const { model, resolved } = modelOf(hoverScene());
    expect(model.clip.ticks.map((t) => t.actionId)).toEqual([
      "act-1",
      "act-2",
      "act-h",
      "act-3",
    ]);
    const act2 = model.clip.ticks[1];
    const marker = proceduralBundle().markers.find(
      (m) => m.actionId === "act-2",
    );
    expect(marker).toBeDefined();
    // On the OUTPUT axis: the marker's source instant mapped through the
    // timeline, not the source instant itself.
    expect(act2?.atMs).toBeCloseTo(
      toOutputMs(resolved.timeline, marker?.sourceTimeMs ?? 0),
      6,
    );
    expect(model.clip.ticks[2]?.timing).toBe("estimated"); // act-h has no marker
  });

  it("flags a hover the pixel check calls unchanged", () => {
    const { model } = modelOf(hoverScene(), proceduralBundle(), {
      checked: 1,
      unchecked: 0,
      removable: ["act-h"],
      failed: false,
    });
    expect(model.clip.ticks.find((t) => t.actionId === "act-h")?.flag).toBe(
      "unchangedHover",
    );
  });

  it("reports a rendered time source once a bundle exists", () => {
    // The "captured" half (no bundle, so nothing is measured) is exercised
    // by "still draws a zoom with no render, from the take's own
    // timestamps" below; every other test in this file resolves a bundle
    // and so exercises this path too, but without asserting it — a
    // `timeSource` that always read "captured" would pass every one of
    // them unnoticed.
    expect(modelOf().model.timeSource).toBe("rendered");
  });
});

describe("trim", () => {
  it("spans the whole take when untrimmed and follows the resolved range when not", () => {
    const { model } = modelOf();
    expect(model.clip.trim).toEqual({
      headMs: 0,
      headTiming: "rendered",
      tailMs: model.durationMs,
      tailTiming: "rendered",
      headMarker: null,
      tailMarker: null,
    });

    const scene = applyCommand(
      readonlyScene(),
      { kind: "setTrim", head: { actionId: "act-2", offsetMs: 300 } },
      ids(),
    );
    const { model: cut, resolved } = modelOf(scene);
    expect(cut.clip.trim.headMs).toBeCloseTo(resolved.range.startMs, 6);
    // The document's own marker, not one re-derived from the nearest tick:
    // `resolveGesture`'s trim collapse guard compares against it.
    expect(cut.clip.trim.headMarker).toEqual({
      actionId: "act-2",
      offsetMs: 300,
    });
    expect(cut.durationMs).toBe(model.durationMs); // the axis stays untrimmed
  });

  it("hatches a trim side whose step has no marker", () => {
    const scene = applyCommand(
      readonlyScene(),
      { kind: "setTrim", tail: { actionId: "act-3", offsetMs: -100 } },
      ids(),
    );
    const bundle = proceduralBundle({
      markers: proceduralBundle().markers.filter((m) => m.actionId !== "act-3"),
    });
    const { model } = modelOf(scene, bundle);
    expect(model.clip.trim.tailTiming).toBe("estimated");
  });
});

describe("zooms", () => {
  it("draws an un-authored end where the compositor returns to full frame", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      ids(),
    );
    const { model, resolved } = modelOf(scene);
    const seg = resolved.cameraSegments[0];
    expect(model.zooms).toEqual([
      {
        id: "gen-1",
        actionId: "act-2",
        departMs: seg?.departMs,
        startMs: seg?.startMs,
        endMs: seg?.endMs,
        drawnEndMs: seg?.endMs,
        endAuthored: false,
        scale: 1.8,
        target: { kind: "element", anchorId: "a-row" },
        aimFallback: null,
        timing: "rendered",
        clamped: false,
        marker: { actionId: "act-2", offsetMs: -350 },
        endMarker: null,
      },
    ]);
  });

  it("carries a point target, its note, and a clamped end", () => {
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "point", x: 5, y: 6 },
        scale: 1.8,
        note: "aimed at the cursor: the element here has no anchor",
      },
      ids(),
    );
    scene = applyCommand(
      scene,
      {
        kind: "setZoomRange",
        id: "gen-1",
        start: { actionId: "act-2", offsetMs: -350 },
        end: { actionId: "act-2", offsetMs: 10 },
      },
      ids(),
    );
    const { model } = modelOf(scene);
    expect(model.zooms[0]).toMatchObject({
      target: { kind: "point", x: 5, y: 6 },
      aimFallback: "aimed at the cursor: the element here has no anchor",
      endAuthored: true,
      clamped: true,
    });
    expect(model.notices.some((n) => /zoom "gen-1"/.test(n))).toBe(true);
  });

  it("still draws a zoom with no render, from the take's own timestamps", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      ids(),
    );
    const view = buildTimelineView({ scene, bundle: null, resolved: null });
    const model = buildLaneModel({
      scene,
      view,
      bundle: null,
      resolved: null,
      hoverReport: null,
    });
    expect(model.timeSource).toBe("captured");
    expect(model.zooms[0]?.startMs).toBe(3200 - 350);
    // Drawn from where the push-in would set off, as a rendered one is.
    expect(model.zooms[0]?.departMs).toBe(3200 - 350 - model.zoomInMs);
    expect(model.zooms[0]?.timing).toBe("estimated");
  });

  // The render never sets a push-in off before the camera's previous key,
  // so the estimate must not either: B departing 800ms before A lands drew
  // A's block ending before A had zoomed in at all (review, 2026-10-22).
  it("sets an unrendered zoom off no earlier than the zoom before it lands", () => {
    const fresh = ids();
    let scene = readonlyScene();
    for (const offsetMs of [0, 500])
      scene = applyCommand(
        scene,
        {
          kind: "addZoom",
          marker: { actionId: "act-2", offsetMs },
          target: { kind: "point", x: 5, y: 6 },
          scale: 1.8,
        },
        fresh,
      );
    const view = buildTimelineView({ scene, bundle: null, resolved: null });
    const model = buildLaneModel({
      scene,
      view,
      bundle: null,
      resolved: null,
      hoverReport: null,
    });
    const [a, b] = [...model.zooms].sort((x, y) => x.startMs - y.startMs);
    if (!a || !b) throw new Error("fixture");
    // Fixture guard: B lands within its own push-in of A's landing.
    expect(b.startMs - a.startMs).toBeLessThan(model.zoomInMs);
    expect(a.departMs).toBe(a.startMs - model.zoomInMs);
    expect(b.departMs).toBe(a.startMs);
    expect(a.drawnEndMs).toBe(b.departMs);
  });

  // A ruling on Task 4's `CameraSegment.endUnplaced`, amending this task's
  // brief: an authored end whose step the bundle has no marker for falls
  // back to the compositor's own return timing (`endAuthored` stays true —
  // the author DID name an end — but the instant is not measured), and the
  // editor owes the author a reason. `hoverScene()`'s `act-h` is a step
  // `proceduralBundle()` never rendered, so its bundle carries no marker for
  // it — exactly the condition `endUnplaced` reports.
  it("draws an authored end as estimated, with a notice, when its step has no marker", () => {
    let scene = applyCommand(
      hoverScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      ids(),
    );
    scene = applyCommand(
      scene,
      {
        kind: "setZoomRange",
        id: "gen-1",
        start: { actionId: "act-2", offsetMs: -350 },
        end: { actionId: "act-h", offsetMs: 0 },
      },
      ids(),
    );
    const { model, resolved } = modelOf(scene);
    const seg = resolved.cameraSegments[0];
    expect(seg?.endUnplaced).toBe(true); // fixture guard
    expect(model.zooms[0]).toMatchObject({
      endAuthored: true,
      timing: "estimated",
    });
    expect(model.notices).toContain(
      'The end of zoom "gen-1" is placed from the take\'s own timestamp: the last render carried no marker for its step. Re-shoot it in Runs to give it measured timing.',
    );
  });
});

// A 9:16 preview narrows a zoom whose target its crop cannot hold at the
// zoom's scale (`solveCamera`'s fit). The lane keeps the zoom's own scale,
// so the narrowing is said under the timeline; and since the zoom's end was
// not touched, the inspector's "the end you set could not be reached" must
// not fire. Red if the lane reads every clamp on a zoom's id as an end
// clamp: `clamped` comes back true.
describe("a zoom a cover crop narrowed", () => {
  it("is said in the notices and is not an end clamp", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      ids(),
    );
    const bundle = proceduralBundle();
    // A crop far narrower than any target: the fit takes the zoom to 1.
    const resolved = resolvePlan(planScene(scene), bundle, scene, [], {
      width: 60,
      height: 60,
    });
    // Premise: the fit narrowed it.
    expect(resolved.clampedRanges.map((c) => c.kind)).toEqual(["zoomFit"]);
    const view = buildTimelineView({ scene, bundle, resolved });
    const model = buildLaneModel({
      scene,
      view,
      bundle,
      resolved,
      hoverReport: null,
    });
    expect(model.zooms[0]).toMatchObject({ scale: 1.8, clamped: false });
    expect(model.notices).toContain(
      'zoom "gen-1" asked for 1.8x, but its target is too wide to zoom on in this frame\'s crop, so the camera pans to it at 1x instead',
    );
  });
});

describe("masks", () => {
  it("resolves a ranged mask and marks a pre-spec mask whole-take", () => {
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addMask",
        rect: { x: 1, y: 2, width: 3, height: 4 },
        start: { actionId: "act-1", sourceOffsetMs: 0 },
        end: { actionId: "act-2", sourceOffsetMs: 0 },
      },
      ids(),
    );
    scene = {
      ...scene,
      edits: {
        ...scene.edits,
        masks: [
          ...scene.edits.masks,
          { id: "old", rect: { x: 0, y: 0, width: 9, height: 9 } },
        ],
      },
    };
    const { model, resolved } = modelOf(scene);
    const ranged = model.masks.find((m) => m.id === "gen-1");
    expect(ranged).toMatchObject({
      startMs: resolved.cosmetics.find((c) => c.id === "gen-1")?.range?.startMs,
      endMs: resolved.cosmetics.find((c) => c.id === "gen-1")?.range?.endMs,
      wholeTake: false,
    });
    expect(model.masks.find((m) => m.id === "old")).toMatchObject({
      startMs: 0,
      endMs: model.durationMs,
      wholeTake: true,
    });
  });

  it("names a mask side the last render carried no marker for", () => {
    // F4: the trim's unplaced sides and a zoom's unplaced end are both
    // noticed; a mask's were dropped on the floor, so a mask that had
    // silently widened to the end of the take — painting over stretches the
    // author never asked to redact — said nothing beyond the same
    // `estimated` hatch an unmeasured-but-correct end wears.
    const scene = applyCommand(
      hoverScene(),
      {
        kind: "addMask",
        rect: { x: 1, y: 2, width: 3, height: 4 },
        start: { actionId: "act-1", sourceOffsetMs: 0 },
        end: { actionId: "act-h", sourceOffsetMs: 0 },
      },
      ids(),
    );
    const { model, resolved } = modelOf(scene);
    // Fixture guard: `act-h` is the step the procedural bundle carries no
    // marker for. If it ever gains one this assertion goes quiet, and the
    // notice below would then be asserting nothing.
    expect(resolved.cosmetics.find((c) => c.id === "gen-1")?.unplaced).toEqual([
      "end",
    ]);
    expect(model.notices).toContain(
      'The end of mask "gen-1" is placed from the take\'s own timestamp: the last render carried no marker for its step, so the mask covers more of the video than it was drawn to. Re-shoot it in Runs to give it measured timing.',
    );
  });

  it("says nothing about a mask both of whose steps were measured", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addMask",
        rect: { x: 1, y: 2, width: 3, height: 4 },
        start: { actionId: "act-1", sourceOffsetMs: 0 },
        end: { actionId: "act-2", sourceOffsetMs: 0 },
      },
      ids(),
    );
    const { model } = modelOf(scene);
    expect(model.notices.some((n) => /mask "gen-1"/.test(n))).toBe(false);
  });

  it("keeps a mask beyond the trim in the model", () => {
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addMask",
        rect: { x: 1, y: 2, width: 3, height: 4 },
        start: { actionId: "act-1", sourceOffsetMs: 0 },
        end: { actionId: "act-2", sourceOffsetMs: 0 },
      },
      ids(),
    );
    scene = applyCommand(
      scene,
      { kind: "setTrim", head: { actionId: "act-3", offsetMs: -100 } },
      ids(),
    );
    const { model } = modelOf(scene);
    expect(model.masks).toHaveLength(1);
    expect(model.masks[0]?.endMs).toBeLessThan(model.clip.trim.headMs);
  });
});

describe("the take reporting on itself", () => {
  it("maps degradations through the timeline and names them in the notices", () => {
    // A capture bundle with an authored gap, so source ms and output ms
    // differ and the mapping is not an identity.
    const scene = readonlyScene();
    const paced = {
      ...scene,
      edits: {
        ...scene.edits,
        gaps: [{ id: "g", afterActionId: "act-1", durationMs: 100 }],
      },
    };
    const bundle = compressionBundle({
      source: "capture",
      degradations: [
        {
          startMs: 5200,
          endMs: 5600,
          kind: "keyframeOnly",
          note: "memory pressure",
        },
      ],
    });
    const { model, resolved } = modelOf(paced, bundle);
    expect(toOutputMs(resolved.timeline, 5200)).not.toBeCloseTo(5200, 0); // fixture guard
    expect(model.clip.degraded).toHaveLength(1);
    expect(model.clip.degraded[0]?.startMs).toBeCloseTo(
      toOutputMs(resolved.timeline, 5200),
      6,
    );
    expect(model.clip.degraded[0]?.endMs).toBeCloseTo(
      toOutputMs(resolved.timeline, 5600),
      6,
    );
    expect(model.notices).toContain("keyframeOnly: memory pressure");
  });

  it("relabels the legacy reclaimed-motion sentence and only that sentence", () => {
    const bundle = proceduralBundle({
      degradations: [
        {
          startMs: 0,
          endMs: 1,
          kind: "motionReclaimed",
          note: "Motion reclaimed to free space. Replay to restore.",
        },
        {
          startMs: 0,
          endMs: 1,
          kind: "motionReclaimed",
          note: "spans 2-4 went",
        },
      ],
    });
    const { model } = modelOf(readonlyScene(), bundle);
    expect(model.notices).toContain(MOTION_RECLAIMED_LABEL);
    expect(model.notices).toContain("spans 2-4 went");
  });

  // The pin: `src/adapters/frame-store.ts`'s `reclaimSpans` writes the
  // literal string below into every new row (see that function's own
  // comment) rather than importing `MOTION_RECLAIMED_LABEL` — a storage
  // adapter pulling in an editor module for one string was rejected there.
  // The two literals are kept equal by this assertion instead. Written as a
  // hardcoded string rather than the constant on purpose: comparing against
  // `MOTION_RECLAIMED_LABEL` itself would pass no matter how far the two
  // drifted apart, which is exactly the shape CLAUDE.md's "tests must be
  // able to fail" rule warns about.
  it("labels a reclaimed range with the exact sentence frame-store.ts writes for new rows", () => {
    const bundle = proceduralBundle({
      degradations: [
        {
          startMs: 0,
          endMs: 1,
          kind: "motionReclaimed",
          note: "Motion reclaimed to free space. Replay to restore.",
        },
      ],
    });
    const { model } = modelOf(readonlyScene(), bundle);
    expect(model.notices).toContain(
      "Motion reclaimed to free space. Re-shoot it in Runs to restore.",
    );
  });

  // Rows reclaimed between 2026-09-08 and 2026-09-28 say "Rebuild to
  // restore." — a rebuild the editor no longer has (plan 2, Task 7). They
  // are relabelled on read like the pre-09-08 wording, never shown as-is.
  it("relabels the rebuild-era reclaimed-motion sentence too", () => {
    const bundle = proceduralBundle({
      degradations: [
        {
          startMs: 0,
          endMs: 1,
          kind: "motionReclaimed",
          note: "Motion reclaimed to free space. Rebuild to restore.",
        },
      ],
    });
    const { model } = modelOf(readonlyScene(), bundle);
    expect(model.notices).toEqual([
      "Motion reclaimed to free space. Re-shoot it in Runs to restore.",
    ]);
  });

  it("marks a crashed hover pass as failed, never clean", () => {
    const { model } = modelOf(
      hoverScene(),
      proceduralBundle(),
      HOVER_CHECK_FAILED,
    );
    expect(model.hoverCheck.failed).toBe(true);
  });

  it("gives the last step a second of room with no render", () => {
    const scene = readonlyScene();
    const view = buildTimelineView({ scene, bundle: null, resolved: null });
    const model = buildLaneModel({
      scene,
      view,
      bundle: null,
      resolved: null,
      hoverReport: null,
    });
    expect(model.durationMs).toBe(9000 + CAPTURED_TAIL_MS);
  });
});

describe("markerAt", () => {
  it("names the nearest tick, offset signed, ties to the preceding tick", () => {
    const { model } = modelOf();
    const [t1, t2] = model.clip.ticks;
    if (!t1 || !t2) throw new Error("fixture");
    expect(markerAt(model, t2.atMs + 300, 0)).toEqual({
      actionId: "act-2",
      offsetMs: 300,
    });
    expect(markerAt(model, t2.atMs - 300, 0)).toEqual({
      actionId: "act-2",
      offsetMs: -300,
    });
    const mid = (t1.atMs + t2.atMs) / 2;
    expect(markerAt(model, mid, 0).actionId).toBe("act-1");
  });

  it("snaps to exactly zero inside the band and not one ms outside it", () => {
    const { model } = modelOf();
    const t2 = model.clip.ticks[1];
    if (!t2) throw new Error("fixture");
    expect(markerAt(model, t2.atMs + 40, 40)).toEqual({
      actionId: "act-2",
      offsetMs: 0,
    });
    expect(markerAt(model, t2.atMs + 41, 40).offsetMs).toBe(41);
  });

  it("runs off the first and last ticks", () => {
    const { model } = modelOf();
    const first = model.clip.ticks[0];
    const last = model.clip.ticks[model.clip.ticks.length - 1];
    if (!first || !last) throw new Error("fixture");
    expect(markerAt(model, 0, 0)).toEqual({
      actionId: "act-1",
      offsetMs: -first.atMs,
    });
    expect(markerAt(model, model.durationMs, 0).actionId).toBe(last.actionId);
  });
});

describe("pacing notices", () => {
  it("says so when the action log does not ascend", () => {
    // The shape a readiness wait used to produce: a step stamped back at the
    // take's origin sitting between two later ones. The pair across it runs
    // backwards, and the pair after it then claims dead air the earlier pair
    // already covered — so a rebuild renders longer than the take with every
    // pause apparently intact, and nothing about the video looks wrong
    // enough to ask about.
    const base = readonlyScene();
    const scene = {
      ...base,
      actions: base.actions.map((a, i) =>
        i === 1 ? { ...a, timestamp: 0 } : a,
      ),
    };
    // The premise: this really is out of order, so the notice below is the
    // count's doing rather than a fixture that quietly kept ascending.
    const stamps = scene.actions.map((a) => a.timestamp);
    expect(stamps.some((t, i) => i > 0 && t < (stamps[i - 1] as number))).toBe(
      true,
    );

    const { model } = modelOf(scene);

    expect(model.notices.some((n) => n.startsWith("pacingBackwards:"))).toBe(
      true,
    );
  });

  it("says nothing about pacing for a log that ascends", () => {
    const stamps = readonlyScene().actions.map((a) => a.timestamp);
    expect(stamps.every((t, i) => i === 0 || t >= (stamps[i - 1] as number)));
    const { model } = modelOf();
    expect(model.notices.some((n) => n.startsWith("pacingBackwards:"))).toBe(
      false,
    );
  });
});

// An authored take's route to new frames is "run its script again in Runs",
// because Runs refuses to re-shoot it. The reclaimed note is STORED (by
// `frame-store.ts`, at reclaim time, when the reader's take is not known), so
// the lane relabels it at read time. Goes red if `buildLaneModel` stops
// reading the scene's capture mode.
describe("lane notices for an authored take", () => {
  const reclaimed = (note: string) =>
    proceduralBundle({
      degradations: [{ startMs: 0, endMs: 1, kind: "motionReclaimed", note }],
    });
  const STORED =
    "Motion reclaimed to free space. Re-shoot it in Runs to restore.";

  it("relabels the stored reclaimed note (new and legacy rows) for an authored take, and leaves a recorded take's alone", () => {
    const scene = authoredScene(readonlyScene());
    // Premise: the two takes differ in exactly the flag under test.
    expect(scene.meta.capture.mode).toBe("authored");
    expect(readonlyScene().meta.capture.mode).not.toBe("authored");
    for (const note of [
      STORED,
      "Motion reclaimed to free space. Replay to restore.",
      "Motion reclaimed to free space. Rebuild to restore.",
    ]) {
      expect(modelOf(scene, reclaimed(note)).model.notices).toEqual([
        "Motion reclaimed to free space. Run its script again in Runs to restore.",
      ]);
      expect(modelOf(readonlyScene(), reclaimed(note)).model.notices).toEqual([
        STORED,
      ]);
    }
  });

  it("does not touch a reclaimed note that names its own spans, on either kind of take", () => {
    const own = "spans 2-4 went";
    expect(
      modelOf(authoredScene(readonlyScene()), reclaimed(own)).model.notices,
    ).toEqual([own]);
  });

  it("says run its script again in the zoom-end timing notice for an authored take, and re-shoot for a recorded one", () => {
    const zoomed = (base: ReturnType<typeof hoverScene>) => {
      let scene = applyCommand(
        base,
        {
          kind: "addZoom",
          marker: { actionId: "act-2", offsetMs: 0 },
          target: { kind: "element", anchorId: "a-row" },
          scale: 1.8,
        },
        ids(),
      );
      scene = applyCommand(
        scene,
        {
          kind: "setZoomRange",
          id: "gen-1",
          start: { actionId: "act-2", offsetMs: -350 },
          end: { actionId: "act-h", offsetMs: 0 },
        },
        ids(),
      );
      return scene;
    };
    const tail =
      "is placed from the take's own timestamp: the last render carried no marker for its step.";
    for (const [scene, route] of [
      [zoomed(authoredScene(hoverScene())), "Run its script again in Runs"],
      [zoomed(hoverScene()), "Re-shoot it in Runs"],
    ] as const) {
      const { model, resolved } = modelOf(scene);
      // Premise: the fixture puts an authored zoom end on a step the bundle
      // has no marker for, and the take is the kind this row claims.
      expect(resolved.cameraSegments[0]?.endUnplaced).toBe(true);
      expect(model.authored).toBe(scene.meta.capture.mode === "authored");
      expect(model.notices).toContain(
        `The end of zoom "gen-1" ${tail} ${route} to give it measured timing.`,
      );
    }
  });
});

describe("clicks the generated zooms left out", () => {
  // The take carries every click its zooms skipped (`zoomsSkipped`), and the
  // take notes are where the author reads it: one line per click. Red
  // without the loop in `buildLaneModel` (no line), and red if a note is
  // still drawn for a step the author has since zoomed by hand. The too-close
  // note is measured from the zoom on act-1, so the take carries that zoom.
  const skipped = (): ReturnType<typeof readonlyScene> => ({
    ...readonlyScene(),
    camera: [
      {
        id: "zoom-1",
        kind: "zoom",
        anchorId: "a-checkout",
        marker: { actionId: "act-1", offsetMs: 0 },
        scale: 1.8,
      },
    ],
    zoomsSkipped: [
      {
        actionId: "act-2",
        reason: "tooClose",
        afterActionId: "act-1",
        gapMs: 600,
      },
      { actionId: "act-3", reason: "targetTooWide", scale: 1.1 },
    ],
  });
  const TOO_CLOSE =
    "No zoom on click act-2: too close to the previous zoom (600ms after act-1, minimum 1000ms).";
  const TOO_WIDE =
    "No zoom on click act-3: target too wide to zoom (fits at 1.1x, floor 1.2x).";

  it("says each one in the notices, and the take notes draw it", () => {
    const { model } = modelOf(skipped());
    expect(model.notices).toContain(TOO_CLOSE);
    expect(model.notices).toContain(TOO_WIDE);
    const root = document.createElement("div");
    renderTakeNotes(root, { notices: model.notices, hoverReport: null });
    const lines = [...root.querySelectorAll("[data-take-notice]")].map(
      (l) => l.textContent,
    );
    expect(lines).toContain(TOO_CLOSE);
    expect(lines).toContain(TOO_WIDE);
  });

  it("drops the note for a step the author has zoomed since", () => {
    const scene = applyCommand(
      skipped(),
      {
        kind: "addZoom",
        marker: { actionId: "act-3", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-checkout" },
        scale: 1.8,
      },
      ids(),
    );
    expect(scene.camera.some((c) => c.marker.actionId === "act-3")).toBe(true); // guard
    const { model } = modelOf(scene);
    expect(model.notices).toContain(TOO_CLOSE);
    expect(model.notices).not.toContain(TOO_WIDE);
  });
  // A too-close note says the click is blocked by the zoom on act-1. Once
  // that zoom is gone nothing blocks it, and the note would tell the author
  // otherwise. Red without the check on `afterActionId`.
  it("drops a too-close note once the zoom it was measured from is gone", () => {
    expect(skipped().camera.map((c) => c.marker.actionId)).toEqual(["act-1"]); // guard
    expect(modelOf(skipped()).model.notices).toContain(TOO_CLOSE); // guard
    const scene = applyCommand(
      skipped(),
      { kind: "removeZoom", id: "zoom-1" },
      ids(),
    );
    const { model } = modelOf(scene);
    expect(model.notices).not.toContain(TOO_CLOSE);
    expect(model.notices).toContain(TOO_WIDE);
  });
});

describe("estimated zoom ends", () => {
  // Before anything renders, a zoom's end is estimated. Two zooms closer
  // than a full return glide from one to the next (`insertNeutralKeys`), so
  // the first one's estimate stops at the second's start instead of drawing
  // a return that overlaps it. Red without the cap in `buildLaneModel`.
  it("stops at the next zoom's start when that comes before the return", () => {
    const scene = {
      ...readonlyScene(),
      camera: [
        {
          id: "z-1",
          kind: "zoom" as const,
          anchorId: "a-row",
          marker: { actionId: "act-2", offsetMs: -350 },
          scale: 1.8,
        },
        {
          id: "z-2",
          kind: "zoom" as const,
          anchorId: "a-checkout",
          marker: { actionId: "act-2", offsetMs: 1_150 },
          scale: 1.8,
        },
      ],
    };
    const view = buildTimelineView({ scene, bundle: null, resolved: null });
    const model = buildLaneModel({
      scene,
      view,
      bundle: null,
      resolved: null,
      hoverReport: null,
    });
    const [a, b] = model.zooms;
    if (!a || !b) throw new Error("fixture: two zooms");
    // Premise: B starts before A's uncapped estimate would return.
    expect(a.timing).toBe("estimated");
    expect(b.startMs - a.startMs).toBe(1_500);
    expect(
      a.startMs +
        CAMERA_DEFAULTS.neutral.zoomHoldMs +
        CAMERA_DEFAULTS.zoomOutMs,
    ).toBeGreaterThan(b.startMs);
    expect(a.endMs).toBe(b.startMs);
  });
});

// Review 2026-10-22: a split whose step the frames never reached was
// dropped from the timeline without a word.
describe("a split the frames cannot place", () => {
  it("is said in the notices", () => {
    const base = readonlyScene();
    const scene = {
      ...base,
      edits: {
        ...base.edits,
        splits: [{ id: "s1", at: { actionId: "act-gone", sourceOffsetMs: 0 } }],
      },
    };
    // Premise: the frames carry no marker for that step.
    expect(
      proceduralBundle().markers.some((m) => m.actionId === "act-gone"),
    ).toBe(false);
    const { model } = modelOf(scene);
    expect(model.clip.pieces).toHaveLength(1);
    expect(model.notices).toContain(
      "A split is not drawn: the last render carried no marker for its step. Re-shoot it in Runs to place it.",
    );
  });
});

// Review 2026-10-22: a removed piece that removed no frames marked its
// steps as out of the video while their frames still played.
describe("a removed piece that removed no frames", () => {
  it("leaves its steps in the video", () => {
    const base = readonlyScene();
    const scene = {
      ...base,
      edits: {
        ...base.edits,
        removed: [
          {
            id: "r1",
            start: { actionId: "act-2", sourceOffsetMs: 0 },
            end: { actionId: "act-3", sourceOffsetMs: 0 },
          },
        ],
      },
    };
    const full = proceduralBundle();
    const bundle = {
      ...full,
      markers: full.markers.filter((m) => m.actionId !== "act-3"),
    };
    const { model, resolved } = modelOf(scene, bundle);
    // Premise: the piece removed nothing.
    expect(resolved.timeline.unplacedCuts).toHaveLength(1);
    expect(model.clip.ticks.find((t) => t.actionId === "act-2")?.cut).toBe(
      false,
    );
  });
});
