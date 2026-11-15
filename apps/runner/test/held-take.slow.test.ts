// Slow tier: records held videos through a real browser and renders two.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELD_FRAME_MS } from "@demoman/replay-engine";
import { frameOf, targetFor } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fullChromiumPath } from "../src/executor/browser.js";
import { shouldHold } from "../src/executor/held.js";
import { launch } from "../src/launch.js";
import { listenOnLoopback } from "../src/loopback.js";
import { renderToFiles } from "../src/render.js";
import {
  apartFrames,
  greyDiff,
  moves,
  NOISE,
  PAGE,
  PIN,
  pageRegion,
  type Recorded,
  record as recordIn,
  SCRIPT_STEPS,
} from "./held-record.js";
import { mp4FrameTimes, readMp4Crops } from "./mp4-probe.js";

/**
 * Held-clock capture in a real browser (Task 6): the page's own time is
 * held and moved on one video frame at a time, so one script records the
 * same video twice. Full Chromium, as production records (`fullChromiumPath`):
 * the headless shell has no site isolation, so it would hide the
 * cross-site cases below.
 */

let home: string;
const record = (target: string, steps: unknown[], extra = {}) =>
  recordIn(home, target, steps, extra);
let a: Server;
let b: Server;
let aUrl: string;
let bUrl: string;
/** The other server on this page's own site (127.0.0.1, another port):
 *  Chrome keeps such a frame in the page's renderer. */
