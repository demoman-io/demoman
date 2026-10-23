import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import { rectCenter } from "../../src/geometry";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import { readonlyScene } from "../fixtures/scene";

// Two clicks on the SAME anchor (a scrolled checkout button, clicked, moved,
// clicked again), so one anchorId legitimately holds two different rects —
// exactly the shape `resolve.ts`'s and `plan.ts`'s `rects` map used to
// collapse last-write-wins. `a-row` supplies a third action that shares no
// anchor with either click, carries no rect of its own, and has no bundle
// entry either — it exercises the fallback to the anchor's first sighting.
const FIRST_RECT = { x: 980, y: 100, width: 160, height: 44 };
const SECOND_RECT = { x: 980, y: 900, width: 160, height: 44 };

function sceneWithTwoActionsOnOneAnchor(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    actions: [
      {
        id: "act-1",
        anchorId: "a-checkout",
        timestamp: 1000,
        marker: "click:a-checkout:1",
        kind: "click",
        button: "left",
        rect: FIRST_RECT,
      },
      {
        id: "act-2",
        anchorId: "a-checkout",
        timestamp: 5000,
        marker: "click:a-checkout:2",
        kind: "click",
        button: "left",
        rect: SECOND_RECT,
      },
      {
        id: "act-3",
        anchorId: "a-row",
        timestamp: 9000,
        marker: "click:a-row",
        kind: "click",
        button: "left",
        // No `rect`: this sighting carries none of its own, so the fallback
        // has to reach `a-row`'s fingerprint rect.
      },
    ],
    camera: [
      {
        id: "cam-1",
        kind: "zoom",
        anchorId: "a-checkout",
        marker: { actionId: "act-1", offsetMs: 0 },
        scale: 1.8,
      },
      {
        id: "cam-2",
        kind: "zoom",
        anchorId: "a-checkout",
        marker: { actionId: "act-2", offsetMs: 0 },
        scale: 1.8,
      },
      {
        id: "cam-3",
        kind: "zoom",
        anchorId: "a-row",
        marker: { actionId: "act-3", offsetMs: 0 },
        scale: 1.8,
      },
    ],
  };
}

function bundleForScene(): FrameBundle {
  return {
    bundleVersion: 1,
    sceneId: "scene-readonly-001",
    source: "replay",
    dpr: 3,
    viewport: { width: 1280, height: 800 },
    keyframes: [
      {
        byteLength: 0,
        sourceTimeMs: 0,
        ref: "k0",
        width: 3840,
        height: 2400,
        actionId: null,
      },
      {
        byteLength: 0,
        sourceTimeMs: 9000,
        ref: "k1",
        width: 3840,
        height: 2400,
        actionId: "act-3",
      },
    ],
    motionSpans: [],
    cursorSamples: [
      { sourceTimeMs: 0, x: 0, y: 0 },
      { sourceTimeMs: 9000, x: 640, y: 328 },
    ],
    cursorGaps: [],
    // Two entries, same anchorId, different actionId and rect — replay
    // re-measured the checkout button at each of its two clicks. No entry
    // for act-3: a-row was never re-measured, so its camera key has to fall
    // back to the anchor's fingerprint rect.
    anchorRects: [
      { actionId: "act-1", anchorId: "a-checkout", rect: FIRST_RECT },
      { actionId: "act-2", anchorId: "a-checkout", rect: SECOND_RECT },
    ],
    markers: [
      { actionId: "act-1", sourceTimeMs: 1000 },
      { actionId: "act-2", sourceTimeMs: 5000 },
      { actionId: "act-3", sourceTimeMs: 9000 },
    ],
    degradations: [],
  };
}

describe("per-action rect resolution", () => {
  // This is the assertion that fails today. `resolve.ts` and `plan.ts` each
  // built one map keyed by anchorId alone, so `act-2`'s rect (written second)
  // overwrote `act-1`'s and the FIRST click's waypoint landed at the SECOND
  // click's position.
  it("plans the FIRST action's cursor waypoint at the FIRST rect, not the second's", () => {
    const scene = sceneWithTwoActionsOnOneAnchor();
    const plan = planScene(scene);
    const firstSegment = plan.cursorSegments.find(
      (s) => s.toActionId === "act-1",
    );
    expect(firstSegment?.to).toEqual(rectCenter(FIRST_RECT));
  });

  it("solves the FIRST action's camera key at the FIRST rect, not the second's", () => {
    const scene = sceneWithTwoActionsOnOneAnchor();
    const plan = planScene(scene);
    const resolved = resolvePlan(plan, bundleForScene(), scene);
    const zoomKeys = resolved.cameraKeys.filter((k) => k.scale > 1);
    expect(zoomKeys[0]?.center).toEqual(rectCenter(FIRST_RECT));
  });

  // The fallback must survive the fix: an action whose anchorId has no
  // per-action entry (act-3, on a-row) still resolves to the anchor's
  // fingerprint.boundingRect — the first sighting.
  it("falls back to the anchor's fingerprint rect when an action has no per-action entry", () => {
    const scene = sceneWithTwoActionsOnOneAnchor();
    const plan = planScene(scene);
    const resolved = resolvePlan(plan, bundleForScene(), scene);
    const zoomKeys = resolved.cameraKeys.filter((k) => k.scale > 1);
    const aRow = scene.anchors.find((a) => a.id === "a-row");
    const fallbackRect = aRow?.fingerprint.boundingRect;
    expect(fallbackRect).toBeTruthy();
    expect(zoomKeys[2]?.center).toEqual(rectCenter(fallbackRect as never));
  });
});
