// Slow tier: records held videos of pages that wait on their server.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HELD_FRAME_MS, STEP_REQUEST_CAP_MS } from "@demoman/replay-engine";
import type { FilmReport } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listenOnLoopback } from "../src/loopback.js";
import { type Arrival, arrivals } from "./arrivals.js";
import {
  greyDiff,
  NOISE,
  pageFrames,
  type Recorded,
  record,
} from "./held-record.js";
import { heldByLagMs, relagCdp } from "./lag.js";

/**
 * The network half of held capture (spec tests 3, 4 and 6): while the page
 * waits on its server the video follows real time, and only then.
 */

const CHUNKS = 10;
const CHUNK_GAP_MS = 200;

/** An endless spinner, so every frame differs and none is filed as a
 *  still: the motion spans hold every frame, at its time. A button that
 *  asks the server, and a row the answer fills, one 40px block per chunk
 *  (left 40 + 50 i, top 300). */
const page = (
  ask: string,
) => `<!doctype html><meta charset=utf-8><link rel=icon href="data:,">
<style>
body{margin:0;background:#fff}
#ask{position:absolute;left:40px;top:40px;width:160px;height:40px;background:#eee;border:1px solid #888}
#spin{position:absolute;left:40px;top:120px;width:60px;height:60px;background:linear-gradient(90deg,#c00,#00c);animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.b{position:absolute;top:300px;width:40px;height:40px;background:#000}
</style>
<button id=ask>Ask</button><div id=spin></div>
<script>document.getElementById("ask").addEventListener("click", async () => {${ask}});</script>`;

const STREAM = page(`
  const res = await fetch("/answer", { method: "POST" });
  const reader = res.body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) {
      const b = document.createElement("div");
      b.className = "b";
      b.style.left = 40 + 50 * n++ + "px";
      document.body.append(b);
    }
  }
  const d = document.createElement("p");
  d.id = "done";
  d.textContent = "done";
  document.body.append(d);
`);

const IDLE = page(`fetch("/poll");`);
/** A page with a feed open from its load, a byte every 300 ms for as long
 *  as the page is there, shown as it arrives. */
const FED = `<!doctype html><meta charset=utf-8><link rel=icon href="data:,">
<button id=ask style="position:absolute;left:40px;top:40px;width:160px;height:40px">Ask</button>
<p id=fed style="position:absolute;left:40px;top:120px;margin:0">0</p>
<script>(async () => {
  const reader = (await fetch("/feed")).body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    document.getElementById("fed").textContent = String(n);
  }
})();</script>`;
const LATE_MS = 700;
/** Times the server was asked for the late document. */
let lateAsked = 0;
const LATE = `<!doctype html><meta charset=utf-8><link rel=icon href="data:,">
<button id=ask style="position:absolute;left:40px;top:40px;width:160px;height:40px">Ask</button>`;

/** A same-origin frame its server answers after `FRAME_MS`, past a step's
 *  request cap, inserted by a click: the page itself is done at once. */
const FRAME_MS = 8000;
const FRAMED = `<!doctype html><meta charset=utf-8><link rel=icon href="data:,">
<button id=ask style="position:absolute;left:40px;top:40px;width:160px;height:40px">Ask</button>
<script>document.getElementById("ask").addEventListener("click", () => {
  const f = document.createElement("iframe");
  f.src = "/slowframe";
  f.style.cssText = "position:absolute;left:40px;top:120px;width:300px;height:100px";
  document.body.append(f);
});</script>`;

/** A click starts a muted video whose server sends its headers and then
 *  nothing: playing, and never moving off its first frame. */
const STALLED = `<!doctype html><meta charset=utf-8><link rel=icon href="data:,">
<button id=ask style="position:absolute;left:40px;top:40px;width:160px;height:40px">Ask</button>
<script>document.getElementById("ask").addEventListener("click", () => {
  const v = document.createElement("video");
  v.muted = true;
  v.src = "/stall.webm";
  v.style.cssText = "position:absolute;left:40px;top:120px;width:320px;height:180px";
  document.body.append(v);
  v.play().catch(() => undefined);
});</script>`;

/** A click adds a muted autoplaying video (`fixtures/ramp-4s.webm`: 4 s, a
 *  flat grey 14 to 28 levels lighter every frame, back to black every 10;
 *  VP8, as this Chromium plays no H.264), sent faster than it plays,
 *  as `compare/held-push.sh`'s video page. It loops, so it still plays at
 *  the pause's end however slowly the machine captures. Made with
 *  `ffmpeg -f lavfi -i "color=c=black:s=320x180:r=30:d=4,format=yuv420p,geq=lum='20+mod(N*20\,200)':cb=128:cr=128" -c:v libvpx -b:v 400k -auto-alt-ref 0`. */
