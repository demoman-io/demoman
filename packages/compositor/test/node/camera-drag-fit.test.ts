import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  CAMERA_DEFAULTS,
  fitScaleFor,
  planCameraIntents,
  solveCamera,
} from "../../src/plan/camera";
import type { Timeline } from "../../src/plan/timeline";
import { sceneWithCamera } from "../fixtures/scene";

// Review of 2026-10-21: a drag's zoom aims at the middle of its two ends as a
// bare point, and a point fits any crop, so a 9:16 export pushed in at the
// take's 16:9 scale and cut the drop off.

const timeline: Timeline = {
  segments: [
    {
      outStartMs: 0,
      outEndMs: 20_000,
      srcStartMs: 0,
      srcEndMs: 20_000,
      kind: "motion",
    },
  ],
  outputDurationMs: 20_000,
  sourceDurationMs: 20_000,
  unplacedPaces: 0,
  nonMonotonicPaces: 0,
  cuts: [],
  unplacedCuts: [],
  interruptions: [],
};
const viewport = { width: 1280, height: 800 };
/** What a 9:16 cover crop of a 1280x800 capture shows at scale 1. */
const crop = { width: 450, height: 800 };

/** cam-1 on act-2, made a 300px drag (120, 320) to (420, 320) and aimed at
 *  its middle, as `zoomsForClicks` writes one. */
function dragScene(): SceneDocument {
  const scene = sceneWithCamera();
  return {
    ...scene,
    actions: scene.actions.map((a) =>
      a.id === "act-2"
        ? {
            id: a.id,
            anchorId: a.anchorId,
            timestamp: a.timestamp,
            marker: a.marker,
            kind: "drag",
            rect: { x: 100, y: 300, width: 40, height: 40 },
            toAnchorId: null,
            to: { by: { x: 300, y: 0 } },
          }
        : a,
    ) as SceneDocument["actions"],
    camera: [
      {
        id: "cam-1",
        kind: "zoom",
        point: { x: 270, y: 320 },
        marker: { actionId: "act-2", offsetMs: CAMERA_DEFAULTS.leadInMs },
        scale: 1.8,
      },
    ],
  };
}

describe("a drag's zoom in a narrower crop", () => {
  it("is narrowed until both ends fit, not just its middle", () => {
    const intents = planCameraIntents(dragScene(), new Set(), []);
    const box = { x: 120, y: 320, width: 300, height: 0 };
    expect(intents[0]?.fit).toEqual(box);
    const { keys } = solveCamera(
      intents,
      () => null,
      timeline,
      new Map([["act-2", 2000]]),
      viewport,
      crop,
    );
    const zoom = keys.find((k) => k.scale > 1);
    // The premise: the box does not fit the crop at the asked 1.8x.
    const fits = fitScaleFor(box, crop);
    expect(fits).toBeLessThan(1.8);
    expect(fits).toBeGreaterThan(1);
    expect(zoom?.scale).toBe(fits);
  });
});
