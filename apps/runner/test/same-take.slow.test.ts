// Slow tier: records one script twice through a real browser and renders both.
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
import { TYPE_KEY_MS, TYPE_LEAD_MS } from "@demoman/replay-engine";
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
import { lagCdp } from "./lag.js";
import { mp4FrameTimes } from "./mp4-probe.js";

// Spec 2026-11-13 (same take on any machine), Part 4 test 1. One script is
// recorded twice in this process, the second time with every CDP command
// held 40 ms (a slower machine), and the two takes are compared step by
// step. The comparisons are red today: the renderer keeps the idle a slow
// machine adds, so the slowed take's steps start later by more than its
// motion explains, and its zooms are decided from the measured gaps.

const LAG_MS = 40;
const FRAME_MS = 1000 / 60;
/** Acting steps after the opening waitForLoad: type, then three clicks. */
const STEPS = 4;

// A field top left; A bottom left and B top right, far apart, so each is its
// own zoom and the camera comes back between them; C a short walk from B.
// Positions and sizes are explicit: no glyph width moves a rect.
const PAGE = `<!doctype html><meta charset=utf-8><title>same take</title>
<style>
body{margin:0;font:16px sans-serif;background:#fff}
button,input{position:absolute;width:160px;height:40px;font:16px monospace}
#amount{left:40px;top:40px}
#a{left:100px;top:700px}
#b{left:1060px;top:120px}
#c{left:1000px;top:190px}
</style>
<input id="amount" aria-label="Amount">
<button id="a">Alpha</button>
<button id="b">Bravo</button>
<button id="c">Charlie</button>`;

const SCRIPT_STEPS = [
  { do: "waitForLoad" },
  { do: "type", into: { stableId: "amount" }, text: "4800" },
  { do: "click", on: { text: "Alpha" } },
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
  /** The decoded film's last frame, in ms. */
  mp4Ms: number;
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

async function record(lagMs: number): Promise<Recording> {
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
        scriptVersion: 1,
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

    const launched = await launch();
    try {
      const rendered = await renderToFiles({
        wallpaper: null,
        scene,
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
        mp4Ms: (timesSec.at(-1) ?? 0) * 1000,
        frames: (report as { frames?: unknown }).frames,
        evidence: () =>
          JSON.stringify({
            markers: bundle.markers,
            camera: scene.camera,
            segments: timeline.segments,
          }),
      };
    } finally {
      await launched.close();
    }
  } finally {
    await session.close();
  }
}

/** Marker i is script step i (the opening waitForLoad is step 0). */
const markerOf = (r: Recording, step: number) => {
  const id = r.scene.actions[step]?.id;
  const marker = r.bundle.markers.find((m) => m.actionId === id);
  if (marker === undefined) {
    throw new Error(`no marker for step ${step}: ${r.evidence()}`);
  }
  return marker;
};
const steps = Array.from({ length: STEPS }, (_, i) => i + 1);

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
 *  recordings, so the step's index), kind and scale; no times. */
const zoomShape = (r: Recording) => (c: SceneDocument["camera"][number]) => ({
  step: r.scene.actions.findIndex((a) => a.id === c.marker.actionId),
  kind: c.kind,
  scale: c.scale,
});

let fast: Recording;
let slow: Recording;

// Measured locally (Apple silicon, 2026-11-13): the whole file takes 75-85 s,
// both recordings and both 1080p renders. CI is ~5x slower at composing
// frames (CLAUDE.md, `fff4505`), so ~425 s there; 600 s leaves margin.
const RECORD_BOTH_MS = 600_000;

beforeAll(async () => {
  fast = await record(0);
  // Slowed second: the lag is the process's and nothing runs after it.
  slow = await record(LAG_MS);
}, RECORD_BOTH_MS);

describe("one script recorded fast and slowed", () => {
  it("the slowed recording really was slower (the premise)", () => {
    const said = `${fast.evidence()} ${slow.evidence()}`;
    // The fixture: the three clicks are zoomed, so there are camera
    // decisions to compare, and every step has a marker.
    for (const step of steps) markerOf(fast, step);
    for (const step of steps) markerOf(slow, step);
    const zoomed = new Set(fast.scene.camera.map((c) => c.marker.actionId));
    // Steps 2 and 3 (far apart) always zoom. Step 4, near step 3, zooms in
    // some recordings and not others (seen 2026-11-13: the fast take had it
    // in one run and not in the next): that is the camera deciding from
    // measured gaps, so it is compared below, not assumed here.
    for (const step of [2, 3]) {
      expect(zoomed.has(markerOf(fast, step).actionId), said).toBe(true);
    }
    const sourceDiff =
      sourceDurationOf(slow.bundle) - sourceDurationOf(fast.bundle);
    console.table({
      "source ms": {
        fast: sourceDurationOf(fast.bundle),
        slow: sourceDurationOf(slow.bundle),
        diff: sourceDiff,
      },
      "mp4 ms": {
        fast: fast.mp4Ms,
        slow: slow.mp4Ms,
        diff: slow.mp4Ms - fast.mp4Ms,
      },
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
    // length of the typing is chars x TYPE_KEY_MS + TYPE_LEAD_MS; a journey's
    // designed length is not persisted (the scene and bundle carry no cursor
    // segment), so it is null here.
    const typedText = "4800";
    console.log(
      `typing designed ${typedText.length * TYPE_KEY_MS + TYPE_LEAD_MS} ms; journey designed: not recorded in the scene or bundle`,
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

  // Result 1 turns green in Task 7: idle contributes nothing to the
  // difference. Red today because the slowed take keeps its added idle: the
  // assertion that fails is the first step's `Math.abs(startDiff -
  // motionDiff) <= FRAME_MS` (step 1 starts ~1400 ms later slowed, with ~50 ms
  // more motion before it).
  it.fails("idle contributes nothing to where each step starts", () => {
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

  // Result 2: the same script gets the same camera. Skipped until Task 7,
  // which turns it into a plain `it`: today the camera is decided from
  // measured time, so two recordings may or may not agree (two fast
  // recordings already differed on 2026-11-13), and an `it.fails` would go
  // red on a run where they happen to. The shapes of both cameras are in
  // the premise's reported output above.
  it.skip("the two takes have the same camera", () => {
    expect(
      slow.scene.camera.map(zoomShape(slow)),
      `${fast.evidence()} ${slow.evidence()}`,
    ).toEqual(fast.scene.camera.map(zoomShape(fast)));
  });
});
