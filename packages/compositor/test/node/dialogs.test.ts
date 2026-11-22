import {
  type DialogRecord,
  migrateToCurrent,
  type SceneDocument,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { DIALOG_PRESS_MS, planDialogs } from "../../src/plan/dialogs";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { buildTimeline } from "../../src/plan/timeline";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

const confirm: DialogRecord = {
  kind: "confirm",
  host: "localhost:8130",
  message: "Delete Northwind?",
  answer: "accept",
  by: "default",
  beatMs: 1500,
};

/** The fixture with `dialogs` on act-1 (a type: its focusing click opened them). */
function withDialogs(dialogs: DialogRecord[]): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    actions: scene.actions.map((a) =>
      a.id === "act-1" ? { ...a, dialogs } : a,
    ),
  };
}

describe("dialog holds", () => {
  it("a take with no dialogs plans exactly as before", () => {
    const bundle = proceduralBundle();
    const scene = readonlyScene();
    // Premise: the fixture carries no dialog at all.
    expect(
      scene.actions.some((a) => "dialogs" in a && a.dialogs !== undefined),
    ).toBe(false);
    // The snapshot was written by the code before this change (fd62c41a),
    // so a dialog-free take's segments are the ones it always had.
    const timeline = buildTimeline(planScene(scene), bundle);
    expect(timeline.segments).toMatchSnapshot();
    expect(timeline.segments.some((s) => s.kind === "hold")).toBe(false);
    expect(planDialogs(scene)).toEqual([]);
    expect(resolvePlan(planScene(scene), bundle, scene).dialogCards).toEqual(
      [],
    );
  });

  it("one dialog adds one hold of its beatMs at its action's marker", () => {
    const bundle = proceduralBundle();
    const marker = bundle.markers.find((m) => m.actionId === "act-1");
    expect(marker, "premise: act-1 has a marker").toBeDefined();
    const base = buildTimeline(planScene(readonlyScene()), bundle);
    const held = buildTimeline(planScene(withDialogs([confirm])), bundle);
    const holds = held.segments.filter((s) => s.kind === "hold");
    expect(holds).toHaveLength(1);
    const [hold] = holds;
    expect(hold?.srcStartMs).toBe(marker?.sourceTimeMs);
    expect(hold?.srcEndMs).toBe(marker?.sourceTimeMs);
    expect((hold?.outEndMs ?? 0) - (hold?.outStartMs ?? 0)).toBe(1500);
    expect(held.outputDurationMs - base.outputDurationMs).toBeCloseTo(1500, 6);
  });

  it("reads the beat from the record, not the constant", () => {
    const bundle = proceduralBundle();
    const held = buildTimeline(
      planScene(withDialogs([{ ...confirm, beatMs: 900 }])),
      bundle,
    );
    const hold = held.segments.find((s) => s.kind === "hold");
    expect((hold?.outEndMs ?? 0) - (hold?.outStartMs ?? 0)).toBe(900);
  });

  it("two dialogs on one action are one hold of 3000 with two cards in order", () => {
    const bundle = proceduralBundle();
    const second: DialogRecord = {
      ...confirm,
      kind: "alert",
      message: "Deleted.",
    };
    const scene = withDialogs([confirm, second]);
    expect(planDialogs(scene)).toEqual([
      { actionId: "act-1", durationMs: 3000, cards: [confirm, second] },
    ]);
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const holds = resolved.timeline.segments.filter((s) => s.kind === "hold");
    expect(holds).toHaveLength(1);
    const [hold] = holds;
    expect((hold?.outEndMs ?? 0) - (hold?.outStartMs ?? 0)).toBe(3000);
    const [first, next] = resolved.dialogCards;
    expect(resolved.dialogCards).toHaveLength(2);
    expect(first?.card).toEqual(confirm);
    expect(next?.card).toEqual(second);
    expect(first?.range.startMs).toBe(hold?.outStartMs);
    expect((first?.range.endMs ?? 0) - (first?.range.startMs ?? 0)).toBe(1500);
    expect(next?.range.startMs).toBe(first?.range.endMs);
    expect((next?.range.endMs ?? 0) - (next?.range.startMs ?? 0)).toBe(1500);
    expect(next?.range.endMs).toBe(hold?.outEndMs);
    for (const c of resolved.dialogCards) {
      expect(c.pressedFromMs).toBe(c.range.endMs - DIALOG_PRESS_MS);
    }
  });

  it("a dialog hold survives migrateToCurrent", () => {
    // Not an `edits.holds` entry: `migrateHoldsToGaps` turns an offset-0
    // hold into a gap, and a dialog's hold must not become one.
    const bundle = proceduralBundle();
    const migrated = migrateToCurrent(
      JSON.parse(JSON.stringify(withDialogs([confirm]))),
    );
    expect(migrated.edits.holds ?? []).toEqual([]);
    expect(migrated.edits.gaps).toEqual([]);
    const held = buildTimeline(planScene(migrated), bundle);
    const hold = held.segments.find((s) => s.kind === "hold");
    expect((hold?.outEndMs ?? 0) - (hold?.outStartMs ?? 0)).toBe(1500);
  });

  it("a dialog on a removed step is not held", () => {
    const scene = withDialogs([confirm]);
    const plan = planScene({
      ...scene,
      edits: {
        ...scene.edits,
        removed: [
          {
            id: "cut-1",
            start: { actionId: "act-1", sourceOffsetMs: 0 },
            end: { actionId: "act-2", sourceOffsetMs: 0 },
          },
        ],
      },
    });
    // Premise: the cut takes act-1 out.
    expect(plan.removedSteps).toContain("act-1");
    expect(plan.dialogs).toBeUndefined();
    // Control: the same take uncut does hold its dialog.
    expect(planScene(scene).dialogs).toHaveLength(1);
  });
});
