// Records a take through a real browser whose pointer moves are answered
// unevenly, renders it, and finds the drawn cursor in the decoded frames.
// About 14 s here. ubuntu-latest took 91 s before held became the default (CI,
// 2026-11-17) and ran past 120 s beside held files: 300 s.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FrameBundle,
  planScene,
  resolvePlan,
  toOutputMs,
} from "@demoman/compositor";
import type { BrandKitsRead } from "@demoman/run-core";
import { frameOf, targetFor } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserSession } from "../src/executor/browser.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import { runScript } from "../src/executor/run.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { launch } from "../src/launch.js";
import { listenOnLoopback } from "../src/loopback.js";
import { installResolver } from "../src/page-agent.js";
import { renderToFiles } from "../src/render.js";
import { mp4FrameTimes, readMp4Crops } from "./mp4-probe.js";

// Nylon's create-invoice on ubuntu-latest, 2026-11-15: Chrome answered one
// `mouseMoved` in ~480 ms and the next in 3, the walk drew a sample per
// answer, and the cursor jumped 437 px in one frame of the video. Here every
// other move is held 400 ms and the rest 5 ms, the same uneven shape; an
// even lag draws a late but smooth line and would not show it.

// Two untexted light buttons far apart on a white page, and no zoom: the
// only dark thing in a frame is the cursor.
const PAGE = `<!doctype html><meta charset=utf-8><title>pointer lag</title>
<style>
body{margin:0;background:#fff}
button{position:absolute;width:120px;height:40px;background:#e8e8e8;border:0;outline:none}
#a{left:60px;top:60px}
#b{left:1100px;top:680px}
</style>
<button id="a" aria-label="Alpha"></button>
<button id="b" aria-label="Bravo"></button>`;

const kits: BrandKitsRead = {
  state: "ready",
  kits: [],
  defaultId: null,
};
/** The crop the frames are read at: the whole frame, scaled down. */
const READ = { width: 640, height: 360 };
/** The page is white and light grey (232); a frame whose darkest pixel is
 *  lighter than this shows no cursor. */
const DARKEST_MAX = 160;
/** How far above the darkest pixel a cursor's pixels may read. */
const NEAR_DARKEST = 40;

let url: string;
let server: ReturnType<typeof createServer>;
let home: string;

/** Real time (`DEMOMAN_HELD_CLOCK=0`): a held clock keeps the machine's lag
 *  out of page time, which is this file's premise; held, each 400 ms answer
 *  is paid per frame, and ubuntu-latest ran past 240 s. */
const heldWas = process.env.DEMOMAN_HELD_CLOCK;

