import type { HoverVerdict } from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import {
  hoverReportText,
  summarizeHoverVerdicts,
} from "../../../pages/src/editor/hover-report";

/**
 * These cases are about how verdicts become a report, not about cuts: no
 * step is cut, so nothing is filtered out. `editor-cuts.test.ts` and
 * `editor-main-cuts.test.ts` own what a cut does to a hover, and passing
 * the set explicitly here — rather than defaulting it — is what keeps a
 * future caller from silently getting the pre-cuts behaviour back.
 */
const noCuts = (verdicts: Parameters<typeof summarizeHoverVerdicts>[0]) =>
  summarizeHoverVerdicts(verdicts, new Set<string>());

describe("summarizeHoverVerdicts", () => {
  it("counts what was checked separately from what could not be", () => {
    const verdicts: HoverVerdict[] = [
      { actionId: "a", kind: "still" },
      { actionId: "b", kind: "moved" },
      { actionId: "c", kind: "unknown", reason: "sameFrame" },
      { actionId: "d", kind: "unknown", reason: "noRect" },
    ];
    const report = noCuts(verdicts);
    expect(report).toEqual({
      removable: ["a"],
      checked: 2,
      unchecked: 2,
      uncheckedBy: { sameFrame: 1, noRect: 1 },
      failed: false,
    });
  });

  it("never offers an unchecked hover for removal", () => {
    const verdicts: HoverVerdict[] = [
      { actionId: "a", kind: "unknown", reason: "outOfTolerance" },
    ];
    const report = noCuts(verdicts);
    expect(report.removable).toEqual([]);
  });

  it("excludes a notStyleSignalled hover from both checked and unchecked", () => {
    // notStyleSignalled means the pixel check was never asked to look —
    // a mutation-signalled or author-inserted moveTo, out of scope rather
    // than uncovered. Counting it as `unchecked` is the defect I2 exists to
    // fix: on a take with three real style-signalled hovers and five
    // out-of-scope ones, the honest coverage statement is "0 of 3", not
    // "5 of 8" — this fails if notStyleSignalled is folded back in.
    const verdicts: HoverVerdict[] = [
      { actionId: "a", kind: "still" },
      { actionId: "b", kind: "moved" },
      { actionId: "c", kind: "still" },
      { actionId: "x1", kind: "unknown", reason: "notStyleSignalled" },
      { actionId: "x2", kind: "unknown", reason: "notStyleSignalled" },
      { actionId: "x3", kind: "unknown", reason: "notStyleSignalled" },
      { actionId: "x4", kind: "unknown", reason: "notStyleSignalled" },
      { actionId: "x5", kind: "unknown", reason: "notStyleSignalled" },
    ];
    const report = noCuts(verdicts);
    expect(report).toEqual({
      removable: ["a", "c"],
      checked: 3,
      unchecked: 0,
      uncheckedBy: {},
      failed: false,
    });
  });
});

describe("hoverReportText", () => {
  it("says nothing when there is nothing to remove and nothing unchecked", () => {
    expect(
      hoverReportText({
        removable: [],
        checked: 3,
        unchecked: 0,
        failed: false,
      }),
    ).toBeNull();
  });

  it("says the check did not run rather than falling silent", () => {
    // Silence here would be the defect this codebase pays most for: a check
    // that crashed would look exactly like a check that ran and found the
    // take clean.
    const text = hoverReportText({
      removable: [],
      checked: 0,
      unchecked: 0,
      failed: true,
    });
    expect(text).not.toBeNull();
    expect(text).toMatch(/could not run|did not run/i);
  });

  it("says how many could not be checked, so silence is never read as clean", () => {
    // The failure this wording exists to prevent: "0 hover moves changed
    // nothing" reads as *checked and clean* when in fact almost nothing was
    // checked.
    const text = hoverReportText({
      removable: [],
      checked: 2,
      unchecked: 8,
      failed: false,
    });
    expect(text).toContain("8");
    expect(text).not.toMatch(/^0 hover moves/);
  });

  it("does not assert a single cause for the coverage gap", () => {
    // `unchecked` folds together reasons that disagree — some about missing
    // frames (sameFrame, outOfTolerance), others about the anchor's rect
    // (noRect, offFrame) — and the report has no way to know which mix
    // produced any given count. Naming "no frames either side" as though it
    // were always the reason was I2's defect; the sentence must report the
    // number without inventing a story for it.
    const text = hoverReportText({
      removable: [],
      checked: 1,
      unchecked: 4,
      failed: false,
    });
    expect(text).not.toBeNull();
    expect(text).not.toMatch(/frames either side/i);
  });

  it("names its subject and says why each unchecked hover went unchecked", () => {
    // The take notes show this sentence on its own line. "4 of 4 could not be
    // checked" (2026-10-10) read as the whole take failing and gave no reason;
    // the author needed a debugging round to learn which.
    const report = noCuts([
      { actionId: "a", kind: "unknown", reason: "outOfTolerance" },
      { actionId: "b", kind: "unknown", reason: "outOfTolerance" },
      { actionId: "c", kind: "unknown", reason: "outOfTolerance" },
      { actionId: "d", kind: "unknown", reason: "offFrame" },
    ]);
    // Fixture premise: two distinct reasons, so the breakdown has to group.
    expect(report.uncheckedBy).toEqual({ outOfTolerance: 3, offFrame: 1 });
    expect(hoverReportText(report)).toBe(
      "4 of 4 hovers could not be checked: 3 had no frame close enough to the hover, 1 was partly off screen.",
    );
  });

  it("never prints a raw reason identifier", () => {
    const reasons = [
      "noMarker",
      "noRect",
      "crossFrameRect",
      "degenerateRect",
      "offFrame",
      "cropTooSmall",
      "nativeCropTooSmall",
      "sameFrame",
      "outOfTolerance",
      "decodeFailed",
    ] as const;
    for (const reason of reasons) {
      const text = hoverReportText(
        noCuts([{ actionId: "a", kind: "unknown", reason }]),
      );
      expect(text).toMatch(/^1 of 1 hover could not be checked: 1 [a-z]/);
      expect(text).not.toContain(reason);
    }
  });

  it("offers the removals it found", () => {
    const text = hoverReportText({
      removable: ["a", "b"],
      checked: 5,
      unchecked: 0,
      failed: false,
    });
    expect(text).toContain("2");
  });
});
