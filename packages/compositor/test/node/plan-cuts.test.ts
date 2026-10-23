import type { SourcePoint } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { buildTimeline } from "../../src/plan/timeline";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

const at = (actionId: string, sourceOffsetMs = 0): SourcePoint => ({
  actionId,
  sourceOffsetMs,
});

/** `readonlyScene` with removed pieces. */
function withRemoved(
  ranges: { start: SourcePoint | null; end: SourcePoint | null }[],
) {
  const scene = readonlyScene();
  return {
    ...scene,
    edits: {
      ...scene.edits,
      removed: ranges.map((r, i) => ({ id: `r-${i + 1}`, ...r })),
    },
  };
}

/** The piece from one step's frame to another's (null: the take's end). */
const removing = (from: string, until: string | null) =>
  withRemoved([{ start: at(from), end: until === null ? null : at(until) }]);

describe("removed pieces on the timeline", () => {
  it("the bundle's markers are the ones these cases resolve against", () => {
    expect(
      proceduralBundle().markers.map((m) => [m.actionId, m.sourceTimeMs]),
    ).toEqual([
      ["act-1", 400],
      ["act-2", 3200],
      ["act-3", 9000],
    ]);
  });

  it("a removed range resolves to the source stretch between its two points", () => {
    const plan = planScene(
      withRemoved([{ start: at("act-1", 500), end: at("act-3", -200) }]),
    );
    const timeline = buildTimeline(plan, proceduralBundle());
    expect(timeline.cuts).toEqual([
      { ids: ["r-1"], srcStartMs: 900, srcEndMs: 8800, trailing: false },
    ]);
    expect(timeline.unplacedCuts).toEqual([]);
    // And the axis really closed: shorter than the take without it.
    const whole = buildTimeline(planScene(readonlyScene()), proceduralBundle());
    expect(timeline.outputDurationMs).toBeLessThan(whole.outputDurationMs);
  });

  it("a migrated cut removes the same stretch planCuts did", () => {
    const timeline = buildTimeline(
      planScene(removing("act-2", "act-3")),
      proceduralBundle(),
    );
    expect(timeline.cuts.map((c) => [c.srcStartMs, c.srcEndMs])).toEqual([
      [3200, 9000],
    ]);
  });

  it("null start and null end are the take's two ends", () => {
    const bundle = proceduralBundle();
    const timeline = buildTimeline(
      planScene(withRemoved([{ start: at("act-2"), end: null }])),
      bundle,
    );
    // Premise: act-3's frame is the take's last, so the end is 9000.
    expect(timeline.sourceDurationMs).toBe(9000);
    expect(timeline.cuts).toEqual([
      {
        ids: ["r-1"],
        srcStartMs: 3200,
        srcEndMs: timeline.sourceDurationMs,
        trailing: true,
      },
    ]);
    const head = buildTimeline(
      planScene(withRemoved([{ start: null, end: at("act-1") }])),
      bundle,
    );
    expect(head.cuts.map((c) => [c.srcStartMs, c.srcEndMs])).toEqual([
      [0, 400],
    ]);
  });

  it("adjacent and overlapping ranges merge into one cut with both ids", () => {
    const timeline = buildTimeline(
      planScene(
        withRemoved([
          { start: at("act-1"), end: at("act-2") },
          { start: at("act-2"), end: at("act-2", 1000) },
          { start: at("act-2", 500), end: at("act-3", -500) },
        ]),
      ),
      proceduralBundle(),
    );
    expect(timeline.cuts).toEqual([
      {
        ids: ["r-1", "r-2", "r-3"],
        srcStartMs: 400,
        srcEndMs: 8500,
        trailing: false,
      },
    ]);
  });

  it("a point whose step has no marker is an unplaced cut with a sentence", () => {
    const timeline = buildTimeline(
      planScene(withRemoved([{ start: at("act-9"), end: at("act-3") }])),
      proceduralBundle(),
    );
    expect(timeline.cuts).toEqual([]);
    expect(timeline.unplacedCuts).toHaveLength(1);
    expect(timeline.unplacedCuts[0]?.ids).toEqual(["r-1"]);
    expect(timeline.unplacedCuts[0]?.reason).toContain("act-9");
  });

  it("an empty range is an unplaced cut, not a silent nothing", () => {
    const timeline = buildTimeline(
      planScene(withRemoved([{ start: at("act-2"), end: at("act-2") }])),
      proceduralBundle(),
    );
    expect(timeline.cuts).toEqual([]);
    expect(timeline.unplacedCuts[0]?.ids).toEqual(["r-1"]);
  });
});

