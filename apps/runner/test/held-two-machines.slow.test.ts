// Slow tier: records the held fixture twice, once on a slowed machine.
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELD_FRAME_MS } from "@demoman/replay-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listenOnLoopback } from "../src/loopback.js";
import {
  greyDiff,
  NOISE,
  PAGE,
  pageFrames,
  type Recorded,
  record,
  SCRIPT_STEPS,
} from "./held-record.js";

/**
 * Spec test 2: one script, the same timing on any machine. CI runs this
 * file on ubuntu and on macOS, and both are held to one golden written on
 * a Mac (`fixtures/held-two-machines.json`, rewritten by a run with
 * `WRITE_GOLDEN=1`). Timing only, never pixels
 * across operating systems: the frame count, the frames every step's
 * moments land on, and the frames the picture changes on, in held frames
 * from the first frame, network stretches left out.
 */

const GOLDEN = join(import.meta.dirname, "fixtures", "held-two-machines.json");
/** A slow machine on this one: every CDP command held this long (`lag.ts`). */
const LAG_MS = 40;

/** The recording's timing in held frames from its first frame (`originMs`,
 *  not compared): a moment is counted by the page time before it that was
 *  not waiting on the server, and a frame taken while it was (network
 *  time, real time) is no picture change of the held clock's. */
async function timingOf(r: Recorded) {
  const frames = await pageFrames(r, [0, 0, 1, 1], { width: 96, height: 60 });
  const stills = r.bundle.keyframes.map((k) => k.sourceTimeMs);
  const originMs = Math.min(...stills, ...frames.map((f) => f.ms));
  const spans = r.bundle.networkSpans ?? [];
  const at = (ms: number) => {
    let network = 0;
    for (const s of spans)
      network += Math.max(
        0,
        Math.min(s.endMs, ms) - Math.max(s.startMs, originMs),
      );
    return Math.round((ms - originMs - network) / HELD_FRAME_MS);
  };
  const waiting = (ms: number) =>
    spans.some((s) => ms > s.startMs && ms <= s.endMs);
  // A still starts where the picture stopped changing; a span's frame is a
  // change when it moved past the encoder's noise from the frame before.
  const changed = frames.filter(
    (f, i) => i === 0 || greyDiff(f.grey, frames[i - 1]?.grey ?? "") > NOISE,
  );
  return {
    originMs,
    timing: {
      frames:
        at(Math.max(...stills, ...r.bundle.motionSpans.map((s) => s.endMs))) +
        1,
      stepFrames: r.bundle.markers.map((m) =>
        [
          m.sourceTimeMs,
          m.approachSourceTimeMs,
          m.actEndSourceTimeMs,
          m.scrollEndSourceTimeMs,
        ].map((ms) => (ms === undefined ? null : at(ms))),
      ),
      changeFrames: [
        ...new Set(
          [...changed.map((f) => f.ms), ...stills]
            .filter((ms) => !waiting(ms))
            .map(at),
        ),
      ].sort((x, y) => x - y),
    },
  };
}

let home: string;
let a: Server;
let b: Server;
let url: string;
let away: string;
const requests: string[] = [];
const was = process.env.DEMOMAN_HELD_CLOCK;

/** The fixture, then a click to another site whose server answers 200 ms
 *  late, mid-flow: the path whose held frames once varied (Task 9). */
const STEPS = [
  ...SCRIPT_STEPS,
  { do: "click", on: { stableId: "away" }, zoom: false },
  { do: "waitFor", on: { stableId: "there" }, until: "visible" },
];

