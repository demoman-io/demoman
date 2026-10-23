import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import {
  bridgeCutSeams,
  CUT_BRIDGE_MS,
  resolvePlan,
  sampleCursor,
} from "../../src/plan/resolve";
import { buildTimeline, toSourceMs } from "../../src/plan/timeline";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene, removedFor } from "../fixtures/scene";

/**
 * act-1 cut, not act-2: cutting act-2 runs to act-3's marker, which on this
 * fixture IS the take's end, so there would be no frames after the seam to
 * glide across. act-1's run removes 400–3200ms and leaves the rest.
 */
function cutScene() {
  const scene = readonlyScene();
  return {
    ...scene,
    edits: {
      ...scene.edits,
      removed: removedFor(scene, [{ id: "cut-1", actionId: "act-1" }]),
    },
  };
}

describe("the cursor across a cut", () => {
  it("glides rather than teleporting", () => {
    const bundle = proceduralBundle();
    // Premise: the recorded positions on the two sides of the cut really are
    // far apart. Without this a "never steps far" assertion is satisfied by
    // a fixture whose pointer barely moved, and tests nothing.
    const at = new Map(bundle.cursorSamples.map((s) => [s.sourceTimeMs, s]));
    const before = at.get(400);
    const after = at.get(3200);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(
      Math.hypot(
        (after?.x ?? 0) - (before?.x ?? 0),
        (after?.y ?? 0) - (before?.y ?? 0),
      ),
    ).toBeGreaterThan(400);

    const scene = cutScene();
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    // Premise: the cut really did remove that stretch, or there is no seam
    // for the bridge to cross.
    expect(resolved.timeline.cuts[0]).toMatchObject({
      srcStartMs: 400,
      srcEndMs: 3200,
    });

    // Sample the drawn cursor at 1/60s of OUTPUT time, the way `compose.ts`
    // does: output time -> source time -> sampleCursor.
    const stepMs = 1000 / 60;
    let worstStepPx = 0;
    for (
      let out = 0;
      out + stepMs <= resolved.timeline.outputDurationMs;
      out += stepMs
    ) {
      const a = sampleCursor(
        resolved.cursor,
        toSourceMs(resolved.timeline, out),
      );
      const b = sampleCursor(
        resolved.cursor,
        toSourceMs(resolved.timeline, out + stepMs),
      );
      if (!a || !b) continue;
      worstStepPx = Math.max(worstStepPx, Math.hypot(b.x - a.x, b.y - a.y));
    }
    // 400px+ spread over at least CUT_BRIDGE_MS of output time is well under
    // 40px per 1/60s frame; an unbridged seam puts the whole distance into
    // a single step.
    expect(worstStepPx).toBeLessThan(60);
    expect(CUT_BRIDGE_MS).toBe(250);
  });

  /**
   * FINAL REVIEW's ledger, minor #2: this case used to compare
   * `resolvePlan(x)` against `resolvePlan(x)` — a second call on the exact
   * same inputs, which proves the resolve pipeline is deterministic and
   * proves nothing about `bridgeCutSeams` in particular. Any function this
   * test called instead of the real one, so long as it was itself
   * deterministic, would have passed it too.
   *
   * Rewritten to compare against the PRE-BRIDGE sample list — the fixture's
   * own recorded samples, never run through `bridgeCutSeams` at all — rather
   * than a second run of the same pipeline. Outside the bridge window every
   * sample must survive byte-for-byte; inside it (this cut's own closing
   * instant, `srcEndMs`) the fixture never recorded a sample at all, and the
   * bridge inserts one — the synthetic point a glide starts from.
   */
  it("changes the drawn cursor only inside the bridge window, against the pre-bridge samples", () => {
    const bundle = proceduralBundle();
    const scene = cutScene();
    const timeline = buildTimeline(planScene(scene), bundle);
    const cut = timeline.cuts[0];
    // Premise: the cut really did remove 400–3200ms, same as the glide test
    // above.
    expect(cut).toMatchObject({ srcStartMs: 400, srcEndMs: 3200 });

    const preBridge = bundle.cursorSamples;
    const bridged = bridgeCutSeams(preBridge, timeline, CUT_BRIDGE_MS);

    // Outside the window: every sample the fixture recorded survives, exactly
    // as recorded — checked against the PRE-BRIDGE list itself, not a second
    // resolve, so a bridge that touched the wrong stretch would be caught
    // here rather than cancelled out by touching both calls identically.
    const outside = preBridge.filter(
      (s) => s.sourceTimeMs < (cut?.srcEndMs ?? 0),
    );
    expect(outside.length).toBeGreaterThan(0);
    for (const sample of outside) expect(bridged).toContainEqual(sample);

    // Inside it: the fixture recorded a real sample at 3200ms (640, 328 —
    // see the fixture), and the bridge REPLACES it with a synthetic one
    // carrying the pre-cut position instead.
    const recordedAtClose = preBridge.find(
      (s) => s.sourceTimeMs === (cut?.srcEndMs ?? -1),
    );
    expect(recordedAtClose).toBeDefined();
    const bridgedAtClose = bridged.find(
      (s) => s.sourceTimeMs === (cut?.srcEndMs ?? -1),
    );
    expect(bridgedAtClose).toBeDefined();
    expect(bridgedAtClose).not.toEqual(recordedAtClose);
  });

  /**
   * FINAL REVIEW's ledger, minor #2's other half: this case used to sample
   * at `cut.srcStartMs` (400ms) — the position BEFORE the cut opens, which
   * `bridgeCutSeams` never touches at all (its window starts at `fromMs ===
   * cut.srcEndMs`). Passing there proved only that `sampleCursor` reads the
   * fixture's own recorded value back, with or without a bridge.
   *
   * Rewritten to sample AT the window's own start (`cut.srcEndMs`, where
   * `bridge.from` is placed) and assert it reads the PRE-cut position rather
   * than whatever the fixture actually recorded there — the two differ on
   * this fixture (200,42 vs 640,328), which is the premise that makes this
   * assertion capable of failing.
   */
  it("starts the glide from where the pointer was when the cut opened, not the point it re-enters on", () => {
    const bundle = proceduralBundle();
    const scene = cutScene();
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const cut = resolved.timeline.cuts[0];
    expect(cut).toMatchObject({ srcStartMs: 400, srcEndMs: 3200 });

    const recordedAtOpen = bundle.cursorSamples.find(
      (s) => s.sourceTimeMs === 400,
    );
    const recordedAtClose = bundle.cursorSamples.find(
      (s) => s.sourceTimeMs === 3200,
    );
    expect(recordedAtOpen).toBeDefined();
    expect(recordedAtClose).toBeDefined();
    // Premise: the two really do differ, or reading either one back would
    // pass this assertion regardless of which position the bridge chose.
    expect(
      Math.hypot(
        (recordedAtClose?.x ?? 0) - (recordedAtOpen?.x ?? 0),
        (recordedAtClose?.y ?? 0) - (recordedAtOpen?.y ?? 0),
      ),
    ).toBeGreaterThan(100);

    const atSeamReentry = sampleCursor(resolved.cursor, cut?.srcEndMs ?? -1);
    expect(atSeamReentry?.x).toBeCloseTo(recordedAtOpen?.x ?? -1, 3);
    expect(atSeamReentry?.y).toBeCloseTo(recordedAtOpen?.y ?? -1, 3);
  });
});

// Review 2026-10-22: removing the take's first piece left a seam at the very
// start, and the bridge glided the pointer in from a position in frames the
// viewer never saw — motion added to the picture.
describe("a piece removed from the take's start", () => {
  it("adds no glide: there are no frames before it to glide from", () => {
    const bundle = proceduralBundle();
    const base = readonlyScene();
    const leading = {
      ...base,
      edits: {
        ...base.edits,
        removed: [
          {
            id: "r-1",
            start: null,
            end: { actionId: "act-2", sourceOffsetMs: 0 },
          },
        ],
      },
    };
    const timeline = buildTimeline(planScene(leading), bundle);
    // Premise: one cut, from the take's start, with frames after it.
    expect(timeline.cuts).toMatchObject([{ srcStartMs: 0, trailing: false }]);
    const samples = bundle.cursorSamples;
    expect(bridgeCutSeams(samples, timeline, CUT_BRIDGE_MS)).toBe(samples);
    // Positive control: an interior cut on the same frames does bridge.
    const inner = buildTimeline(planScene(cutScene()), bundle);
    expect(bridgeCutSeams(samples, inner, CUT_BRIDGE_MS)).not.toBe(samples);
  });
});