beforeAll(async () => {
  process.env.DEMOMAN_HELD_CLOCK = "0";
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  url = `${await listenOnLoopback(server)}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-pointer-lag-"));
}, 30_000);
afterAll(async () => {
  server.close();
  if (heldWas === undefined) delete process.env.DEMOMAN_HELD_CLOCK;
  else process.env.DEMOMAN_HELD_CLOCK = heldWas;
  await rm(home, { recursive: true, force: true });
});

/** Holds `mouseMoved` answers 400 ms and 5 ms in turn, on every session of
 *  this context's process (`lag.ts` says why the prototype). */
async function unevenMoves(context: BrowserContext): Promise<() => number> {
  const proto = Object.getPrototypeOf(
    await context.newCDPSession(
      context.pages()[0] ?? (await context.newPage()),
    ),
  ) as { send: (...args: unknown[]) => Promise<unknown> };
  const send = proto.send;
  let moves = 0;
  proto.send = async function (this: unknown, ...args: unknown[]) {
    const [method, params] = args as [string, { type?: string } | undefined];
    const reply = await send.apply(this, args);
    if (
      method === "Input.dispatchMouseEvent" &&
      params?.type === "mouseMoved"
    ) {
      moves++;
      await new Promise((r) => setTimeout(r, moves % 2 === 1 ? 400 : 5));
    }
    return reply;
  };
  return () => moves;
}

describe("a take whose pointer moves the page answers unevenly", () => {
  it("draws the cursor's journey without a jump in the video", async () => {
    const lines: string[] = [];
    let moves = () => 0;
    const session = createBrowserSession({
      headless: true,
      log: (line) => void lines.push(line),
      // A display, so the take records at one scale on any machine, as
      // same-take.slow.test.ts pins it: headless with none reads no screen.
      readDisplay: async () => ({ width: 1440, height: 900, scale: 1 }),
      onLaunched: async ({ context }) => {
        await installResolver(context);
        await installExecutorEntry(context);
        moves = await unevenMoves(context);
      },
    });
    const library = createLibrary(home);
    let scene: SceneDocument;
    let bundle: FrameBundle;
    let store: ReturnType<typeof library.frameStore>;
    try {
      const report = await runScript(
        {
          scriptVersion: 8,
          name: "pointer lag",
          target: url,
          viewport: { width: 1280, height: 800 },
          steps: [
            { do: "click", on: { stableId: "a" }, zoom: false },
            { do: "click", on: { stableId: "b" }, zoom: false },
          ],
        } as never,
        {
          session,
          library,
          kits,
          log: (line) => void lines.push(line),
          sessions: [],
          sessionStore: createSessionStore(home),
          signinCommand: "npx demoman signin",
          recordingFrameRate: { value: 30, from: "default" } as const,
          loadSessions: async () => ({ ok: true as const, files: [] }),
          sessionsContext: {} as BrowserContext,
        },
        () => undefined,
      );
      const failure = JSON.stringify({ report, lines: lines.slice(-20) });
      expect(report.outcome, failure).toBe("complete");
      const takeId = report.provenance.takeId as string;
      scene = (await library.getScene(takeId)) as SceneDocument;
      store = library.frameStore(takeId);
      bundle = (await store.getBundle(takeId)) as FrameBundle;
    } finally {
      await session.close();
    }
    // The premise: the moves really were held unevenly, and the journey
    // between the buttons is in the take.
    expect(moves()).toBeGreaterThanOrEqual(4);
    const timeline = resolvePlan(planScene(scene), bundle, scene).timeline;
    const [first, second] = scene.actions.map(
      (a) => bundle.markers.find((m) => m.actionId === a.id)?.sourceTimeMs,
    );
    expect(first, JSON.stringify(bundle.markers)).toBeDefined();
    expect(second, JSON.stringify(bundle.markers)).toBeDefined();

    const launched = await launch();
    let bytes: Uint8Array;
    try {
      const rendered = await renderToFiles({
        wallpaper: null,
        scene: { ...scene, cursor: { ...scene.cursor, hideWhenIdle: false } },
        bundle,
        store,
        page: launched.page,
        target: targetFor("mp4", scene.canvas.aspect, bundle, frameOf(scene)),
        fileType: "mp4",
        logo: null,
      });
      const file = rendered.files[0];
      if (file === undefined) throw new Error("the render produced no file");
      bytes = file.bytes;
    } finally {
      await launched.close();
    }

    // Every frame from the first click to the second, the cursor found as
    // the dark pixels' centre.
    const { timesSec } = await mp4FrameTimes(bytes);
    const fromSec = toOutputMs(timeline, first as number) / 1000;
    const toSecAt = toOutputMs(timeline, second as number) / 1000;
    const times = timesSec.filter((t) => t >= fromSec && t <= toSecAt);
    const crops = await readMp4Crops(bytes, times, [0, 0, 1, 1], READ, true);
    // The cursor is what is near the frame's darkest pixel, when that pixel
    // is dark: no fixed level, since how dark a shrunk cursor reads depends
    // on its size in the film (ubuntu-latest found nothing under 40 on
    // 2026-11-15 where the Mac found 6-19 px).
    const found = crops.map((c) => {
      const grey = Buffer.from(c.grey ?? "", "base64");
      const darkest = grey.reduce((m, g) => Math.min(m, g), 255);
      const below = darkest < DARKEST_MAX ? darkest + NEAR_DARKEST : -1;
      let n = 0;
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < grey.length; i++) {
        if ((grey[i] as number) < below) {
          n++;
          sx += i % READ.width;
          sy += Math.floor(i / READ.width);
        }
      }
      return {
        sec: c.frameSec,
        darkest,
        n,
        x: n ? sx / n : Number.NaN,
        y: n ? sy / n : Number.NaN,
      };
    });
    const steps = found
      .slice(1)
      .map((f, i) =>
        Math.round(
          Math.hypot(
            f.x - (found[i] as { x: number }).x,
            f.y - (found[i] as { y: number }).y,
          ),
        ),
      );
    const evidence = `${moves()} moves; ${found.length} frames; darkest ${found.map((f) => f.darkest).join(",")}; dark px ${found.map((f) => f.n).join(",")}; steps ${steps.join(",")}`;
    // The premise: the cursor is found in every frame (a dark pixel, and no
    // more than a cursor's worth near it), and it travelled most of the
    // frame between the buttons over many frames. How many pixels a shrunk
    // cursor leaves varies by machine: 6-19 on the Mac, 3-26 on
    // ubuntu-latest (2026-11-15).
    expect(found.length, evidence).toBeGreaterThanOrEqual(15);
    for (const f of found) {
      expect(f.darkest, evidence).toBeLessThan(DARKEST_MAX);
      expect(f.n, evidence).toBeGreaterThan(0);
      expect(f.n, evidence).toBeLessThan(400);
    }
    const a = found[0] as { x: number; y: number };
    const b = found.at(-1) as { x: number; y: number };
    expect(Math.hypot(b.x - a.x, b.y - a.y), evidence).toBeGreaterThan(200);
    // No frame jumps. Measured 2026-11-15 on this machine at this crop: the
    // eased journey drawn on its grid peaks at 17 px a frame; one sample per
    // answered move (the walk before) drew single frames of 85 and 261 px.
    expect(Math.max(...steps), evidence).toBeLessThanOrEqual(40);
  }, 300_000);
});
