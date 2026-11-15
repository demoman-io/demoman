// Slow tier: records held videos through a real browser and renders two.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameBundle } from "@demoman/compositor";
import { HELD_FRAME_MS } from "@demoman/replay-engine";
import {
  type BrandKitsRead,
  frameOf,
  type RunReport,
  targetFor,
} from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBrowserSession,
  fullChromiumPath,
} from "../src/executor/browser.js";
import { shouldHold } from "../src/executor/held.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import { runScript } from "../src/executor/run.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { launch } from "../src/launch.js";
import { listenOnLoopback } from "../src/loopback.js";
import { installResolver } from "../src/page-agent.js";
import { renderToFiles } from "../src/render.js";
import { mp4FrameTimes, readMp4Crops } from "./mp4-probe.js";

/**
 * Held-clock capture in a real browser (Task 6): the page's own time is
 * held and moved on one video frame at a time, so one script records the
 * same video twice. Full Chromium, as production records (`fullChromiumPath`):
 * the headless shell has no site isolation, so it would hide the
 * cross-site cases below.
 */

const PIN = "2026-11-15T09:00:00Z";
const VIEWPORT = { width: 1280, height: 800 };

/** A click-opened transition, a timer, a field to type in, an endless
 *  spinner, an animation driven by requestAnimationFrame (a box and a
 *  canvas), and a button below the fold the walk scrolls to. The right-hand
 *  column is striped down the whole page, so every scroll position paints it
 *  differently. Positions and sizes are explicit: no glyph width moves a
 *  rect. The timer and the box change the DOM every frame, inside a shadow
 *  root, where the walk's settle (a MutationObserver on the document) does
 *  not see them: otherwise every step would wait out its settle cap, said
 *  as never quiet, and this fixture's video would be mostly those caps. */
const PAGE = `<!doctype html><meta charset=utf-8><title>held</title>
<style>
body{margin:0;height:3200px;font:16px monospace;background:#fff}
#stripes{position:absolute;right:0;top:0;width:80px;height:3200px;background:repeating-linear-gradient(#000 0 20px,#fff 20px 37px)}
button,input{position:absolute;width:160px;height:40px;font:16px monospace;background:#eee;border:1px solid #888;outline:none}
#open{left:40px;top:40px}
#name{left:240px;top:40px}
#far{left:40px;top:2600px}
#spin{position:absolute;left:40px;top:120px;width:60px;height:60px;background:linear-gradient(90deg,#c00,#00c);animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#canvas{position:absolute;left:300px;top:180px}
#dialog{position:absolute;left:400px;top:300px;width:400px;height:200px;background:#225;opacity:0;transform:translateY(60px);transition:opacity .3s,transform .3s}
#dialog.open{opacity:1;transform:none}
</style>
<div id=stripes></div>
<button id=open>Open</button>
<input id=name aria-label=Name>
<div id=spin></div><div id=host></div>
<canvas id=canvas width=400 height=60></canvas>
<div id=dialog></div>
<button id=far>Far</button>
<script>
const shadow = document.getElementById("host").attachShadow({ mode: "open" });
shadow.innerHTML = '<div id=timer style="position:absolute;left:140px;top:120px;width:120px;height:40px">0</div><div id=box style="position:absolute;left:300px;top:120px;width:40px;height:40px;background:#080"></div>';
const timer = shadow.getElementById("timer");
const box = shadow.getElementById("box");
let ticks = 0;
setInterval(() => { timer.textContent = String(++ticks); }, 100);
document.getElementById("open").addEventListener("click", () => document.getElementById("dialog").classList.add("open"));
const ctx = document.getElementById("canvas").getContext("2d");
// Moved by the frames counted since the first, not by the timestamp's
// value: Chrome reads performance.now() to 100 µs with a jitter of its own
// each run, so a held time can read 0.1 ms either side (measured
// 2026-11-15, compare/held-probe-timestamps.mjs) and a position rounded
// from it moves a pixel on some frames and not others.
let first = null;
function frame(t) {
  if (first === null) first = t;
  const n = Math.round((t - first) / (1000 / 30));
  box.style.left = 300 + ((n * 6) % 300) + "px";
  ctx.clearRect(0, 0, 400, 60);
  ctx.fillStyle = "#808";
  ctx.fillRect((n * 9) % 360, 10, 40, 40);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script>`;

const SCRIPT_STEPS = [
  { do: "click", on: { stableId: "open" }, zoom: false },
  { do: "type", into: { stableId: "name" }, text: "held" },
  { do: "click", on: { stableId: "far" }, zoom: false },
];

const kits: BrandKitsRead = {
  state: "ready",
  kits: [],
  defaultId: null,
  migrationPending: false,
};

