import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEGRADATION_WORDS } from "@demoman/run-core";
import { describe, expect, it } from "vitest";
import {
  degradedNote,
  keepFailure,
  recordWithRetry,
  runVerdict,
} from "../src/executor/refresh.js";
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
    ["no frames block", { frames: undefined }],
    ["a record not stored", { notStored: [{ what: "status", error: "x" }] }],
  ])("fails %s, with the run's own line", (_, more) => {
    expect(verdictOf(more)).toEqual({
      kind: "failed",
      detail: "the run's own line",
    });
  });
  // Red when a forgiven degradation fails the flow: it is degraded,
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
  // Ruled 2026-11-24: the stills-only rule is the real-time
  // recorder's starved screencast (run-core `stillsOnly`). Red if a held run
  // that recorded no motion is called degraded (a static page, on any
  // machine), or if a real-time one stops being.
  it("calls a run that recorded no motion for its acting steps in real time degraded", () => {
    expect(
      verdictOf({
        run: { recording: { clock: "real", why: "asked" } },
        steps: acting,
        frames: { spans: 0, degradations: [] },
      }),
    ).toEqual({
      kind: "degraded",
      problems: ["no motion was recorded: the video is its stills only"],
    });
  });
  it("calls a held run that recorded no motion for its acting steps clean", () => {
    expect(
      verdictOf({
        run: { recording: { clock: "held", frameRate: 30, from: "default" } },
        steps: acting,
        frames: { spans: 0, degradations: [] },
      }),
    ).toEqual({ kind: "clean" });
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
      rerecord: true,
    });
  });
  // Only a failure whose cure is a new script says "record again".
  // Red when the set loses a reason, or when a stop the app or the machine
  // caused is sent to the agent.
  it.each([
    ["a step not shown", { verdict: { kind: "diverged", diverged: [{}] } }],
    [
      "a target gone",
      { outcome: "stopped", stopped: { reason: "unresolvedAnchor" } },
    ],
    [
      "a target not rendered",
      { outcome: "stopped", stopped: { reason: "anchorNotRendered" } },
    ],
  ])("sends %s to be recorded again", (_, more) => {
    expect(verdictOf(more)).toEqual({
      kind: "failed",
      detail: "the run's own line",
      rerecord: true,
    });
  });
  it.each([
    "pageSilent",
    "signedOut",
    "clickNotDelivered",
    "portFailure",
    // A slow runner can miss a wait the author's machine makes.
    "waitTimeout",
  ])("does not send a run stopped by %s to be recorded again", (reason) => {
    expect(verdictOf({ outcome: "stopped", stopped: { reason } })).toEqual({
      kind: "failed",
      detail: "the run's own line",
    });
  });
  it("sends a script the door refused to be recorded again, not a reset", () => {
    expect(
      runVerdict({
        outcome: "refusedBeforeRun",
        reason: "invalidScript",
        detail: "d",
      }),
    ).toEqual({ kind: "failed", detail: "invalidScript: d", rerecord: true });
    expect(
      runVerdict({
        outcome: "refusedBeforeRun",
        reason: "reset failed",
        detail: "d",
      }),
    ).toEqual({ kind: "failed", detail: "reset failed: d" });
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

// Red when an earlier run's still survives beside a later run's
// report, or a run with no still is said to have kept one.
describe("keepFailure", () => {
  it("keeps one run's report and still, never an earlier run's still", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keep-failure-"));
    try {
      const png = join(dir, "still.png");
      await writeFile(png, "png bytes");
      const run = (still: unknown) => ({
        outcome: "stopped",
        summary: "Stopped at script step 2 of 3",
        provenance: { videoId: "v" },
        still,
      });
      const failures = join(dir, "failed");
      const flow = ".demoman/flows/broken.json";
      const first = await keepFailure(run({ path: png }), failures, flow);
      const at = join(failures, "broken");
      expect(first).toEqual({ evidence: { folder: at, noStill: null } });
      // Premise: the first run kept a still for the second to replace.
      expect(await readFile(join(at, "final-still.png"), "utf8")).toBe(
        "png bytes",
      );
      const second = await keepFailure(
        run({ unavailable: "no frames to show" }),
        failures,
        flow,
      );
      expect(second).toEqual({
        evidence: { folder: at, noStill: "no frames to show" },
      });
      expect(existsSync(join(at, "final-still.png"))).toBe(false);
      const report = JSON.parse(
        await readFile(join(at, "report.json"), "utf8"),
      );
      expect(report.still).toEqual({ unavailable: "no frames to show" });
      // A refusal at the door made no report: nothing to keep, nothing said.
      expect(
        await keepFailure({ outcome: "refusedBeforeRun" }, failures, flow),
      ).toEqual({ note: null });
      // A copy that fails is said, not kept quiet.
      const lost = await keepFailure(
        run({ path: join(dir, "gone.png") }),
        failures,
        flow,
      );
      expect(lost).toEqual({
        note: expect.stringMatching(
          /^its run report and last still could not be kept in .*broken \(.*ENOENT/,
        ),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
  // Review of 2026-11-16. Red when a held recording of a page with a frame
  // from another site, a playing video or a quiet connection is recorded
  // twice: the second recording has them too.
  it("does not record again for what a held recording could not hold", async () => {
    const unheld = {
      ...clean,
      frames: {
        spans: 2,
        degradations: ["animationUnpinned", "connectionIgnored"],
      },
    };
    const r = runs(unheld, clean);
    const got = await recordWithRetry(r.run, "Flow", log);
    expect(r.count()).toBe(1);
    expect(got.verdict).toMatchObject({ kind: "degraded" });
    if (got.verdict.kind !== "degraded") throw new Error("premise");
    expect(degradedNote(got.verdict.problems)).toMatch(
      /^recorded with problems the page itself made/,
    );
  });
  // Red when a step that never settled sends the flow round again: a stream
  // does not settle on the second recording either (seen in the trial).
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
        expect.stringContaining("was not waited for, so"),
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
  // Red when a settle the machine failed (a paint that never came, a page
  // screen that could not be taken) is taken as the page's: it is the
  // kind of one-off a forgiven degradation is, and recording again may settle it.
  it("records again when a step's settle failed on the machine's side", async () => {
    const failedSettle = {
      ...clean,
      frames: { spans: 2, degradations: ["stepSettleFailed"] },
    };
    const r = runs(failedSettle, clean);
    const got = await recordWithRetry(r.run, "Flow", log);
    expect(r.count()).toBe(2);
    expect(got.verdict).toEqual({ kind: "clean" });
  });
  it("never retries a failed run", async () => {
    const r = runs(diverged, clean);
    const got = await recordWithRetry(r.run, "Flow", log);
    expect(r.count()).toBe(1);
    expect(got.verdict).toMatchObject({ kind: "failed" });
  });
});

describe("degradedNote", () => {
  const problems = (...kinds: string[]) => {
    const v = runVerdict({
      ...clean,
      frames: { spans: 2, degradations: kinds },
    });
    if (v.kind !== "degraded") throw new Error(JSON.stringify(v));
    return v.problems;
  };
  const MACHINE = "could not avoid on this machine";
  // Red when an app's long poll or stream is blamed on the machine: neither
  // is, and recording again changes neither.
  it("says the page's own problems as the page's, and still names them", () => {
    const note = degradedNote(problems("stepUnsettled", "requestNotWaited"));
    expect(note).not.toContain(MACHINE);
    expect(note).toContain("the page itself");
    expect(note).toContain("(stepUnsettled)");
    expect(note).toContain("(requestNotWaited)");
  });
  // The control: a problem the machine can make keeps the machine's note,
  // with the page's beside it.
  // Red if a settle the machine failed is said as the page's own.
  it("blames the machine for a settle that failed on its side", () => {
    const note = degradedNote(problems("stepUnsettled", "stepSettleFailed"));
    expect(note).toContain(MACHINE);
    expect(note).not.toContain("the page itself");
    expect(note).toContain("(stepSettleFailed)");
  });
  it("blames the machine when any problem is the machine's", () => {
    const note = degradedNote(problems("stepUnsettled", "budgetBreach"));
    expect(note).toContain(MACHINE);
    expect(note).toContain("(budgetBreach)");
    expect(note).toContain("(stepUnsettled)");
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
