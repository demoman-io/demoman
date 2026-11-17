// Slow tier: records held videos of pages that wait on their server.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELD_FRAME_MS, STEP_REQUEST_CAP_MS } from "@demoman/replay-engine";
import type { FilmReport } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listenOnLoopback } from "../src/loopback.js";
import { pageFrames, type Recorded, record } from "./held-record.js";

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
const LATE = `<!doctype html><meta charset=utf-8><link rel=icon href="data:,">
<button id=ask style="position:absolute;left:40px;top:40px;width:160px;height:40px">Ask</button>`;

let home: string;
let server: Server;
let url: string;
const open: ServerResponse[] = [];
const was = process.env.DEMOMAN_HELD_CLOCK;

beforeAll(async () => {
  process.env.DEMOMAN_HELD_CLOCK = "1";
  home = await mkdtemp(join(tmpdir(), "demoman-held-network-"));
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/answer") {
      // One byte a chunk, the first at once, the last 1800 ms later.
      res.writeHead(200, { "content-type": "text/plain" });
      let sent = 0;
      const send = () => {
        res.write("x");
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
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(LATE);
      }, LATE_MS);
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

  beforeAll(async () => {
    normal = await record(home, `${url}/`, ASK, {}, undefined, FAR_PIN);
    slowed = await record(home, `${url}/`, ASK, {}, 40, FAR_PIN);
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
      [normal, slowed].map(async (r) => ({
        ...(await streamed(r)),
        stretch: (r.bundle.networkSpans ?? []).find((n) =>
          n.label.includes("POST /answer"),
        ),
        realMs: r.realMs,
        network: r.bundle.networkSpans,
      })),
    );
    const said = JSON.stringify(both);
    expect(slowed.realMs, said).toBeGreaterThan(normal.realMs + 10_000);
    for (const s of both) {
      // Premise: the answer grew in the frames, from none to all ten, over
      // at least six states seen, and at least 1200 ms of it is measured.
      expect(s.rising, said).toBe(true);
      expect(s.states[0], said).toBe(0);
      expect(s.states.at(-1), said).toBe(CHUNKS);
      expect(s.states.length, said).toBeGreaterThanOrEqual(6);
      expect(
        Math.abs(s.last - s.first - (CHUNKS - 1) * CHUNK_GAP_MS),
        said,
      ).toBeLessThanOrEqual(s.frameMs);
      // And from where the wait began: the server answers at once, so its
      // last chunk is 1800 ms on, within a frame, or the held frame after:
      // the page can run the last chunk's script in the grant after the
      // wait ends (44 ms here, 2 runs of about 12, 2026-11-16; the next
      // test allows the same). The stretch lasts no longer than the stream
      // and a frame either side.
      const start = s.stretch?.startMs ?? Number.NaN;
      expect(
        Math.abs(s.last - start - (CHUNKS - 1) * CHUNK_GAP_MS),
        said,
      ).toBeLessThanOrEqual(s.frameMs + HELD_FRAME_MS);
      expect(
        (s.stretch?.endMs ?? Number.NaN) - start,
        said,
      ).toBeLessThanOrEqual((CHUNKS - 1) * CHUNK_GAP_MS + 2 * s.frameMs);
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
  it("the opening's load behind a slow server is the server's time", async () => {
    const r = await record(home, `${url}/late`, [
      { do: "click", on: { stableId: "ask" }, zoom: false },
    ]);
    const spans = r.bundle.networkSpans ?? [];
    const late = spans.find((n) => n.label.includes("GET /late"));
    expect(
      (late?.endMs ?? 0) - (late?.startMs ?? 0),
      JSON.stringify(spans),
    ).toBeGreaterThanOrEqual(LATE_MS - 200);
  }, 120_000);
});
