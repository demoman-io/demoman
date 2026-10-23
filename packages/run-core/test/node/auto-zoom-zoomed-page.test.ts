import { describe, expect, it } from "vitest";
import { takeOf } from "../../../replay-engine/test/helpers/film";
import { zoomsForClicks } from "../../src/auto-zoom.js";

/**
 * A phone shows a page with no meta viewport zoomed out: it lays out 980 px
 * wide and is drawn at 393, scale 0.401 (probe:tap-space). A click's rect is
 * in the page's own px, so a button 300 px wide there is 120 px on the
 * phone's screen — and the zoom has to be fitted to the 120.
 */
describe("zoomsForClicks on a zoomed-out page", () => {
  const SCALE = 393 / 980;
  const viewport = { width: 393, height: 852 };
  const base = takeOf(["click"]);
  const actions = base.actions.map((a) => ({
    ...a,
    rect: { x: 100, y: 600, width: 300, height: 60 },
  }));

  it("fits the target as the screen shows it, not at its page width", () => {
    const flat = zoomsForClicks(actions, viewport);
    const zoomed = zoomsForClicks(actions, viewport, () => SCALE);
    // The premise: read as screen px, 300 px of a 393 px screen leaves no
    // zoom worth making.
    expect(flat.camera).toHaveLength(0);
    expect(flat.zoomsSkipped[0]?.reason).toBe("targetTooWide");
    // As the screen showed it, 120 px fits at the default zoom.
    expect(zoomed.camera[0]?.scale).toBe(1.8);
  });
});
