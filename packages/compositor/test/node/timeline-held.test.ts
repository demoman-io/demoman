import { describe, expect, it } from "vitest";
import { type FrameBundle, isHeld } from "../../src/bundle";
import { planScene } from "../../src/plan/plan";
import { buildTimeline } from "../../src/plan/timeline";
import type { RenderPlan } from "../../src/plan/types";
import { readonlyScene } from "../fixtures/scene";

const GAP = 6000;

function heldBundle(): FrameBundle {
  const key = (sourceTimeMs: number, ref: string, actionId: string | null) => ({
    byteLength: 0,
    sourceTimeMs,
    ref,
    width: 3840,
    height: 2400,
    actionId,
  });
  return {
    bundleVersion: 1,
    sceneId: "scene-readonly-001",
    source: "replay",
    timing: "real",
    clock: "held",
    dpr: 3,
    viewport: { width: 1280, height: 800 },
    keyframes: [key(0, "k0", null), key(GAP, "k1", "a2")],
    motionSpans: [],
    cursorSamples: [{ sourceTimeMs: 0, x: 0, y: 0 }],
    cursorGaps: [],
    anchorRects: [],
    markers: [
      { actionId: "a1", sourceTimeMs: 0 },
      { actionId: "a2", sourceTimeMs: GAP },
    ],
    networkSpans: [{ startMs: 1000, endMs: 5000, label: "POST /api/chat" }],
    degradations: [],
  };
}

const plan = planScene(readonlyScene());
const hint = { startMs: 1000, endMs: 2000 };

describe("buildTimeline on a held take", () => {
  it("plays a held take at its recorded length", () => {
    const bundle = heldBundle();
    expect(isHeld(bundle)).toBe(true);
    const t = buildTimeline({ ...plan, paces: null }, bundle);
    expect(t.outputDurationMs).toBe(t.sourceDurationMs);
    expect(t.sourceDurationMs).toBe(GAP);
    for (const s of t.segments) {
      expect(s.outEndMs - s.outStartMs).toBeCloseTo(
        s.srcEndMs - s.srcStartMs,
        6,
      );
    }
  });

  it("takes no keyframe-diff hint as motion on a held take", () => {
    // Red if `buildTimeline` counts keyframe hints as motion on a held take.
    const t = buildTimeline({ ...plan, paces: null }, heldBundle(), [], [hint]);
    const inside = t.segments.filter(
      (s) => s.srcStartMs < hint.endMs && s.srcEndMs > hint.startMs,
    );
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((s) => s.kind === "idle")).toBe(true);
    // Premise: the same hint on a real-clock take is motion.
    const real = buildTimeline(
      { ...plan, paces: null },
      { ...heldBundle(), clock: undefined },
      [],
      [hint],
    );
    expect(real.segments.some((s) => s.kind === "motion")).toBe(true);
  });

  it("an authored gap still shortens a hold", () => {
    const authored: RenderPlan = {
      ...plan,
      paces: [
        {
          afterActionId: "a1",
          beforeActionId: "a2",
          origin: "authored",
          idleTargetMs: 200,
        },
      ],
    };
    const t = buildTimeline(authored, heldBundle());
    expect(t.outputDurationMs).toBeCloseTo(200, 0);
  });
});
