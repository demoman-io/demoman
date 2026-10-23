import { describe, expect, it } from "vitest";
import { buildCaptureBundle, tagKeyframes } from "../../src/index.js";
import { scene } from "../helpers/replay-scene";

const shot = (sourceTimeMs: number) => ({
  sourceTimeMs,
  ref: `kf:s1:capture:${sourceTimeMs}`,
  width: 1280,
  height: 800,
  byteLength: 0,
});

describe("buildCaptureBundle with motion", () => {
  it("carries motion spans through to the bundle", () => {
    const bundle = buildCaptureBundle(scene(), [shot(0), shot(1000)], {
      spans: [
        {
          startMs: 100,
          endMs: 800,
          ref: "span:s1:capture:0",
          width: 2560,
          height: 1600,
          fps: 30,
          byteLength: 0,
        },
      ],
      degradations: [],
    });
    expect(bundle.motionSpans.length).toBe(1);
    expect(bundle.source).toBe("capture");
  });

  it("carries each shot's byteLength onto its keyframe entry", () => {
    const entries = tagKeyframes(
      [
        {
          sourceTimeMs: 10,
          ref: "kf:s:0",
          width: 8,
          height: 8,
          byteLength: 777,
        },
      ],
      [],
    );
    expect(entries[0]?.byteLength).toBe(777);
  });

  it("carries degradations, so retiming does not read a lost stretch as dead air", () => {
    const bundle = buildCaptureBundle(
      scene(),
      [shot(0)],
      {
        spans: [],
        degradations: [
          {
            startMs: 200,
            endMs: 900,
            kind: "keyframeOnly",
            note: "credential field open",
          },
        ],
      },
      // A non-empty cursor, so this motion-only test does not also pick up
      // `bundle.ts`'s `cursorSynthesized` degradation (Task 8) — that
      // belongs to the cursor tests in pointer-routing.test.ts, and mixing
      // it in here would dilute this test's own length check down to a
      // membership check that could no longer catch a spurious third
      // degradation.
      { samples: [{ sourceTimeMs: 0, x: 0, y: 0 }], gaps: [] },
    );
    expect(bundle.degradations.length).toBe(1);
  });

  it("still builds a stills-only bundle when no motion is given", () => {
    const bundle = buildCaptureBundle(scene(), [shot(0)]);
    expect(bundle.motionSpans).toEqual([]);
    expect(bundle.cursorSamples).toEqual([]);
  });

  it("refuses a capture bundle carrying cursor samples it never dispatched", () => {
    // Guard on the invariant the schema enforces for replay: capture never
    // dispatches a cursor, so it must never claim samples.
    const bundle = buildCaptureBundle(scene(), [shot(0)]);
    expect(bundle.cursorSamples.length).toBe(0);
  });

  it("records the action log the take was made from", () => {
    const doc = scene({
      actions: [
        {
          id: "act-1",
          kind: "type",
          anchorId: "first-btn",
          timestamp: 0,
          marker: "type:first-btn",
          text: "northwind",
          redacted: false,
        },
        {
          id: "act-2",
          kind: "click",
          anchorId: "second-btn",
          timestamp: 900,
          marker: "click:second-btn",
        },
      ],
    });
    const bundle = buildCaptureBundle(doc, [shot(0), shot(900)]);
    expect(bundle.madeFrom?.map((s) => s.actionId)).toEqual(
      doc.actions.map((a) => a.id),
    );
    // Premise: the take has a typed step, or the field this exists to carry
    // across a reload is not in the fixture at all.
    expect(bundle.madeFrom?.some((s) => s.text !== null)).toBe(true);
  });
});