const AUTOPLAY = `<!doctype html><meta charset=utf-8><link rel=icon href="data:,">
<button id=ask style="position:absolute;left:40px;top:40px;width:160px;height:40px">Ask</button>
<script>document.getElementById("ask").addEventListener("click", () => {
  const v = document.createElement("video");
  v.muted = true;
  v.autoplay = true;
  v.loop = true;
  v.src = "/clip.webm";
  v.style.cssText = "position:absolute;left:40px;top:120px;width:320px;height:180px";
  document.body.append(v);
});</script>`;
/** The same, and it asks for `/underway` once it has played half a
 *  second: there the test slows the machine (`relagCdp`). Slowed from the
 *  start, or at its `playing` event, Chrome never got the clip off 0.00
 *  (DEM-244, said; CI's ubuntu and a loaded Mac, 2026-11-23). */
const AHEAD = AUTOPLAY.replace(
  "document.body.append(v);",
  'v.addEventListener("timeupdate", function underway() {\n    if (v.currentTime < 0.5) return;\n    v.removeEventListener("timeupdate", underway);\n    fetch("/underway");\n  });\n  document.body.append(v);',
);
const CLIP = readFileSync(
  fileURLToPath(new URL("./fixtures/ramp-4s.webm", import.meta.url)),
);
/** The clip in 16 parts, 125 ms apart: its 4 s, in 2 s. Sent at the rate it
 *  plays, it waited over 3 s to start even paced, as Chrome starts one only
 *  with data to play through (2026-11-19). */
const CLIP_PARTS = 16;
/** Real seconds per take second at or above which a walk counts as a
 *  machine far behind its frames (DEM-244; the measurements are at its
 *  one reader). */
const STARVED_REAL_PER_TAKE = 2;
const CLIP_GAP_MS = 125;
/** What the pin says of a video whose picture stood on its last frame
 *  ahead of its currentTime (DEM-259). */
const PICTURE_AHEAD =
  /^a video's picture stood on its last frame while it played \(its picture at \d+\.\d\d s of [\d.]+, its currentTime at \d+\.\d\d s\): its picture plays in real time, ahead of the take$/;
/** Real seconds per take second above which a walk fell behind real time:
 *  a machine that keeps up walks 1.01 to 1.02 (paced to real time). */
const BEHIND_REAL_PER_TAKE = 1.1;

let home: string;
let server: Server;
let url: string;
const open: ServerResponse[] = [];
/** Each streamed answer as the server sent it, in real ms: when it was
 *  asked for and when each chunk was written. A loaded machine sends late
 *  (DEM-235: chunks 8-10 shown together on CI's macOS), and the video
 *  follows what the server did, not the 200 ms it was told. */
const streams: { askedAt: number; sentAt: number[] }[] = [];
const was = process.env.DEMOMAN_HELD_CLOCK;
/** Real ms the `/ahead` page said its video was under way, or null. */
let underwayAt: number | null = null;
/** Why the machine could not be slowed there, if it could not. */
let underwayRefused: string | null = null;
/** Every CDP command held this long once `/ahead`'s video is under way:
 *  each frame takes several real frames. */
const AHEAD_LAG_MS = 100;

beforeAll(async () => {
  process.env.DEMOMAN_HELD_CLOCK = "1";
  home = await mkdtemp(join(tmpdir(), "demoman-held-network-"));
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/answer") {
      // One byte a chunk, the first at once, the last 1800 ms later.
      res.writeHead(200, { "content-type": "text/plain" });
      // Paced on one monotonic clock against absolute deadlines: chunk i
      // goes no earlier than i gaps after the first, by performance.now(),
      // and a timer that fires early is set again for what is left. Timed
      // with Date.now() and chained timers, the ten came 1799 ms apart on
      // CI's ubuntu (PR #128, DEM-235): a wall clock can step and a chained
      // timer can come early, and the premise below then failed on the
      // fixture, not on the walk.
      const stream = { askedAt: performance.now(), sentAt: [] as number[] };
      streams.push(stream);
      let sent = 0;
      let firstAt = 0;
      const send = () => {
        const due = firstAt + sent * CHUNK_GAP_MS;
        const early = sent === 0 ? 0 : due - performance.now();
        if (early > 0) {
          setTimeout(send, Math.ceil(early));
          return;
        }
        res.write("x");
        const now = performance.now();
        if (sent === 0) firstAt = now;
        stream.sentAt.push(now);
        if (++sent === CHUNKS) res.end();
        else setTimeout(send, CHUNK_GAP_MS);
      };
      send();
      return;
    }
    if (path === "/feed") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("x");
      const timer = setInterval(() => res.write("x"), 300);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (path === "/late") {
      lateAsked++;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(LATE);
      }, LATE_MS);
      return;
    }
    if (path === "/slowframe") {
      const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<p>framed</p>");
      }, FRAME_MS);
      req.on("close", () => clearTimeout(timer));
      return;
    }
    if (path === "/stall.webm") {
      res.writeHead(200, { "content-type": "video/webm" });
      res.flushHeaders();
      open.push(res);
      return;
    }
    if (path === "/clip.webm") {
      res.writeHead(200, {
        "content-type": "video/webm",
        "content-length": CLIP.length,
        "cache-control": "no-store",
      });
      const part = Math.ceil(CLIP.length / CLIP_PARTS);
      let at = 0;
      const send = () => {
        res.write(CLIP.subarray(at, at + part));
        at += part;
        if (at >= CLIP.length) res.end();
        else timer = setTimeout(send, CLIP_GAP_MS);
      };
      let timer = setTimeout(send, 0);
      req.on("close", () => clearTimeout(timer));
      return;
    }
    if (path === "/underway") {
      try {
        relagCdp(AHEAD_LAG_MS);
        underwayAt = Date.now();
        res.writeHead(204);
      } catch (e) {
        underwayRefused = (e as Error).message;
        res.writeHead(500);
      }
      res.end();
      return;
    }
    if (path === "/ahead") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(AHEAD);
      return;
    }
    if (path === "/autoplay") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(AUTOPLAY);
      return;
    }
    if (path === "/stalled") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(STALLED);
      return;
    }
    if (path === "/framed") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(FRAMED);
      return;
    }
    if (path === "/poll") {
      // A long poll that never answers, not even its headers.
      open.push(res);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(path === "/idle" ? IDLE : path === "/fed" ? FED : STREAM);
  });
  url = (await listenOnLoopback(server)).replace(/\/$/, "");
}, 30_000);

