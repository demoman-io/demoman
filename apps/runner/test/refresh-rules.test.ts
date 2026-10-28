import { describe, expect, it } from "vitest";
import { uncleanRun } from "../src/executor/refresh.js";
import {
  comparePictures,
  samePicture,
  sharedScreens,
} from "../src/executor/same-picture.js";

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

const screens = (steps: number, ...ms: (number | null)[]) => ({
  steps,
  moments: ms.map((m, i) => ({
    step: m === null ? null : i,
    ms: m ?? 9000,
  })),
});

describe("sharedScreens", () => {
  it("pairs by step, leaving out a screen only one film has", () => {
    const a = { steps: 3, moments: [m(0, 0), m(1, 2000), m(null, 5000)] };
    const b = { steps: 3, moments: [m(0, 0), m(2, 1000), m(null, 4000)] };
    expect(sharedScreens(a, b)).toEqual([
      { step: 0, msA: 0, msB: 0 },
      { step: null, msA: 5000, msB: 4000 },
    ]);
  });
  it("is empty when no step is in both", () => {
    const a = { steps: 3, moments: [m(0, 0)] };
    const b = { steps: 3, moments: [m(1, 0)] };
    expect(sharedScreens(a, b)).toEqual([]);
  });
});

function m(step: number | null, ms: number) {
  return { step, ms };
}

describe("samePicture decides before it decodes", () => {
  // No session is given: a rule that answers first never opens a page, and
  // one that did would throw on it.
  const none = {} as never;
  it("steps that differ are not the same", async () => {
    const out = await samePicture(
      "/x",
      "/y",
      "mp4",
      screens(3, 0),
      screens(4, 0),
      { session: none },
    );
    expect(out).toEqual({
      same: false,
      detail: "the video's steps changed, 3 to 4",
    });
  });
  it("no shared screen is uncomparable", async () => {
    const a = { steps: 3, moments: [m(0, 0)] };
    const b = { steps: 3, moments: [m(1, 0)] };
    expect(
      await samePicture("/x", "/y", "mp4", a, b, { session: none }),
    ).toEqual({
      uncomparable: "no screen of the video is still in both films",
    });
  });
});

describe("comparePictures", () => {
  const file = (length: number) => ({
    width: 1920,
    height: 1080,
    length,
    frame: 1 / 30,
  });
  const shared = [
    { step: 0, msA: 0, msB: 0 },
    { step: 1, msA: 2000, msB: 2100 },
    { step: null, msA: 5000, msB: 5200 },
  ];
  const diff = (changed: (number | null)[], a = 6, b = 8) => ({
    a: file(a),
    b: file(b),
    changed,
  });
  it("is the same when every shared screen is under the threshold", () => {
    expect(comparePictures(diff([0, 0, 0]), shared, 4)).toEqual({
      same: true,
      detail: "at most 0.000% of the picture changed, over 3 of 4 screens",
    });
  });
  it("names the step and time of the screen that changed", () => {
    const out = comparePictures(diff([0, 0.002, 0]), shared, 4);
    expect(out).toMatchObject({ same: false });
    expect((out as { detail: string }).detail).toMatch(
      /% of the picture changed before step 2 at [\d.]+s, over the 0\.015% allowed, of 3 of 4 screens/,
    );
  });
  it("names the final screen", () => {
    const out = comparePictures(diff([0, 0, 0.01]), shared, 4);
    expect((out as { detail: string }).detail).toMatch(/on the final screen/);
  });
  it("a screen past the end of a film is uncomparable, naming the film", () => {
    expect(comparePictures(diff([0, null, 0], 1.5, 8), shared, 4)).toEqual({
      uncomparable:
        "the committed video ends at 1.500s, before its screen at 2.000s",
    });
    expect(comparePictures(diff([0, null, 0], 6, 2), shared, 4)).toEqual({
      uncomparable: "the new video ends at 2.000s, before its screen at 2.100s",
    });
  });
  // Red if the length check returns: these films are 2 s apart.
  it("lengths 2 s apart with equal screens are the same", () => {
    expect(comparePictures(diff([0, 0, 0], 6, 8), shared, 4)).toMatchObject({
      same: true,
    });
  });
});
