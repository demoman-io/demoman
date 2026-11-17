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
  apartFrames,
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

/** Both recordings took 200 s on CI's macOS and 177 s on ubuntu
 *  (2026-11-15, before the navigation), 87 s here: with room. */
const BOTH_MS = 900_000;

describe("a held recording", () => {
  // Spec test 2. The slowed recording is the other machine. Red when
  // anything the walk times follows the machine's speed rather than the
  // held clock.
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
      // Exact, also after each page load: a load is the server's time until
      // the page says it has loaded, asked between frames (it was 8 frames
      // loose while loops ended on the browser's load events; 2026-11-16).
      expect(two.timing, said).toEqual(one.timing);
      // And the same pictures, up to the click that leaves the page: what
      // the page animates itself (the box its animation frames move) stands
      // where it did, however long each machine's server took. Timing alone
      // did not see page time added after the page's scripts began, by the
      // length of the opening's load: CI's macOS did, twice (2026-11-16).
      const box = async (r: Recorded) => {
        const leaves = r.bundle.markers.at(-2)?.sourceTimeMs ?? 0;
        const frames = await pageFrames(r, [0.23, 0.14, 0.43, 0.21]);
        return frames.filter((f) => f.ms < leaves).map((f) => f.grey);
      };
      const boxes = [await box(fast), await box(slow)];
      expect(boxes[0]?.length, said).toBeGreaterThan(100);
      expect(apartFrames(boxes[1] ?? [], boxes[0] ?? []), said).toEqual([]);
      expect(one.timing, said).toEqual(
        JSON.parse(readFileSync(GOLDEN, "utf8")),
      );
    },
    BOTH_MS,
  );

  // DEM-204. The click asks for a streamed answer a moment later, so the
  // step's settle is asked before it opens and runs over it. Chunks 600 ms
  // apart: 12 captured frames fit in a gap on a fast machine and not on a
  // slowed one, and the settle's cap ran on the page's clock, which follows
  // the server there. Red while either decides where the settle ends.
  it(
    "a settle over a streamed answer ends on the same frame on any machine",
    async () => {
      const s = createServer((req, res) => {
        if (req.url === "/answer") {
          res.writeHead(200, { "content-type": "text/plain" });
          let n = 0;
          const send = () => {
            res.write(`chunk ${++n} `);
            if (n < 3) setTimeout(send, 600);
            else setTimeout(() => res.end(), 100);
          };
          send();
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<!doctype html><meta charset=utf-8><link rel=icon href="data:,"><style>body{margin:0;font:16px monospace}button{position:absolute;left:40px;width:160px;height:40px}#ask{top:40px}#next{top:120px}#log{position:absolute;left:240px;top:40px;margin:0}</style><button id=ask>Ask</button><button id=next>Next</button><p id=log>-</p><script>ask.onclick=()=>setTimeout(async()=>{const r=(await fetch("/answer")).body.getReader();const d=new TextDecoder();let t="";for(;;){const c=await r.read();if(c.done)break;t+=d.decode(c.value);log.textContent=t}},100)</script>`,
        );
      });
      const at = await listenOnLoopback(s);
      try {
        const steps = [
          { do: "click", on: { stableId: "ask" }, zoom: false },
          { do: "click", on: { stableId: "next" }, zoom: false },
        ];
        const fast = await timingOf(await record(home, at, steps));
        const slowed = await record(home, at, steps, {}, LAG_MS);
        const slow = await timingOf(slowed);
        const said = JSON.stringify({
          network: slowed.bundle.networkSpans,
          fast: fast.timing,
          slow: slow.timing,
        });
        // Premise: the answer was a network stretch.
        expect(
          (slowed.bundle.networkSpans ?? []).some((n) =>
            n.label.includes("GET /answer"),
          ),
          said,
        ).toBe(true);
        expect(slow.timing.stepFrames, said).toEqual(fast.timing.stepFrames);
        expect(slow.timing.frames, said).toBe(fast.timing.frames);
      } finally {
        s.close();
      }
    },
    BOTH_MS,
  );
});
