import { describe, expect, it } from "vitest";
import { uncleanRun } from "../src/executor/refresh.js";
import { comparePictures, SLACK_SEC } from "../src/executor/same-picture.js";

// Each condition of a clean run on its own: refresh.slow.test.ts's stopped
// run also fails the verdict, so it cannot tell whether the stop is checked.
const clean = {
  summary: "Complete: the video matches every step the script asked for.",
  outcome: "complete",
  verdict: { kind: "matches" },
  frames: { degradations: [] },
};
const said = (more: Record<string, unknown>) =>
  uncleanRun({ ...clean, summary: "the run's own line", ...more });

describe("uncleanRun", () => {
  it("passes a complete, matching, whole run", () => {
    expect(uncleanRun(clean)).toBeNull();
  });
  it.each([
    ["stopped", { outcome: "stopped" }],
    [
      "complete but stopped (a bundle that did not persist)",
      { stopped: { reason: "portFailure" } },
    ],
    ["a step not shown", { verdict: { kind: "diverged", diverged: [{}] } }],
    ["a degradation", { frames: { degradations: ["budgetBreach"] } }],
    ["no frames block", { frames: undefined }],
    ["a record not stored", { notStored: [{ what: "status", error: "x" }] }],
  ])("fails %s, with the run's own line", (_, more) => {
    expect(said(more)).toBe("the run's own line");
  });
  it("names a refusal and a throw, which carry no line", () => {
    expect(
      uncleanRun({
        outcome: "refusedBeforeRun",
        reason: "signedOut",
        detail: "d",
      }),
    ).toBe("signedOut: d");
    expect(uncleanRun({ outcome: "threw", error: "boom" })).toBe(
      "the run threw: boom",
    );
  });
});

describe("comparePictures", () => {
  const file = (length: number) => ({
    width: 1920,
    height: 1080,
    length,
    frame: 1 / 30,
  });
  const sample = (t: number, moving: number, changed: number | null) => ({
    t,
    moving,
    changed,
  });
  // Red if the slack goes: re-films of one script ran 0.27 s apart.
  it("lengths up to SLACK_SEC apart are the same; further are not", () => {
    const samples = [sample(0, 0, 0)];
    expect(SLACK_SEC).toBe(0.4);
    expect(
      comparePictures({ a: file(4.533), b: file(4.8), samples }).same,
    ).toBe(true);
    expect(comparePictures({ a: file(10), b: file(10.5), samples })).toEqual({
      same: false,
      detail: "the length changed, 10.000s to 10.500s",
    });
  });
  it("judges the moments compared, at rest", () => {
    const panning = [
      sample(0, 0, 0),
      sample(1, 0.05, null),
      sample(2, 0, 0.0001),
    ];
    expect(
      comparePictures({ a: file(3), b: file(3), samples: panning }),
    ).toEqual({
      same: true,
      detail: "at most 0.010% of the picture changed, over 2 moments at rest",
    });
    const heading = [...panning, sample(2.5, 0, 0.002)];
    expect(
      comparePictures({ a: file(3), b: file(3), samples: heading }),
    ).toEqual({
      same: false,
      detail: "0.200% of the picture changed at 2.50s, of 3 moments at rest",
    });
  });
  it("judges every moment of a film never at rest, saying so", () => {
    const moving = [sample(0, 0.01, 0.0001), sample(1, 0.02, 0.03)];
    expect(
      comparePictures({ a: file(2), b: file(2), samples: moving }),
    ).toEqual({
      same: false,
      detail:
        "3.000% of the picture changed at 1.00s, of 2 moments (the film is never at rest)",
    });
  });
});
