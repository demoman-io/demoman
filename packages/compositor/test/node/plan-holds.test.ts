import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { isUnkeptMotion } from "../../src/plan/timeline";
import { readonlyScene } from "../fixtures/scene";

function sceneWithHold() {
  const scene = readonlyScene();
  return {
    ...scene,
    edits: {
      ...scene.edits,
      holds: [
        {
          id: "hold-1",
          marker: { actionId: "act-3", offsetMs: 0 },
          durationMs: 800,
        },
      ],
    },
  };
}

describe("planScene holds", () => {
  it("is empty when the document authors none", () => {
    expect(planScene(readonlyScene()).holds).toEqual([]);
  });

  it("flattens the document's marker shape the way camera intents are flattened", () => {
    // CameraIntent already carries actionId + offsetMs side by side rather
    // than a nested marker; the plan is the compositor's own contract and
    // stays internally consistent.
    expect(planScene(sceneWithHold()).holds).toEqual([
      { id: "hold-1", actionId: "act-3", offsetMs: 0, durationMs: 800 },
    ]);
  });

  it("stays deterministic for a given scene", () => {
    const scene = sceneWithHold();
    expect(JSON.stringify(planScene(scene))).toBe(
      JSON.stringify(planScene(scene)),
    );
  });
});

it("treats motionReclaimed as unkept motion, like keyframeOnly", () => {
  expect(
    isUnkeptMotion({ startMs: 0, endMs: 1, kind: "motionReclaimed", note: "" }),
  ).toBe(true);
});
