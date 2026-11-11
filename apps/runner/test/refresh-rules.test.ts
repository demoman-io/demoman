import { DEGRADATION_WORDS } from "@demoman/run-core";
import { describe, expect, it } from "vitest";
import { recordWithRetry, runVerdict } from "../src/executor/refresh.js";
import {
  comparePictures,
  pairScreens,
  STILL_LOOKS,
} from "../src/executor/same-picture.js";

// Each condition of a clean run on its own: the refresh lane's stopped run
// (refresh-suite.ts) also fails the verdict, so it cannot tell whether the
// stop is checked.
const clean = {
  summary: "Complete: the video matches every step the script asked for.",
  outcome: "complete",
  verdict: { kind: "matches" },
  frames: { spans: 2, degradations: [] },
};
const verdictOf = (more: Record<string, unknown>) =>
  runVerdict({ ...clean, summary: "the run's own line", ...more });
const STILL = `${DEGRADATION_WORDS.stillFailed} (stillFailed)`;
const acting = [{ intent: { do: "click" } }];

describe("runVerdict", () => {
  it("passes a complete, matching, whole run", () => {
    expect(runVerdict(clean)).toEqual({ kind: "clean" });
  });
  it.each([
    ["stopped", { outcome: "stopped" }],
    [
      "complete but stopped (a bundle that did not persist)",
      { stopped: { reason: "portFailure" } },
    ],
    ["a step not shown", { verdict: { kind: "diverged", diverged: [{}] } }],
    ["no frames block", { frames: undefined }],
    ["a record not stored", { notStored: [{ what: "status", error: "x" }] }],
  ])("fails %s, with the run's own line", (_, more) => {
    expect(verdictOf(more)).toEqual({
      kind: "failed",
      detail: "the run's own line",
    });
  });
  // Red when a forgiven degradation fails the flow (DEM-55): it is degraded,
  // named in the report's own words, once however often it happened.
  it("calls a matching run with a soft still degraded, naming it once", () => {
    expect(
      verdictOf({
        frames: { spans: 2, degradations: ["stillFailed", "stillFailed"] },
      }),
    ).toEqual({ kind: "degraded", problems: [STILL] });
  });
  // Review of #36's branch, finding 2. Red when a video that may be wrong
  // (a drag that changed nothing, missing motion) is forgiven.
  it.each([
    "notDragged",
    "clickUnconfirmed",
    "encodeRefused",
    "surfaceMismatch",
  ])("fails a run whose %s may leave the video wrong", (kind) => {
    const got = verdictOf({ frames: { spans: 2, degradations: [kind] } });
    expect(got.kind).toBe("failed");
  });
  it("calls a run that recorded no motion for its acting steps degraded", () => {
    expect(
      verdictOf({ steps: acting, frames: { spans: 0, degradations: [] } }),
    ).toEqual({
      kind: "degraded",
      problems: ["no motion was recorded: the video is its stills only"],
    });
  });
  // Review, finding 6. Red when a flow with nothing to move is flagged.
  it("a run with no acting steps and no motion is clean", () => {
    expect(
      verdictOf({
        steps: [{ intent: { do: "pause" } }],
        frames: { spans: 0, degradations: [] },
      }),
    ).toEqual({ kind: "clean" });
  });
  it("a failure carries the degradations' words as its cause", () => {
    expect(
      verdictOf({
        verdict: { kind: "diverged", diverged: [{}] },
        frames: { spans: 2, degradations: ["stillFailed"] },
      }),
    ).toEqual({
      kind: "failed",
      detail: `the run's own line — ${STILL}`,
    });
  });
  it("names a refusal and a throw, which carry no line", () => {
    expect(
      runVerdict({
        outcome: "refusedBeforeRun",
        reason: "signedOut",
        detail: "d",
      }),
    ).toEqual({ kind: "failed", detail: "signedOut: d" });
    expect(runVerdict({ outcome: "threw", error: "boom" })).toEqual({
      kind: "failed",
      detail: "the run threw: boom",
    });
  });
});

