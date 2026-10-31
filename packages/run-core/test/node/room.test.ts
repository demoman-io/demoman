import { CAMERA_DEFAULTS } from "@demoman/compositor";
import { MOTION_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { takeOf } from "../../../replay-engine/test/helpers/film";
import { ZOOM_FLOOR_SCALE, zoomsForClicks } from "../../src/auto-zoom.js";
import { createRoomPolicy, PAN_MARGIN_MS } from "../../src/room.js";
import { MIN_ZOOM_GAP_MS } from "../../src/zoom-defaults.js";

// Spec 2026-10-19 (unhurried beats): the replay waits before a zoomed click
// until the camera has room, and must never make a zoom that the take would
// not have had. So the policy decides exactly as zoomsForClicks does.

const viewport = { width: 1280, height: 800 };

describe("createRoomPolicy", () => {
  it("needs the settle, the push-in and the lead-in", () => {
    const first = { heldUntilMs: null, clickMs: 5000 };
    expect(createRoomPolicy(viewport, MOTION_DEFAULTS).neededMs(first)).toBe(
      400 + 1300 + 350,
    );
    expect(
      createRoomPolicy(viewport, {
        ...MOTION_DEFAULTS,
        smoothness: 1,
      }).neededMs(first),
    ).toBe(400 + 1600 + 350);
    expect(CAMERA_DEFAULTS.actSettleMs).toBe(400);
  });

  // Spec 2026-10-22: a click the camera pans to from the zoom before it
  // needs no push-in, so the walk adds nothing (the author's pacing "C").
  it("needs nothing for a pan inside a run", () => {
    const policy = createRoomPolicy(viewport, MOTION_DEFAULTS);
    // The zoom before landed 350ms before its click at 1000; this click is
    // 1.2s after that one.
    expect(policy.neededMs({ heldUntilMs: 1000 - 350, clickMs: 2200 })).toBe(0);
  });

  it("needs the push-in's room where the camera will return", () => {
    const policy = createRoomPolicy(viewport, MOTION_DEFAULTS);
    // Premise: 2725 is exactly the gap a return needs at the default
    // smoothness (push-in 1300, pull-out 925, two 250ms holds).
    expect(
      CAMERA_DEFAULTS.zoomInMs +
        CAMERA_DEFAULTS.zoomOutMs +
        2 * CAMERA_DEFAULTS.neutral.minPlateauMs,
    ).toBe(2725);
    // The next arrival is its click less 350.
    expect(
      policy.neededMs({ heldUntilMs: 650, clickMs: 650 + 350 + 2725 }),
    ).toBe(2050);
    // A gap within `PAN_MARGIN_MS` of a return is paced as one: the click
    // lands a little after the walk projects it, and room only widens the
    // gap, so the walk never paces a pan the camera then renders as a return.
    expect(PAN_MARGIN_MS).toBe(300);
    expect(
      policy.neededMs({ heldUntilMs: 650, clickMs: 650 + 350 + 2725 - 300 }),
    ).toBe(2050);
    expect(
      policy.neededMs({ heldUntilMs: 650, clickMs: 650 + 350 + 2724 - 300 }),
    ).toBe(0);
  });

  it("decides as zoomsForClicks does", () => {
    const base = takeOf(["click", "click", "click", "click"]);
    const narrow = { x: 100, y: 100, width: 140, height: 40 };
    const wide = { x: 0, y: 100, width: 1270, height: 40 };
    const at = [1000, 1000 + MIN_ZOOM_GAP_MS - 100, 6000, 9000];
    const actions = base.actions.map((a, i) => ({
      ...a,
      timestamp: at[i] as number,
      rect: i === 2 ? wide : narrow,
    }));
    const { camera, zoomsSkipped } = zoomsForClicks(actions, viewport);
    // Premise: the second click is too close, the third too wide.
    expect(zoomsSkipped.map((s) => [s.actionId, s.reason])).toEqual([
      [actions[1]?.id, "tooClose"],
      [actions[2]?.id, "targetTooWide"],
    ]);
    expect(ZOOM_FLOOR_SCALE).toBe(1.2);
    const zoomed = new Set(camera.map((c) => c.marker.actionId));

    const policy = createRoomPolicy(viewport, MOTION_DEFAULTS);
    const answers = actions.map((a) =>
      policy.zooms({
        actionId: a.id,
        anchorId: a.anchorId as string,
        rect: a.rect as typeof narrow,
        unwaitedMs: a.timestamp,
        scale: 1,
      }),
    );
    expect(answers).toEqual(actions.map((a) => zoomed.has(a.id)));
  });

  // Code review 2026-10-20 (R10): the page zoom is looked up only for a
  // click the gap rule lets through, as before decideZoom was pulled out.
  it("asks the page zoom only of clicks past the gap rule", () => {
    const base = takeOf(["click", "click", "click"]);
    const at = [1000, 1000 + MIN_ZOOM_GAP_MS - 100, 6000];
    const actions = base.actions.map((a, i) => ({
      ...a,
      timestamp: at[i] as number,
      rect: { x: 100, y: 100, width: 140, height: 40 },
    }));
    const asked: string[] = [];
    const { zoomsSkipped } = zoomsForClicks(actions, viewport, (a) => {
      asked.push(a.id);
      return 1;
    });
    // Premise: the second click is too close.
    expect(zoomsSkipped.map((z) => z.reason)).toEqual(["tooClose"]);
    expect(asked).toEqual([actions[0]?.id, actions[2]?.id]);
  });

  // Spec 2026-10-30 F: the camera's last pull-out lands the zoom hold and
  // the pull-out after what the zoom holds until (`insertNeutralKeys`), at
  // the take's own smoothness; the take runs a settle past that.
  it("settles after the hold, the pull-out at the take's smoothness, and SETTLE_MS", () => {
    expect(
      createRoomPolicy(viewport, MOTION_DEFAULTS).settledAfterMs(1000),
    ).toBe(1000 + 1200 + 925 + 300);
    expect(
      createRoomPolicy(viewport, {
        ...MOTION_DEFAULTS,
        smoothness: 1,
      }).settledAfterMs(1000),
    ).toBe(1000 + 1200 + 1150 + 300);
    expect(CAMERA_DEFAULTS.neutral.zoomHoldMs).toBe(1200);
  });
});
