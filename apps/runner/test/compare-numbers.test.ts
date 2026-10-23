// apps/runner/test/compare-numbers.test.ts
import { describe, expect, it } from "vitest";
import {
  cadence,
  judge,
  LONG_STILL_MS,
  parseSides,
  type RunFacts,
  STILL_CHANGE_MAX,
  stills,
  table,
  tableRows,
} from "../src/compare/numbers.js";

const at60 = (n: number) =>
  Array.from({ length: n }, (_, i) => (i * 1000) / 60);
const FILM = {
  frames: 300,
  width: 3696,
  height: 2536,
  durationMs: 5000,
  timesMs: at60(300),
  changes: Array.from({ length: 300 }, (_, i) => (i === 0 ? 0 : 4)),
  longestStillMs: 0,
  longStills: 0,
};
const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
  executor: "headless",
  run: 1,
  outcome: "complete",
  stopped: null,
  completed: 4,
  total: 4,
  runMs: 9000,
  exportMs: 20000,
  exportOutcome: "saved",
  film: FILM,
  keyframe: [5130, 3321],
  span: [3420, 2214],
  degradations: {},
  framing: { inside: 3 },
  lastStepMs: 4000,
  actingSteps: 4,
  zoomsSkipped: 0,
  detailViolations: 1,
  summary: "Saved …",
  bundleFailed: null,
  sceneFailed: null,
  ...over,
});

describe("cadence", () => {
  it("reads a steady 60 fps film as 60 fps with no hitches", () => {
    const c = cadence(at60(120));
    expect(c.fps).toBeCloseTo(60, 0);
    expect(c.largestGapMs).toBeCloseTo(16.7, 0);
    expect(c.hitches).toBe(0);
  });

  // A hitch is a gap over twice the nominal frame time.
  it("counts a gap over 2x nominal as a hitch, and reports it as the largest gap", () => {
    const t = at60(120);
    const held = [...t.slice(0, 60), ...t.slice(64).map((x) => x)];
    const c = cadence(held);
    expect(c.hitches).toBe(1);
    expect(c.largestGapMs).toBeCloseTo((5 * 1000) / 60, 0);
  });
});

describe("stills", () => {
  const moving = (n: number) =>
    Array.from({ length: n }, (_, i) => (i === 0 ? 0 : 3 * STILL_CHANGE_MAX));

  it("finds no still in a film whose picture changes every frame", () => {
    expect(stills(at60(120), moving(120), 2000)).toEqual({
      longestStillMs: 0,
      longStills: 0,
    });
  });

  // Frames 30..59 repeat frame 29's picture: held from frame 29 (483 ms) until
  // frame 60 changes it (1000 ms). Frames 100..104 hold for 6 frames, 100 ms.
  it("measures a held picture from its first frame to the frame that changes it", () => {
    const c = moving(120);
    for (let i = 30; i < 60; i++) c[i] = STILL_CHANGE_MAX / 10;
    for (let i = 100; i < 105; i++) c[i] = 0;
    const s = stills(at60(120), c, 2000);
    expect(s.longestStillMs).toBeCloseTo((31 * 1000) / 60, 6);
    expect(s.longStills).toBe(1);
  });

  it("runs a still that reaches the end of the film to the film's end", () => {
    const c = moving(120);
    for (let i = 90; i < 120; i++) c[i] = 0;
    const s = stills(at60(120), c, 2000);
    expect(s.longestStillMs).toBeCloseTo(2000 - (89 * 1000) / 60, 6);
    expect(s.longStills).toBe(1);
  });

  it(`counts only stills of ${LONG_STILL_MS} ms or more as long`, () => {
    const c = moving(120);
    // 14 repeats after frame 9: held 15 frames, 250 ms — counted.
    for (let i = 10; i < 24; i++) c[i] = 0;
    // 13 repeats after frame 49: held 14 frames, 233 ms — not counted.
    for (let i = 50; i < 63; i++) c[i] = 0;
    const s = stills(at60(120), c, 2000);
    expect(s.longStills).toBe(1);
    expect(s.longestStillMs).toBeCloseTo(250, 6);
  });

  it("refuses changes that do not line up with the frames", () => {
    expect(() => stills(at60(10), moving(9), 200)).toThrow(
      "the probe answered 9 picture changes for 10 frames",
    );
  });
});

