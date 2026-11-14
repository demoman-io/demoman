// Slow tier: records one script twice through a real browser and renders one.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cursorMotionSpans,
  type FrameBundle,
  planScene,
  resolvePlan,
  sourceDurationOf,
  toOutputMs,
} from "@demoman/compositor";
import { TYPE_KEY_MS } from "@demoman/replay-engine";
import type { BrandKitsRead } from "@demoman/run-core";
import { frameOf, targetFor } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import type { BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPTURE_SCALE } from "../src/display.js";
import { createBrowserSession } from "../src/executor/browser.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import { runScript } from "../src/executor/run.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { launch } from "../src/launch.js";
import { listenOnLoopback } from "../src/loopback.js";
import { installResolver } from "../src/page-agent.js";
import { renderToFiles } from "../src/render.js";
import { lagCdp } from "./lag.js";
import { mp4FirstFrameSize, mp4FrameTimes, readMp4Crops } from "./mp4-probe.js";

// Spec 2026-11-13 (same take on any machine), Part 4 tests 1 to 3. One
// script is recorded twice in this process, the second time with every CDP
// command held 40 ms (a slower machine), and the two takes are compared
// step by step on their rendered timelines; the fast one is rendered and
// decoded for the seams. Both are planned takes (`scene.pacing`): their
// idle plays at its planned length, and their camera is decided once, on
// the designed clock.

const LAG_MS = 40;
const FRAME_MS = 1000 / 60;
/** Acting steps: a click with no zoom, a type, then two zoomed clicks. */
const STEPS = 4;

// A plain button and a field top left; B top right, far from them, so the
// camera comes in from full frame (a return); C a short walk from B, so it
// pans on from B. The first click is `zoom: false`, so the pair after it
// (rest, the journey to the field, arrive) is filmed with the camera at full
// frame and the cursor already on screen: the seam check's pair. (The first
// step's own journey is not: the cursor first appears at its first sample.)
// Positions and sizes are explicit: no glyph width moves a rect. Colours
// and borders are explicit and there is no outline, so no control repaints
// on hover or focus: on 2026-11-13 the field's hover border and Xray's
// background changed inside the planned arrive, a repaint too short to be
// filmed as a motion span, so it played as idle and the seam check read a
// settled frame that moved (Task 7 report: a classification question).
const PAGE = `<!doctype html><meta charset=utf-8><title>same take</title>
<style>
body{margin:0;font:16px sans-serif;background:#fff}
button,input{position:absolute;width:160px;height:40px;font:16px monospace;background:#eee;border:1px solid #888;outline:none}
#x{left:40px;top:300px}
#amount{left:40px;top:40px}
#b{left:1060px;top:120px}
#c{left:1000px;top:190px}
</style>
<button id="x">Xray</button>
<input id="amount" aria-label="Amount">
<button id="b">Bravo</button>
<button id="c">Charlie</button>`;

const SCRIPT_STEPS = [
  { do: "click", on: { text: "Xray" }, zoom: false },
  { do: "type", into: { stableId: "amount" }, text: "4800" },
  { do: "click", on: { text: "Bravo" } },
  { do: "click", on: { text: "Charlie" } },
];

const kits: BrandKitsRead = {
  state: "ready",
  kits: [],
  defaultId: null,
  migrationPending: false,
};