let home: string;
let a: Server;
let b: Server;
let aUrl: string;
let bUrl: string;
/** What the other site's page printed, by label, as epoch milliseconds. */
const printed: { label: string; t: number }[] = [];
const was = process.env.DEMOMAN_HELD_CLOCK;

beforeAll(async () => {
  process.env.DEMOMAN_HELD_CLOCK = "1";
  home = await mkdtemp(join(tmpdir(), "demoman-held-"));
  b = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/report") {
      printed.push({
        label: u.searchParams.get("label") ?? "",
        t: Number(u.searchParams.get("t")),
      });
      res.end();
      return;
    }
    const send = (body: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    };
    if (u.pathname === "/frame") {
      send(
        `<style>div{width:40px;height:40px;background:#c60;animation:s 1s linear infinite}@keyframes s{to{transform:translateX(100px)}}</style><div></div>`,
      );
      return;
    }
    // The other site's page, answered late so its document commits while
    // the clock follows the server's real time (R7).
    setTimeout(
      () =>
        send(
          `<p id=there>there</p><script>fetch("/report?label=there&t=" + Date.now())</script>`,
        ),
      200,
    );
  });
  bUrl = (await listenOnLoopback(b))
    .replace("127.0.0.1", "localhost")
    .replace(/\/$/, "");
  a = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    res.writeHead(200, { "content-type": "text/html" });
    if (path === "/go")
      res.end(
        `<!doctype html><a id=go href="${bUrl}/there" style="position:absolute;left:40px;top:40px;width:160px;height:40px;display:block;background:#eee">Go</a>`,
      );
    else if (path === "/framed")
      res.end(
        `<!doctype html><button id=ok style="position:absolute;left:40px;top:40px;width:160px;height:40px">Ok</button><iframe src="${bUrl}/frame" style="position:absolute;left:40px;top:120px;width:300px;height:100px"></iframe>`,
      );
    else res.end(PAGE);
  });
  aUrl = (await listenOnLoopback(a)).replace(/\/$/, "");
}, 30_000);

afterAll(async () => {
  if (was === undefined) delete process.env.DEMOMAN_HELD_CLOCK;
  else process.env.DEMOMAN_HELD_CLOCK = was;
  a.close();
  b.close();
  await rm(home, { recursive: true, force: true });
});

interface Recorded {
  report: RunReport;
  scene: SceneDocument;
  bundle: FrameBundle;
  store: ReturnType<ReturnType<typeof createLibrary>["frameStore"]>;
  /** Real milliseconds the run took. */
  realMs: number;
  lines: string[];
}

async function record(
  target: string,
  steps: unknown[],
  extra: Record<string, unknown> = {},
): Promise<Recorded> {
  const lines: string[] = [];
  const session = createBrowserSession({
    headless: true,
    executablePath: fullChromiumPath(),
    log: (line) => void lines.push(line),
    // A display, so the run records at the capture scale a real headless
    // run uses.
    readDisplay: async () => ({ width: 1440, height: 900, scale: 1 }),
    onLaunched: async ({ context }) => {
      await installResolver(context);
      await installExecutorEntry(context);
    },
  });
  try {
    const library = createLibrary(home);
    const t0 = Date.now();
    const report = await runScript(
      {
        scriptVersion: 8,
        name: "held",
        target,
        viewport: VIEWPORT,
        steps,
        ...extra,
      } as never,
      {
        session,
        library,
        kits,
        log: (line) => void lines.push(line),
        sessions: [],
        sessionStore: createSessionStore(home),
        signinCommand: "npx demoman signin",
        loadSessions: async () => ({ ok: true as const, files: [] }),
        sessionsContext: {} as BrowserContext,
        pinnedNow: PIN,
      },
      () => undefined,
    );
    const realMs = Date.now() - t0;
    const said = () => JSON.stringify({ report, lines: lines.slice(-20) });
    expect(report.outcome, said()).toBe("complete");
    const takeId = report.provenance.takeId as string;
    const scene = (await library.getScene(takeId)) as SceneDocument;
    const store = library.frameStore(takeId);
    const bundle = (await store.getBundle(takeId)) as FrameBundle;
    return { report, scene, bundle, store, realMs, lines };
  } finally {
    await session.close();
  }
}

async function render(r: Recorded): Promise<Uint8Array> {
  const launched = await launch({ executablePath: fullChromiumPath() });
  try {
    const rendered = await renderToFiles({
      wallpaper: null,
      scene: r.scene,
      bundle: r.bundle,
      store: r.store,
      page: launched.page,
      target: targetFor(
        "mp4",
        r.scene.canvas.aspect,
        r.bundle,
        frameOf(r.scene),
      ),
      fileType: "mp4",
      logo: null,
    });
    const file = rendered.files[0];
    if (file === undefined) throw new Error("the render produced no file");
    return file.bytes;
  } finally {
    await launched.close();
  }
}