describe("judge — the gate refuses to compare broken films (spec §4)", () => {
  const four = (cli: Partial<RunFacts> = {}, ext: Partial<RunFacts> = {}) => [
    facts({ executor: "cli", run: 1, ...ext }),
    facts({ executor: "cli", run: 2, ...ext }),
    facts({ executor: "headless", run: 1, ...cli }),
    facts({ executor: "headless", run: 2, ...cli }),
  ];

  it("compares four complete, matching films", () => {
    expect(judge(four())).toEqual({ kind: "compared" });
  });

  it("refuses an incomplete run, quoting its stop reason verbatim", () => {
    const v = judge(
      four({ outcome: "stopped", stopped: "pageNeverSettled", completed: 2 }),
    );
    expect(v).toMatchObject({ kind: "refused", executor: "headless" });
    if (v.kind === "refused") {
      expect(v.cause).toContain("pageNeverSettled");
      expect(v.cause).toContain("2 of 4");
    }
  });

  it("refuses when the two executors filmed at different resolutions, printing both", () => {
    const v = judge(four({ span: [1710, 1107] }));
    expect(v).toMatchObject({ kind: "refused", executor: "both" });
    if (v.kind === "refused") {
      expect(v.cause).toContain("3420x2214");
      expect(v.cause).toContain("1710x1107");
    }
  });

  // `--sides cli,headless`: the same premise between the CLI's two modes —
  // what a headless pass without its stand-in display films (1x spans).
  it("refuses a visible and a headless CLI that filmed spans at different resolutions, naming both sides", () => {
    const pair = [
      facts({ executor: "cli", run: 1 }),
      facts({ executor: "cli", run: 2 }),
      facts({ executor: "headless", run: 1, span: [1710, 1107] }),
      facts({ executor: "headless", run: 2, span: [1710, 1107] }),
    ];
    expect(judge(pair)).toEqual({
      kind: "refused",
      executor: "both",
      cause:
        "the executors recorded motion spans at different resolutions: cli 3420x2214, headless 1710x1107",
    });
    expect(
      judge(
        pair.map((f) => ({ ...f, span: [3420, 2214] as [number, number] })),
      ),
    ).toEqual({ kind: "compared" });
  });

  // A run that acted and filmed no motion is a slideshow; two of them would
  // match on span resolution as "none" = "none".
  it("refuses a run with acting steps and no motion spans: its video is stills", () => {
    const stillsBoth = four({ span: null }, { span: null });
    // Premise: both sides read their bundle, and the sizes they would be
    // compared on are equal — the vacuous match this refusal replaces.
    expect(stillsBoth.every((f) => f.bundleFailed === null)).toBe(true);
    expect(stillsBoth.every((f) => f.span === null)).toBe(true);
    const v = judge(stillsBoth);
    expect(v).toEqual({
      kind: "refused",
      executor: "cli",
      cause:
        "cli run 1 recorded no motion spans for 4 acting steps — its video is stills",
    });
    // One side only: that side is named.
    expect(judge(four({ span: null }))).toMatchObject({
      kind: "refused",
      executor: "headless",
      cause:
        "headless run 1 recorded no motion spans for 4 acting steps — its video is stills",
    });
    // A script with nothing but pauses owes no motion.
    expect(
      judge(
        four({ span: null, actingSteps: 0 }, { span: null, actingSteps: 0 }),
      ),
    ).toEqual({
      kind: "compared",
    });
  });

  it("refuses a film that ends before its last step happens", () => {
    const v = judge(
      four({
        film: { ...FILM, durationMs: 1200, frames: 72, timesMs: at60(72) },
      }),
    );
    expect(v).toMatchObject({ kind: "refused", executor: "headless" });
    if (v.kind === "refused") expect(v.cause).toMatch(/ends at 1\.2 s.*4\.0 s/);
  });

  it("refuses a film with fewer frames than steps", () => {
    const v = judge(four({ film: { ...FILM, frames: 3, timesMs: at60(3) } }));
    expect(v).toMatchObject({ kind: "refused" });
  });

  // Cadence takes its nominal from the median gap; when half the gaps are 0
  // the median is 0 and every other gap would count as a hitch.
  it("refuses a film whose timestamps repeat for half its gaps", () => {
    const t = Array.from({ length: 41 }, (_, i) => Math.floor(i / 2) * 33);
    const gaps = t.length - 1;
    expect(t.filter((x, i) => i > 0 && x === t[i - 1]).length).toBe(gaps / 2);
    const v = judge(four({ film: { ...FILM, frames: t.length, timesMs: t } }));
    expect(v).toMatchObject({ kind: "refused", executor: "headless" });
    if (v.kind === "refused")
      expect(v.cause).toContain("repeats a timestamp for 20 of 40 frame gaps");
  });

  it("still compares a film with a few repeated timestamps", () => {
    const t = at60(120);
    t[50] = t[49] as number;
    t[80] = t[79] as number;
    expect(t.filter((x, i) => i > 0 && x === t[i - 1]).length).toBe(2);
    expect(judge(four({ film: { ...FILM, frames: 120, timesMs: t } }))).toEqual(
      { kind: "compared" },
    );
  });

  // An unread bundle has no keyframe or span size. Read on one side only, the
  // "none" would be blamed on resolution; unread on both, "none" = "none"
  // would match and compare vacuously. The read itself is the cause.
  it("refuses a bundle that could not be read on one side, naming the read — not a resolution mismatch", () => {
    const unread = four({
      bundleFailed: "no bundle under /tmp/h/takes/t1",
      keyframe: null,
      span: null,
    });
    // Premise: with the read ignored, the same facts would be blamed on the
    // missing span — the misattribution this check exists to prevent.
    const ignored = judge(unread.map((f) => ({ ...f, bundleFailed: null })));
    expect(ignored).toMatchObject({ kind: "refused", executor: "headless" });
    if (ignored.kind === "refused")
      expect(ignored.cause).toContain("recorded no motion spans");
    const v = judge(unread);
    expect(v).toMatchObject({ kind: "refused", executor: "headless" });
    if (v.kind === "refused") {
      expect(v.cause).toContain("headless run 1's bundle could not be read");
      expect(v.cause).toContain("no bundle under /tmp/h/takes/t1");
    }
  });

  it("refuses when the bundle and scene are unread on both sides, rather than matching none to none", () => {
    const blank = {
      bundleFailed: "IndexedDB refused",
      sceneFailed: "scene store refused",
      keyframe: null,
      span: null,
      zoomsSkipped: 0,
    };
    const facts4 = four(blank, blank);
    // Premise: with the reads ignored, the unread "none" would be blamed on
    // the film (no motion spans) rather than on the read.
    const ignored = judge(
      facts4.map((f) => ({ ...f, bundleFailed: null, sceneFailed: null })),
    );
    expect(ignored).toMatchObject({ kind: "refused" });
    if (ignored.kind === "refused")
      expect(ignored.cause).toContain("recorded no motion spans");
    const v = judge(facts4);
    expect(v).toMatchObject({ kind: "refused", executor: "cli" });
    if (v.kind === "refused")
      expect(v.cause).toBe(
        "cli run 1's bundle could not be read: IndexedDB refused",
      );
    const sceneOnly = judge(four({ sceneFailed: "scene store refused" }));
    expect(sceneOnly).toMatchObject({ kind: "refused", executor: "headless" });
    if (sceneOnly.kind === "refused")
      expect(sceneOnly.cause).toBe(
        "headless run 1's scene could not be read: scene store refused",
      );
  });

  it("refuses a run whose export made no film, saying what the export answered", () => {
    const v = judge(four({ film: null, exportOutcome: "renderFailed" }));
    expect(v).toMatchObject({ kind: "refused", executor: "headless" });
    if (v.kind === "refused") expect(v.cause).toContain("renderFailed");
  });
});