afterAll(async () => {
  if (was === undefined) delete process.env.DEMOMAN_HELD_CLOCK;
  else process.env.DEMOMAN_HELD_CLOCK = was;
  for (const res of open) res.destroy();
  server.close();
  await rm(home, { recursive: true, force: true });
});

/** Every captured frame's time, and how many blocks of the answer it shows. */
async function blocksOf(r: Recorded): Promise<{ ms: number; n: number }[]> {
  // The row, one block a slot of 5 cells: a block's middle cells are dark.
  const frames = await pageFrames(
    r,
    [40 / 1280, 300 / 800, 540 / 1280, 0.425],
    {
      width: 50,
      height: 4,
    },
  );
  return frames.map((f) => {
    const grey = Buffer.from(f.grey, "base64");
    let n = 0;
    for (let slot = 0; slot < CHUNKS; slot++)
      if ((grey[50 + 5 * slot + 2] ?? 255) < 128) n++;
    return { ms: f.ms, n };
  });
}

/** From the first frame that shows the answer's first chunk to the first
 *  that shows its last, in the video's source ms; a frame of the machine
 *  that recorded it (the longest time between two of its frames from one to
 *  the other: frames that wait on the server follow real time, so this is
 *  how often it captured, never under a held frame); whether the answer only
 *  grew; and each frame it grew on. */
async function streamed(r: Recorded) {
  const frames = await blocksOf(r);
  const from = frames.findIndex((f) => f.n >= 1);
  const to = frames.findIndex((f) => f.n === CHUNKS);
  const between = frames.slice(from, to + 1);
  return {
    first: frames[from]?.ms ?? Number.NaN,
    last: frames[to]?.ms ?? Number.NaN,
    frameMs: Math.max(
      HELD_FRAME_MS,
      ...between.slice(1).map((f, i) => f.ms - (between[i]?.ms ?? 0)),
    ),
    rising: frames.every((f, i) => i === 0 || f.n >= (frames[i - 1]?.n ?? 0)),
    grew: frames
      .filter((f, i) => i > 0 && f.n !== frames[i - 1]?.n)
      .map((f) => [Math.round(f.ms), f.n]),
    states: [...new Set(frames.map((f) => f.n))].sort((x, y) => x - y),
  };
}

const ASK = [
  { do: "click", on: { stableId: "ask" }, zoom: false },
  { do: "waitFor", on: { stableId: "done" }, until: "visible" },
];

/** Ten hours before now: a page's own clock far from real time, as a pin
 *  makes it (a fetch's wallTime is the page's, review of Task 9 round 2:
 *  CI run 3's stream stretch was 10.5 h). */
const FAR_PIN = new Date(Date.now() - 10 * 3600 * 1000).toISOString();

/** One recording of the stream takes about 9 s here, 40 s slowed; CI's
 *  macOS took 32-44 s each (2026-11-15). Both, with room: */
const STREAMS_MS = 300_000;

