import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { toOutputMs } from "../../src/plan/timeline";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

const trimmed = () => {
  const scene = readonlyScene();
  return {
    ...scene,
    edits: {
      ...scene.edits,
      trim: {
        head: { actionId: "act-2", offsetMs: 1000 },
        tail: { actionId: "act-3", offsetMs: -500 },
      },
    },
  };
};

describe("planScene trim", () => {
  it("is null-sided when the document has none", () => {
    expect(planScene(readonlyScene()).trim).toEqual({ head: null, tail: null });
  });
  it("carries both markers through", () => {
    expect(planScene(trimmed()).trim).toEqual({
      head: { actionId: "act-2", offsetMs: 1000 },
      tail: { actionId: "act-3", offsetMs: -500 },
    });
  });
});

describe("resolvePlan range", () => {
  it("is the whole output when untrimmed", () => {
    const scene = readonlyScene();
    const r = resolvePlan(planScene(scene), proceduralBundle(), scene);
    expect(r.range).toEqual({ startMs: 0, endMs: r.timeline.outputDurationMs });
    expect(r.trimUnplaced).toEqual([]);
    expect(r.clampedRanges).toEqual([]);
  });

  it("resolves the trim on the UNTRIMMED output axis, offsets included", () => {
    const scene = trimmed();
    const bundle = proceduralBundle();
    const r = resolvePlan(planScene(scene), bundle, scene);
    const at = (id: string) =>
      toOutputMs(
        r.timeline,
        bundle.markers.find((m) => m.actionId === id)?.sourceTimeMs ?? 0,
      );
    expect(r.range.startMs).toBeCloseTo(at("act-2") + 1000, 6);
    expect(r.range.endMs).toBeCloseTo(at("act-3") - 500, 6);
    // The output duration is NOT shortened: the axis stays untrimmed and the
    // cut is a range on it. Task 3's render loop walks the range.
    expect(r.timeline.outputDurationMs).toBe(
      resolvePlan(planScene(readonlyScene()), bundle, readonlyScene()).timeline
        .outputDurationMs,
    );
  });

  it("keeps a trim at the same offset from its step when a gap after it changes", () => {
    // The gap after act-1 grows by 3s. act-2 moves on the output axis; the
    // head trim hangs on act-2 and must move WITH it — same offset.
    const scene = trimmed();
    const paced = {
      ...scene,
      edits: {
        ...scene.edits,
        gaps: [{ id: "g", afterActionId: "act-1", durationMs: 5800 }],
      },
    };
    const bundle = proceduralBundle({ source: "capture" });
    const before = resolvePlan(planScene(scene), bundle, scene);
    const after = resolvePlan(planScene(paced), bundle, paced);
    const act2 = (r: typeof before) =>
      toOutputMs(
        r.timeline,
        bundle.markers.find((m) => m.actionId === "act-2")?.sourceTimeMs ?? 0,
      );
    expect(after.range.startMs - act2(after)).toBeCloseTo(
      before.range.startMs - act2(before),
      6,
    );
    // Fixture guard: the gap really did move act-2, or the assertion above
    // is an identity.
    expect(act2(after)).not.toBeCloseTo(act2(before), 0);
  });

  it("names an unplaced trim side instead of dropping it", () => {
    const scene = trimmed();
    const bundle = proceduralBundle({
      markers: proceduralBundle().markers.filter((m) => m.actionId !== "act-3"),
    });
    const r = resolvePlan(planScene(scene), bundle, scene);
    expect(r.trimUnplaced).toEqual(["tail"]);
    expect(r.range.endMs).toBe(r.timeline.outputDurationMs);
  });
});