describe("planScene and removed pieces", () => {
  it("carries the ranges and the steps inside them", () => {
    const plan = planScene(removing("act-2", "act-3"));
    expect(plan.removed).toEqual([
      { id: "r-1", start: at("act-2"), end: at("act-3") },
    ]);
    expect(plan.removedSteps).toEqual(["act-2"]);
  });

  it("does not draw a zoom whose marker is a step inside a removed piece, and names it", () => {
    const base = removing("act-3", null);
    const scene = {
      ...base,
      camera: [
        {
          id: "cam-1",
          kind: "zoom" as const,
          anchorId: "a-checkout",
          marker: { actionId: "act-3", offsetMs: -350 },
          scale: 1.6,
        },
      ],
    };
    // Premise: without the cut this zoom IS planned — otherwise the empty
    // list below would prove nothing about cuts.
    expect(
      planScene({ ...scene, edits: { ...scene.edits, removed: [] } })
        .cameraIntents,
    ).toHaveLength(1);

    const plan = planScene(scene);
    expect(plan.cameraIntents).toEqual([]);
    expect(plan.attachedToCuts).toEqual([
      { id: "cam-1", kind: "zoom", actionId: "act-3" },
    ]);
  });

  it("does not draw a ranged mask that opens on a step inside a removed piece, and names it", () => {
    const base = removing("act-2", "act-3");
    const scene = {
      ...base,
      edits: {
        ...base.edits,
        masks: [
          {
            id: "mask-1",
            rect: { x: 10, y: 10, width: 100, height: 40 },
            start: { actionId: "act-2", offsetMs: 0 },
            end: { actionId: "act-3", offsetMs: 0 },
          },
        ],
      },
    };
    // Premise: without the cut this mask IS planned.
    expect(
      planScene({ ...scene, edits: { ...scene.edits, removed: [] } }).cosmetics,
    ).toHaveLength(1);

    const plan = planScene(scene);
    expect(plan.cosmetics).toEqual([]);
    expect(plan.attachedToCuts).toEqual([
      { id: "mask-1", kind: "mask", actionId: "act-2" },
    ]);
  });

  it("keeps a whole-take mask, which sits on no step at all", () => {
    const base = removing("act-2", "act-3");
    const scene = {
      ...base,
      edits: {
        ...base.edits,
        masks: [
          { id: "mask-1", rect: { x: 10, y: 10, width: 100, height: 40 } },
        ],
      },
    };
    const plan = planScene(scene);
    // Premise: the mask really does carry no range — that is what makes it
    // a whole-take mask and what makes it immune to every cut.
    expect(plan.cosmetics[0]?.range).toBeNull();
    expect(plan.cosmetics).toHaveLength(1);
    expect(plan.attachedToCuts).toEqual([]);
  });

  it("does not play a hold on a step inside a removed piece, and names it", () => {
    const base = removing("act-2", "act-3");
    const scene = {
      ...base,
      edits: {
        ...base.edits,
        holds: [
          {
            id: "hold-1",
            marker: { actionId: "act-2", offsetMs: 0 },
            durationMs: 800,
          },
        ],
      },
    };
    expect(
      planScene({ ...scene, edits: { ...scene.edits, removed: [] } }).holds,
    ).toHaveLength(1);

    const plan = planScene(scene);
    expect(plan.holds).toEqual([]);
    expect(plan.attachedToCuts).toEqual([
      { id: "hold-1", kind: "hold", actionId: "act-2" },
    ]);
  });

  it("leaves a take with no removed pieces exactly as it was", () => {
    const plan = planScene(readonlyScene());
    expect(plan.removed).toEqual([]);
    expect(plan.removedSteps).toEqual([]);
    expect(plan.attachedToCuts).toEqual([]);
  });

  // Review 2026-10-22: a removed piece that removed no frames left its
  // steps' zooms undrawn over frames that still play.
  it("draws the zoom on a step inside a removed piece that removed no frames", () => {
    const base = removing("act-2", "act-3");
    const scene = {
      ...base,
      camera: [
        {
          id: "cam-1",
          kind: "zoom" as const,
          anchorId: "a-checkout",
          marker: { actionId: "act-2", offsetMs: 0 },
          scale: 1.6,
        },
      ],
    };
    // Frames that never reached act-3: the piece's end is nowhere.
    const full = proceduralBundle();
    const bundle = {
      ...full,
      markers: full.markers.filter((m) => m.actionId !== "act-3"),
    };
    // Premise: planned alone, the zoom is dropped as inside the piece.
    expect(planScene(scene).cameraIntents).toEqual([]);
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    // Premise: the piece removed nothing, and still says so.
    expect(resolved.timeline.unplacedCuts.map((u) => u.ids)).toEqual([["r-1"]]);
    expect(resolved.plan.cameraIntents.map((i) => i.id)).toEqual(["cam-1"]);
    expect(resolved.plan.attachedToCuts).toEqual([]);
    expect(resolved.plan.removedSteps).toEqual([]);
    expect(resolved.cameraSegments.length).toBeGreaterThan(0);
  });
});
