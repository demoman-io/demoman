import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEGRADATION_WORDS } from "@demoman/run-core";
import { describe, expect, it } from "vitest";
import { recordWithRetry, runVerdict } from "../src/executor/refresh.js";
import {
  comparePictures,
  LOOKS,
  PICTURE_OPTIONS,
  STILL_LOOKS,
  samePicture,
  sharedScreens,
} from "../src/executor/same-picture.js";
import { changedShare, type Drawn, insideOnly } from "../src/picture-diff.js";

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
  it("never retries a failed run", async () => {
    const r = runs(diverged, clean);
    const got = await recordWithRetry(r.run, "Flow", log);
    expect(r.count()).toBe(1);
    expect(got.verdict).toMatchObject({ kind: "failed" });
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
      { session: none, log: () => undefined },
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
      await samePicture("/x", "/y", "mp4", a, b, {
        session: none,
        log: () => undefined,
      }),
    ).toEqual({
      uncomparable: "no screen of the video is still in both films",
    });
  });
});

describe("samePicture says a work page that would not close", () => {
  it("logs the close failure beside a verdict it still gives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "same-close-"));
    const [a, b] = [join(dir, "a.mp4"), join(dir, "b.mp4")];
    await writeFile(a, "a");
    await writeFile(b, "b");
    const file = { width: 4, height: 4, length: 2, frame: 1 / 30 };
    let closes = 0;
    const page = {
      goto: async () => undefined,
      addScriptTag: async () => undefined,
      // What the page would read: one screen, unchanged.
      evaluate: async () => ({ a: file, b: file, changed: [[0, 0]] }),
      close: async () => {
        closes++;
        throw new Error("Target closed");
      },
    };
    const said: string[] = [];
    const out = await samePicture(
      a,
      b,
      "mp4",
      screens(1, 500),
      screens(1, 500),
      {
        session: { openWorkPage: async () => ({ ok: true, page }) } as never,
        log: (line: string) => void said.push(line),
      },
    );
    expect(closes, "premise: the page was closed and refused").toBe(1);
    expect(out).toMatchObject({ same: true });
    expect(said.join("\n")).toContain("Target closed");
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
  /** Per screen, `[sharply, faintly]` (LOOKS' order), or one number for
   *  both looks, or null. */
  const diff = (
    changed: (number | [number, number] | null)[],
    a = 6,
    b = 8,
  ) => ({
    a: file(a),
    b: file(b),
    changed: changed.map((c) =>
      c === null ? null : typeof c === "number" ? [c, c] : c,
    ),
  });
  it("is the same when every shared screen is under the threshold", () => {
    expect(comparePictures(diff([0, 0, 0]), shared, 4)).toEqual({
      same: true,
      detail:
        "at most 0.0000% sharply and 0.0000% faintly of the picture changed, over 3 of 4 screens",
    });
  });
  it("takes its looks as a parameter, STILL_LOOKS the same as LOOKS for now", () => {
    const changed = diff([0, 0.002, 0]);
    expect(comparePictures(changed, shared, 4, undefined, STILL_LOOKS)).toEqual(
      comparePictures(changed, shared, 4),
    );
    // Premise: LOOKS reads this as changed, so the lenient list below is
    // what makes it same.
    expect(comparePictures(changed, shared, 4)).toMatchObject({ same: false });
    const lenient = LOOKS.map((look) => ({ ...look, allowed: 1 }));
    expect(
      comparePictures(changed, shared, 4, undefined, lenient),
    ).toMatchObject({ same: true });
  });
  it("names the step and time of the screen that changed", () => {
    const out = comparePictures(diff([0, 0.002, 0]), shared, 4);
    expect(out).toMatchObject({ same: false });
    expect((out as { detail: string }).detail).toMatch(
      /% of the picture changed sharply before action 2 at [\d.]+s, over the 0\.0008% allowed, of 3 of 4 screens/,
    );
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
    const paused = [
      { step: 0, msA: 0, msB: 0 },
      { step: 2, msA: 2000, msB: 2100 },
    ];
    const out = comparePictures(diff([0, 0.002]), paused, 4, steps);
    expect((out as { detail: string }).detail).toMatch(
      /changed sharply before step 4 at 2\.10s/,
    );
    // The script cannot have that action: named as what it is.
    const short = comparePictures(
      diff([0, 0.002]),
      paused,
      4,
      steps.slice(0, 2),
    );
    expect((short as { detail: string }).detail).toMatch(/before action 3 at/);
  });
  it("names the final screen", () => {
    const out = comparePictures(diff([0, 0, 0.01]), shared, 4);
    expect((out as { detail: string }).detail).toMatch(/on the final screen/);
  });
  // Each look has its own allowance: red if one threshold judges both.
  it("judges each look against its own allowance", () => {
    // Faintly over its 0.0170%, sharply nothing: changed.
    const faint = comparePictures(diff([0, [0, 0.0002], 0]), shared, 4);
    expect(faint).toMatchObject({ same: false });
    expect((faint as { detail: string }).detail).toMatch(
      /^0\.0200% of the picture changed faintly before action 2 at 2\.10s, over the 0\.0170% allowed/,
    );
    // Faintly 0.0100%: over sharply's 0.0008%, under its own 0.0170%.
    expect(comparePictures(diff([0, [0, 0.0001], 0]), shared, 4)).toMatchObject(
      { same: true },
    );
    // Sharply 0.0010%, over its 0.0008%: changed, though faintly is under.
    expect(
      comparePictures(diff([0, [0.00001, 0.00001], 0]), shared, 4),
    ).toMatchObject({ same: false });
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

// The report's shape (2026-10-28): on a smooth blurred background the
// encoder's error is a solid offset over a whole macroblock, which no block
// average dilutes. Outside the window it is judged by the look, not here.
describe("the window's pixels", () => {
  const W = 320;
  const H = 180;
  const grey = (): Drawn => ({
    width: W,
    height: H,
    rgba: new Uint8ClampedArray(W * H * 4).fill(128),
  });
  /** `base` with a solid `levels` offset over the 16x16 square at x, y. */
  const offset = (base: Drawn, x: number, y: number, levels = 30): Drawn => {
    const rgba = new Uint8ClampedArray(base.rgba);
    for (let j = y; j < y + 16; j++)
      for (let i = x; i < x + 16; i++)
        for (let c = 0; c < 3; c++) {
          const p = (j * W + i) * 4 + c;
          rgba[p] = (rgba[p] as number) + levels;
        }
    return { ...base, rgba };
  };
  // In the film's own pixels, a film twice the drawn width.
  const window = { x: 100, y: 60, width: 440, height: 240, radius: 24 };
  const faintly = LOOKS[1];
  const inset = PICTURE_OPTIONS.inset;
  const share = (b: Drawn) =>
    changedShare(grey(), insideOnly(grey(), b, window, 2 * W, inset), faintly);

  it("a block changed only outside the window reads unchanged", () => {
    const outside = offset(grey(), 10, 10);
    // Premise: over the whole picture the same block reads changed.
    expect(changedShare(grey(), outside, faintly)).toBeGreaterThan(
      faintly.allowed,
    );
    expect(share(outside)).toBe(0);
  });
  it("the same block inside the window reads changed", () => {
    expect(share(offset(grey(), 120, 80))).toBeGreaterThan(faintly.allowed);
  });
  // The window's rounded corner: its square holds background past the arc.
  it("a block in a corner's square past the arc reads unchanged", () => {
    // Drawn at half size and inset, the window's corner is at 52, 32 with
    // a radius of 10: the 3x3 pixels there are inside its rect, past its arc.
    const tiny = grey();
    for (let j = 32; j < 35; j++)
      for (let i = 52; i < 55; i++)
        for (let c = 0; c < 3; c++) tiny.rgba[(j * W + i) * 4 + c] = 218;
    expect(changedShare(grey(), tiny, LOOKS[0])).toBeGreaterThan(0);
    expect(
      changedShare(
        grey(),
        insideOnly(grey(), tiny, window, 2 * W, inset),
        LOOKS[0],
      ),
    ).toBe(0);
  });
});

describe("comparePictures with windows", () => {
  const file = { width: 1920, height: 1080, length: 6, frame: 1 / 30 };
  const diff = { a: file, b: file, changed: [[0, 0]] };
  const w = { x: 230, y: 130, width: 1460, height: 820, radius: 18 };
  it("a window drawn elsewhere is a change, naming where", () => {
    const moved = { ...w, x: w.x + 3 };
    const out = comparePictures(
      diff,
      [{ step: null, msA: 5000, msB: 5000, windowA: w, windowB: moved }],
      2,
    );
    expect(out).toEqual({
      same: false,
      detail:
        "the window moved on the final screen: the committed video has it at 230,130 1460x820 at 5.00s, the new one at 233,130 1460x820 at 5.00s",
    });
  });
  // DEM-63: the two videos reach a screen at different times. The message
  // printed the new one's time beside the committed one's window, which sent
  // an investigation to the wrong moment of the committed video.
  it("a moved window names each video's own moment", () => {
    const zoomed = {
      x: -1547.42,
      y: 500.58,
      width: 3606.84,
      height: 2336.04,
      radius: 43.2,
    };
    const out = comparePictures(
      diff,
      [{ step: 3, msA: 4537.5, msB: 14620, windowA: zoomed, windowB: w }],
      2,
    );
    if (!("same" in out)) throw new Error(JSON.stringify(out));
    expect(out.detail).toContain(
      "the committed video has it at -1547,501 3607x2336 at 4.54s",
    );
    expect(out.detail).toContain("the new one at 230,130 1460x820 at 14.62s");
  });
  // 1 px at the 1280 drawn width is 1.5 px of a 1920 film.
  it("a window within a pixel of where it was is the same window", () => {
    const out = comparePictures(
      diff,
      [
        {
          step: null,
          msA: 5000,
          msB: 5000,
          windowA: w,
          windowB: { ...w, x: w.x + 1.4 },
        },
      ],
      2,
    );
    expect(out).toMatchObject({ same: true });
  });
  it("a film without windows is compared whole, as before", () => {
    const out = comparePictures(
      diff,
      [{ step: null, msA: 5000, msB: 5000, windowA: w }],
      2,
    );
    expect(out).toMatchObject({ same: true });
  });
});

describe("samePicture judges the look before it decodes", () => {
  const none = {} as never;
  const s = (look?: string) => ({
    steps: 1,
    moments: [{ step: null, ms: 500 }],
    ...(look === undefined ? {} : { look }),
  });
  it("two looks are not the same", async () => {
    const out = await samePicture("/x", "/y", "mp4", s("a1"), s("b2"), {
      session: none,
      log: () => undefined,
    });
    expect(out).toMatchObject({
      same: false,
      detail: expect.stringMatching(/^the look changed: /),
    });
  });
  // No session: a look check that answered for a file kept before looks
  // would never reach the page, which throws here.
  // Going on to the pixels reads the committed file first, which is not
  // there: that refusal is the proof it went on. A look verdict would not throw.
  it("a committed file without a look goes on to the pixels", async () => {
    await expect(
      samePicture("/x", "/y", "mp4", s(), s("b2"), {
        session: none,
        log: () => undefined,
      }),
    ).rejects.toThrow(/ENOENT.*'\/x'/);
  });
});
