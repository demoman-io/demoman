import { describe, expect, it } from "vitest";
import {
  CAMERA_DEFAULTS,
  heldThroughEndMs,
  motionTimings,
  pullOutLandsAt,
} from "../../src/plan/camera";

// DEM-178: a video trimmed `after: "action"` ends on the close-up, however
// late its step finished.
describe("heldThroughEndMs", () => {
  const hold = CAMERA_DEFAULTS.neutral.zoomHoldMs;

  it("holds nothing when the zoom's own pull-out starts at or after the cut", () => {
    expect(heldThroughEndMs(1000, 1000 + hold)).toBeNull();
    expect(heldThroughEndMs(1000, 1500)).toBeNull();
  });

  it("lands late enough that no smoothness starts the pull-out before the cut", () => {
    const cut = 1000 + hold + 1;
    const end = heldThroughEndMs(1000, cut);
    expect(end).not.toBeNull();
    for (const smoothness of [0, 0.5, 1]) {
      const start = (end as number) - motionTimings(smoothness).zoomOutMs;
      expect(start, `smoothness ${smoothness}`).toBeGreaterThanOrEqual(cut);
    }
    // Premise: the default return would have started before this cut.
    expect(
      pullOutLandsAt(1000, motionTimings(0.5)) - motionTimings(0.5).zoomOutMs,
    ).toBeLessThan(cut);
  });
});
