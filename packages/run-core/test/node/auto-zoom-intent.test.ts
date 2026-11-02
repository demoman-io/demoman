import { CAMERA_DEFAULTS } from "@demoman/compositor";
import { ZOOM_MAX_SCALE, type ZoomIntent } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { takeOf } from "../../../replay-engine/test/helpers/film";
import {
  ZOOM_FLOOR_SCALE,
  zoomSkippedNote,
  zoomsForClicks,
} from "../../src/auto-zoom.js";
import { MIN_ZOOM_GAP_MS } from "../../src/zoom-defaults.js";

const viewport = { width: 1280, height: 800 };
const narrow = { x: 100, y: 100, width: 140, height: 40 };
// Fits at under the floor: the window cannot hold it with its margin.
const wide = { x: 0, y: 100, width: 1270, height: 40 };

function clicks(at: number[], rects = at.map(() => narrow)) {
  const base = takeOf(at.map(() => "click"));
  return base.actions.map((a, i) => ({
    ...a,
    timestamp: at[i] as number,
    rect: rects[i] as typeof narrow,
  }));
}

const intents =
  (byId: Record<string, ZoomIntent>) =>
  (id: string): ZoomIntent | undefined =>
    byId[id];

describe("the script's say on a click's zoom", () => {
  it("the camera's own scale is the engine's, not the script's", () => {
    const actions = clicks([1000, 4000, 7000]);
    const { camera, zoomsSkipped } = zoomsForClicks(actions, viewport);
    expect(camera).toHaveLength(3); // premise: all three zoom without intent
    expect(zoomsSkipped).toEqual([]);
    expect(camera.every((c) => c.scaleSetBy === undefined)).toBe(true);
    expect(camera.every((c) => c.source === "click")).toBe(true);
  });

  it("zoom false on the middle click: no event, an off skip, and the third still zooms", () => {
    const at = [1000, 1000 + MIN_ZOOM_GAP_MS, 1000 + MIN_ZOOM_GAP_MS * 1.5];
    const actions = clicks(at);
    // Premise: without intent the third is too close to the second.
    expect(
      zoomsForClicks(actions, viewport).zoomsSkipped.map((s) => s.reason),
    ).toEqual(["tooClose"]);
    const [, second, third] = actions;
    const { camera, zoomsSkipped } = zoomsForClicks(
      actions,
      viewport,
      undefined,
      intents({ [second?.id as string]: false }),
    );
    expect(zoomsSkipped).toEqual([{ actionId: second?.id, reason: "off" }]);
    expect(camera.map((c) => c.marker.actionId)).toEqual([
      actions[0]?.id,
      third?.id,
    ]);
  });

  it("a scale overrides the fit and is marked as the script's", () => {
    const actions = clicks([1000]);
    const plain = zoomsForClicks(actions, viewport).camera[0];
    expect(plain?.scale).not.toBe(1.6); // premise
    const [event] = zoomsForClicks(
      actions,
      viewport,
      undefined,
      intents({ [actions[0]?.id as string]: { scale: 1.6 } }),
    ).camera;
    expect(event?.scale).toBe(1.6);
    expect(event?.scaleSetBy).toBe("script");
    expect(event?.source).toBe("click");
  });

  it("a scale on a too-close click stays skipped and keeps askedScale", () => {
    const actions = clicks([1000, 1000 + MIN_ZOOM_GAP_MS - 100]);
    const second = actions[1]?.id as string;
    const { camera, zoomsSkipped } = zoomsForClicks(
      actions,
      viewport,
      undefined,
      intents({ [second]: { scale: 1.6 } }),
    );
    expect(camera).toHaveLength(1);
    expect(zoomsSkipped).toMatchObject([
      { actionId: second, reason: "tooClose", askedScale: 1.6 },
    ]);
  });

  it("a scale overrides the width floor", () => {
    const actions = clicks([1000], [wide]);
    const without = zoomsForClicks(actions, viewport);
    expect(ZOOM_FLOOR_SCALE).toBe(1.2);
    expect(without.zoomsSkipped.map((s) => s.reason)).toEqual([
      "targetTooWide",
    ]); // premise
    const { camera, zoomsSkipped } = zoomsForClicks(
      actions,
      viewport,
      undefined,
      intents({ [actions[0]?.id as string]: { scale: 1.6 } }),
    );
    expect(zoomsSkipped).toEqual([]);
    expect(camera[0]?.scale).toBe(1.6);
  });

  it("zoomSkippedNote says turned off", () => {
    expect(zoomSkippedNote({ actionId: "a-2", reason: "off" })).toBe(
      "No zoom on click a-2: turned off.",
    );
  });

  // The only thing keeping the script's bound and the compositor's clamp equal.
  it("the script's scale bound is the camera's clamp", () => {
    expect(ZOOM_MAX_SCALE).toBe(CAMERA_DEFAULTS.maxScale);
  });
});
