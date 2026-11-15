import { describe, expect, it } from "vitest";
import { type AuthoredStep, trimFromScript } from "../../src/authored.js";
import { SETTLE_MS } from "../../src/constants.js";

// Code review, 2026-11-14: a planned take's tail is sized on the designed
// clock to just hold the end trim, and the video runs a journey's eased end
// (50-73 ms) shorter than designed, so the trim landed past the take and was
// dropped.

const script = {
  scriptVersion: 8,
  name: "end",
  target: "https://app.example.com/",
  steps: [{ do: "click", on: { text: "Save" } }],
  trim: { end: { ms: 500 } },
} as never;

/** One performed step at output 2000 ms whose zoom is out 1000 ms later. */
const step = (planned: boolean): AuthoredStep =>
  ({
    index: 0,
    actionId: "ac-1",
    timing: { markerMs: 2000, finishMs: 0, zoomOutMs: 1000 },
    ...(planned
      ? {
          outputTiming: {
            markerMs: 2000,
            finishMs: 0,
            zoomOutMs: 1000,
            heldUntilMs: null,
          },
        }
      : {}),
  }) as never;

/** The end the trim asks for: the marker, the zoom-out, the 500 ms. */
const ASKED_END = 2000 + 1000 + 500;

describe("a planned take's end trim that lands just past the take", () => {
  // Red if the slack is dropped: `unplaced` is ["end"] and no tail is
  // written.
  it("is placed at the take's end", () => {
    const placed = trimFromScript(script, [step(true)], ASKED_END - 60);
    expect(placed.unplaced).toEqual([]);
    expect(placed.trim?.tail).toEqual({ actionId: "ac-1", offsetMs: 1440 });
  });

  it("is placed where it asks when the take holds it", () => {
    const placed = trimFromScript(script, [step(true)], ASKED_END);
    expect(placed.trim?.tail).toEqual({ actionId: "ac-1", offsetMs: 1500 });
  });

  it("is still said when it misses by more than a settle", () => {
    const placed = trimFromScript(
      script,
      [step(true)],
      ASKED_END - SETTLE_MS - 1,
    );
    expect(placed.unplaced).toEqual(["end"]);
    expect(placed.trim).toBeUndefined();
  });

  // A take without a plan is measured, not designed: a miss there is a run
  // that stopped before its tail, and stays said.
  it("is not given to a take without a plan", () => {
    const placed = trimFromScript(script, [step(false)], ASKED_END - 60);
    expect(placed.unplaced).toEqual(["end"]);
  });
});
