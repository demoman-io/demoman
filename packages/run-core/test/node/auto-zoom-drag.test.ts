import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { zoomsForClicks } from "../../src/auto-zoom.js";

const VIEWPORT = { width: 1280, height: 800 };

/** One drag from `rect` to `toRect`, as an authored run commits it. */
function drag(
  rect: { x: number; y: number; width: number; height: number },
  toRect: { x: number; y: number; width: number; height: number },
): SceneDocument["actions"] {
  return [
    {
      id: "act-1",
      kind: "drag",
      anchorId: "a1",
      timestamp: 1000,
      marker: "drag:a1",
      rect,
      toAnchorId: "a2",
      toRect,
      to: {},
    },
  ];
}

describe("auto zoom on a drag", () => {
  it("zooms a drag on the box around its ends", () => {
    const { camera, zoomsSkipped } = zoomsForClicks(
      drag(
        { x: 100, y: 100, width: 100, height: 40 },
        { x: 300, y: 200, width: 100, height: 40 },
      ),
      VIEWPORT,
    );
    expect(zoomsSkipped).toEqual([]);
    expect(camera).toHaveLength(1);
    // The middle of the box from (100, 100) to (400, 240).
    expect(camera[0]?.point).toEqual({ x: 250, y: 170 });
    expect(camera[0]?.anchorId).toBeUndefined();
    expect(camera[0]?.marker.actionId).toBe("act-1");
  });

  it("skips a drag zoom whose ends are too far apart", () => {
    const { camera, zoomsSkipped } = zoomsForClicks(
      drag(
        { x: 20, y: 100, width: 100, height: 40 },
        { x: 1160, y: 600, width: 100, height: 40 },
      ),
      VIEWPORT,
    );
    expect(camera).toEqual([]);
    expect(zoomsSkipped).toEqual([
      expect.objectContaining({ actionId: "act-1", reason: "targetTooWide" }),
    ]);
  });
});