describe("recordWithRetry", () => {
  const degraded = {
    ...clean,
    frames: { spans: 2, degradations: ["stillFailed"] },
  };
  const diverged = {
    ...clean,
    verdict: { kind: "diverged", diverged: [{}] },
    frames: { spans: 2, degradations: ["stillFailed"] },
  };
  const runs = (...answers: Record<string, unknown>[]) => {
    let n = 0;
    const run = async () => answers[Math.min(n++, answers.length - 1)] ?? {};
    return { run, count: () => n };
  };
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);

  it("records a clean run once", async () => {
    const r = runs(clean);
    const got = await recordWithRetry(r.run, "Flow", log);
    expect(got.verdict).toEqual({ kind: "clean" });
    expect(r.count()).toBe(1);
  });
  it("records a degraded run once more, and keeps the clean second", async () => {
    const r = runs(degraded, clean);
    const got = await recordWithRetry(r.run, "Flow", log);
    expect(r.count()).toBe(2);
    expect(got.answer).toBe(clean);
    expect(got.verdict).toEqual({ kind: "clean" });
    expect(logs.at(-1)).toContain(`"Flow" recorded with ${STILL}`);
  });
  it("delivers a second degraded run, naming its problems", async () => {
    const r = runs(degraded, degraded);
    const got = await recordWithRetry(r.run, "Flow", log);
    expect(r.count()).toBe(2);
    expect(got.verdict).toMatchObject({ kind: "degraded" });
  });
  // Review, finding 3. Red when a retry that fails throws away a first
  // recording that could be delivered.
  it("keeps the first, degraded run when the retry fails", async () => {
    const r = runs(degraded, diverged);
    const got = await recordWithRetry(r.run, "Flow", log);
    expect(r.count()).toBe(2);
    expect(got.answer).toBe(degraded);
    expect(got.verdict).toMatchObject({ kind: "degraded" });
  });
  // Red when a step that never settled sends the flow round again: a stream
  // does not settle on the second recording either (DEM-138 trial).
  it("does not record again for an unsettled step, and still says why", async () => {
    const unsettled = {
      ...clean,
      frames: { spans: 2, degradations: ["stepUnsettled"] },
    };
    const r = runs(unsettled, clean);
    const got = await recordWithRetry(r.run, "Flow", log);
    expect(r.count()).toBe(1);
    expect(got.answer).toBe(unsettled);
    expect(got.verdict).toMatchObject({
      kind: "degraded",
      problems: [expect.stringContaining("(stepUnsettled)")],
    });
  });
  // Red when a long poll left out fails the run or sends it round again: it
  // is open on the second recording too, and the video is right.
  it("delivers a run that left out a long poll, once, and still says so", async () => {
    const poll = {
      ...clean,
      frames: { spans: 2, degradations: ["stepUnsettled", "requestNotWaited"] },
    };
    const r = runs(poll, clean);
    const got = await recordWithRetry(r.run, "Flow", log);
    expect(r.count()).toBe(1);
    expect(got.answer).toBe(poll);
    expect(got.verdict).toMatchObject({
      kind: "degraded",
      problems: [
        expect.stringContaining("(stepUnsettled)"),
        expect.stringContaining("was not waited for again"),
      ],
    });
  });
  it("still records again when an unsettled step comes with a soft still", async () => {
    const both = {
      ...clean,
      frames: { spans: 2, degradations: ["stepUnsettled", "stillFailed"] },
    };
    const r = runs(both, clean);
    await recordWithRetry(r.run, "Flow", log);
    expect(r.count()).toBe(2);
  });
  it("never retries a failed run", async () => {
    const r = runs(diverged, clean);
    const got = await recordWithRetry(r.run, "Flow", log);
    expect(r.count()).toBe(1);
    expect(got.verdict).toMatchObject({ kind: "failed" });
  });
});