/** Every frame of an mp4, each read whole as small grey levels. */
async function framesOf(bytes: Uint8Array): Promise<string[]> {
  const { timesSec } = await mp4FrameTimes(bytes);
  const crops = await readMp4Crops(
    bytes,
    timesSec,
    [0, 0, 1, 1],
    { width: 96, height: 60 },
    true,
  );
  return crops.map((c) => c.grey ?? "");
}

/** The page's own captured frames, a region of each as grey levels, from
 *  every motion span of the recording: no cursor, no camera. */
async function pageRegion(
  r: Recorded,
  rect: [number, number, number, number],
): Promise<string[]> {
  const out: string[] = [];
  for (const span of r.bundle.motionSpans) {
    const bytes = await r.store.load(span.ref);
    const { timesSec } = await mp4FrameTimes(bytes);
    const crops = await readMp4Crops(
      bytes,
      timesSec,
      rect,
      { width: 32, height: 32 },
      true,
    );
    out.push(...crops.map((c) => c.grey ?? ""));
  }
  return out;
}

/** Grey levels two frames' crops may differ by and be the same frame: the
 *  motion spans are encoded on the GPU, not bit-exact between runs (1-2
 *  grey levels apart measured, 2026-11-15, and 6 on one cell of a frame
 *  of the scroll, where every pixel moves). */
const NOISE = 8;
const greyDiff = (x: string, y: string): number => {
  const p = Buffer.from(x, "base64");
  const q = Buffer.from(y, "base64");
  let most = 0;
  for (let i = 0; i < Math.max(p.length, q.length); i++)
    most = Math.max(most, Math.abs((p[i] ?? 0) - (q[i] ?? 0)));
  return most;
};
/** Where two 96x60 crops differ past the noise: the cells' bounding box. */
const apartIn = (x: string, y: string): string => {
  const p = Buffer.from(x, "base64");
  const q = Buffer.from(y, "base64");
  const cells = [...p.keys()].filter(
    (i) => Math.abs((p[i] ?? 0) - (q[i] ?? 0)) > NOISE,
  );
  const xs = cells.map((i) => i % 96);
  const ys = cells.map((i) => Math.floor(i / 96));
  return `x ${Math.min(...xs)}-${Math.max(...xs)}, y ${Math.min(...ys)}-${Math.max(...ys)} of 96x60`;
};
const changes = (frames: string[]): number =>
  frames.filter((f, i) => i > 0 && f !== frames[i - 1]).length;
const hash = (s: string) => createHash("sha1").update(s).digest("hex");

