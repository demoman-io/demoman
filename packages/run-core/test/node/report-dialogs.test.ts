import type { AuthoredStep } from "@demoman/replay-engine";
import {
  BRANDING_DEFAULTS,
  CURSOR_DEFAULTS,
  type SceneDocument,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { NOT_CHECKED } from "../../../replay-engine/test/helpers/film";
import {
  buildRunReport,
  verdictLine,
  type WalkResultLike,
} from "../../src/replay/report.js";

// DEM-161: the report lists every dialog the walk answered, each with the
// script step it opened during, and the verdict says how many.

const step = (i: number): AuthoredStep => ({
  index: i - 1,
  step: { do: "click", on: { stableId: `stable-${i}` } },
  anchorId: `anchor${i}`,
  actionId: `a${i}`,
  strategy: "stableId",
  candidates: 1,
  failureReason: null,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  marker: `click:anchor${i}`,
  pageUrl: null,
});

const walk: WalkResultLike = {
  reason: null,
  completed: 3,
  total: 3,
  bundle: null,
  degradations: [],
  storageRefused: false,
  counters: { encodeShrunkSpans: 0 },
};

const dialog = (actionId: string | null, answer: "accept" | "dismiss") => ({
  actionId,
  kind: "confirm" as const,
  host: "app.example.com",
  message: `Delete ${actionId}?`,
  answer,
  by: "default" as const,
  beatMs: 0,
});

/** `held`: the actions the take holds, every step's by default. */
const reportOf = (
  dialogs?: WalkResultLike["dialogs"],
  held: string[] = ["a1", "a2", "a3"],
) =>
  buildRunReport({
    ...NOT_CHECKED,
    run: {
      id: "run-1",
      startedAt: 0,
      target: "https://app.example.com/",
      executor: "cli",
      script: { name: "dialogs", scriptVersion: 1, steps: 3 },
    },
    walk: { ...walk, ...(dialogs === undefined ? {} : { dialogs }) },
    steps: [step(1), step(2), step(3)],
    scene: {
      actions: held.map((id) => ({ id, kind: "click" })),
      edits: { trim: undefined },
      branding: BRANDING_DEFAULTS,
      cursor: CURSOR_DEFAULTS,
    } as unknown as SceneDocument,
    madeFrom: [],
    look: {
      branding: "defaultKit",
      kit: { name: "Dark" },
      brandKitError: null,
      wallpaperError: null,
    },
  });

describe("dialogsOf", () => {
  it("maps action ids to script steps and marks unowned ones undrawn", () => {
    // Red if `dialogsOf` goes, drops the null-action dialog, or numbers
    // steps from 0.
    const walked = [dialog("a2", "accept"), dialog(null, "dismiss")];
    // Premise: one dialog owned by a step and one owned by none.
    expect(walked.map((d) => d.actionId)).toEqual(["a2", null]);
    const report = reportOf(walked);
    expect(
      report.dialogs?.map(({ step, answer, drawn }) => ({
        step,
        answer,
        drawn,
      })),
    ).toEqual([
      { step: 2, answer: "accept", drawn: true },
      { step: null, answer: "dismiss", drawn: false },
    ]);
    expect(report.dialogs?.[0]).toMatchObject({
      kind: "confirm",
      message: "Delete a2?",
      by: "default",
    });
    expect(report.dialogs?.[0]).not.toHaveProperty("actionId");
  });

  it("names an action this run has no step for as undrawn, not dropped", () => {
    // Red if an unmatched action id is filtered out.
    expect(reportOf([dialog("gone", "accept")]).dialogs).toMatchObject([
      { step: null, drawn: false },
    ]);
  });

  it("a step the take does not hold is listed but undrawn", () => {
    // A run stopped on step 2 (its answer did not fit): the take holds
    // step 1 only, so the video has no card for step 2's dialog.
    const report = reportOf([dialog("a2", "accept")], ["a1"]);
    // Premise: the script still names the step.
    expect(report.dialogs).toMatchObject([{ step: 2 }]);
    expect(report.dialogs?.[0]?.drawn).toBe(false);
    // Control: held, the same dialog is drawn.
    expect(reportOf([dialog("a2", "accept")]).dialogs?.[0]?.drawn).toBe(true);
  });

  it("is absent when none opened", () => {
    expect(reportOf()).not.toHaveProperty("dialogs");
    expect(reportOf([])).not.toHaveProperty("dialogs");
  });
});

describe("verdictLine", () => {
  it("names answered dialogs", () => {
    // Red if `dialogsClause` leaves the verdict, or stops counting.
    expect(verdictLine(reportOf([dialog("a1", "accept")]))).toContain(
      "answered 1 dialog (OK)",
    );
    expect(
      verdictLine(reportOf([dialog("a1", "accept"), dialog("a2", "dismiss")])),
    ).toContain("answered 2 dialogs (OK, Cancel)");
  });

  it("says nothing about dialogs when none opened", () => {
    expect(verdictLine(reportOf())).not.toMatch(/dialog/i);
  });
});
