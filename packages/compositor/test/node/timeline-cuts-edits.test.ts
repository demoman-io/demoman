import { describe, expect, it } from "vitest";
import { planScene } from "../../src/plan/plan";
import { buildTimeline } from "../../src/plan/timeline";
import type { RenderPlan } from "../../src/plan/types";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene, removedFor } from "../fixtures/scene";

/**
 * The plan for a take with act-2 cut. On `proceduralBundle` that removes
 * 3200–9000ms: act-2's marker to act-3's.
 */
function cutPlan(): RenderPlan {
  const scene = readonlyScene();
  return planScene({
    ...scene,
    edits: {
      ...scene.edits,
      removed: removedFor(scene, [{ id: "cut-1", actionId: "act-2" }]),
    },
  });
}

describe("edits inside a removed stretch", () => {
  it("plays no hold whose instant is inside the cut", () => {
    const bundle = proceduralBundle();
    // A hold on the SURVIVING act-1, pushed by its own offset into the
    // removed stretch. (A hold ON a cut step never reaches the timeline at
    // all — `planScene` detaches it; see `plan-cuts.test.ts`.)
    const plan = {
      ...cutPlan(),
      holds: [
        { id: "h-1", actionId: "act-1", offsetMs: 4000, durationMs: 700 },
      ],
    };
    // Premise: act-1's marker plus that offset really does land strictly
    // inside 3200–9000, or this case would assert nothing about cuts.
    const at = new Map(bundle.markers.map((m) => [m.actionId, m.sourceTimeMs]));
    expect((at.get("act-1") ?? 0) + 4000).toBeGreaterThan(3200);
    expect((at.get("act-1") ?? 0) + 4000).toBeLessThan(9000);

    const withCut = buildTimeline(plan, bundle);
    expect(withCut.segments.some((s) => s.kind === "hold")).toBe(false);
    // And the same hold DOES play when the cut is gone — otherwise the
    // absence above could come from the hold never having worked.
    const noCut = buildTimeline({ ...plan, removed: [] }, bundle);
    expect(noCut.segments.filter((s) => s.kind === "hold")).toHaveLength(1);
  });

  it("keeps a hold standing exactly on the seam", () => {
    const bundle = proceduralBundle();
    const plan = {
      ...cutPlan(),
      holds: [{ id: "h-1", actionId: "act-2", offsetMs: 0, durationMs: 700 }],
    };
    // act-2's marker IS the stretch's opening instant, which is the last
    // frame still in the video. A pause there is a pause on the seam and it
    // plays. Hand-built rather than authored, precisely to exercise the
    // BOUNDARY rule rather than the attachment rule `planScene` applies
    // first.
    expect(
      bundle.markers.find((m) => m.actionId === "act-2")?.sourceTimeMs,
    ).toBe(3200);
    const timeline = buildTimeline(plan, bundle);
    expect(timeline.segments.filter((s) => s.kind === "hold")).toHaveLength(1);
  });

  /**
   * The ledger's minor #1: `insideCut` was closed at `srcEndMs` while the
   * segmentation keeps that frame, so a LEGACY hold landing exactly on a
   * cut's closing marker was dropped though its frame plays. Fixed by
   * splitting the predicate (`insideCutClosed` / `insideCutOpen`,
   * `timeline.ts`) rather than moving the one boundary both callers shared.
   *
   * Both halves in one case, at the SAME instant (act-3's marker, which is
   * also `cutPlan()`'s cut's own `srcEndMs` — see this file's header): a
   * hold there is emitted, because `holdInstants` wants the open form and
   * the frame it names is the first one back after the seam; a pace there
   * is still dropped, because `paceInstants` wants the closed form and a
   * wait for the very step the cut runs up to was already removed with it.
   * Proving only one half would leave the split half-made.
   */
  it("keeps a hold standing exactly on a cut's closing marker, and still drops a pace there", () => {
    const bundle = proceduralBundle();
    // Premise: act-3's marker really is this cut's closing instant.
    expect(
      bundle.markers.find((m) => m.actionId === "act-3")?.sourceTimeMs,
    ).toBe(9000);
    const removed = buildTimeline(cutPlan(), bundle).cuts[0];
    expect(removed).toMatchObject({ srcStartMs: 3200, srcEndMs: 9000 });

    // The hold half.
    const holdPlan = {
      ...cutPlan(),
      holds: [{ id: "h-1", actionId: "act-3", offsetMs: 0, durationMs: 700 }],
    };
    const withHold = buildTimeline(holdPlan, bundle);
    expect(withHold.segments.filter((s) => s.kind === "hold")).toHaveLength(1);

    // The pace half — only on a replay bundle, and only where the author's
    // target exceeds what the replay itself left, exactly as the earlier
    // pace case in this file requires.
    const replayBundle = proceduralBundle({ source: "replay" });
    const scene = readonlyScene();
    const paced = {
      ...scene,
      edits: {
        ...scene.edits,
        gaps: [{ id: "gap-1", afterActionId: "act-2", durationMs: 20_000 }],
        removed: removedFor(scene, [{ id: "cut-1", actionId: "act-2" }]),
      },
    };
    const pacePlan = planScene(paced);
    // Premise: without the cut, this really does produce a pace freeze
    // exactly at act-3's marker — the same instant the hold above lands on.
    const noCut = buildTimeline({ ...pacePlan, removed: [] }, replayBundle);
    const freezes = noCut.segments.filter((s) => s.kind === "pace");
    expect(freezes).toHaveLength(1);
    expect(freezes[0]?.srcStartMs).toBe(9000);

    const withPace = buildTimeline(pacePlan, replayBundle);
    expect(withPace.segments.some((s) => s.kind === "pace")).toBe(false);
  });

  it("plays no reconstructed pace inside the cut, and counts none unplaced", () => {
    // Paces only exist on a replay bundle (`paceInstants`' gate), and only
    // where the author's target EXCEEDS the replay's own dead air — the
    // reconstruction is a floor, never a ceiling. The fixture's recorded
    // pacing is already met exactly, so it produces no instant at all and a
    // version of this case built on it would pass with and without the
    // implementation. An authored gap far longer than the take's own is
    // what puts a real freeze at act-3's marker.
    const bundle = proceduralBundle({ source: "replay" });
    const scene = readonlyScene();
    const paced = {
      ...scene,
      edits: {
        ...scene.edits,
        gaps: [{ id: "gap-1", afterActionId: "act-2", durationMs: 20_000 }],
      },
    };
    const plan = planScene({
      ...paced,
      edits: {
        ...paced.edits,
        removed: removedFor(paced, [{ id: "cut-1", actionId: "act-2" }]),
      },
    });

    // Premise: without the cut, a `pace` freeze really is emitted, and it
    // really does stand inside the stretch the cut removes.
    const noCut = buildTimeline({ ...plan, removed: [] }, bundle);
    const freezes = noCut.segments.filter((s) => s.kind === "pace");
    expect(freezes).toHaveLength(1);
    // ...and it really does stand inside the stretch act-2's cut removes,
    // read off the cut itself rather than restated as literals.
    const removed = buildTimeline(plan, bundle).cuts[0];
    expect(removed).toMatchObject({ srcStartMs: 3200, srcEndMs: 9000 });
    const freezeMs = freezes[0]?.srcStartMs ?? -1;
    expect(freezeMs).toBeGreaterThan(removed?.srcStartMs ?? 0);
    expect(freezeMs).toBeLessThanOrEqual(removed?.srcEndMs ?? 0);

    const timeline = buildTimeline(plan, bundle);
    expect(timeline.segments.some((s) => s.kind === "pace")).toBe(false);
    // Dropped WITH the stretch is not the same as unplaced: `unplacedPaces`
    // means "the frames carry no marker for this pair", which is a
    // different fault the editor draws a `pacingUnplaced` degradation for,
    // and it must not be inflated by cuts.
    expect(timeline.unplacedPaces).toBe(0);
  });
});
