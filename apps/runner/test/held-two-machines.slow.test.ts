// Slow tier: records the held fixture twice, once on a slowed machine.
import { readFileSync } from "node:fs";
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
 * a Mac (`fixtures/held-two-machines.json`). Timing only, never pixels
 * across operating systems: the frame count, the frames every step's
 * moments land on, and the frames the picture changes on, in held frames
 * from the first frame.
 */

const GOLDEN = join(import.meta.dirname, "fixtures", "held-two-machines.json");
/** A slow machine on this one: every CDP command held this long (`lag.ts`). */
const LAG_MS = 40;

/** The recording's timing in held frames from its first frame (`originMs`,
 *  not compared). Every frame from the first on is on the held grid while
 *  no network stretch falls after it, which the test asserts. */
async function timingOf(r: Recorded) {
  const frames = await pageFrames(r, [0, 0, 1, 1], { width: 96, height: 60 });
  const stills = r.bundle.keyframes.map((k) => k.sourceTimeMs);
  const originMs = Math.min(...stills, ...frames.map((f) => f.ms));
  const at = (ms: number) => Math.round((ms - originMs) / HELD_FRAME_MS);
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
        ...new Set([...changed.map((f) => f.ms), ...stills].map(at)),
      ].sort((x, y) => x - y),
    },
  };
}

let home: string;
let server: Server;
let url: string;
const requests: string[] = [];
const was = process.env.DEMOMAN_HELD_CLOCK;

beforeAll(async () => {
  process.env.DEMOMAN_HELD_CLOCK = "1";
  home = await mkdtemp(join(tmpdir(), "demoman-held-machines-"));
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  url = await listenOnLoopback(server);
}, 30_000);

afterAll(async () => {
  if (was === undefined) delete process.env.DEMOMAN_HELD_CLOCK;
  else process.env.DEMOMAN_HELD_CLOCK = was;
  server.close();
  await rm(home, { recursive: true, force: true });
});

describe("a held recording", () => {
  // Spec test 2, and the Task 6 review's open question: the loops that end
  // on the top frame's loading state hear `Page.frameStoppedLoading` from
  // the browser process, so a slow machine could end them on another frame.
  // The slowed recording is that machine. Red when anything the walk times
  // follows the machine's speed rather than the held clock.
  it("the same timing on any machine", async () => {
    requests.length = 0;
    const fast = await record(home, url, SCRIPT_STEPS);
    const fastRequests = [...requests];
    requests.length = 0;
    const slow = await record(home, url, SCRIPT_STEPS, {}, LAG_MS);
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
    // Premise: the fixture makes one request, its document, whose wait is
    // over before the first frame, so no network stretch is in the timing
    // compared (its icon is empty, so Chrome fetches none).
    expect(measured.requests, said).toEqual([["GET /"], ["GET /"]]);
    for (const [i, r] of [one, two].entries())
      expect(
        (measured.network[i] ?? []).map((s) => [s.label, s.endMs < r.originMs]),
        said,
      ).toEqual([["GET /", true]]);
    // The slowed recording really was slower.
    expect(slow.realMs, said).toBeGreaterThan(fast.realMs + 10_000);
    expect(two.timing, said).toEqual(one.timing);
    expect(one.timing, said).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
  }, 600_000);
});