describe("a held recording", () => {
  let first: Recorded;
  let second: Recorded;

  // Spec test 1. Red when anything the page times or animates itself
  // follows the machine's clock: the pin (held-clock.ts), the held animation
  // frames (R4) or the walk's own scroll (R5).
  it("records the same video twice", async () => {
    first = await record(`${aUrl}/`, SCRIPT_STEPS);
    second = await record(`${aUrl}/`, SCRIPT_STEPS);
    const said = () =>
      JSON.stringify({
        realMs: [first.realMs, second.realMs],
        degradations: [first.bundle.degradations, second.bundle.degradations],
        recording: [first.report.run.recording, second.report.run.recording],
      });
    expect(first.report.run.recording, said()).toEqual({ clock: "held" });
    expect(first.bundle.clock, said()).toBe("held");

    // Premises, on the page's own frames: the rAF box moved on at least 20
    // of them (R4), and the walk's scroll showed at least 5 positions of the
    // striped column (R5), so neither comparison below is trivially equal.
    const box = await pageRegion(first, [0.23, 0.14, 0.43, 0.21]);
    expect(changes(box), said()).toBeGreaterThanOrEqual(20);
    const stripes = await pageRegion(first, [0.94, 0, 1, 1]);
    expect(new Set(stripes).size, said()).toBeGreaterThanOrEqual(5);
    // And the same on the second run, frame for frame.
    expect(await pageRegion(second, [0.23, 0.14, 0.43, 0.21])).toEqual(box);
    expect(await pageRegion(second, [0.94, 0, 1, 1])).toEqual(stripes);

    // Exactly the same recording: every frame at the same time, the cursor
    // and the steps on the same frames, and every still (a hold) the same
    // bytes. Motion spans are encoded on the GPU, which is not bit-exact
    // between runs (the same frames came out 954473 and 954294 bytes on
    // 2026-11-15), so their bytes are left out here and read decoded below.
    const timeline = (r: Recorded) =>
      JSON.stringify({
        keyframes: r.bundle.keyframes.map((k) => [
          k.sourceTimeMs,
          k.width,
          k.height,
        ]),
        spans: r.bundle.motionSpans.map((m) => [
          m.startMs,
          m.endMs,
          m.width,
          m.height,
          m.fps,
        ]),
        cursor: r.bundle.cursorSamples,
        markers: r.bundle.markers.map((m) => [
          m.sourceTimeMs,
          m.approachSourceTimeMs,
          m.actEndSourceTimeMs,
          m.scrollEndSourceTimeMs,
        ]),
      });
    expect(timeline(second), said()).toBe(timeline(first));
    const stills = async (r: Recorded) =>
      Promise.all(
        r.bundle.keyframes.map(async (k) =>
          hash(Buffer.from(await r.store.load(k.ref)).toString("base64")),
        ),
      );
    expect(await stills(second), said()).toEqual(await stills(first));

    const one = await framesOf(await render(first));
    const two = await framesOf(await render(second));
    expect(two.length, said()).toBe(one.length);
    // Decoded, every frame within the spans' encoding noise: at most
    // NOISE grey levels apart at 96x60 (1-2 measured). Premise: the picture
    // moved by more than that on at least 20 frames (the spinner, timer,
    // transition, the rAF box, the scroll), so a frame off by one fails.
    const moved = one.filter(
      (f, i) => i > 0 && greyDiff(f, one[i - 1] ?? "") > NOISE,
    ).length;
    expect(moved, said()).toBeGreaterThanOrEqual(20);
    const apart = one.flatMap((f, i) => {
      const d = greyDiff(f, two[i] ?? "");
      return d > NOISE
        ? [`frame ${i}: ${d} grey levels, in cells ${apartIn(f, two[i] ?? "")}`]
        : [];
    });
    expect(apart, said()).toEqual([]);

    // The addendum's proof: no step waited out a 30 s answer deadline (one
    // such wait alone takes 30 s of real time, longer than this whole
    // recording is let take), and nothing was said but what the fixture is
    // built to produce: nothing.
    for (const r of [first, second]) {
      expect(r.realMs, said()).toBeLessThan(30_000);
      expect(r.bundle.degradations, said()).toEqual([]);
    }
  }, 300_000);

  // Review Focus 1. The other site's document answers 200 ms late, to have
  // its renderer made while the clock follows the server (R7): measured
  // 2026-11-15, it never is, because the walk's read of the click (the old
  // document's) waits for the commit, so the commit lands between grants.
  // Red without the pause after every grant (held-clock.ts): the new
  // renderer then starts on the machine's clock, years past the pin.
  it("continues the held time across a navigation to another origin", async () => {
    printed.length = 0;
    const r = await record(`${aUrl}/go`, [
      { do: "click", on: { stableId: "go" }, zoom: false },
      { do: "waitFor", on: { stableId: "there" }, until: "visible" },
    ]);
    const said = JSON.stringify({
      printed,
      markers: r.bundle.markers,
      network: r.bundle.networkSpans,
    });
    // Premise: the other site's page printed its clock.
    const there = printed.find((p) => p.label === "there");
    expect(there, said).toBeDefined();
    // The walk's clock is the held clock from its hold, so the page's
    // Date.now() less the pinned instant is the held time it ran at.
    const at = (there?.t ?? Number.NaN) - Date.parse(PIN);
    const click = r.bundle.markers[0]?.sourceTimeMs ?? Number.NaN;
    expect(Math.abs(at - click), said).toBeLessThanOrEqual(HELD_FRAME_MS);
    // Within the run's real time too, not merely near the click.
    expect(r.realMs, said).toBeLessThan(30_000);
  }, 120_000);

  // Review Focus 4 and R6.
  it("says a frame from another site, which it could not hold", async () => {
    const r = await record(`${aUrl}/framed`, [
      { do: "click", on: { stableId: "ok" }, zoom: false },
    ]);
    const said = r.bundle.degradations.filter(
      (d) => d.kind === "animationUnpinned",
    );
    expect(said, JSON.stringify(r.bundle.degradations)).toHaveLength(1);
    expect(said[0]?.note).toContain(new URL(bUrl).origin);
    expect(said[0]?.note).toMatch(/timers, animations and requests/);
  }, 120_000);

  it("records in real time, and says so, when headed", async () => {
    const headed = shouldHold({ headed: true });
    expect(headed).toEqual({
      hold: false,
      why: expect.stringMatching(/visible window/),
    });
    // A visible window cannot open here; a device recording is the other
    // mode not yet held, and its report says so the same way.
    const r = await record(
      `${aUrl}/framed`,
      [{ do: "click", on: { stableId: "ok" }, zoom: false }],
      { device: "phone", viewport: undefined },
    );
    expect(r.report.run.recording).toEqual({
      clock: "real",
      why: expect.stringMatching(/device/),
    });
    expect(r.bundle.clock).toBeUndefined();
  }, 120_000);
});