describe("table", () => {
  it("prints one column per run and a stillFailed row counted per executor", () => {
    const out = table("wikipedia", [
      facts({ executor: "cli", run: 1 }),
      facts({ executor: "cli", run: 2 }),
      facts({ run: 1, degradations: { stillFailed: 1 } }),
      facts({ run: 2, degradations: { stillFailed: 2 } }),
    ]);
    expect(out).toContain("cli 1");
    expect(out).toContain("headless 2");
    expect(out).toMatch(/stillFailed\s+0\s+0\s+1\s+2/);
  });

  // compare.html prints this structure; the terminal prints `table`, built on it.
  it("answers the same rows as structured cells for compare.html", () => {
    const got = tableRows([
      facts({ executor: "cli", run: 1 }),
      facts({ executor: "cli", run: 2 }),
      facts({ run: 1, degradations: { stillFailed: 1 } }),
      facts({ run: 2, degradations: { stillFailed: 2 } }),
    ]);
    expect(got.columns).toEqual(["cli 1", "cli 2", "headless 1", "headless 2"]);
    expect(got.rows.find((r) => r.name === "stillFailed")?.cells).toEqual([
      "0",
      "0",
      "1",
      "2",
    ]);
  });

  it("puts the CLI before headless in the columns, whichever came first", () => {
    const got = tableRows([
      facts({ executor: "headless", run: 1 }),
      facts({ executor: "headless", run: 2 }),
      facts({ executor: "cli", run: 2 }),
      facts({ executor: "cli", run: 1 }),
    ]);
    expect(got.columns).toEqual(["cli 1", "cli 2", "headless 1", "headless 2"]);
  });

  it("prints an unread read as unread, not none or 0, and says which read", () => {
    const got = tableRows([
      facts({ executor: "cli", run: 1 }),
      facts({ executor: "cli", run: 2 }),
      facts({
        run: 1,
        bundleFailed: "gone",
        sceneFailed: "gone",
        keyframe: null,
        span: null,
        zoomsSkipped: 0,
        degradations: { surfaceMismatch: 1 },
      }),
      facts({ run: 2 }),
    ]);
    const row = (n: string) => got.rows.find((r) => r.name === n)?.cells;
    expect(row("keyframes")).toEqual([
      "5130x3321",
      "5130x3321",
      "unread",
      "5130x3321",
    ]);
    expect(row("spans")).toEqual([
      "3420x2214",
      "3420x2214",
      "unread",
      "3420x2214",
    ]);
    expect(row("zooms skipped")).toEqual(["0", "0", "unread", "0"]);
    expect(row("surfaceMismatch")).toEqual(["0", "0", ">=1", "0"]);
    expect(row("unread")).toEqual(["-", "-", "bundle+scene", "-"]);
  });

  // The export's timestamps are the compositor's fixed grid, so they are
  // labelled as the encoder's; the picture's stills are what can differ.
  it("labels the timestamp rows as the encoder's and prints the picture's stills", () => {
    const still = {
      ...FILM,
      longestStillMs: 7000,
      longStills: 2,
    };
    const got = tableRows([
      facts({ executor: "cli", run: 1 }),
      facts({ run: 1, film: still }),
    ]);
    const names = got.rows.map((r) => r.name);
    expect(names).toContain("export fps (encoder)");
    expect(names).not.toContain("fps");
    expect(names).not.toContain("hitches");
    const row = (n: string) => got.rows.find((r) => r.name === n)?.cells;
    expect(row("longest still")).toEqual(["0.0 s", "7.0 s"]);
    expect(row(`stills >= ${LONG_STILL_MS} ms`)).toEqual(["0", "2"]);
  });

  it("prints no unread row when every read succeeded", () => {
    const got = tableRows([facts({ executor: "cli" }), facts()]);
    expect(got.rows.map((r) => r.name)).toContain("keyframes");
    expect(got.rows.map((r) => r.name)).not.toContain("unread");
  });
});

// film:compare's --sides after the extension was archived (2026-10-20):
// the CLI visible against the CLI headless is the one comparison left.
describe("parseSides", () => {
  it("defaults to the CLI visible against the CLI headless", () => {
    expect(parseSides(undefined)).toEqual({
      ok: true,
      sides: ["cli", "headless"],
    });
  });

  it("puts the two sides in filming order whichever way they are named", () => {
    expect(parseSides("headless,cli")).toEqual({
      ok: true,
      sides: ["cli", "headless"],
    });
  });

  it("refuses the extension side by name", () => {
    expect(parseSides("extension,cli")).toEqual({
      ok: false,
      reason:
        '--sides: "extension" was retired with the extension; use cli and headless',
    });
  });

  it("refuses a side twice, or one it does not know", () => {
    expect(parseSides("cli,cli").ok).toBe(false);
    expect(parseSides("cli,firefox").ok).toBe(false);
  });
});