describe("pairScreens", () => {
  const sc = (...screens: { step: number | null; unsettled?: string }[]) => ({
    steps: 3,
    screens,
  });
  it("pairs the screens settled in both, by step", () => {
    expect(
      pairScreens(
        sc({ step: 0 }, { step: 1 }, { step: null }),
        sc({ step: 0 }, { step: 1 }, { step: null }),
      ),
    ).toEqual({ pairs: [0, 1, null], skipped: [] });
  });
  // Red if an unsettled screen is compared, or skipped without a word.
  it("names each screen left out, and the side when only one is unsettled", () => {
    const steps = [{ do: "waitForLoad" }, { do: "pause" }, { do: "click" }];
    const out = pairScreens(
      sc(
        { step: 0, unsettled: "the DOM never went quiet" },
        { step: 1 },
        { step: 2, unsettled: "2 requests in flight" },
        { step: null, unsettled: "a" },
      ),
      sc(
        { step: 0 },
        { step: 1, unsettled: "the DOM never went quiet" },
        { step: 2, unsettled: "2 requests in flight" },
        { step: null, unsettled: "b" },
      ),
      steps,
    );
    expect(out).toEqual({
      pairs: [],
      skipped: [
        "before step 1: the DOM never went quiet in the committed video",
        // Past the pause: action 1 is the script's step 3.
        "before step 3: the DOM never went quiet in the new video",
        "before action 3: 2 requests in flight",
        "on the final screen: a in the committed video, b in the new one",
      ],
    });
  });
  it("names a screen only one recording has", () => {
    expect(pairScreens(sc({ step: 0 }), sc({ step: 1 }))).toEqual({
      pairs: [],
      skipped: [
        "before action 1: no screen in the new video",
        "before action 2: no screen in the committed video",
      ],
    });
  });
});

describe("comparePictures", () => {
  const pairs = [0, 1, null];
  /** Per screen, `[sharply, faintly]` (STILL_LOOKS' order), or one number
   *  for both looks. */
  const diff = (changed: (number | [number, number])[]) =>
    changed.map((c) => (typeof c === "number" ? [c, c] : c));
  it("is the same when every compared screen is under the threshold", () => {
    expect(comparePictures(diff([0, 0, 0]), pairs, 4)).toEqual({
      same: true,
      detail:
        "at most 0.0000% sharply and 0.0000% faintly of the picture changed, over 3 of 4 screens",
    });
  });
  it("takes its looks as a parameter", () => {
    const changed = diff([0, 0.002, 0]);
    // Premise: STILL_LOOKS reads this as changed, so the lenient list below
    // is what makes it same.
    expect(comparePictures(changed, pairs, 4)).toMatchObject({ same: false });
    const lenient = STILL_LOOKS.map((look) => ({ ...look, allowed: 1 }));
    expect(
      comparePictures(changed, pairs, 4, undefined, lenient),
    ).toMatchObject({ same: true });
  });
  it("names the screen that changed", () => {
    const out = comparePictures(diff([0, 0.002, 0]), pairs, 4);
    expect(out).toEqual({
      same: false,
      detail:
        "0.2000% of the picture changed sharply before action 2, over the 0.0008% allowed, of 3 of 4 screens",
    });
  });
  // Red if the screen is named by its action: a `pause` makes none, so
  // action 2 (the second click) is the script's step 4.
  it("names a screen by its script step, past a pause", () => {
    const steps = [
      { do: "waitForLoad" },
      { do: "click" },
      { do: "pause" },
      { do: "click" },
    ];
    const out = comparePictures(diff([0, 0.002]), [0, 2], 4, steps);
    expect(out.detail).toMatch(/changed sharply before step 4, over/);
    // The script cannot have that action: named as what it is.
    const short = comparePictures(
      diff([0, 0.002]),
      [0, 2],
      4,
      steps.slice(0, 2),
    );
    expect(short.detail).toMatch(/before action 3, over/);
  });
  it("names the final screen", () => {
    const out = comparePictures(diff([0, 0, 0.01]), pairs, 4);
    expect(out.detail).toMatch(/on the final screen/);
  });
  // Each look has its own allowance: red if one threshold judges both.
  it("judges each look against its own allowance", () => {
    // Faintly over its 0.0170%, sharply nothing: changed.
    const faint = comparePictures(diff([0, [0, 0.0002], 0]), pairs, 4);
    expect(faint).toMatchObject({ same: false });
    expect(faint.detail).toMatch(
      /^0\.0200% of the picture changed faintly before action 2, over the 0\.0170% allowed/,
    );
    // Faintly 0.0100%: over sharply's 0.0008%, under its own 0.0170%.
    expect(comparePictures(diff([0, [0, 0.0001], 0]), pairs, 4)).toMatchObject({
      same: true,
    });
    // Sharply 0.0010%, over its 0.0008%: changed, though faintly is under.
    expect(
      comparePictures(diff([0, [0.00001, 0.00001], 0]), pairs, 4),
    ).toMatchObject({ same: false });
  });
});
