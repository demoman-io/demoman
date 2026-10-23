import { describe, expect, it } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { hintsCurrent, markHints } from "../../../pages/src/editor/hint-gate";
import { summarizeHoverVerdicts } from "../../../pages/src/editor/hover-report";

/**
 * The gate in front of `refreshHints`: when the motion hints and the hover
 * check need recomputing. The three conditions each have a page test of
 * their own (`editor-main-hover-*.test.ts`); this pins the predicate
 * directly so a change to it is read here before it is felt there.
 */

/** A completed check that found nothing — a report all the same. */
const REPORT = summarizeHoverVerdicts([], new Set<string>());

describe("hintsCurrent", () => {
  const bundle = proceduralBundle({ motionSpans: [] });
  const scene = readonlyScene();
  const mark = markHints({ scene, bundle });

  it("is current for the same bundle, the same ids and a report in hand", () => {
    expect(hintsCurrent(mark, { scene, bundle, hoverReport: REPORT })).toBe(
      true,
    );
  });

  it("has nothing to compare against before a first mark", () => {
    expect(hintsCurrent(null, { scene, bundle, hoverReport: REPORT })).toBe(
      false,
    );
  });

  it("re-opens for a different bundle", () => {
    const other = proceduralBundle({ motionSpans: [] });
    expect(
      hintsCurrent(mark, { scene, bundle: other, hoverReport: REPORT }),
    ).toBe(false);
  });

  it("re-opens for an id-changing edit on the same bundle", () => {
    // A delete: the bundle never changes, only the action-id shape does.
    const edited = { ...scene, actions: scene.actions.slice(1) };
    expect(
      hintsCurrent(mark, { scene: edited, bundle, hoverReport: REPORT }),
    ).toBe(false);
  });

  it("re-opens when the report was retired without an id change", () => {
    // Undo of a rename: same bundle, same ids, `hoverReport` nulled.
    const renamed = { ...scene, meta: { ...scene.meta, name: "other" } };
    expect(
      hintsCurrent(mark, { scene: renamed, bundle, hoverReport: null }),
    ).toBe(false);
  });
});