beforeAll(async () => {
  process.env.DEMOMAN_HELD_CLOCK = "1";
  home = await mkdtemp(join(tmpdir(), "demoman-held-machines-"));
  b = createServer((req, res) => {
    requests.push(`b ${req.method} ${req.url}`);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><link rel=icon href="data:,"><p id=there style="position:absolute;left:40px;top:40px">there</p>`,
      );
    }, 200);
  });
  // Another site: localhost, where the page is on 127.0.0.1.
  away = (await listenOnLoopback(b)).replace("127.0.0.1", "localhost");
  a = createServer((req, res) => {
    requests.push(`a ${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html" });
    // Beside the Far button, where the walk has scrolled by then.
    res.end(
      `${PAGE}<a id=away href="${away.replace(/\/$/, "")}/there" style="position:absolute;left:240px;top:2600px;width:160px;height:40px;display:block;background:#eee">Away</a>`,
    );
  });
  url = await listenOnLoopback(a);
}, 30_000);

afterAll(async () => {
  if (was === undefined) delete process.env.DEMOMAN_HELD_CLOCK;
  else process.env.DEMOMAN_HELD_CLOCK = was;
  a.close();
  b.close();
  await rm(home, { recursive: true, force: true });
});

/**
 * How far a page load may move what follows it, in frames. A page's load is
 * real time, so the frames that pass during it follow the machine (246
 * against 248 after the navigation under the lag here, and the opening's
 * load a frame later in 1 run of 6; traced 2026-11-16). While load and
 * settle fit inside the planned rest before the next step nothing showed,
 * and the held clock's longer settle (`HELD_STEP_QUIET_MS`) no longer fits.
 * The author accepted a few frames there (2026-11-16) for settled screens
 * that are the page's result. Between the two loads timing stays exact.
 * Measured on one Mac, six fast recordings: the step after the navigation
 * on frame 217, 221, 222 or 223, so 8 with room.
 * shortcut: a bound, not a cause removed; the loops that end on a load hear
 * it from browser events the frames do not order. Upgrade by deciding a
 * load's end from the page between frames, and put this back to 0.
 */
const AFTER_LOAD_FRAMES = 8;

type Timing = Awaited<ReturnType<typeof timingOf>>["timing"];
/** `got` against `want`: the opening's load may put everything up to
 *  `AFTER_LOAD_FRAMES` later or earlier; from the first step's approach to
 *  the end of the click that navigates (the second-last step) the two are
 *  then exact; after it, within `AFTER_LOAD_FRAMES` again. */
function expectSameTiming(got: Timing, want: Timing, said: string) {
  const first = (t: Timing) => t.stepFrames[0]?.[1] ?? Number.NaN;
  const late = first(got) - first(want);
  expect(Math.abs(late), said).toBeLessThanOrEqual(AFTER_LOAD_FRAMES);
  const navigated = want.stepFrames.at(-2)?.[2] ?? Number.NaN;
  const between = (t: Timing, by: number) => ({
    steps: t.stepFrames
      .slice(0, -1)
      .map((step) => step.map((f) => (f === null ? null : f - by))),
    changes: t.changeFrames
      .map((f) => f - by)
      .filter((f) => f >= first(want) && f <= navigated),
  });
  expect(between(got, late), said).toEqual(between(want, 0));
  const after = (t: Timing, by: number) => [
    t.frames - by,
    ...(t.stepFrames.at(-1) ?? []).map((f) => (f ?? -1) - by),
    ...t.changeFrames.map((f) => f - by).filter((f) => f > navigated),
  ];
  const [g, w] = [after(got, late), after(want, 0)];
  expect(g.length, said).toBe(w.length);
  for (const [i, f] of g.entries())
    expect(Math.abs(f - (w[i] ?? Number.NaN)), said).toBeLessThanOrEqual(
      AFTER_LOAD_FRAMES,
    );
}

/** Both recordings took 200 s on CI's macOS and 177 s on ubuntu
 *  (2026-11-15, before the navigation), 87 s here: with room. */
const BOTH_MS = 900_000;

describe("a held recording", () => {
  // Spec test 2, and the Task 6 review's open question: the loops that end
  // on the top frame's loading state hear `Page.frameStoppedLoading` from
  // the browser process, so a slow machine could end them on another frame.
  // The slowed recording is that machine. Red when anything the walk times
  // follows the machine's speed rather than the held clock.
  it(
    "the same timing on any machine",
    async () => {
      requests.length = 0;
      const fast = await record(home, url, STEPS);
      const fastRequests = [...requests];
      requests.length = 0;
      const slow = await record(home, url, STEPS, {}, LAG_MS);
      const [one, two] = [await timingOf(fast), await timingOf(slow)];
      const measured = {
        platform: process.platform,
        realMs: [fast.realMs, slow.realMs],
        requests: [fastRequests, [...requests]],
        network: [fast.bundle.networkSpans, slow.bundle.networkSpans],
        originMs: [one.originMs, two.originMs],
        fast: one.timing,
        slow: two.timing,
      };
      const said = JSON.stringify(measured);
      // Premise: two requests, the document's (over before the first frame)
      // and the other site's after the click, each a network stretch (the
      // icons are empty, so Chrome fetches none).
      const premise = [["a GET /", "b GET /there"]];
      expect(measured.requests, said).toEqual([...premise, ...premise]);
      for (const [i, r] of [one, two].entries())
        expect(
          (measured.network[i] ?? []).map((s) => [
            s.label,
            s.endMs < r.originMs,
          ]),
          said,
        ).toEqual([
          ["GET /", true],
          ["GET /there", false],
        ]);
      // The slowed recording really was slower.
      expect(slow.realMs, said).toBeGreaterThan(fast.realMs + 10_000);
      if (process.env.WRITE_GOLDEN === "1")
        writeFileSync(GOLDEN, `${JSON.stringify(one.timing)}\n`);
      expectSameTiming(two.timing, one.timing, said);
      expectSameTiming(
        one.timing,
        JSON.parse(readFileSync(GOLDEN, "utf8")),
        said,
      );
    },
    BOTH_MS,
  );
});