let url: string;
let server: ReturnType<typeof createServer>;
let home: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  url = `${await listenOnLoopback(server)}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-same-take-"));
}, 30_000);
afterAll(async () => {
  server.close();
  await rm(home, { recursive: true, force: true });
});

interface Recording {
  scene: SceneDocument;
  bundle: FrameBundle;
  timeline: ReturnType<typeof resolvePlan>["timeline"];
  /** The rendered film, when this recording was rendered. */
  mp4: { bytes: Uint8Array; lastFrameMs: number } | null;
  /** The run report's own `frames` block, as the report words it. */
  frames: unknown;
  evidence: () => string;
}

interface Span {
  startMs: number;
  endMs: number;
}
const mergeSpans = (spans: Span[]): Span[] => {
  const out: Span[] = [];
  for (const s of [...spans]
    .filter((x) => x.endMs > x.startMs)
    .sort((a, b) => a.startMs - b.startMs)) {
    const last = out.at(-1);
    if (last && s.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, s.endMs);
    } else out.push({ ...s });
  }
  return out;
};
const clip = (spans: Span[], from: number, to: number): Span[] =>
  mergeSpans(
    spans.map((s) => ({
      startMs: Math.max(s.startMs, from),
      endMs: Math.min(s.endMs, to),
    })),
  );
/** `a` with `b`'s stretches taken out. */
const minus = (a: Span[], b: Span[]): Span[] =>
  mergeSpans(a).flatMap((s) => {
    let parts = [s];
    for (const cut of mergeSpans(b)) {
      parts = parts.flatMap((p) =>
        cut.endMs <= p.startMs || cut.startMs >= p.endMs
          ? [p]
          : [
              { startMs: p.startMs, endMs: Math.max(p.startMs, cut.startMs) },
              { startMs: Math.min(p.endMs, cut.endMs), endMs: p.endMs },
            ],
      );
    }
    return parts;
  });
const total = (spans: Span[]) =>
  Math.round(mergeSpans(spans).reduce((n, s) => n + s.endMs - s.startMs, 0));

/**
 * Where a take's motion came from, per stretch between steps (source ms,
 * which is output ms: motion plays at rate 1). `typing` is the page's motion
 * between the type step's marker and its act end; `journey` is the cursor's
 * travel (what resolvePlan takes as hints) outside that; `page` is the rest
 * of the bundle's motion spans (the app's own response).
 */
function motionByCause(r: Recording) {
  const typed = markerOf(r, 1);
  const typing: Span[] = clip(
    r.bundle.motionSpans,
    typed.sourceTimeMs,
    typed.actEndSourceTimeMs ?? typed.sourceTimeMs,
  );
  const travel = minus(cursorMotionSpans(r.bundle.cursorSamples), typing);
  const page = minus(
    minus(
      r.bundle.motionSpans.map((s) => ({ startMs: s.startMs, endMs: s.endMs })),
      typing,
    ),
    travel,
  );
  const marks = steps.map((s) => markerOf(r, s).sourceTimeMs);
  const windows: [string, number, number][] = [
    ["opening", 0, marks[0] as number],
    ...steps
      .slice(1)
      .map((s, i): [string, number, number] => [
        `step ${s - 1} to ${s}`,
        marks[i] as number,
        marks[i + 1] as number,
      ]),
  ];
  return windows.map(([window, from, to]) => ({
    window,
    journey: total(clip(travel, from, to)),
    typing: total(clip(typing, from, to)),
    page: total(clip(page, from, to)),
  }));
}

async function record(lagMs: number, render: boolean): Promise<Recording> {
  const lines: string[] = [];
  const session = createBrowserSession({
    headless: true,
    log: (line) => void lines.push(line),
    onLaunched: async ({ context }) => {
      await installResolver(context);
      await installExecutorEntry(context);
      await lagCdp(context, lagMs);
    },
  });
  try {
    const library = createLibrary(home);
    const report = await runScript(
      {
        // 8: the first version with a step's `zoom`.
        scriptVersion: 8,
        name: `same take, lag ${lagMs}`,
        target: url,
        viewport: { width: 1280, height: 800 },
        steps: SCRIPT_STEPS,
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
      },
      () => undefined,
    );
    const failure = () => JSON.stringify({ report, lines: lines.slice(-20) });
    expect(report.outcome, failure()).toBe("complete");
    const takeId = report.provenance.takeId as string;
    const scene = (await library.getScene(takeId)) as SceneDocument;
    const store = library.frameStore(takeId);
    const bundle = (await store.getBundle(takeId)) as FrameBundle;
    const timeline = resolvePlan(planScene(scene), bundle, scene).timeline;
    const evidence = () =>
      JSON.stringify({
        markers: bundle.markers,
        camera: scene.camera,
        pacing: scene.pacing,
        segments: timeline.segments,
      });
    const frames = (report as { frames?: unknown }).frames;
    if (!render)
      return { scene, bundle, timeline, mp4: null, frames, evidence };

    const launched = await launch();
    try {
      const rendered = await renderToFiles({
        wallpaper: null,
        // The seam check reads the settled frame either side of a rest: a
        // pointer fading out after `CURSOR_IDLE_HIDE_MS` of stillness
        // would paint over it, so this film keeps the pointer up.
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
      const { timesSec } = await mp4FrameTimes(file.bytes);
      return {
        scene,
        bundle,
        timeline,
        mp4: { bytes: file.bytes, lastFrameMs: (timesSec.at(-1) ?? 0) * 1000 },
        frames,
        evidence,
      };
    } finally {
      await launched.close();
    }
  } finally {
    await session.close();
  }
}

/** Marker i is script step i. */
const markerOf = (r: Recording, step: number) => {
  const id = r.scene.actions[step]?.id;
  const marker = r.bundle.markers.find((m) => m.actionId === id);
  if (marker === undefined) {
    throw new Error(`no marker for step ${step}: ${r.evidence()}`);
  }
  return marker;
};
const steps = Array.from({ length: STEPS }, (_, i) => i);

/** Where step i starts on the film. */
const start = (r: Recording, step: number) =>
  toOutputMs(r.timeline, markerOf(r, step).sourceTimeMs);

/** Film time spent in motion before step i starts. */
const motionMsBefore = (r: Recording, step: number) => {
  const at = start(r, step);
  return r.timeline.segments
    .filter((s) => s.kind === "motion" && s.outStartMs < at)
    .reduce((sum, s) => sum + Math.min(s.outEndMs, at) - s.outStartMs, 0);
};

/** What identifies a zoom decision: its step (action ids differ between
 *  recordings, so the step's index), kind, scale and how the camera
 *  reaches it; no times. */
const zoomShape = (r: Recording) => (c: SceneDocument["camera"][number]) => ({
  step: r.scene.actions.findIndex((a) => a.id === c.marker.actionId),
  kind: c.kind,
  scale: c.scale,
  arrives: c.arrives ?? null,
});

let fast: Recording;
let slow: Recording;

// The hook (both recordings, the fast one's 1080p render) took 37.5 s
// locally on Apple silicon, 2026-11-13, rounded up to 40 s; the seam check
// 0.9 s (a probe browser per seam), rounded up to 2 s. CI is 6.5-7x slower,
// not 5x: the ubuntu runner took 535 s for an old file's two four-step
// recordings and two renders that ran 75-85 s locally (535/85 to 535/75).
// A timeout in this shared hook fails every case in the file, so both get 7x.
const RECORD_BOTH_MS = 40_000 * 7;
const DECODE_MS = 2_000 * 7;

beforeAll(async () => {
  fast = await record(0, true);
  // Slowed second: the lag is the process's and nothing runs after it.
  slow = await record(LAG_MS, false);
}, RECORD_BOTH_MS);

describe("one script recorded fast and slowed", () => {
  it("the slowed recording really was slower (the premise)", () => {
    const said = `${fast.evidence()} ${slow.evidence()}`;
    // The fixture: both takes are planned, every step has a marker, and
    // the fast take's camera comes in from full frame to one click and pans
    // on to the next, so there are camera decisions of both kinds.
    expect(fast.scene.pacing, said).toBeDefined();
    expect(slow.scene.pacing, said).toBeDefined();
    for (const step of steps) markerOf(fast, step);
    for (const step of steps) markerOf(slow, step);
    expect(fast.scene.camera.map(zoomShape(fast)), said).toEqual([
      { step: 2, kind: "zoom", scale: expect.any(Number), arrives: "return" },
      { step: 3, kind: "zoom", scale: expect.any(Number), arrives: "pan" },
    ]);
    const sourceDiff =
      sourceDurationOf(slow.bundle) - sourceDurationOf(fast.bundle);
    console.table({
      "source ms": {
        fast: sourceDurationOf(fast.bundle),
        slow: sourceDurationOf(slow.bundle),
        diff: sourceDiff,
      },
      "planned output ms": {
        fast: fast.timeline.outputDurationMs,
        slow: slow.timeline.outputDurationMs,
        diff: slow.timeline.outputDurationMs - fast.timeline.outputDurationMs,
      },
      "fast mp4 last frame ms": { fast: fast.mp4?.lastFrameMs ?? null },
    });
    console.table(
      steps.map((step) => ({
        step,
        "start fast": Math.round(start(fast, step)),
        "start slow": Math.round(start(slow, step)),
        "motion before fast": Math.round(motionMsBefore(fast, step)),
        "motion before slow": Math.round(motionMsBefore(slow, step)),
      })),
    );
    // Reported, not asserted: each stretch's motion by cause. The designed
    // length of the typing is (chars - 1) x TYPE_KEY_MS (run-core's `actMs`:
    // the verb's lead is idle inside the act and plays for 0); a journey's
    // designed length is not persisted (the scene and bundle carry no cursor
    // segment), so it is null here.
    const typedText = "4800";
    console.log(
      `typing designed ${(typedText.length - 1) * TYPE_KEY_MS} ms; journey designed: not recorded in the scene or bundle`,
    );
    const causeFast = motionByCause(fast);
    const causeSlow = motionByCause(slow);
    console.table(
      causeFast.map((f, i) => {
        const s = causeSlow[i] as (typeof causeFast)[number];
        return {
          window: f.window,
          "journey fast": f.journey,
          "journey slow": s.journey,
          "typing fast": f.typing,
          "typing slow": s.typing,
          "page fast": f.page,
          "page slow": s.page,
        };
      }),
    );
    const screencast = (r: Recording) => ({
      spans: r.bundle.motionSpans.length,
      spanMs: total(
        r.bundle.motionSpans.map((s) => ({
          startMs: s.startMs,
          endMs: s.endMs,
        })),
      ),
      frames: JSON.stringify(r.frames),
    });
    console.table({ fast: screencast(fast), slow: screencast(slow) });
    console.log(
      JSON.stringify({
        fast: fast.scene.camera.map(zoomShape(fast)),
        slow: slow.scene.camera.map(zoomShape(slow)),
      }),
    );
    expect(sourceDiff, said).toBeGreaterThan(LAG_MS * STEPS * 4);
  });

  // Result 1: idle contributes nothing to the difference. Red if the take
  // stops writing `pacing` (authored.ts, `assembleAuthored`): the slowed
  // take keeps its added idle (seen 2026-11-13: step 0 started 1117 ms later
  // slowed with 50 ms more motion before it).
  it("idle contributes nothing to where each step starts", () => {
    for (const step of steps) {
      const startDiff = start(slow, step) - start(fast, step);
      const motionDiff =
        motionMsBefore(slow, step) - motionMsBefore(fast, step);
      expect(
        Math.abs(startDiff - motionDiff),
        `step ${step}: start differs by ${startDiff}, motion by ${motionDiff}. ${fast.evidence()} ${slow.evidence()}`,
      ).toBeLessThanOrEqual(FRAME_MS);
    }
  });

  // Result 2: the same script gets the same camera, pan or return
  // included. Red if `cameraInputs` hands the camera the markers' source
  // stamps rather than the walk's designed times, or the zooms lose the
  // walk's `arrives` (authored.ts, `runAuthored`).
  it("the two takes have the same camera", () => {
    expect(
      slow.scene.camera.map(zoomShape(slow)),
      `${fast.evidence()} ${slow.evidence()}`,
    ).toEqual(fast.scene.camera.map(zoomShape(fast)));
  });

  // Spec Part 4 test 2, seams. At each idle/motion boundary of the type's
  // pair (rest, the journey to the field, arrive), on the decoded film: the
  // frame on the idle side is the settled frame, equal to the idle frame
  // 100 ms further from the seam, and the frame on the motion side differs
  // from it. No motion frame is held and no settled frame skipped. The
  // camera is at full frame and the cursor shown throughout this pair.
  // Red (seen, at the motion premise) if the pointer's travel stops counting
  // as motion (resolve.ts's cursor hints dropped): the journey then plays as
  // planned idle and the pair has no seam. Red at the settled frame if a
  // frame inside planned idle moves, as a control's hover repaint did (PAGE).
  it(
    "holds the settled frame up to each seam of a planned pair, and moves after it",
    async () => {
      const film = fast.mp4;
      if (film === null) throw new Error("the fast take was not rendered");
      const pairStart = start(fast, 0);
      const pairEnd = start(fast, 1);
      // The timeline's segments, runs of one kind merged: two idle
      // segments side by side are one still stretch on the film.
      const segments: { outStartMs: number; outEndMs: number; kind: string }[] =
        [];
      for (const g of fast.timeline.segments) {
        if (g.outEndMs <= pairStart) continue;
        if (g.outStartMs >= pairEnd) break;
        const kind = g.kind === "motion" ? "motion" : "still";
        const last = segments.at(-1);
        if (last?.kind === kind) last.outEndMs = g.outEndMs;
        else
          segments.push({
            outStartMs: g.outStartMs,
            outEndMs: g.outEndMs,
            kind,
          });
      }
      const still = (g: (typeof segments)[number]) => g.kind === "still";
      const seams: { atMs: number; idleBefore: boolean }[] = [];
      for (let i = 0; i + 1 < segments.length; i++) {
        const a = segments[i] as (typeof segments)[number];
        const b = segments[i + 1] as (typeof segments)[number];
        if (still(a) === still(b)) continue;
        const idle = still(a) ? a : b;
        const moving = still(a) ? b : a;
        // Only seams a frame and the 100 ms reference can sit either side of.
        if (idle.outEndMs - idle.outStartMs < 100 + 3 * FRAME_MS) continue;
        if (moving.outEndMs - moving.outStartMs < 3 * FRAME_MS) continue;
        seams.push({ atMs: a.outEndMs, idleBefore: still(a) });
      }
      const said = `${JSON.stringify(seams)} ${fast.evidence()}`;
      // Premise: the pair has motion, and a seam on each side of it.
      const motionMs = segments
        .filter((g) => g.kind === "motion")
        .reduce((n, g) => n + g.outEndMs - g.outStartMs, 0);
      expect(motionMs, said).toBeGreaterThan(0);
      expect(
        seams.map((x) => x.idleBefore),
        said,
      ).toEqual(expect.arrayContaining([true, false]));
      const grey = (r: { grey?: string }) =>
        Buffer.from(r.grey ?? "", "base64");
      // The encoder's own noise between two decodes of one still picture:
      // single pixels off by 10 and by 25 measured here (2026-11-13), so
      // twice that. The pointer moving is 195 and more.
      const NOISE = 50;
      /** Pixels that differ by more than `NOISE` grey levels, and where (the
       *  box round them, at 960x540), for the failure message. */
      type Box = [number, number, number, number];
      const diffOf = (a: Buffer, b: Buffer, mask: Box | null = null) => {
        let n = 0;
        let box: Box = [960, 540, -1, -1];
        let peak = 0;
        for (let i = 0; i < a.length; i++) {
          const x = i % 960;
          const y = Math.floor(i / 960);
          if (
            mask !== null &&
            x >= mask[0] &&
            x <= mask[2] &&
            y >= mask[1] &&
            y <= mask[3]
          )
            continue;
          const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
          peak = Math.max(peak, d);
          if (d <= NOISE) continue;
          n++;
          box = [
            Math.min(box[0], x),
            Math.min(box[1], y),
            Math.max(box[2], x),
            Math.max(box[3], y),
          ];
        }
        return { n, box, peak };
      };
      for (const seam of seams) {
        const idleSide = seam.idleBefore ? -FRAME_MS / 2 : FRAME_MS * 1.5;
        const motionSide = seam.idleBefore ? FRAME_MS * 1.5 : -FRAME_MS / 2;
        const settled = seam.idleBefore ? idleSide - 100 : idleSide + 100;
        const at = [settled, idleSide, motionSide]
          .map((d) => (seam.atMs + d) / 1000)
          .sort((x, y) => x - y);
        const read = await readMp4Crops(
          film.bytes,
          at,
          [0, 0, 1, 1],
          { width: 960, height: 540 },
          true,
        );
        const frameAt = (d: number) =>
          grey(read[at.indexOf((seam.atMs + d) / 1000)] as { grey?: string });
        const idleFrame = frameAt(idleSide);
        // The motion across this seam is the pointer's journey, so what
        // changes is the pointer: its box, with a margin.
        const motion = diffOf(idleFrame, frameAt(motionSide));
        const [x0, y0, x1, y1] = motion.box;
        const pointer: Box = [x0 - 12, y0 - 12, x1 + 12, y1 + 12];
        // The settled frame is compared outside the pointer: the frames are
        // the recording's, the pointer is drawn over them from its samples,
        // and the first and last half-pixel steps of a journey are below
        // `CURSOR_MOTION_EPSILON_PX`, so they play as idle and the pointer
        // creeps there by a pixel (2026-11-13; Task 7 report).
        const still = diffOf(idleFrame, frameAt(settled), pointer);
        const where = `${JSON.stringify({ still, motion })} seam at ${Math.round(seam.atMs)} ms (${seam.idleBefore ? "idle to motion" : "motion to idle"}), frames ${read.map((r) => r.frameSec)}: ${said}`;
        // Premise: what moved is pointer-sized, so the mask below (`pointer`,
        // the box of what changed, plus 12 px) hides no page. It guards
        // `still.n === 0` from reading the pointer's own creep as a page
        // change. The box holds the pointer at both frames, so its size is
        // the pointer's plus its travel between them, and the travel
        // depends on where the seam falls against the 60 fps frames, which
        // moves with the planned rests (`BASE_REST_MS`/`OPENING_REST_MS`).
        // The bound is NOT derived: the pointer's drawn size and the
        // page-to-film scale are not reachable from this test (they are
        // the compositor's cursor art and its window layout; only
        // `fast.bundle.cursorSamples`, in page px, is). Measured: 62 px
        // wide, 50 px tall at 200/250 on 2026-11-13, 40 px passed at the
        // old 700/800 phase. 80 clears the measured box and is far under
        // a page change, which spans hundreds.
        expect(motion.n, where).toBeGreaterThan(0);
        expect(x1 - x0, where).toBeLessThan(80);
        expect(y1 - y0, where).toBeLessThan(80);
        expect(still.n, where).toBe(0);
      }
    },
    DECODE_MS,
  );
});

// Spec 2026-11-13 part 2: a headless first run records motion at
// CAPTURE_SCALE, never the screen's, so a 1x desktop records what a Retina
// Mac does. Turns red when browser.ts's `start` launches at the display's
// own scale (`read.scale`) again: the take records 1 and decodes 1280 wide.
describe("a first run on a 1x screen", () => {
  it(
    "records the desktop constant, and its motion decodes at twice the viewport",
    async () => {
      const lines: string[] = [];
      const reads: number[] = [];
      const session = createBrowserSession({
        headless: true,
        log: (line) => void lines.push(line),
        readDisplay: async () => {
          reads.push(1);
          return { width: 1440, height: 900, scale: 1 };
        },
        onLaunched: async ({ context }) => {
          await installResolver(context);
          await installExecutorEntry(context);
        },
      });
      try {
        const library = createLibrary(home);
        const viewport = { width: 1280, height: 800 };
        const report = await runScript(
          {
            scriptVersion: 8,
            name: "same take, a 1x screen",
            target: url,
            viewport,
            steps: SCRIPT_STEPS,
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
          },
          () => undefined,
        );
        const failure = JSON.stringify({ report, lines: lines.slice(-20) });
        expect(report.outcome, failure).toBe("complete");
        // Premise: the screen really was read, and read as 1x.
        expect(reads, failure).toEqual([1]);
        const takeId = report.provenance.takeId as string;
        const scene = (await library.getScene(takeId)) as SceneDocument;
        expect(scene.meta.capture.displayScale).toBe(CAPTURE_SCALE.desktop);
        const store = library.frameStore(takeId);
        const spans = (await store.getBundle(takeId))?.motionSpans ?? [];
        // Premise: there is motion to decode.
        expect(spans.length, failure).toBeGreaterThan(0);
        const widest = spans.reduce((a, b) => (b.width > a.width ? b : a));
        const decoded = await mp4FirstFrameSize(await store.load(widest.ref));
        expect(decoded.width, JSON.stringify({ widest, decoded })).toBe(
          viewport.width * CAPTURE_SCALE.desktop,
        );
      } finally {
        await session.close();
      }
    },
    RECORD_BOTH_MS,
  );
});
