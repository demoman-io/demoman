import type { ReplayResult } from "@demoman/replay-engine";
import { describe, expect, it } from "vitest";
import { scene } from "../../../replay-engine/test/helpers/replay-scene";
import { replayEvent } from "../../src/index.js";

const result: ReplayResult = {
  bundle: null,
  outcome: "partial",
  completed: 3,
  total: 9,
  lastCompletedActionId: "act-3",
  reason: "waitTimeout",
  storageRefused: false,
  degradations: [],
  hoverSensitive: false,
  counters: {
    actions: 9,
    completed: 3,
    replayThrough: 3 / 9,
    keyframes: 7,
    motionSpans: 2,
    motionFrames: 84,
    droppedMotionFrames: 3,
    surfaceMismatchFrames: 0,
    encodeRefusedFrames: 0,
    encodeShrunkSpans: 0,
    budgetBreaches: 3,
    keyframeOnlySpans: 1,
    occlusionPauses: 0,
    occlusionMs: 0,
    heapHighWater: 0.42,
    motionWidth: 2560,
    motionHeight: 1600,
    durationMs: 8400,
    dpr: 3,
    viewportWidth: 1280,
    viewportHeight: 800,
  },
};

describe("replayEvent", () => {
  it("carries v9's four counters", () => {
    const event = replayEvent(scene(), result, {
      id: "t-1",
      at: "2026-08-25T10:00:00.000Z",
    });

    // frame-source mix, budget breaches and degradations, occlusion pauses,
    // replay-through rate — v9's telemetry list, in order.
    expect(event.data.keyframes).toBe(7);
    expect(event.data.motionFrames).toBe(84);
    expect(event.data.budgetBreaches).toBe(3);
    expect(event.data.keyframeOnlySpans).toBe(1);
    expect(event.data.occlusionPauses).toBe(0);
    expect(event.data.replayThrough).toBeCloseTo(0.333, 2);
    expect(event.data.outcome).toBe("partial");
    expect(event.data.reason).toBe("waitTimeout");
  });

  // SP1's open question #4, answered from real runs instead of a manual
  // re-measurement on a 1x monitor.
  it("records the motion stream's real size against the emulated DPR", () => {
    const event = replayEvent(scene(), result, {
      id: "t-1",
      at: "2026-08-25T10:00:00.000Z",
    });
    expect(event.data.motionWidth).toBe(2560);
    expect(event.data.dpr).toBe(3);
    expect(event.data.viewportWidth).toBe(1280);
  });

  // outcome and reason are independent facts: a run can finish every action
  // and still fail to persist its bundle. Neither is derived from the other.
  it("carries outcome and reason as independent facts", () => {
    const complete: ReplayResult = {
      ...result,
      outcome: "complete",
      reason: "portFailure",
    };
    const event = replayEvent(scene(), complete, {
      id: "t-2",
      at: "2026-08-25T10:00:00.000Z",
    });
    expect(event.data.outcome).toBe("complete");
    expect(event.data.reason).toBe("portFailure");
  });

  // The case this round exists for: a run that stopped early for its own
  // reason and then also failed to persist. `reason` is never overwritten to
  // say so — `storageRefused` is the only place that second fact survives, and
  // it must show up alongside the original reason, not instead of it.
  it("shows both an original stop reason and a later persistence failure", () => {
    const stoppedThenRefused: ReplayResult = {
      ...result,
      outcome: "partial",
      reason: "waitTimeout",
      storageRefused: true,
    };
    const event = replayEvent(scene(), stoppedThenRefused, {
      id: "t-4",
      at: "2026-08-25T10:00:00.000Z",
    });
    expect(event.data.reason).toBe("waitTimeout");
    expect(event.data.storageRefused).toBe(true);
  });
});
