import type { FrameBundle } from "@demoman/compositor";
import type { BrandKitsRead, RunReport } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import type { BrowserContext } from "playwright";
import { expect } from "vitest";
import {
  createBrowserSession,
  fullChromiumPath,
} from "../src/executor/browser.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import { runScript } from "../src/executor/run.js";
import {
  createSessionStore,
  type SessionFile,
} from "../src/executor/sessions.js";
import { installResolver } from "../src/page-agent.js";
import { lagCdp } from "./lag.js";
import { mp4FrameTimes, readMp4Crops } from "./mp4-probe.js";

/**
 * Recording on a held clock in a real browser, shared by the held tests
 * (held-take, held-network, held-two-machines). Full Chromium, as
 * production records (`fullChromiumPath`): the headless shell has no site
 * isolation, so it would hide the cross-site cases. `DEMOMAN_HELD_CLOCK=1`
 * must be set before `record` runs: the flags are read at launch.
 */

export const PIN = "2026-11-15T09:00:00Z";
export const VIEWPORT = { width: 1280, height: 800 };

/** A click-opened transition, a timer, a field to type in, an endless
 *  spinner, an animation driven by requestAnimationFrame (a box and a
 *  canvas), and a button below the fold the walk scrolls to. The right-hand
 *  column is striped down the whole page, so every scroll position paints it
 *  differently. Positions and sizes are explicit: no glyph width moves a
 *  rect. The timer and the box change the DOM every frame, inside a shadow
 *  root, where the walk's settle (a MutationObserver on the document) does
 *  not see them: otherwise every step would wait out its settle cap, said
 *  as never quiet, and this fixture's video would be mostly those caps.
 *  Its icon is empty: Chrome's favicon fetch can reach the network watch
 *  as a stretch (seen 2026-11-15), and the page is to make one request. */
export const PAGE = `<!doctype html><meta charset=utf-8><title>held</title><link rel=icon href="data:,">
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
// Moved by the time since the first frame, at fractional positions, as most
// animations are: Chrome's own performance.now() jitters 0.1 ms each run,
// so this is the same twice only if the frames' timestamp does not.
let start = null;
function frame(t) {
  if (start === null) start = t;
  const ms = t - start;
  box.style.left = (300 + ((ms / 5.3) % 300)).toFixed(3) + "px";
  ctx.clearRect(0, 0, 400, 60);
  ctx.fillStyle = "#808";
  ctx.fillRect((ms / 3.7) % 360, 10.5, 40, 40);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script>`;

export const SCRIPT_STEPS = [
  { do: "click", on: { stableId: "open" }, zoom: false },
  { do: "type", into: { stableId: "name" }, text: "held" },
  { do: "click", on: { stableId: "far" }, zoom: false },
];

const kits: BrandKitsRead = {
  state: "ready",
  kits: [],
  defaultId: null,
};

export interface Recorded {
  report: RunReport;
  scene: SceneDocument;
  bundle: FrameBundle;
  store: ReturnType<ReturnType<typeof createLibrary>["frameStore"]>;
  /** Real milliseconds the run took. */
  realMs: number;
  lines: string[];
}

/** Records `steps` at `target` into the library at `home`. With `lagMs`,
 *  every CDP command is held that long (`lag.ts`: a slow machine), and the
 *  lag is taken off again afterwards. */
export async function record(
  home: string,
  target: string,
  steps: unknown[],
  extra: Record<string, unknown> = {},
  lagMs?: number,
  pin: string = PIN,
  sessions: SessionFile[] = [],
): Promise<Recorded> {
  const lines: string[] = [];
  let lagged: BrowserContext | null = null;
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
      if (lagMs !== undefined) {
        await lagCdp(context, lagMs);
        lagged = context;
      }
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
        sessions,
        sessionStore: createSessionStore(home),
        signinCommand: "npx demoman signin",
        recordingFrameRate: { value: 30, from: "default" } as const,
        loadSessions: async () => ({ ok: true as const, files: sessions }),
        sessionsContext: {} as BrowserContext,
        pinnedNow: pin,
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
    if (lagged !== null) await lagCdp(lagged, 0);
    await session.close();
  }
}

/** What a call of the walk's that waited out its answer deadline says
 *  (`withAnswerDeadline`): each line of the run's log and report that has
 *  it. The deadline is real time, so a recording's own length on a slow
 *  machine says nothing; this does. */
export const deadlinesMissed = (r: Recorded): string[] =>
  [...r.lines, JSON.stringify(r.report)].filter((l) =>
    l.includes("got no answer from the browser"),
  );

/** The page's own captured frames, a region of each as grey levels at its
 *  source time, from every motion span of the recording: no cursor, no
 *  camera. A hold (a still) is not among them. */
export async function pageFrames(
  r: Recorded,
  rect: [number, number, number, number],
  size = { width: 32, height: 32 },
): Promise<{ ms: number; grey: string }[]> {
  const out: { ms: number; grey: string }[] = [];
  for (const span of r.bundle.motionSpans) {
    const bytes = await r.store.load(span.ref);
    const { timesSec } = await mp4FrameTimes(bytes);
    const crops = await readMp4Crops(bytes, timesSec, rect, size, true);
    out.push(
      ...crops.map((c, i) => ({
        ms: span.startMs + (timesSec[i] ?? Number.NaN) * 1000,
        grey: c.grey ?? "",
      })),
    );
  }
  return out;
}

export const pageRegion = async (
  r: Recorded,
  rect: [number, number, number, number],
): Promise<string[]> => (await pageFrames(r, rect)).map((f) => f.grey);

/** Grey levels two frames' crops may differ by and be the same frame: the
 *  motion spans are encoded on the GPU, not bit-exact between runs (1-2
 *  grey levels apart measured, 2026-11-15, and 6 on one cell of a frame
 *  of the scroll, where every pixel moves). */
export const NOISE = 8;
export const greyDiff = (x: string, y: string): number => {
  const p = Buffer.from(x, "base64");
  const q = Buffer.from(y, "base64");
  let most = 0;
  for (let i = 0; i < Math.max(p.length, q.length); i++)
    most = Math.max(most, Math.abs((p[i] ?? 0) - (q[i] ?? 0)));
  return most;
};
/** The frames of two runs' crops further apart than the noise, with how far;
 *  a different count of frames is a difference too. */
export const apartFrames = (two: string[], one: string[]): string[] => [
  ...(two.length === one.length
    ? []
    : [`${two.length} frames against ${one.length}`]),
  ...one.flatMap((f, i) => {
    const d = greyDiff(f, two[i] ?? "");
    return d > NOISE ? [`frame ${i}: ${d}`] : [];
  }),
];
/** How many frames moved past the encoder's noise from the frame before: a
 *  still picture's decoded crops differ by a grey level or two. */
export const moves = (frames: string[]): number =>
  frames.filter((f, i) => i > 0 && greyDiff(f, frames[i - 1] ?? "") > NOISE)
    .length;
