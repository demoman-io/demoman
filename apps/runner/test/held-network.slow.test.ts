// Slow tier: records held videos of pages that wait on their server.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELD_FRAME_MS, IDLE_CONNECTION_MS } from "@demoman/replay-engine";
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
    if (path === "/poll") {
      // A long poll that never answers, not even its headers.
      open.push(res);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(path === "/idle" ? IDLE : STREAM);
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

/** One recording of the stream takes about 9 s here, 40 s slowed; CI's
 *  macOS took 32-44 s each (2026-11-15). Both, with room: */
const STREAMS_MS = 300_000;

describe("a held recording that waits on its server", () => {
  let normal: Recorded;
  let slowed: Recorded;

  beforeAll(async () => {
    normal = await record(home, `${url}/`, ASK);
    slowed = await record(home, `${url}/`, ASK, {}, 40);
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
    expect(stretch?.endMs, said).toBeGreaterThanOrEqual(s.last + toOutput);
    expect(film.networkMs, said).toBeGreaterThanOrEqual(
      (CHUNKS - 1) * CHUNK_GAP_MS,
    );
    expect(film.connectionsIgnored, said).toEqual([]);
  });

  // Spec test 6. Red without the idle cut-off (network-watch.ts): the poll
  // keeps the clock on real time to the end, and nothing is named. 50 s
  // here; 120 s was not enough on CI's macOS (2026-11-15): 5x, the lane's
  // rule (vitest.config.ts).
  it("an idle connection stops counting and is named", async () => {
    const r = await record(home, `${url}/idle`, [
      { do: "click", on: { stableId: "ask" }, zoom: false },
      { do: "pause", ms: IDLE_CONNECTION_MS + 3000 },
    ]);
    const film = r.report.video as Extract<FilmReport, { steps: unknown }>;
    const poll = (r.bundle.networkSpans ?? []).filter((n) =>
      n.label.includes("GET /poll"),
    );
    const frames = await pageFrames(r, [0, 0, 1, 1]);
    const said = JSON.stringify({
      network: r.bundle.networkSpans,
      ignored: film.connectionsIgnored,
      realMs: r.realMs,
    });
    expect(film.connectionsIgnored, said).toEqual(["GET /poll"]);
    // The poll was waited on, for about the idle cut-off, then let go.
    expect(poll, said).toHaveLength(1);
    const end = poll[0]?.endMs ?? Number.NaN;
    expect(end - (poll[0]?.startMs ?? 0), said).toBeGreaterThanOrEqual(
      IDLE_CONNECTION_MS - 1000,
    );
    // After it, the clock is held again: no network time, and every frame
    // on the held grid, one frame apart, for the rest of the pause.
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
});