describe("a held recording that waits on its server", () => {
  let normal: Recorded;
  let slowed: Recorded;
  /** The lag's holds during each recording, summed over its commands
   *  (parallel ones each count): 0 for the normal one. */
  let normalHeldMs = 0;
  let slowHeldMs = 0;
  /** The server's side of each one's answer (`streams`). */
  const served = new Map<Recorded, (typeof streams)[number] | undefined>();
  /** When each one's answer data reached Demoman (`arrivals.ts`), on the
   *  server's clock (`performance.now()`). */
  const arrived = new Map<Recorded, Arrival[]>();
  const answerArrivals = (from: number) =>
    arrivals()
      .slice(from)
      .filter((a) => a.url.endsWith("/answer"));

  beforeAll(async () => {
    const from = streams.length;
    const normalBefore = heldByLagMs();
    const normalArrivals = arrivals().length;
    normal = await record(home, `${url}/`, ASK, {}, undefined, FAR_PIN);
    normalHeldMs = heldByLagMs() - normalBefore;
    served.set(
      normal,
      streams.length === from + 1 ? streams.at(-1) : undefined,
    );
    arrived.set(normal, answerArrivals(normalArrivals));
    const heldBefore = heldByLagMs();
    const slowedArrivals = arrivals().length;
    slowed = await record(home, `${url}/`, ASK, {}, 40, FAR_PIN);
    slowHeldMs = heldByLagMs() - heldBefore;
    served.set(
      slowed,
      streams.length === from + 2 ? streams.at(-1) : undefined,
    );
    arrived.set(slowed, answerArrivals(slowedArrivals));
  }, STREAMS_MS);

  // Spec test 3. Red when the stream is played on the held grid instead of
  // real time: its 1800 ms would be one frame for each frame captured. And
  // red on the slowed run when a frame's time is the real time it was asked
  // for, not taken (1400-1500 ms, held-clock.ts, review of Task 9 round 1).
  // "Within a frame" is a frame of the machine that recorded it: frames
  // that wait on the server are taken as fast as it can, and a chunk shows
  // in the first one taken after it came. Those took 50 ms here, 250-330 ms
  // with every command held 40 ms, and 300-500 ms on CI's macOS without
  // the lag (2026-11-15): two chunks 200 ms apart can share a frame there,
  // so the premise asks for most of the states, not each.
  it("a streamed answer follows real time", async () => {
    const both = await Promise.all(
      [normal, slowed].map(async (r) => {
        const server = served.get(r);
        const sent = server?.sentAt ?? [];
        return {
          ...(await streamed(r)),
          stretch: (r.bundle.networkSpans ?? []).find((n) =>
            n.label.includes("POST /answer"),
          ),
          realMs: r.realMs,
          network: r.bundle.networkSpans,
          // The server's chunks, from when it was asked.
          sent: sent.map((t) => t - (server?.askedAt ?? Number.NaN)),
          // And when each reached Demoman, from the same moment.
          arrived: (arrived.get(r) ?? []).map(
            (a) => a.at - (server?.askedAt ?? Number.NaN),
          ),
          arrivedBytes: (arrived.get(r) ?? []).reduce((n, a) => n + a.bytes, 0),
          answerRequests: new Set(
            (arrived.get(r) ?? []).map((a) => a.requestId),
          ).size,
        };
      }),
    );
    const said = JSON.stringify(both);
    // Premises: the lag held the slowed recording's commands and none of the
    // normal one's. Asked of the lag, not of the two recordings' lengths: on
    // a starved macOS runner the normal one took 41.3 s by itself and the
    // slowed one 40.5 (DEM-235, PR #123), though the lag held every command
    // as asked. The sum counts each held command's 40 ms, parallel ones
    // too, so 10 s is about 250 commands held, not 10 s of the recording's
    // length; what the lag does to frame times is asserted below.
    const heldSaid = `normalHeldMs ${normalHeldMs} slowHeldMs ${slowHeldMs} ${said}`;
    expect(normalHeldMs, heldSaid).toBe(0);
    expect(slowHeldMs, heldSaid).toBeGreaterThan(10_000);
    for (const s of both) {
      // Premise: the server sent one answer, all ten chunks, at least 200 ms
      // apart (each is set off by the one before).
      expect(s.sent, said).toHaveLength(CHUNKS);
      const firstSent = s.sent[0] ?? Number.NaN;
      const lastSent = s.sent.at(-1) ?? Number.NaN;
      expect(lastSent - firstSent, said).toBeGreaterThanOrEqual(
        (CHUNKS - 1) * CHUNK_GAP_MS,
      );
      // Premise: the answer grew in the frames, from none to all ten, over
      // at least six states seen, and at least 1200 ms of it is measured.
      expect(s.rising, said).toBe(true);
      expect(s.states[0], said).toBe(0);
      expect(s.states.at(-1), said).toBe(CHUNKS);
      expect(s.states.length, said).toBeGreaterThanOrEqual(6);
      // Premise: Demoman heard all of the one answer's data arrive, from
      // its first byte (each chunk is one byte; chunks that came together
      // share an event). Those times are real ones, not the grants': on
      // the slowed run, frames 500 ms apart and every command held 40 ms,
      // each chunk was heard 1-5 ms after it was sent (2026-11-24), so a
      // held clock that took data late would still be red against them.
      expect(s.answerRequests, said).toBe(1);
      expect(s.arrivedBytes, said).toBe(CHUNKS);
      const firstArrived = s.arrived[0] ?? Number.NaN;
      const lastArrived = s.arrived.at(-1) ?? Number.NaN;
      // Within a frame, or the held frame after, of when the data ARRIVED:
      // the held clock follows arrival, which is all a page on that network
      // would have seen; when the server sent it is a premise above. The
      // page can run a chunk's script in the grant after it arrived, at the
      // first chunk as at the last. Against send times this went red when a
      // loaded runner delivered the first chunk 140 ms late (DEM-235, PR
      // #142's ubuntu). The bound is the one it had: each end of the
      // stretch shows in the first frame taken after its data arrived, or
      // the held frame after, on the same machine and the same clock as the
      // arrival, so no delivery jitter can move the two apart.
      expect(
        Math.abs(s.last - s.first - (lastArrived - firstArrived)),
        said,
      ).toBeLessThanOrEqual(s.frameMs + HELD_FRAME_MS);
      // And from where the wait began: the last chunk shows as long after it
      // as its data arrived after the server was asked, within a frame, or
      // the held frame after:
      // the page can run the last chunk's script in the grant after the
      // wait ends (44 ms here, 2 runs of about 12, 2026-11-16; the next
      // test allows the same). The stretch lasts no longer than the stream
      // and a frame either side.
      const start = s.stretch?.startMs ?? Number.NaN;
      expect(Math.abs(s.last - start - lastArrived), said).toBeLessThanOrEqual(
        s.frameMs + HELD_FRAME_MS,
      );
      expect(
        (s.stretch?.endMs ?? Number.NaN) - start,
        said,
      ).toBeLessThanOrEqual(lastArrived + 2 * s.frameMs);
    }
  });

  // Spec test 4, Review Focus 5: the report says where the waiting was,
  // and it covers the answer, from the click that asked for it.
  it("network time is reported where it happened", async () => {
    const film = normal.report.video as Extract<FilmReport, { steps: unknown }>;
    const s = await streamed(normal);
    const said = JSON.stringify({ ...s, film });
    // The source clock is the video's, so a step's output time places the
    // source frames on it.
    const click = film.steps[0]?.outputMs ?? Number.NaN;
    const toOutput = click - (normal.bundle.markers[0]?.sourceTimeMs ?? 0);
    const answer = film.network?.filter((n) =>
      n.label.includes("POST /answer"),
    );
    expect(answer, said).toHaveLength(1);
    const [stretch] = answer ?? [];
    expect(film.pacing, said).toBe("held");
    expect(stretch?.startMs, said).toBeGreaterThanOrEqual(click);
    expect(stretch?.startMs, said).toBeLessThanOrEqual(s.first + toOutput);
    // To the last chunk's frame, or the held frame before it: the page can
    // run the last chunk's script in the grant after the wait ends (CI
    // ubuntu run 4: the stretch to 3866.7, the last chunk at 3900).
    expect(stretch?.endMs, said).toBeGreaterThanOrEqual(
      s.last + toOutput - HELD_FRAME_MS - 1e-6,
    );
    expect(film.networkMs, said).toBeGreaterThanOrEqual(
      (CHUNKS - 1) * CHUNK_GAP_MS,
    );
    expect(film.connectionsIgnored, said).toEqual([]);
  });

  // The author's ruling, 2026-11-16 (DEM-202): the video follows the server
  // only while the script waits on the page. A request that never answers
  // is waited on by its step's settle, to the settle's cap, and said; the
  // pause after it is designed time. (Before, the pause followed the open
  // connection until the 10 s idle cut-off, which now bounds only a wait.)
  // Red if a pause follows an open connection, or the settle does not.
  it("a request that never answers costs its step's settle the cap, and no pause", async () => {
    const r = await record(home, `${url}/idle`, [
      { do: "click", on: { stableId: "ask" }, zoom: false },
      { do: "pause", ms: 3000 },
    ]);
    const poll = (r.bundle.networkSpans ?? []).filter((n) =>
      n.label.includes("GET /poll"),
    );
    const frames = await pageFrames(r, [0, 0, 1, 1]);
    const said = JSON.stringify({
      network: r.bundle.networkSpans,
      degradations: r.bundle.degradations,
      realMs: r.realMs,
    });
    // The settle waited on the poll, for about its request cap, and said so.
    expect(poll, said).toHaveLength(1);
    const end = poll[0]?.endMs ?? Number.NaN;
    const waited = end - (poll[0]?.startMs ?? 0);
    expect(waited, said).toBeGreaterThanOrEqual(STEP_REQUEST_CAP_MS - 1000);
    expect(waited, said).toBeLessThanOrEqual(STEP_REQUEST_CAP_MS + 3000);
    expect(
      r.bundle.degradations
        .filter((d) => d.kind === "stepUnsettled")
        .map((d) => d.note)
        .join(" "),
      said,
    ).toMatch(/request\(s\) in flight/);
    // After it the clock is held, with the poll still open: no network
    // time, and every frame on the held grid, one frame apart.
    expect(
      (r.bundle.networkSpans ?? []).filter((n) => n.endMs > end),
      said,
    ).toEqual([]);
    const after = frames.filter((f) => f.ms > end + 1).map((f) => f.ms);
    expect(after.length, said).toBeGreaterThanOrEqual(60);
    const offGrid = after.filter((ms, i) => {
      const k = ms / HELD_FRAME_MS;
      const step = i === 0 ? HELD_FRAME_MS : ms - (after[i - 1] ?? 0);
      return (
        Math.abs(k - Math.round(k)) > 0.05 || Math.abs(step - HELD_FRAME_MS) > 1
      );
    });
    expect(offGrid, said).toEqual([]);
  }, 250_000);

  // DEM-202: a feed open from the page's load kept every pause on the
  // server's time (a 5 s video ran 76 s, compare/held-push.sh). Red if the
  // pause follows the feed, or what arrived in it goes unsaid, or is said
  // more than once.
  it("a feed still sending during a pause is designed time, and said once", async () => {
    const PAUSE = 2000;
    const r = await record(home, `${url}/fed`, [
      { do: "click", on: { stableId: "ask" }, zoom: false },
      { do: "pause", ms: PAUSE },
    ]);
    const spans = r.bundle.networkSpans ?? [];
    const said = JSON.stringify({
      network: spans,
      degradations: r.bundle.degradations,
      markers: r.bundle.markers.map((m) => m.actEndSourceTimeMs),
    });
    expect(
      r.bundle.degradations
        .filter((d) => d.kind === "answerUnpaced")
        .map((d) => d.note),
      said,
    ).toEqual([
      "an answer was still arriving during a pause, a rest or a step's settle that did not wait for it, which is not paced by the server",
    ]);
    // The feed never ends, so a pause that followed it would be all network
    // time: here the take's last PAUSE of page time has none in it.
    const endMs = Math.max(...r.bundle.keyframes.map((k) => k.sourceTimeMs));
    const inPause = spans.filter((n) => n.endMs > endMs - PAUSE + 500);
    expect(inPause, said).toEqual([]);
  }, 120_000);

  // The anti-goal of the same change: a wait left out, so page time outruns
  // the server. The opening's load is the first wait there is. Red if the
  // document's wait is not in the video as the server's time.
  // DEM-186: the take's time starts at its opening still, so the opening's
  // load is not in it: timed from before the load, the video opened on its
  // first frame for as long as the server took. Red if the take is timed
  // from the walk's start: its first frame and the load's span 700 ms in.
  it("starts the take after the opening's load behind a slow server", async () => {
    const asked = lateAsked;
    const r = await record(home, `${url}/late`, [
      { do: "click", on: { stableId: "ask" }, zoom: false },
    ]);
    const spans = r.bundle.networkSpans ?? [];
    const first = r.bundle.keyframes[0]?.sourceTimeMs ?? Number.NaN;
    const opening = r.bundle.openingMs ?? Number.NaN;
    const said = JSON.stringify({ spans, first, opening });
    // Premise: the take loaded the document the server held back, and the
    // opening played that wait as the server's time.
    expect(lateAsked - asked, said).toBe(1);
    expect(opening, said).toBeGreaterThanOrEqual(LATE_MS - 200);
    expect(first, said).toBeLessThanOrEqual(HELD_FRAME_MS + 1e-6);
    expect(
      spans.filter((n) => n.label.includes("GET /late")),
      said,
    ).toEqual([]);
  }, 120_000);

  // DEM-203: an iframe's document was counted as the page loading, so a
  // step that added a slow widget held its settle on the widget's server.
  // Red if the step's screen waits on the frame, or the run says it did.
  it("a slow iframe does not hold a step's settle", async () => {
    const r = await record(home, `${url}/framed`, [
      { do: "click", on: { stableId: "ask" }, zoom: false },
    ]);
    const spans = r.bundle.networkSpans ?? [];
    const unsettled = r.bundle.degradations
      .filter((d) => d.kind === "stepUnsettled")
      .map((d) => d.note);
    const click = r.bundle.markers[0]?.sourceTimeMs ?? Number.NaN;
    const screen = r.bundle.pageScreens?.at(-1)?.sourceTimeMs ?? Number.NaN;
    const said = JSON.stringify({ spans, unsettled, click, screen });
    expect(unsettled, said).toEqual([]);
    expect(
      spans.filter((n) => n.label.includes("/slowframe")),
      said,
    ).toEqual([]);
    // The step's screen is taken long before the frame answers.
    expect(screen - click, said).toBeLessThan(FRAME_MS / 2);
  }, 120_000);

  // DEM-207: a video that stops while playing (its data stalled, or the
  // recorder froze it) showed as a still picture, unsaid. Red if it is
  // unsaid, or said without why (its data, on CI's machines). Red if it is
  // unsaid or the note leaves out the video's state.
  it("says a video that stopped on one frame", async () => {
    const r = await record(home, `${url}/stalled`, [
      { do: "click", on: { stableId: "ask" }, zoom: false },
      { do: "pause", ms: 2000 },
    ]);
    const said = r.bundle.degradations
      .filter((d) => d.kind === "animationUnpinned")
      .map((d) => d.note);
    expect(
      said.filter((n) =>
        /^a video stopped on one frame while playing \(at \d+\.\d\d s of \S+, readyState \d, buffered to \d+\.\d\d s, networkState \d\)$/.test(
          n,
        ),
      ),
      JSON.stringify(r.bundle.degradations),
    ).toHaveLength(1);
  }, 120_000);

  // DEM-207: on a clock ahead of real time, an autoplaying video never had
  // the data to start, and stood on its first frame, unsaid. Red if the
  // clock does not pace it (held-clock.ts `grant`): the video region then
  // never moves.
  it("plays a video whose download runs at its own pace", async () => {
    const r = await record(home, `${url}/autoplay`, [
      { do: "click", on: { stableId: "ask" }, zoom: false },
      { do: "pause", ms: 3000 },
    ]);
    const notes = r.bundle.degradations.map((d) => d.note);
    // The video's box (40, 120, 320 x 180) in the 1280 x 800 frame, inset.
    const frames = await pageFrames(r, [
      50 / 1280,
      130 / 800,
      350 / 1280,
      290 / 800,
    ]);
    const moved = frames.filter(
      (f, i) => i > 0 && greyDiff(f.grey, frames[i - 1]?.grey ?? "") > NOISE,
    ).length;
    const mean = (grey: string) => {
      const b = Buffer.from(grey, "base64");
      return Math.round(b.reduce((s, x) => s + x, 0) / (b.length || 1));
    };
    // Real seconds the walk took per second of the take: how far the
    // machine fell behind the frames it captured.
    const walkS = Number(
      /timing run [^:]*:.*?\bwalk ([\d.]+)s/.exec(r.lines.join("\n"))?.[1],
    );
    const takeS =
      Math.max(...r.bundle.keyframes.map((k) => k.sourceTimeMs)) / 1000;
    const said = JSON.stringify({
      notes,
      moved,
      realPerTake: walkS / takeS,
      walkS,
      takeS,
      greys: frames.map((f) => [Math.round(f.ms), mean(f.grey)]),
    });
    // Premise: the run said how long its walk took, and the take has length.
    expect(walkS, said).toBeGreaterThan(0);
    expect(takeS, said).toBeGreaterThan(3);
    // It started: the pin saw it playing, and never said it waited.
    expect(notes, said).toContain(
      "a playing video runs on its own clock: it was not held",
    );
    expect(
      notes.filter((n) => n.includes("waited")),
      said,
    ).toEqual([]);
    // And it plays in the picture: a second or more of the page's frames
    // in motion, and the ramp, which changes on every one of its own
    // frames, moving on most of them. Its frames and the recording's are
    // not in step on a paced clock, so some repeat: 35 of 46 here
    // (2026-11-19). Frozen, it stood on its first frame (held-probe-video.mjs).
    if (frames.length >= 30 && moved > frames.length / 2) return;
    // Unless the report says why its picture stood still, with the video's
    // state. DEM-259: the picture is Chrome's real-time playback, which
    // starts about 1.3 s ahead of currentTime and gains on every frame the
    // machine falls behind, until it stands on the clip's last frame (CI's
    // ubuntu at 2.35 and 2.54 real s per take s, 5 and 3 frames; its macOS
    // at 1.82 and 1.92, 2026-11-22). The pin says it only while the picture
    // is ahead of currentTime, on the clip's last frame: a clock that
    // stopped pacing the video (the regression this test is for) leaves it
    // behind, and is not excused, nor is a machine that kept up.
    if (
      walkS / takeS > BEHIND_REAL_PER_TAKE &&
      notes.some((n) => PICTURE_AHEAD.test(n))
    )
      return;
    // DEM-244: on a machine far behind its frames, Chrome may never start
    // the clip, fully buffered, at readyState 1 or 2 (CI after #105, and the
    // Mac on its efficiency cores beside CPU burners: 4.3 to 7.5 real s per
    // take s, 2026-11-20). Not fixed yet, so there it must be said. A
    // machine that keeps up walks 1.01 to 1.02 (paced to real time); one
    // whose clock runs ahead of real time, under 1: the threshold sits well
    // clear of both.
    expect(walkS / takeS, said).toBeGreaterThanOrEqual(STARVED_REAL_PER_TAKE);
    expect(
      notes.filter((n) =>
        /^a video stopped on one frame while playing \(at 0\.\d\d s of [\d.]+, readyState [012], buffered to [\d.]+ s, networkState \d\)$/.test(
          n,
        ),
      ),
      said,
    ).not.toEqual([]);
  }, 120_000);

  // DEM-259: a playing video's picture is Chrome's real-time playback. On a
  // machine behind its frames it runs ahead of the take to the clip's last
  // frame, and stands there while currentTime, on the page's clock, plays
  // on; the loop restarts only when currentTime reaches the end. That read
  // as a still, unsaid. Red if the pin does not count the frames Chrome
  // presents (held-clock.ts PIN_ANIMATIONS).
  it("says a video whose picture ran ahead and stopped", async () => {
    // A retry starts unslowed and unseen.
    underwayAt = null;
    underwayRefused = null;
    // Unslowed until the video is under way (`/underway`).
    const r = await record(
      home,
      `${url}/ahead`,
      [
        { do: "click", on: { stableId: "ask" }, zoom: false },
        { do: "pause", ms: 3000 },
      ],
      {},
      0,
    );
    const notes = r.bundle.degradations.map((d) => d.note);
    const frames = await pageFrames(r, [
      50 / 1280,
      130 / 800,
      350 / 1280,
      290 / 800,
    ]);
    const takeMs = Math.max(...r.bundle.keyframes.map((k) => k.sourceTimeMs));
    const lastMoving = Math.max(
      0,
      ...frames.flatMap((f, i) =>
        i > 0 && greyDiff(f.grey, frames[i - 1]?.grey ?? "") > NOISE
          ? [f.ms]
          : [],
      ),
    );
    // Real seconds the walk took per second of the take, as "own pace".
    const realPerTake =
      Number(
        /timing run [^:]*:.*?\bwalk ([\d.]+)s/.exec(r.lines.join("\n"))?.[1],
      ) /
      (takeMs / 1000);
    // When the pin first saw it playing.
    const playing =
      r.bundle.degradations.find(
        (d) =>
          d.note === "a playing video runs on its own clock: it was not held",
      )?.startMs ?? Number.NaN;
    // Chrome left the clip on 0.00 while it played, fully buffered short
    // of playing (DEM-244's state; a clip at readyState 3 or 4 that stands
    // still is the clock's fault, not a starved machine's).
    const startStalls = r.bundle.degradations.filter((d) =>
      /^a video stopped on one frame while playing \(at 0\.00 s of [\d.]+, readyState [012], buffered to [\d.]+ s, networkState \d\)$/.test(
        d.note,
      ),
    );
    const startStall = startStalls[0];
    const said = JSON.stringify({
      said: r.bundle.degradations.map((d) => [d.startMs, d.note]),
      realPerTake,
      underwayAt,
      underwayRefused,
      takeMs,
      playing,
      lastMoving,
      spans: r.bundle.motionSpans.map((m) => [m.startMs, m.endMs]),
    });
    // DEM-244: on a machine far behind its frames, Chrome may never get the
    // clip off 0.00, before any slowing (the Mac at utility QoS beside ten
    // CPU burners, 3 of 3, 2026-11-23). Then this case cannot be recorded
    // there, and the report must say why, as in "own pace".
    if (underwayAt === null) {
      expect(realPerTake, said).toBeGreaterThanOrEqual(STARVED_REAL_PER_TAKE);
      expect(startStalls, said).toHaveLength(1);
      return;
    }
    expect(notes, said).toContain(
      "a playing video runs on its own clock: it was not held",
    );
    // DEM-263: CI's ubuntu starves it a step later. Chrome stood the clip on
    // 0.00 for half a second at its start, said, then got it under way, and
    // the last-frame note never came (red on main 3 times; the Mac beside
    // six CPU burners 7 of 10, and unloaded 0 of 10, 2026-11-23). That
    // machine cannot supply this case's premise either, and the report said
    // why, as above. Only on a machine far behind its frames.
    if (startStall !== undefined && !notes.some((n) => PICTURE_AHEAD.test(n))) {
      expect(realPerTake, said).toBeGreaterThanOrEqual(STARVED_REAL_PER_TAKE);
      expect(startStalls, said).toHaveLength(1);
      // The stall came before the clip played the half second `/underway`
      // waits for: it played less than its length after the pin first saw
      // it, so its currentTime, on the take's clock (1.33 s at 1.3 s in,
      // 2026-11-23), never looped back to 0.00.
      const clipMs =
        Number(/ of ([\d.]+), readyState/.exec(startStall.note)?.[1]) * 1000;
      expect(takeMs - playing, said).toBeLessThan(clipMs);
      return;
    }
    // Premise: it played, half a second of its currentTime and not only
    // its picture (a clip stuck at 0.00 flickers, which reads as motion:
    // CI, 2026-11-23), the machine slowed there, and its picture moved and
    // then stood still for the last half second or more of the take.
    expect(lastMoving, said).toBeGreaterThan(0);
    expect(takeMs - lastMoving, said).toBeGreaterThan(500);
    // Said, once, with where its picture stood and where its clock was.
    expect(
      notes.filter((n) => PICTURE_AHEAD.test(n)),
      said,
    ).toHaveLength(1);
  }, 120_000);
});