let bSameSite: string;
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
    if (u.pathname === "/raf") {
      send(
        `<body style="margin:0"><div id=b style="position:absolute;top:10px;width:30px;height:30px;background:#06c"></div><iframe src="/raf-inner" style="position:absolute;left:0;top:50px;width:300px;height:60px;border:0"></iframe><script>let s=null;(function f(t){if(s===null)s=t;document.getElementById("b").style.left=((t-s)/10%200)+"px";requestAnimationFrame(f)})(performance.now())</script>`,
      );
      return;
    }
    // The frame's own frame, of its own origin: reachable from it, not
    // from the page (fix round 2).
    if (u.pathname === "/raf-inner") {
      send(
        `<body style="margin:0"><div id=c style="position:absolute;top:10px;width:30px;height:30px;background:#c06"></div><script>let s=null;(function f(t){if(s===null)s=t;document.getElementById("c").style.left=((t-s)/7%200)+"px";requestAnimationFrame(f)})(performance.now())</script>`,
      );
      return;
    }
    if (u.pathname === "/frame") {
      send(
        `<style>div{width:40px;height:40px;background:#c60;animation:s 1s linear infinite}@keyframes s{to{transform:translateX(100px)}}</style><div></div>`,
      );
      return;
    }
    // The other site's page, answered late: the wait is the server's, and is
    // to be in the video as one (fix round 1, finding 3).
    setTimeout(
      () =>
        send(
          `<p id=there>there</p><script>fetch("/report?label=there&t=" + Date.now())</script>`,
        ),
      200,
    );
  });
  bSameSite = (await listenOnLoopback(b)).replace(/\/$/, "");
  bUrl = bSameSite.replace("127.0.0.1", "localhost");
  a = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    res.writeHead(200, { "content-type": "text/html" });
    if (path === "/go")
      res.end(
        `<!doctype html><a id=go href="${bUrl}/there" style="position:absolute;left:40px;top:40px;width:160px;height:40px;display:block;background:#eee">Go</a>`,
      );
    else if (path === "/same-site")
      res.end(
        `<!doctype html><button id=ok style="position:absolute;left:40px;top:40px;width:160px;height:40px">Ok</button><iframe src="${bSameSite}/raf" style="position:absolute;left:40px;top:120px;width:300px;height:120px;border:0"></iframe>`,
      );
    else if (path === "/shadow-scroll")
      res.end(
        `<!doctype html><style>body{margin:0;height:3200px}#s{position:absolute;right:0;top:0;width:80px;height:3200px;background:repeating-linear-gradient(#000 0 20px,#fff 20px 37px)}#host{position:absolute;left:40px;top:2400px}</style><div id=s></div><div id=host></div><script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML='<button id=deep style="width:160px;height:40px">Deep</button>'</script>`,
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

/** Navigations recorded in a row: enough to see the held frames agree
 *  (20 did, 2026-11-15); the wait that falls between two looks, 1 in 20,
 *  is held by its node test (held-clock.test.ts), which never misses. */
const RUNS = 5;
/** About 6 s a navigation here and 27 s on CI's ubuntu (20 in 541 s,
 *  2026-11-15): twice CI's. */
const NAVIGATIONS_MS = RUNS * 60_000;

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
    expect(moves(stripes), said()).toBeGreaterThanOrEqual(5);
    // And the same on the second run, frame for frame, within the spans'
    // encoding noise (they are GPU-encoded, as the render's are).
    expect(
      apartFrames(await pageRegion(second, [0.23, 0.14, 0.43, 0.21]), box),
      said(),
    ).toEqual([]);
    expect(
      apartFrames(await pageRegion(second, [0.94, 0, 1, 1]), stripes),
      said(),
    ).toEqual([]);

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
    // 73 s here; 300 s was not enough on CI's ubuntu or macOS (2026-11-15).
  }, 900_000);

  // Review Focus 1, and fix round 1 finding 3. The other site's document
  // answers 200 ms late. The old page answers no grant or page call until
  // the new one commits, so the stretch is followed to the wait's end
  // afterwards: the wait is a network stretch in the video. The new page's
  // clock continues the held time, from where the navigation began: Chrome
  // runs its first script in the first grant after the commit, at the time
  // the old page was paused at (measured 2026-11-15), before any of the
  // wait can be granted to it. Red without the pause after every grant
  // (held-clock.ts): the new renderer then starts on the machine's clock,
  // years past the pin; and red without the stretch following the wait to
  // its end: the stretch is a millisecond long.
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
    const click = r.bundle.markers[0]?.sourceTimeMs ?? Number.NaN;
    // The server's wait is network time, from the click on.
    const wait = (r.bundle.networkSpans ?? []).find(
      (s) => s.label.includes("GET /there") && s.endMs > click,
    );
    expect(wait, said).toBeDefined();
    const waitMs = (wait?.endMs ?? 0) - Math.max(wait?.startMs ?? 0, click);
    expect(waitMs, said).toBeGreaterThanOrEqual(150);
    // The walk's clock is the held clock from its hold, so the page's
    // Date.now() less the pinned instant is the held time it ran at.
    const at = (there?.t ?? Number.NaN) - Date.parse(PIN);
    expect(Math.abs(at - click), said).toBeLessThanOrEqual(2 * HELD_FRAME_MS);
    expect(r.realMs, said).toBeLessThan(30_000);
  }, 120_000);

  // Task 6 review, carried to Task 9: the server's wait is in the video
  // however Chrome's word of the request falls between the walk's looks
  // (1 of 20 runs lost it on 2026-11-15, the whole wait inside the one
  // grant after the click; held-clock.ts follows such a wait now, and its
  // node test is the guard that never misses). And the held frames from
  // the click to each later step moment, outside every network stretch,
  // are the same every run: they are what a slower machine must not change.
  it(
    "puts a navigation's server wait in the video every time",
    async () => {
      const runs: { waitMs: number; held: number[]; evidence: unknown }[] = [];
      for (let i = 0; i < RUNS; i++) {
        const r = await record(`${aUrl}/go`, [
          { do: "click", on: { stableId: "go" }, zoom: false },
          { do: "waitFor", on: { stableId: "there" }, until: "visible" },
        ]);
        const spans = r.bundle.networkSpans ?? [];
        const [first, second] = r.bundle.markers;
        const click = first?.sourceTimeMs ?? Number.NaN;
        const wait = spans.find(
          (s) => s.label.includes("GET /there") && s.endMs > click,
        );
        const heldSince = (to: number) => {
          let network = 0;
          for (const s of spans)
            network += Math.max(
              0,
              Math.min(s.endMs, to) - Math.max(s.startMs, click),
            );
          return Math.round((to - click - network) / HELD_FRAME_MS);
        };
        runs.push({
          waitMs:
            (wait?.endMs ?? Number.NaN) - Math.max(wait?.startMs ?? 0, click),
          held: [
            first?.actEndSourceTimeMs,
            second?.approachSourceTimeMs,
            second?.sourceTimeMs,
            second?.actEndSourceTimeMs,
          ].map((ms) => heldSince(ms ?? Number.NaN)),
          evidence: { network: spans, markers: r.bundle.markers },
        });
      }
      const said = JSON.stringify(runs);
      expect(
        runs.filter((r) => !(r.waitMs >= 150)),
        said,
      ).toEqual([]);
      expect(new Set(runs.map((r) => JSON.stringify(r.held))).size, said).toBe(
        1,
      );
    },
    NAVIGATIONS_MS,
  );

  // Fix round 1, finding 1: a frame of another origin on this page's own
  // site shares its renderer; the page cannot run its animation frames, so
  // it keeps Chrome's own, and the run says so. Red when the frame's queue
  // is left to a parent that cannot reach it: the frame's box never moves.
  it("leaves a frame it cannot reach on Chrome's frames, and says so", async () => {
    const r = await record(`${aUrl}/same-site`, [
      { do: "click", on: { stableId: "ok" }, zoom: false },
      { do: "pause", ms: 600 },
    ]);
    const evidence = JSON.stringify(r.bundle.degradations);
    const said = r.bundle.degradations.filter(
      (d) => d.kind === "animationUnpinned",
    );
    expect(
      said.map((d) => d.note),
      evidence,
    ).toEqual([
      `a frame from ${bSameSite} runs its animations on its own clock: they were not held`,
    ]);
    // The frame's box (top 130-160 of 800, left 40-340 of 1280) moved.
    const box = await pageRegion(r, [0.03, 0.16, 0.27, 0.2]);
    expect(moves(box), evidence).toBeGreaterThanOrEqual(5);
    // And the box of that frame's own frame (top 180-210), which only the
    // frame could run: red when it queues its frames for a parent that
    // runs none (fix round 2).
    const inner = await pageRegion(r, [0.03, 0.225, 0.27, 0.265]);
    expect(moves(inner), evidence).toBeGreaterThanOrEqual(5);
  }, 120_000);

  // Fix round 1, finding 4: the walk up from a target in a shadow root
  // reaches the page's own scroll. Red when it stops at the shadow root.
  it("plays the scroll to a target in a shadow root", async () => {
    const r = await record(`${aUrl}/shadow-scroll`, [
      { do: "click", on: { stableId: "deep" }, zoom: false },
    ]);
    const stripes = await pageRegion(r, [0.94, 0, 1, 1]);
    expect(
      moves(stripes),
      JSON.stringify(r.bundle.degradations),
    ).toBeGreaterThanOrEqual(5);
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
