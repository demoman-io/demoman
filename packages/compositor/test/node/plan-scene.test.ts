import { describe, expect, it } from "vitest";
import { COMPOSITOR_VERSION } from "../../src/index";
import { planScene, RETIMING_DEFAULTS } from "../../src/plan/plan";
import {
  readonlyScene,
  sceneWithActions,
  sceneWithCosmetics,
  sceneWithZoomOnClick,
} from "../fixtures/scene";

describe("planScene", () => {
  it("stamps the compositor version so a render is attributable", () => {
    expect(planScene(readonlyScene()).compositorVersion).toBe(
      COMPOSITOR_VERSION,
    );
  });

  it("carries the capture viewport through as the plan's coordinate space", () => {
    expect(planScene(readonlyScene()).viewport).toEqual({
      width: 1280,
      height: 800,
    });
  });

  it("plans a cursor segment per travelling action, and no camera intent unasked", () => {
    const scene = readonlyScene();
    expect(scene.actions).toHaveLength(3);
    const plan = planScene(scene);
    // A scroll is not a cursor stop (film-check spec §1).
    expect(plan.cursorSegments.map((s) => s.toActionId)).toEqual([
      "act-1",
      "act-3",
    ]);
    expect(plan.cameraIntents).toEqual([]);
  });

  it("plans a camera intent for a zoom the author added", () => {
    const plan = planScene(sceneWithZoomOnClick());
    expect(plan.cameraIntents.map((i) => i.actionId)).toEqual(["act-3"]);
  });

  it("uses capture-time bounding rects, which is all that exists before replay", () => {
    const plan = planScene(readonlyScene());
    // a-checkout sits at 980,620 160x44 → centre 1060,642
    // The click is the second segment: a scroll is not a cursor stop
    // (film-check spec §1).
    expect(plan.cursorSegments.map((s) => s.toActionId)).toEqual([
      "act-1",
      "act-3",
    ]);
    expect(plan.cursorSegments[1]?.to).toEqual({ x: 1060, y: 642 });
  });

  it("takes the retiming policy from defaults, overridable per option", () => {
    expect(planScene(readonlyScene()).retiming).toEqual(RETIMING_DEFAULTS);
    expect(
      planScene(readonlyScene(), { retiming: { motionDiffThreshold: 0.05 } })
        .retiming,
    ).toEqual({ ...RETIMING_DEFAULTS, motionDiffThreshold: 0.05 });
  });

  it("records hover sensitivity, which changes the cursor rule on frozen frames", () => {
    const scene = readonlyScene();
    expect(planScene(scene).hoverSensitive).toBe(false);
    expect(
      planScene({ ...scene, flags: { ...scene.flags, hoverSensitive: true } })
        .hoverSensitive,
    ).toBe(true);
  });

  it("hints the pre-retiming duration from the last action", () => {
    expect(planScene(readonlyScene()).durationHintMs).toBe(9000);
  });

  it("plans masks, and no text overlay", () => {
    expect(planScene(sceneWithCosmetics()).cosmetics.map((c) => c.id)).toEqual([
      "mask-1",
    ]);
  });

  // The plan is SP5's input and SP7's timeline source; it has to be stable.
  it("is byte-identical for the same scene and options", () => {
    expect(JSON.stringify(planScene(readonlyScene()))).toBe(
      JSON.stringify(planScene(readonlyScene())),
    );
  });

  it("survives a JSON round trip unchanged", () => {
    const plan = planScene(sceneWithCosmetics());
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it("derives a pace per adjacent action pair from recorded timestamps", () => {
    const scene = sceneWithActions([
      { id: "a1", timestamp: 0 },
      { id: "a2", timestamp: 1500 },
      { id: "a3", timestamp: 2000 },
    ]);
    const plan = planScene(scene);

    expect(plan.paces).toEqual([
      {
        afterActionId: "a1",
        beforeActionId: "a2",
        origin: "recorded",
        recordedSpanMs: 1500,
      },
      {
        afterActionId: "a2",
        beforeActionId: "a3",
        origin: "recorded",
        recordedSpanMs: 500,
      },
    ]);
  });

  it("keeps a backwards interval visible rather than flooring it to nothing", () => {
    // A log whose timestamps do not ascend. Flooring here made the pair read
    // exactly like a pair of simultaneous actions, so nothing downstream
    // could tell "no gap" from "this log is out of order" — and the pair
    // AFTER it goes on to claim dead air this one should have carried.
    // `idleTargetMsFor` floors the negative where it is used; the plan keeps
    // the fact.
    const scene = sceneWithActions([
      { id: "a1", timestamp: 18453 },
      { id: "a2", timestamp: 0 },
    ]);

    expect(planScene(scene).paces).toEqual([
      {
        afterActionId: "a1",
        beforeActionId: "a2",
        origin: "recorded",
        recordedSpanMs: -18453,
      },
    ]);
  });

  it("lets an authored gap replace the recorded target rather than stack on it", () => {
    const scene = sceneWithActions([
      { id: "a1", timestamp: 0 },
      { id: "a2", timestamp: 1500 },
    ]);
    scene.edits.gaps = [{ id: "g1", afterActionId: "a1", durationMs: 200 }];
    const plan = planScene(scene);

    expect(plan.paces).toEqual([
      {
        afterActionId: "a1",
        beforeActionId: "a2",
        origin: "authored",
        idleTargetMs: 200,
      },
    ]);
  });

  it("keeps a zero gap as an authored zero, not as an absent one", () => {
    const scene = sceneWithActions([
      { id: "a1", timestamp: 0 },
      { id: "a2", timestamp: 4000 },
    ]);
    scene.edits.gaps = [{ id: "g1", afterActionId: "a1", durationMs: 0 }];
    expect(planScene(scene).paces).toEqual([
      {
        afterActionId: "a1",
        beforeActionId: "a2",
        origin: "authored",
        idleTargetMs: 0,
      },
    ]);
  });

  it("computes an empty pace list for a single-action scene, never null", () => {
    // [] means "computed, none"; null means "unknown". A one-action take
    // genuinely has no gaps, and must not read as a plan that never looked.
    const plan = planScene(sceneWithActions([{ id: "a1", timestamp: 0 }]));
    expect(plan.paces).toEqual([]);
    expect(plan.paces).not.toBeNull();
  });

  it("no longer carries an idle clamp", () => {
    const plan = planScene(sceneWithActions([{ id: "a1", timestamp: 0 }]));
    expect(plan.retiming).toEqual({ motionDiffThreshold: 0.02 });
  });
});
